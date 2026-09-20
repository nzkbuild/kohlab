// Durability and operations checks.
//
// These are the promises that only show up when something goes wrong: an old
// state file must still load, a file from a newer build must be refused rather
// than half-read, a backup must restore, and the health endpoint must tell the
// truth about the daemon. Each is run against real files and a real server.
import { spawn, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PORT = 7802;
const KEY = "durability-check-key";
const dir = mkdtempSync(join(tmpdir(), "kohlab-durability-"));
const archive = join(tmpdir(), `kohlab-backup-${Date.now()}.tar.gz`);
let failures = 0;

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${got}, wanted ${want})`}`);
}

// Its own socket, always. Without one the throwaway server adopts the daemon of
// a real instance on this machine — harmless in itself, but it makes the check
// depend on, and able to disturb, something it was never meant to touch.
const SOCKET = join(tmpdir(), `kohlab-durability-${process.pid}.sock`);
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  KOHLAB_KEY: KEY,
  WORKS_DIR: dir,
  PTY_SOCKET: SOCKET,
};
const cli = (...args) => spawnSync("bun", ["run", "cli.ts", ...args], { cwd: process.cwd(), env, encoding: "utf8" });

function server() {
  const proc = spawn("bun", ["run", "server.ts"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (b) => (log += b));
  proc.stderr.on("data", (b) => (log += b));
  return { proc, getLog: () => log };
}

const base = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return r;
    } catch {
      /* not listening yet */
    }
    await wait(250);
  }
  throw new Error("server never came up");
}

// ── 1. a state file from before versioning still loads, and is stamped ───────
// This is the shape an install predating schemaVersion has on disk.
const legacyShape = {
  workspaces: [
    {
      id: "legacy-ws",
      repo: "/tmp/legacy-repo",
      task: "a workspace from before versioning existed",
      agent: "sh",
      created: 1,
      started: null,
      stopped: null,
    },
  ],
  agents: { omp: "omp", claude: "claude", codex: "codex", sh: "sh" },
};
writeFileSync(join(dir, "state.json"), JSON.stringify(legacyShape, null, 2));

let s = server();
try {
  const live = await up(); // no credentials: liveness only
  const liveBody = await live.json();
  const body = await (await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  check("a versionless state file loads", (await fetch(`${base}/api/workspaces`, { headers: { authorization: `Bearer ${KEY}` } })).status, 200);
  check("its workspaces survive", body.workspaces.total, 1);
  check("and it is stamped with the current schema", body.schemaVersion, 1);
  const stamped = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  check("the stamp is persisted, not just reported", stamped.schemaVersion, 1);
  check("an unauthenticated probe learns liveness and nothing else",
    Object.keys(liveBody).sort().join(","), "ok");
  check("authenticated health reports the daemon", typeof body.daemon, "boolean");
  check("and the version", typeof body.version, "string");
} finally {
  s.proc.kill("SIGKILL");
}
await wait(300);

// ── 2. a state file from the future is refused, not half-read ────────────────
writeFileSync(join(dir, "state.json"), JSON.stringify({ ...legacyShape, schemaVersion: 999 }, null, 2));
const before = readFileSync(join(dir, "state.json"), "utf8");
const future = spawnSync("bun", ["run", "cli.ts", "list"], { cwd: process.cwd(), env, encoding: "utf8" });
check("a newer state file makes the reader fail", future.status !== 0, true);
check("and the message says why", /newer kohlab/.test(`${future.stdout}${future.stderr}`), true);
check("and the file is left exactly as it was", readFileSync(join(dir, "state.json"), "utf8") === before, true);

// ── 3. backup, wipe, restore ─────────────────────────────────────────────────
writeFileSync(join(dir, "state.json"), JSON.stringify({ ...legacyShape, schemaVersion: 1 }, null, 2));
writeFileSync(join(dir, "users.json"), JSON.stringify({ users: [{ id: "someone", name: "Someone", role: "member", key: "deadbeef" }] }, null, 2));
writeFileSync(join(dir, "audit.log"), '{"t":1,"user":"cli","action":"test"}\n');

const backup = cli("backup", archive);
check("backup succeeds", backup.status, 0);
check("the archive exists", existsSync(archive), true);
const listed = spawnSync("tar", ["tzf", archive], { encoding: "utf8" }).stdout;
check("it holds state, members and the audit trail",
  ["state.json", "users.json", "audit.log"].every((f) => listed.includes(f)), true);

rmSync(join(dir, "state.json"));
rmSync(join(dir, "users.json"));
const restore = cli("restore", archive);
check("restore succeeds", restore.status, 0);
check("state.json is back", existsSync(join(dir, "state.json")), true);
check("users.json is back", existsSync(join(dir, "users.json")), true);
check("the workspaces in it are back",
  JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).workspaces.length, 1);
check("the member is back",
  JSON.parse(readFileSync(join(dir, "users.json"), "utf8")).users[0].id, "someone");
const aside = readdirSync(dir).filter((f) => f.includes(".before-restore-"));
check("the files it replaced were kept, not deleted", aside.length >= 1, true);

