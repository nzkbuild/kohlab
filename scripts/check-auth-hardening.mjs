// Auth hardening checks: the uniform gate, the throttle, self-service rotation,
// and the socket handshake that carries the key in a subprotocol instead of a URL.
// Runs against a real server on a free port, because all four are behaviours of
// the HTTP/WS layer rather than of a function.
import { spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

const PORT = 7799;
const dir = mkdtempSync(join(tmpdir(), "kohlab-auth-"));
const KEY = "test-key-0123456789abcdef";
let failures = 0;

function check(name, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${got}, wanted ${want})`}`);
}

// Its own socket, so this never adopts (or disturbs) a real instance's daemon.
const SOCKET = join(tmpdir(), `kohlab-auth-${process.pid}.sock`);
const server = spawn("bun", ["run", "server.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: dir, PTY_SOCKET: SOCKET },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (b) => (log += b));
server.stderr.on("data", (b) => (log += b));


/**
 * The pid bound to a unix socket.
 *
 * A daemon is spawned detached and deliberately outlives its server, so a check
 * that starts a server leaks a daemon per run unless it ends the one it caused —
 * and `pkill -f pty-daemon.cjs` would also kill the daemon of a real kohlab
 * instance on this machine, ending live agent sessions.
 */
function pidOnSocket(path) {
  const out = spawnSync(
    "sh",
    ["-c", `ss -xlp 2>/dev/null | grep -F '${path}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`],
    { encoding: "utf8" },
  ).stdout.trim();
  return out || null;
}

/** End the daemon bound to a socket, if one is there. */
function killDaemonOn(path) {
  const pid = pidOnSocket(path);
  if (pid) spawnSync("kill", ["-9", pid], { encoding: "utf8" });
  rmSync(path, { force: true });
}

const base = `http://127.0.0.1:${PORT}`;
const owner = { authorization: `Bearer ${KEY}` };
const as = (k) => ({ authorization: `Bearer ${k}` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(`${base}/api/auth/required`);
    if (r.ok) break;
  } catch {
    await wait(250);
  }
}

function socketProbe(protocols) {
  return new Promise((resolve) => {
    const ws = protocols ? new WebSocket(`ws://127.0.0.1:${PORT}`, protocols) : new WebSocket(`ws://127.0.0.1:${PORT}`);
    const done = (v) => {
      try { ws.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(() => done("timeout"), 5000);
    ws.onopen = () => { clearTimeout(timer); done("open"); };
    ws.onerror = () => { clearTimeout(timer); done("error"); };
  });
}

try {
  check("no credentials at all -> 401", (await fetch(`${base}/api/users`)).status, 401);
  check("no credentials, mutating -> 401", (await fetch(`${base}/api/agents`, { method: "POST", body: "{}" })).status, 401);
  check("no credentials, clone -> 401", (await fetch(`${base}/api/clone`, { method: "POST", body: "{}" })).status, 401);
  check("no credentials, update -> 401", (await fetch(`${base}/api/release/update`, { method: "POST", body: "{}" })).status, 401);
  check("no credentials, workspace delete -> 401",
    (await fetch(`${base}/api/workspaces/x/delete`, { method: "POST", body: "{}" })).status, 401);
  check("wrong key -> 401", (await fetch(`${base}/api/users?key=wrong`)).status, 401);
  check("key in a header -> 200", (await fetch(`${base}/api/users`, { headers: owner })).status, 200);
  check("key in a query string still works (bookmarks, curl)",
    (await fetch(`${base}/api/users?key=${KEY}`)).status, 200);

  check("socket opens with the key in the subprotocol", await socketProbe([`kohlab.key.${KEY}`]), "open");
  check("socket without a key is refused", await socketProbe(null), "error");

  // ── self-service rotation ──────────────────────────────────────────────────
  const made = await fetch(`${base}/api/users`, {
    method: "POST",
    headers: { ...owner, "content-type": "application/json" },
    body: JSON.stringify({ id: "rotator", name: "Rotator", role: "member" }),
  });
  check("an owner can mint a member", made.status, 200);
  const { key: first } = await made.json();

  const me = await (await fetch(`${base}/api/account`, { headers: as(first) })).json();
  check("account reports id and role", `${me.id}:${me.role}`, "rotator:member");

  const rotated = await fetch(`${base}/api/account/key`, { method: "POST", headers: as(first) });
  check("a member can rotate their own key", rotated.status, 200);
  const { key: second } = await rotated.json();

  check("the new key works", (await fetch(`${base}/api/workspaces`, { headers: as(second) })).status, 200);
  check("the old key is dead", (await fetch(`${base}/api/workspaces`, { headers: as(first) })).status, 401);
  check("and it is dead in a URL too", (await fetch(`${base}/api/workspaces?key=${first}`)).status, 401);

  // The legacy key is set on the box, so there is nothing here to rotate.
  const legacy = await fetch(`${base}/api/account/key`, { method: "POST", headers: owner });
  check("rotating the box key is refused with a pointer to the CLI", legacy.status, 400);

  const audit = await (await fetch(`${base}/api/audit`, { headers: owner })).json();
  check("rotation is in the audit trail",
    audit.events.some((e) => e.action === "key.rotate"), true);

  // Last, because it deliberately trips the limit for this address. Note what a
  // dead key reports while the window is open: 429, not 401. The throttle cannot
  // tell a revoked key from a guessed one, and refusing both is the point.
  let sawThrottle = false;
  for (let i = 0; i < 25; i++) {
    const r = await fetch(`${base}/api/users?key=wrong-${i}`);
    if (r.status === 429) { sawThrottle = true; break; }
  }
  check("a loop of wrong keys is throttled", sawThrottle, true);
  check("the throttle does not lock out the real key",
    (await fetch(`${base}/api/users`, { headers: owner })).status, 200);
} finally {
  server.kill("SIGKILL");
  killDaemonOn(SOCKET);
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed. server log:\n${log.slice(-2000)}`);
  process.exit(1);
}
console.log("\nall auth checks passed");
