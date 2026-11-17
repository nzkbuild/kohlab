#!/usr/bin/env node
/**
 * The server terminal (SERVER_SHELL_ID, "server-shell"): an owner-only plain shell as the server user, not a project.
 *
 * Throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) with an owner key and a seeded member and viewer. The members are
 * written straight into users.json, so no OS account is provisioned. Checks:
 *  - the owner opens it (POST /api/server-shell -> { id }), it is idempotent, and it is not in the project list or the health count
 *  - a member, a viewer, a share link and no credentials are refused (403, 403, 403, 401); a member cannot attach to it over the socket
 *  - every other route under /api/workspaces/server-shell is 403 for the owner, and DELETE is refused; the terminal close is allowed
 *  - the owner's socket runs sh as the server user, in the home directory (echo 42, and the pwd and uid it reports)
 *  - an anonymous socket cannot open at all; the open is audited
 *
 * Run:  node scripts/check-server-shell.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonOn } from "./kill-daemon.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7937;
const KEY = "server-shell-owner-key";
const MEMBER_KEY = "server-shell-member-key";
const VIEWER_KEY = "server-shell-viewer-key";
const base = `http://127.0.0.1:${PORT}`;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${String(detail).slice(0, 300)}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await Promise.resolve(fn()).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}

const tmp = mkdtempSync(join(tmpdir(), "kohlab-server-shell-"));
const works = join(tmp, "works");
const projects = join(tmp, "projects");
const socket = join(tmp, "pty.sock");
const audit = join(works, "audit.log");
mkdirSync(works, { recursive: true });
mkdirSync(projects, { recursive: true });
// Members with hashed keys, so no OS account is made (provisioning runs as root on this box).
writeFileSync(
  join(works, "users.json"),
  JSON.stringify({
    users: [
      { id: "shell-member", name: "Shell member", role: "member", key: sha256(MEMBER_KEY) },
      { id: "shell-viewer", name: "Shell viewer", role: "viewer", key: sha256(VIEWER_KEY) },
    ],
  }),
);

const proc = spawn("bun", ["run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket },
  stdio: "ignore",
});

const api = async (method, path, { key, query = "", body } = {}) => {
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}${path}${query}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
};

/** A socket to the server; resolves when open, rejects when the upgrade is refused. Frames collect in `text`. */
function openSocket(key) {
  return new Promise((resolve, reject) => {
    const protocols = ["kohlab"];
    if (key) protocols.push(`kohlab.key.${key}`);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, protocols);
    const sock = { ws, text: "" };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") sock.text += ev.data;
    };
    ws.onopen = () => resolve(sock);
    ws.onerror = () => reject(new Error("upgrade refused"));
  });
}

