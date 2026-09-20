#!/usr/bin/env node
/**
 * Corruption handling — what happens when a state file is unreadable.
 *
 * Run:  node scripts/check-corruption.mjs
 *
 * Three properties, each of which was wrong at some point:
 *   1. A corrupt state.json fails LOUDLY rather than presenting an empty fleet.
 *   2. A corrupt users.json FAILS CLOSED — it used to read as "no users", which
 *      made authRequired() false and let anonymous requests mutate.
 *   3. Both survive a RESTART. An earlier fix quarantined the damaged file by
 *      renaming it aside; the "we are damaged" signal was module state, so a
 *      restart cleared it and the renamed-away file simply read as absent —
 *      re-opening anonymous access, and turning a corrupt state file into a
 *      working-looking empty fleet. The file is now left in place.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT_A = 7798;
const PORT_B = 7797;
const GARBAGE_USERS = "{ this is not json";
const GARBAGE_STATE = '{"workspaces": [{"id": "trunc';

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a server against a throwaway WORKS_DIR. Does NOT throw when the server
 * refuses to come up: with a corrupt state file, exiting is a valid outcome and
 * the caller asserts on that rather than dying inside a helper.
 */
async function startServer(port, worksDir) {
  const logs = [];
  const proc = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    // HOST is pinned to loopback: bound anywhere else, a keyless, userless server
    // now generates itself a key (lib.ts resolveAccessKey), which is the correct
    // behaviour but not what this check is about. Loopback is the documented
    // case where an open server is acceptable — the only caller is on the box.
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", WORKS_DIR: worksDir, PTY_SOCKET: join(worksDir, "pty.sock") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  let up = false;
  for (let i = 0; i < 40; i++) {
    up = await fetch(`http://127.0.0.1:${port}/api/auth/required`)
      .then((r) => r.ok)
      .catch(() => false);
    if (up) break;
    await sleep(150);
  }
  return { proc, logs, up };
}

/** Status, or 0 when the server is unreachable (which is itself a valid outcome). */
const status = (port, path) =>
  fetch(`http://127.0.0.1:${port}${path}`)
    .then((r) => r.status)
    .catch(() => 0);

/** Read a file without throwing — a missing file is itself a finding. */
const safeRead = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const kill = (s) => {
  try {
    s?.proc.kill("SIGKILL");
  } catch {
    /* gone */
  }
};

const tmp = mkdtempSync(join(tmpdir(), "kohlab-corrupt-"));
const worksA = join(tmp, "a");
const worksB = join(tmp, "b");
for (const d of [worksA, worksB]) {
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "state.json"), JSON.stringify({ workspaces: [], agents: { sh: "sh" } }, null, 2));
}

let a = null;
let b = null;

try {
  console.log("\nkohlab corruption handling\n");

  // ---- 1. a corrupt state.json -------------------------------------------------
  a = await startServer(PORT_A, worksA);
  check("healthy state.json serves normally", (await status(PORT_A, "/api/workspaces")) === 200);

  writeFileSync(join(worksA, "state.json"), GARBAGE_STATE);
  await sleep(250);
  const broken = await status(PORT_A, "/api/workspaces");
  check("a corrupt state.json fails the request", broken >= 400, `got ${broken}`);
  check(
    "the failure names the corruption rather than pretending to be empty",
    /corrupt/i.test(a.logs.join("")),
    a.logs.join("").slice(-160),
  );
  check(
    "the corrupt file is left in place, not renamed away",
    safeRead(join(worksA, "state.json")) === GARBAGE_STATE,
    `file is now ${JSON.stringify((safeRead(join(worksA, "state.json")) ?? "<missing>").slice(0, 40))}`,
  );

  kill(a);
  await sleep(300);
  a = await startServer(PORT_A, worksA);
  const afterRestartA = await status(PORT_A, "/api/workspaces");
  check(
    "a restart does not silently start from an empty fleet",
    afterRestartA !== 200,
    `got ${afterRestartA} — 200 would mean a corrupt state file quietly became an empty, working fleet`,
  );

  kill(a);
  await sleep(200);
  a = null;

  // ---- 2. a corrupt users.json must not disable auth ---------------------------
  b = await startServer(PORT_B, worksB);
  check("with no users file and no KOHLAB_KEY on loopback, the API is open", (await status(PORT_B, "/api/workspaces")) === 200);

  writeFileSync(join(worksB, "users.json"), GARBAGE_USERS);
  await sleep(250);
  check(
    "a corrupt users.json FAILS CLOSED — the FIRST request is refused",
    (await status(PORT_B, "/api/workspaces")) === 401,
    "200 would mean a damaged auth file disabled authentication",
  );
  check(
    "the corrupt users file is left in place, not renamed away",
    safeRead(join(worksB, "users.json")) === GARBAGE_USERS,
    `file is now ${JSON.stringify(safeRead(join(worksB, "users.json")) ?? "<missing>")}`,
  );

  kill(b);
  await sleep(300);
  b = await startServer(PORT_B, worksB);
  check(
    "a RESTART does not re-open anonymous access",
    (await status(PORT_B, "/api/workspaces")) === 401,
    "200 would mean a restart cleared the latch and re-opened auth — the bug that renaming the file caused",
  );
  const required = await fetch(`http://127.0.0.1:${PORT_B}/api/auth/required`).then((r) => r.json());
  check("auth is reported as required after the restart", required.required === true, JSON.stringify(required));
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.log(`  FAIL ${err.message}`);
} finally {
  kill(a);
  kill(b);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* gone */
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("corruption handling intact\n");
}
