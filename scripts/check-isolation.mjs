#!/usr/bin/env node
/**
 * Per-user isolation — the claim the whole team story rests on.
 *
 * Run:  node scripts/check-isolation.mjs      (needs root; skips itself otherwise)
 *
 * v1.8 promised that "Bob cannot read Alice's files or signal her processes"
 * because each member is a real OS account and their agents run as that account.
 * It was true, documented, and its definition-of-done was ticked **by hand** —
 * which is to say the most important claim in the product was asserted by
 * nothing. This asserts it.
 *
 * What it does *not* cover: the spawn-time uid/gid drop itself. That is the
 * daemon's business and is driven by check-screen.mjs over a real socket; this
 * check asserts the OS boundary the drop depends on.
 *
 * Creating accounts is a host mutation, which is why this skips itself when it
 * cannot create them — and cleans up in a finally block either way.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const KEY = "isolation-check-key";
const tmp = mkdtempSync(join(tmpdir(), "kohlab-iso-"));

/**
 * A port nothing is listening on.
 *
 * A fixed port silently tested the wrong process: a server left behind by an
 * earlier run answered every request here, with a state directory that no longer
 * existed — so `DELETE /api/users/x` found no user, deprovisioned nothing and
 * reported success, and this check failed for a reason that had nothing to do
 * with isolation.
 */
async function freePort() {
  const srv = createServer();
  const { promise, resolve } = Promise.withResolvers();
  srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  const port = await promise;
  const closed = Promise.withResolvers();
  srv.close(closed.resolve);
  await closed.promise;
  return port;
}

const PORT = await freePort();

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name} ${detail}`);
}

const j = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const api = (path, opts = {}) =>
  fetch(`http://127.0.0.1:${PORT}${path}${path.includes("?") ? "&" : "?"}key=${KEY}`, opts).then(j);
const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

/** Does this OS account exist, and with which uid/home? */
function account(osUser) {
  const line = spawnSync("getent", ["passwd", osUser], { encoding: "utf8" }).stdout.trim();
  if (!line) return null;
  const [, , uid, gid, , home] = line.split(":");
  return { uid: Number(uid), gid: Number(gid), home };
}