const sockets = [];
try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await sleep(250);
  }

  // A sh project, for the share-link check and the project count.
  const made = await api("POST", "/api/workspaces", { key: KEY, body: { newProject: "shellcheck", task: "shellcheck", location: projects, agent: "sh" } });
  if (made.status !== 200) throw new Error(`create project: ${made.status} ${JSON.stringify(made.body)}`);
  const projectId = made.body.id;

  // ── the owner opens it ──────────────────────────────────────────────────
  const open = await api("POST", "/api/server-shell", { key: KEY });
  check("owner POST /api/server-shell -> 200 with the id", open.status === 200 && open.body?.id === "server-shell", JSON.stringify(open));
  const again = await api("POST", "/api/server-shell", { key: KEY });
  check("a second open is the same workspace (200, same id)", again.status === 200 && again.body?.id === "server-shell", JSON.stringify(again));

  const list = await api("GET", "/api/workspaces", { key: KEY });
  const ids = Array.isArray(list.body) ? list.body.map((w) => w.id) : [];
  check("the shell is not in GET /api/workspaces", !ids.includes("server-shell") && ids.includes(projectId), JSON.stringify(ids));
  const health = await api("GET", "/api/health", { key: KEY });
  check("health counts projects only", health.body?.workspaces?.total === 1, JSON.stringify(health.body?.workspaces));

  // ── who is refused ──────────────────────────────────────────────────────
  const anon = await api("POST", "/api/server-shell");
  check("no credentials -> 401", anon.status === 401, String(anon.status));
  const member = await api("POST", "/api/server-shell", { key: MEMBER_KEY });
  check("a member -> 403", member.status === 403, String(member.status));
  const viewer = await api("POST", "/api/server-shell", { key: VIEWER_KEY });
  check("a viewer -> 403", viewer.status === 403, String(viewer.status));
  const share = await api("POST", `/api/workspaces/${projectId}/share`, { key: KEY });
  const token = share.body?.share;
  check("the project can be shared (for the share check)", share.status === 200 && typeof token === "string", JSON.stringify(share));
  const viaShare = await api("POST", "/api/server-shell", { query: `?share=${token}` });
  check("a share link -> 403", viaShare.status === 403, String(viaShare.status));
  const memberRoute = await api("POST", "/api/workspaces/server-shell/terminal", { key: MEMBER_KEY, body: { terminalId: "shell-9" } });
  check("a member on the terminal close route -> 403", memberRoute.status === 403, String(memberRoute.status));
  const viewerDiff = await api("GET", "/api/workspaces/server-shell/diff", { key: VIEWER_KEY });
  check("a viewer on a workspace route -> 403", viewerDiff.status === 403, String(viewerDiff.status));

  // ── the owner's other routes on it are refused ──────────────────────────
  const refusedRoutes = [
    ["GET", "/api/workspaces/server-shell"],
    ["GET", "/api/workspaces/server-shell/diff"],
    ["GET", "/api/workspaces/server-shell/files"],
    ["GET", "/api/workspaces/server-shell/log"],
    ["GET", "/api/workspaces/server-shell/terminal"],
    ["POST", "/api/workspaces/server-shell/start"],
    ["POST", "/api/workspaces/server-shell/stop"],
    ["POST", "/api/workspaces/server-shell/rename"],
    ["POST", "/api/workspaces/server-shell/share"],
    ["POST", "/api/workspaces/server-shell/chat"],
    ["GET", "/api/workspaces/server-shell/browser"],
    ["DELETE", "/api/workspaces/server-shell"],
    ["POST", "/api/workspaces/server-shell/delete"],
  ];
  for (const [method, path] of refusedRoutes) {
    const r = await api(method, path, { key: KEY, body: method === "POST" ? {} : undefined });
    check(`owner ${method} ${path} -> 403`, r.status === 403, String(r.status));
  }
  const still = await api("POST", "/api/server-shell", { key: KEY });
  check("the refused DELETE and delete left the shell in place", still.status === 200 && still.body?.id === "server-shell", JSON.stringify(still));

  const closeOwn = await api("POST", "/api/workspaces/server-shell/terminal", { key: KEY, body: { terminalId: "shell-9" } });
  check("owner closes a terminal of it (allowed route) -> 200", closeOwn.status === 200 && closeOwn.body?.ok === true, JSON.stringify(closeOwn));

  // ── sockets ─────────────────────────────────────────────────────────────
  const anonSocket = await openSocket(null).then(
    () => "opened",
    () => "refused",
  );
  check("an anonymous socket cannot open", anonSocket === "refused", anonSocket);

  const memberSock = await openSocket(MEMBER_KEY);
  sockets.push(memberSock.ws);
  memberSock.ws.send(JSON.stringify({ type: "attach", id: "server-shell", terminalId: "main" }));
  const memberRefused = await waitFor(() => memberSock.text.includes('"type":"error"') && memberSock.text.includes("forbidden"), 8000);
  check("a member cannot attach to it over the socket", memberRefused, memberSock.text.slice(0, 200));

  const owner = await openSocket(KEY);
  sockets.push(owner.ws);
  owner.ws.send(JSON.stringify({ type: "attach", id: "server-shell", terminalId: "main" }));
  const attached = await waitFor(() => owner.text.includes("\x1b[2J"), 15000);
  check("owner attaches to the shell's main terminal", attached);
  const home = realpathSync(homedir());
  const uid = String(process.getuid());
  // The typed line shows "%s", not the values: only the shell's own output can contain PWD=<home> UID=<uid>.
  owner.ws.send("echo $((6*7)); printf 'PWD=%s UID=%s\\n' \"$(pwd -P)\" \"$(id -u)\"\r");
  await waitFor(() => /^42\r?$/m.test(owner.text) && owner.text.includes(`PWD=${home} UID=${uid}`), 15000);
  check("the shell runs commands (6*7 -> 42)", /^42\r?$/m.test(owner.text), owner.text.slice(-300));
  check(`it runs as the server user in the home directory (${home}, uid ${uid})`, owner.text.includes(`PWD=${home} UID=${uid}`), owner.text.slice(-300));

  // The real attack shape. A session id is works-<id>-<terminalId>: a project whose id is "server" with terminalId
  // "shell-main" would name works-server-shell-main, the server terminal's own session. Type a marker first.
  owner.ws.send("echo MARK$((3*5))\r");
  check("a marker is typed in the server shell before the attempts", await waitFor(() => /^MARK15\r?$/m.test(owner.text), 10000), owner.text.slice(-200));
  const srv = await api("POST", "/api/workspaces", { key: KEY, body: { newProject: "server", task: "server", location: projects, agent: "sh" } });
  check("an ordinary project with the id server exists", srv.status === 200 && srv.body?.id === "server", JSON.stringify(srv.body));
  const longId = "x".repeat(5000);
  for (const [who, key] of [["owner", KEY], ["member", MEMBER_KEY]]) {
    for (const terminalId of ["shell-main", "shell-shell-1", "main/../x", longId]) {
      const sock = await openSocket(key);
      sockets.push(sock.ws);
      sock.ws.send(JSON.stringify({ type: "attach", id: "server", terminalId }));
      sock.ws.send(JSON.stringify({ type: "resize", id: "server", terminalId, cols: 50, rows: 10 }));
      const refused = await waitFor(() => sock.text.includes('"type":"error"'), 8000);
      await sleep(500);
      check(`${who}: attach/resize server with terminalId ${terminalId.slice(0, 14)} is refused, no shell output`, refused && !sock.text.includes("MARK15") && !sock.text.includes("\x1b["), sock.text.slice(0, 200));
    }
  }
  // The server shell is intact: a fresh owner attach replays the marker, and the session still runs commands.
  const replay = await openSocket(KEY);
  sockets.push(replay.ws);
  replay.ws.send(JSON.stringify({ type: "attach", id: "server-shell", terminalId: "main" }));
  check("after the attempts the server shell still replays its marker (MARK15)", await waitFor(() => replay.text.includes("MARK15"), 10000), replay.text.slice(-200));
  // Stopping and deleting the project "server" must not close the server terminal's session (works-server-shell-main).
  const stopped = await api("POST", "/api/workspaces/server/stop", { key: KEY });
  const deleted = await api("POST", "/api/workspaces/server/delete", { key: KEY });
  check("the server project stops and deletes (200)", stopped.status === 200 && deleted.status === 200, `${stopped.status} ${deleted.status}`);
  owner.ws.send("echo STILL$((2*3))\r");
  check("after stop and delete of project server, the server shell is alive (STILL6)", await waitFor(() => /^STILL6\r?$/m.test(owner.text), 10000), owner.text.slice(-200));

  // ── audit ───────────────────────────────────────────────────────────────
  const lines = existsSync(audit) ? readFileSync(audit, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  check("the open is audited (server.shell.open)", lines.some((l) => l.action === "server.shell.open" && l.id === "server-shell" && l.user === "legacy"), lines.map((l) => l.action).join(","));
} catch (e) {
  check("the check ran", false, e instanceof Error ? e.message : String(e));
} finally {
  for (const ws of sockets) ws.close();
  proc.kill("SIGKILL");
  killDaemonOn(socket);
  await sleep(300);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall server terminal checks passed");
process.exit(failures ? 1 : 0);