// A path in the archive must be refused: that is a write outside the state dir.
const evil = join(tmpdir(), `kohlab-evil-${Date.now()}.tar.gz`);
writeFileSync(join(dir, "escape"), "x");
spawnSync("tar", ["czf", evil, "-C", tmpdir(), ".."], { encoding: "utf8" });
rmSync(join(dir, "escape"));
const evilResult = cli("restore", evil);
check("an archive with a path in it is refused", evilResult.status !== 0, true);
rmSync(evil, { force: true });

// ── 4. audit rotation ────────────────────────────────────────────────────────
// A tiny threshold, so rolling is exercised without writing 8 MiB.
const auditDir = mkdtempSync(join(tmpdir(), "kohlab-audit-"));
const auditEnv = { ...process.env, WORKS_DIR: auditDir, AUDIT_MAX_BYTES: "512" };
const filler = '{"t":1,"user":"cli","action":"filler","detail":"' + "x".repeat(120) + '"}\n';
writeFileSync(join(auditDir, "audit.log"), filler.repeat(6));
const rotate = spawnSync("bun", ["-e", `
  import { audit } from "./lib.ts";
  await audit("cli", "trigger");
  await new Promise((r) => setTimeout(r, 400));
  console.log("done");
`], { cwd: process.cwd(), env: auditEnv, encoding: "utf8" });
check("the rotation ran", rotate.stdout.includes("done"), true);
check("the log was rolled to .1", existsSync(join(auditDir, "audit.log.1")), true);
check("a fresh log was started", existsSync(join(auditDir, "audit.log")), true);
check("and the roll is recorded in the new log",
  readFileSync(join(auditDir, "audit.log"), "utf8").includes("audit.rotated"), true);
rmSync(auditDir, { recursive: true, force: true });

// ── 5. health reports the daemon honestly ────────────────────────────────────
const health = cli("health");
check("kohlab health exits 0 with a live daemon", health.status, 0);
check("and says so", /up \(/.test(health.stdout), true);

s = server();
try {
  await up();
  const detail = await (await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${KEY}` } })).json();
  check("health reports a live daemon", detail.daemon, true);
  check("and no death timestamp while it is up", detail.daemonDownSince, null);
} finally {
  s.proc.kill("SIGKILL");
}

// ── 6. a dead daemon is reported as dead ─────────────────────────────────────
// Kill the daemon the server adopted; nothing restarts it mid-request, so the
// next health call must say so rather than reporting a stale "up".
const deadDir = mkdtempSync(join(tmpdir(), "kohlab-deadd-"));
const deadSock = join(tmpdir(), `kohlab-dead-${Date.now()}.sock`);
/** The pid bound to a unix socket, so nothing else is ever killed by accident. */
function pidOnSocket(path) {
  const out = spawnSync("sh", ["-c", `ss -xlp 2>/dev/null | grep -F '${path}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`], { encoding: "utf8" }).stdout.trim();
  return out || null;
}

/** End the daemon bound to a socket. A detached daemon outlives its server. */
function killDaemonOn(path) {
  const pid = pidOnSocket(path);
  if (pid) spawnSync("kill", ["-9", pid], { encoding: "utf8" });
  rmSync(path, { force: true });
}
const deadEnv = { ...process.env, PORT: "7803", HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: deadDir, PTY_SOCKET: deadSock };
const dproc = spawn("bun", ["run", "server.ts"], { cwd: process.cwd(), env: deadEnv, stdio: ["ignore", "pipe", "pipe"] });
try {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://127.0.0.1:7803/api/health");
      if (r.ok) break;
    } catch {
      /* not yet */
    }
    await wait(250);
  }
  const alive = await (await fetch("http://127.0.0.1:7803/api/health", { headers: { authorization: `Bearer ${KEY}` } })).json();
  check("the server starts a daemon on demand", alive.daemon, true);
  const beforeKill = alive;

  // Kill the daemon THIS server started, by the pid bound to THIS socket. An
  // unscoped `pkill -f pty-daemon.cjs` would also kill the daemon of any kohlab
  // instance running on this machine, ending real agent sessions — a check that
  // damages the thing it checks is worse than no check.
  const killed = pidOnSocket(deadSock);
  check("the daemon is identifiable by its socket", typeof killed, "string");
  if (killed) spawnSync("kill", ["-9", killed], { encoding: "utf8" });
  await wait(600);
  const after = await (await fetch("http://127.0.0.1:7803/api/health", { headers: { authorization: `Bearer ${KEY}` } })).json();
  // The probe itself adopts-or-starts a daemon, so a monitor sees green again at
  // once - which is exactly why the death has to outlive the recovery in the
  // payload. Otherwise an outage that killed every live session leaves no trace.
  check("a probe brings a dead daemon back", after.daemon, true);
  check("and the death it recovered from is still reported", typeof after.lastDaemonDeath, "number");
  check("with no death before that one", beforeKill.lastDaemonDeath, null);

  const auditLog = existsSync(join(deadDir, "audit.log")) ? readFileSync(join(deadDir, "audit.log"), "utf8") : "";
  check("daemon death is in the audit trail", auditLog.includes("daemon.down"), true);
} finally {
  dproc.kill("SIGKILL");
  killDaemonOn(deadSock);
  rmSync(deadDir, { recursive: true, force: true });
}

killDaemonOn(SOCKET);
rmSync(dir, { recursive: true, force: true });
rmSync(archive, { force: true });

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall durability checks passed");