/** Run a shell command as another user, the way the daemon would. */
function asUser(osUser, command) {
  const r = spawnSync("su", ["-s", "/bin/sh", osUser, "-c", command], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** The daemon is detached on purpose, so it has to be found by its own socket. */
function killOurDaemon() {
  const socketPath = join(tmp, "pty.sock");
  for (const pid of spawnSync("pgrep", ["-f", "pty-daemon.cjs"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${socketPath}`)) process.kill(Number(pid), "SIGTERM");
    } catch {
      /* not ours, or already gone */
    }
  }
}

const stamp = Date.now();
const A = `iso-a-${stamp}`;
const B = `iso-b-${stamp}`;
const osA = `koh-${A}`.slice(0, 24);
const osB = `koh-${B}`.slice(0, 24);

let server = null;

try {
  console.log("\nkohlab — per-user isolation\n");

  if (process.getuid?.() !== 0) {
    console.log("  skip  not root: accounts cannot be provisioned, so there is nothing to assert");
    process.exit(0);
  }
  if (spawnSync("getent", ["passwd", "root"], { encoding: "utf8" }).status !== 0) {
    console.log("  skip  no getent on this host");
    process.exit(0);
  }

  mkdirSync(join(tmp, "state"), { recursive: true });
  server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: join(tmp, "state"), PTY_SOCKET: join(tmp, "pty.sock") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${PORT}/api/auth/required`).then((r) => r.ok).catch(() => false);
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  if (!up) throw new Error(`server never came up\n${log}`);
  // A port answering is not proof that *this* server is answering: a stale
  // process from an earlier run can hold the port, with a state directory that
  // no longer exists. Our own startup line is proof.
  for (let i = 0; i < 20 && !/works server on /.test(log); i++) await new Promise((r) => setTimeout(r, 50));
  if (!/works server on /.test(log)) throw new Error(`${PORT} answered, but not from the server this check started:\n${log}`);

  // ── accounts exist, private, and above the system range ──────────────────
  const madeA = await post("/api/users", { id: A, name: "Isolation A", role: "member" });
  const madeB = await post("/api/users", { id: B, name: "Isolation B", role: "member" });
  check("two members are provisioned", madeA.status === 200 && madeB.status === 200, `${madeA.status}/${madeB.status} ${JSON.stringify(madeB.body)}`);

  const accA = account(osA);
  const accB = account(osB);
  check("each member has an OS account", !!accA && !!accB, `${osA}=${JSON.stringify(accA)} ${osB}=${JSON.stringify(accB)}`);
  check("uids are in the member range", (accA?.uid ?? 0) >= 10000 && (accB?.uid ?? 0) >= 10000, `${accA?.uid}/${accB?.uid}`);
  if (accA && accB) {
    check("homes are not each other's", accA.home !== accB.home, accA.home);
    const mode = (p) => statSync(p).mode & 0o777;
    check("a home is 0700", mode(accA.home) === 0o700, mode(accA.home).toString(8));
  }

  // ── the boundary the claim is actually about ─────────────────────────────
  if (accA && accB) {
    const secret = join(accA.home, "the-secret");
    spawnSync("su", ["-s", "/bin/sh", osA, "-c", `printf 'alice-only\\n' > ${secret}`], { encoding: "utf8" });
    check("A can write in A's own home", existsSync(secret));

    const own = asUser(osA, `cat ${secret}`);
    check("A can read A's own file", own.code === 0 && own.out.includes("alice-only"), own.out);

    const cross = asUser(osB, `cat ${secret}`);
    check("B cannot read A's file", cross.code !== 0, `exit ${cross.code}: ${cross.out}`);
    check("and is told why", /Permission denied/i.test(cross.out), cross.out);

    const list = asUser(osB, `ls ${accA.home}`);
    check("B cannot even list A's home", list.code !== 0, `exit ${list.code}: ${list.out}`);

    const write = asUser(osB, `touch ${join(accA.home, "planted")}`);
    check("B cannot write into A's home", write.code !== 0 && !existsSync(join(accA.home, "planted")), `exit ${write.code}`);

    // a process A owns must not be signalable by B
    // detached so it outlives this check's own process tree, like an agent would
    spawn("setsid", ["su", "-s", "/bin/sh", osA, "-c", "sleep 300"], { stdio: "ignore", detached: true }).unref();
    await new Promise((r) => setTimeout(r, 400));
    const found = spawnSync("pgrep", ["-u", osA, "-f", "sleep 30"], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    const sleepPid = found[0];
    check("A's process is running as A", !!sleepPid, "could not find it");
    // The process is deliberately left running. Revoking a member whose agent is
    // still alive is the case that matters, and `userdel` refuses while any of
    // their processes hold the account — so this is what exercises the kill-first
    // step in deprovisionOsUser. A test that tidies up first proves nothing.
    check("A's process is still running at revoke time", !!sleepPid, "nothing to revoke against");
  }

  // ── revoking takes it all away again ─────────────────────────────────────
  const goneA = await api(`/api/users/${A}`, { method: "DELETE" });
  check("revoking succeeds", goneA.status === 200, `${goneA.status} ${JSON.stringify(goneA.body)}`);
  check("revoking reports no leftovers", !goneA.body?.warning, JSON.stringify(goneA.body));
  const stillThere = account(osA);
  check("the OS account is gone", stillThere === null, `${JSON.stringify(stillThere)} — server said: ${log.trim().split("\n").slice(-4).join(" | ")}`);
  if (accA) check("the home is gone", !existsSync(accA.home), `server said: ${log.trim().split("\n").slice(-4).join(" | ")}`);
  const survivors = spawnSync("pgrep", ["-u", osA], { encoding: "utf8" }).stdout.trim();
  check("none of their processes survive the revoke", survivors === "", survivors);
  await api(`/api/users/${B}`, { method: "DELETE" });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failed:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    console.log(`\nserver log:\n${log.trim().split("\n").slice(-25).join("\n")}`);
    process.exit(1);
  }
  console.log("per-user isolation intact\n");
} catch (err) {
  console.error(`\n  FAIL unexpected error: ${err.message}`);
  process.exit(1);
} finally {
  // never leave accounts behind, whatever happened above
  for (const id of [A, B]) {
    await api(`/api/users/${id}`, { method: "DELETE" }).catch(() => {});
  }
  for (const osUser of [osA, osB]) {
    if (account(osUser)) spawnSync("userdel", ["-r", osUser], { encoding: "utf8" });
  }
  try {
    server?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  killOurDaemon();
  rmSync(tmp, { recursive: true, force: true });
}
