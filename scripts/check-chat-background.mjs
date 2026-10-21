#!/usr/bin/env node
/**
 * A terminal Claude project whose chat still runs background work must not
 * start its terminal: POST /start answers 400 until that work is done, then it
 * starts. Also: a stop while a turn runs keeps the transcript cursor (markSeen).
 *
 * The `claude` on PATH is a fake (written into a temp dir) that speaks just
 * enough of the stream-json protocol. No real Claude, no network.
 *
 * Run:  node scripts/check-chat-background.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7861;
const KEY = "background-check-key";
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn().catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The fake claude. Written to a file as `(fakeClaude)()`, so it is plain node with no imports from this repo. */
function fakeClaude() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  if (!process.argv.includes("--input-format")) {
    // the terminal's own Claude: it just stays open
    setInterval(() => {}, 1000);
    return;
  }
  fs.writeFileSync(path.join(dir, "stream.pid"), String(process.pid));
  const sid = `fake-${process.pid}`;
  let bg = false;
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  // a test drops a file named clear: the background work then ends, as the CLI reports it (an empty list)
  setInterval(() => {
    if (bg && fs.existsSync(path.join(dir, "clear"))) {
      fs.unlinkSync(path.join(dir, "clear"));
      bg = false;
      out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    }
  }, 100);
  process.stdin.on("end", () => process.exit(0));
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === "control_request") {
        out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { commands: [], models: [] } } });
      } else if (m.type === "user") {
        const text = typeof m.message?.content === "string" ? m.message.content : "";
        out({ type: "system", subtype: "init", session_id: sid, model: "haiku", permissionMode: "default" });
        if (text.includes("hang")) continue; // a turn that never ends
        bg = true;
        out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg-1", task_type: "local_bash", description: "sleep 300" }] });
        out({ type: "result", subtype: "success", result: "Started.", session_id: sid });
      }
    }
  });
}

/** Kill the detached PTY daemon this run spawned (matched on our own socket, like check-all). */
function killDaemon(socketPath) {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${socketPath}`)) continue;
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* gone, or not ours */
    }
  }
}

const tmp = mkdtempSync(join(tmpdir(), "kohlab-bgcheck-"));
const fakeDir = join(tmp, "fake-bin");
const works = join(tmp, "works");
const socket = join(tmp, "pty.sock");
const repoDir = join(tmp, "repo");
mkdirSync(fakeDir);
mkdirSync(repoDir);
writeFileSync(join(fakeDir, "claude"), `#!/usr/bin/env node\n(${fakeClaude.toString()})();\n`);
chmodSync(join(fakeDir, "claude"), 0o755);

for (const args of [["init", "-q"], ["config", "user.email", "check@kohlab.local"], ["config", "user.name", "check"]]) execFileSync("git", args, { cwd: repoDir });
writeFileSync(join(repoDir, "README.md"), "# check\n");
execFileSync("git", ["add", "-A"], { cwd: repoDir });
execFileSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

let server = null;
let serverLog = "";
let streamPid = null;

async function req(method, path, payload) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}${path}${sep}key=${encodeURIComponent(KEY)}`, {
    method,
    headers: payload ? { "content-type": "application/json" } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

try {
  server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      KOHLAB_KEY: KEY,
      WORKS_DIR: works,
      PTY_SOCKET: socket,
      PATH: `${fakeDir}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));

  const up = await waitFor(() => fetch(`${BASE}/api/auth/required`).then((r) => r.ok), 20000);
  if (!up) throw new Error(`throwaway server did not start:\n${serverLog.slice(-800)}`);

  const created = await req("POST", "/api/workspaces", { task: "background check", repo: repoDir, agent: "claude" });
  const id = created.body?.id;
  check("terminal Claude project created", created.status === 200 && typeof id === "string", `${created.status} ${JSON.stringify(created.body).slice(0, 160)}`);
  if (!id) throw new Error("no project");

  const sent = await req("POST", `/api/workspaces/${id}/chat`, { text: "Make the page" });
  check("a chat message is sent to the terminal project", sent.status === 200, JSON.stringify(sent.body));
  const eventsOf = async () => (await req("GET", `/api/workspaces/${id}/chat?after=0`)).body?.events ?? [];
  const turnDone = await waitFor(async () => (await eventsOf()).some((e) => e.kind === "done"), 30000);
  check("the turn ends (done line)", turnDone);

  const snap = await req("GET", `/api/workspaces/${id}/chat?after=0`);
  check("the chat reports one background task", snap.body?.background === 1 && snap.body?.busy === false, `background ${snap.body?.background}, busy ${snap.body?.busy}`);
  const listed = await req("GET", "/api/workspaces");
  check("the listing marks it backgroundWork", listed.body?.find((w) => w.id === id)?.backgroundWork === true);

  const blocked = await req("POST", `/api/workspaces/${id}/start`);
  check(
    "start is refused while background work runs",
    blocked.status === 400 && /still finishing work in the background/.test(blocked.body?.error ?? ""),
    `${blocked.status} ${JSON.stringify(blocked.body)}`,
  );
  streamPid = Number(readFileSync(join(fakeDir, "stream.pid"), "utf8"));
  check("the chat's claude process is still alive", alive(streamPid), `pid ${streamPid}`);

  writeFileSync(join(fakeDir, "clear"), "");
  let started = null;
  await waitFor(async () => {
    const r = await req("POST", `/api/workspaces/${id}/start`);
    if (r.status === 200) started = r;
    return r.status === 200;
  }, 15000);
  check("start succeeds once the background work is done", started?.status === 200, started ? JSON.stringify(started.body).slice(0, 160) : "never");
  const listedAfter = await req("GET", "/api/workspaces");
  check("the listing clears backgroundWork", listedAfter.body?.find((w) => w.id === id)?.backgroundWork === false);

  // A stop while a turn runs keeps the transcript cursor, so the cut-off turn is not imported again.
  const hang = await req("POST", `/api/workspaces/${id}/chat`, { text: "hang on" });
  check("a turn that never ends is sent", hang.status === 200, JSON.stringify(hang.body));
  const busy = await waitFor(async () => (await req("GET", `/api/workspaces/${id}/chat?after=0`)).body?.busy === true, 15000);
  check("the turn is busy", busy);
  const hangPid = Number(readFileSync(join(fakeDir, "stream.pid"), "utf8"));
  const stopped = await req("POST", `/api/workspaces/${id}/stop`);
  check("stop while busy succeeds", stopped.status === 200, JSON.stringify(stopped.body).slice(0, 160));
  const cursorFile = join(works, "chats", `${id}.cursor.json`);
  const cursor = existsSync(cursorFile) ? JSON.parse(readFileSync(cursorFile, "utf8")) : null;
  check("stop while busy writes the transcript cursor", cursor?.sid === `fake-${hangPid}`, JSON.stringify(cursor));
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}`);
} finally {
  try {
    server?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  if (streamPid && alive(streamPid)) {
    try {
      process.kill(streamPid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  killDaemon(socket);
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall background checks passed");
process.exit(failures ? 1 : 0);
