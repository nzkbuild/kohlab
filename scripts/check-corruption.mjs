#!/usr/bin/env node
/**
 * Corruption handling — what happens when a state file is unreadable.
 *
 * Run:  node scripts/check-corruption.mjs
 *
 * Two properties worth proving rather than asserting:
 *   1. A corrupt state.json fails LOUDLY and preserves the file, instead of
 *      silently presenting an empty fleet (and inviting new state to be written
 *      over the only surviving copy).
 *   2. A corrupt users.json FAILS CLOSED. It used to read as "no users", which
 *      made authRequired() false and let anonymous requests mutate — a damaged
 *      auth file silently disabling authentication.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT_A = 7798;
const PORT_B = 7797;

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

/** Start a server against a throwaway WORKS_DIR and wait until it answers. */
async function startServer(port, worksDir, extraEnv = {}) {
  const logs = [];
  const proc = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), WORKS_DIR: worksDir, PTY_SOCKET: join(worksDir, "pty.sock"), ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/auth/required`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return { proc, logs };
    await sleep(150);
  }
  throw new Error(`server on ${port} never came up:\n${logs.join("").slice(-400)}`);
}

const corruptions = (dir) => readdirSync(dir).filter((f) => f.includes(".corrupt-"));

const tmp = mkdtempSync(join(tmpdir(), "kohlab-corrupt-"));
const worksA = join(tmp, "a");
const worksB = join(tmp, "b");
mkdirSync(worksA, { recursive: true });
mkdirSync(worksB, { recursive: true });

writeFileSync(join(worksA, "state.json"), JSON.stringify({ workspaces: [], agents: { sh: "sh" } }, null, 2));
writeFileSync(join(worksB, "state.json"), JSON.stringify({ workspaces: [], agents: { sh: "sh" } }, null, 2));

let a = null;
let b = null;

try {
  console.log("\nkohlab corruption handling\n");

  // ---- 1. a corrupt state.json -------------------------------------------------
  a = await startServer(PORT_A, worksA);
  const healthy = await fetch(`http://127.0.0.1:${PORT_A}/api/workspaces`);
  check("healthy state.json serves normally", healthy.status === 200, `got ${healthy.status}`);

  writeFileSync(join(worksA, "state.json"), '{"workspaces": [{"id": "trunc');
  await sleep(300);
  const broken = await fetch(`http://127.0.0.1:${PORT_A}/api/workspaces`);
  const body = await broken.text();
  check("a corrupt state.json fails the request", broken.status >= 400, `got ${broken.status}`);
  check(
    "the error names the corruption rather than pretending to be empty",
    /corrupt/i.test(body) || /corrupt/i.test(a.logs.join("")),
    body.slice(0, 120),
  );
  check("the corrupt file is preserved, not discarded", corruptions(worksA).length > 0, JSON.stringify(readdirSync(worksA)));
  check(
    "the preserved copy still holds the original bytes",
    readdirSync(worksA)
      .filter((f) => f.includes(".corrupt-"))
      .some((f) => {
        try {
          return readFileSync(join(worksA, f), "utf8").includes("trunc");
        } catch {
          return false;
        }
      }),
    "preserved file did not contain the original content",
  );

  a.proc.kill("SIGKILL");
  a = null;

  // ---- 2. a corrupt users.json must not disable auth ---------------------------
  b = await startServer(PORT_B, worksB);
  const open = await fetch(`http://127.0.0.1:${PORT_B}/api/workspaces`);
  check(
    "with no users file and no KOHLAB_KEY, the API is open (auth not required)",
    open.status === 200,
    `got ${open.status}`,
  );

  writeFileSync(join(worksB, "users.json"), "{ this is not json");
  await sleep(300);
  const afterCorruption = await fetch(`http://127.0.0.1:${PORT_B}/api/workspaces`);
  check(
    "a corrupt users.json FAILS CLOSED — anonymous access is refused",
    afterCorruption.status === 401,
    `got ${afterCorruption.status} (200 would mean a damaged auth file disabled authentication)`,
  );
  check("the corrupt users file is preserved", corruptions(worksB).length > 0, JSON.stringify(readdirSync(worksB)));
  const required = await fetch(`http://127.0.0.1:${PORT_B}/api/auth/required`).then((r) => r.json());
  check(
    "the server reports auth as required once the user list is untrustworthy",
    required.required === true,
    JSON.stringify(required),
  );
} catch (err) {
  failures.push(`threw: ${err.message}`);
  console.log(`  FAIL ${err.message}`);
} finally {
  for (const s of [a, b]) {
    try {
      s?.proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
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
