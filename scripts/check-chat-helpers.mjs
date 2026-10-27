#!/usr/bin/env node
/**
 * The helper tree and the run info of a chat, through the real server. The `claude` on PATH is a
 * fake that speaks the stream-json protocol: it starts a helper in the background (a Task call,
 * task_started, background_tasks_changed, task_progress, the helper's own line with its model), and
 * ends it only when told. No real Claude, no network, no model call.
 *
 *  - GET .../chat carries helperTree (and the older helpers list), canStop only while the CLI lists the task
 *  - stop_task works for that task and answers 400 for one that is not listed
 *  - a background helper outlives the turn's result; a finished one is gone at the next turn
 *  - GET .../chat/run: the notes and the system text, the tool names from the init line, no command line or secrets
 *  - share links and people outside the project are refused
 *
 * Run:  node scripts/check-chat-helpers.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY = "chat-helpers-check-key";
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
    await sleep(120);
  }
  return false;
}
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
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function fakeClaude() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  if (!process.argv.includes("--input-format")) return;
  fs.appendFileSync(path.join(dir, "stream.pids"), `${process.pid}\n`);
  fs.writeFileSync(path.join(dir, "args.json"), JSON.stringify(process.argv.slice(2)));
  const sid = `fake-${process.pid}`;
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const task = { task_id: "bg-t1", task_type: "local_agent", description: "Look around" };
  let listed = false;
  process.stdin.on("end", () => process.exit(0));
  // a test drops a file named finish: the helper ends by itself, as the CLI reports it
  setInterval(() => {
    if (listed && fs.existsSync(path.join(dir, "finish"))) {
      fs.unlinkSync(path.join(dir, "finish"));
      listed = false;
      out({ type: "system", subtype: "task_notification", task_id: "bg-t1", tool_use_id: "tu-1", status: "completed", summary: "Looked around", output_file: "/x" });
      out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    }
  }, 100);
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
        const reply = (response) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
        const sub = m.request.subtype;
        if (sub === "stop_task" && listed && m.request.task_id === "bg-t1") {
          listed = false;
          out({ type: "system", subtype: "task_updated", task_id: "bg-t1", patch: { status: "killed", end_time: Date.now() } });
          out({ type: "system", subtype: "background_tasks_changed", tasks: [] });
          reply({});
        } else if (sub === "get_context_usage") reply({ totalTokens: 1000, maxTokens: 200000 });
        else if (sub === "get_usage") reply({ rate_limits_available: false });
        else reply({ commands: [], models: [{ value: "default", displayName: "Default" }] });
      } else if (m.type === "user") {
        const text = typeof m.message?.content === "string" ? m.message.content : "";
        out({ type: "system", subtype: "init", session_id: sid, model: "haiku", permissionMode: "default", tools: ["Read", "Bash", "Task", "mcp__browser__agent_browser_open"], mcp_servers: [{ name: "browser", status: "connected", command: "SECRET-COMMAND" }] });
        if (text.includes("launch")) {
          listed = true;
          out({ type: "assistant", message: { model: "haiku", content: [{ type: "tool_use", id: "tu-1", name: "Task", input: { description: "Look around", subagent_type: "Explore", model: "haiku", run_in_background: true } }] } });
          out({ type: "system", subtype: "task_started" }); // fields missing: ignored
          out({ type: "system", subtype: "task_started", task_id: "bg-t1", tool_use_id: "tu-1", description: "Look around", subagent_type: "Explore", is_backgrounded: true });
          out({ type: "system", subtype: "background_tasks_changed", tasks: [task] });
          out({ type: "system", subtype: "task_progress", task_id: "bg-t1", tool_use_id: "tu-1", description: "Look around", usage: { total_tokens: 900, tool_uses: 2, duration_ms: 500 }, last_tool_name: "Read", summary: "Reading the page" });
          out({ type: "system", subtype: "task_progress", usage: "junk", summary: 5 });
          out({ type: "assistant", parent_tool_use_id: "tu-1", message: { model: "claude-haiku-4-5", content: [{ type: "tool_use", id: "h-1", name: "Grep", input: {} }] } });
          out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "Launched" }] } });
        }
        out({ type: "result", subtype: "success", result: "ok", session_id: sid, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 25 } });
      }
    }
  });
}

const tmp = mkdtempSync(join(tmpdir(), "kohlab-helpcheck-"));
const fakeDir = join(tmp, "fake-bin");
const works = join(tmp, "works");
const socket = join(tmp, "pty.sock");
const repoDir = join(tmp, "repo");
mkdirSync(fakeDir);
mkdirSync(repoDir);
writeFileSync(join(fakeDir, "claude"), `#!/usr/bin/env node\n(${fakeClaude.toString()})();\n`);
chmodSync(join(fakeDir, "claude"), 0o755);
for (const args of [["init", "-q"], ["config", "user.email", "check@kohlab.local"], ["config", "user.name", "check"]]) spawnSync("git", args, { cwd: repoDir });
writeFileSync(join(repoDir, "README.md"), "# check\n");
spawnSync("git", ["add", "-A"], { cwd: repoDir });
spawnSync("git", ["commit", "-qm", "init"], { cwd: repoDir });

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

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server = null;
let serverLog = "";
const made = [];

async function req(method, path, { key = KEY, body, query = "" } = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const auth = key ? `${sep}key=${encodeURIComponent(key)}` : "";
  const res = await fetch(`${BASE}${path}${auth}${query ? (path.includes("?") || auth ? "&" : "?") + query : ""}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, text };
}

try {
  server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket, KOHLAB_OS_USER_PREFIX: "kohph", PATH: `${fakeDir}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const up = await waitFor(() => fetch(`${BASE}/api/auth/required`).then((r) => r.ok), 20000);
  if (!up) throw new Error(`throwaway server did not start:\n${serverLog.slice(-800)}`);

  const created = await req("POST", "/api/workspaces", { body: { repo: repoDir, agent: "claude", chat: true } });
  const id = created.body?.id;
  check("a chat project is created", typeof id === "string", created.text.slice(0, 200));
  if (typeof id !== "string") throw new Error("no project");
  await req("POST", `/api/workspaces/${id}/notes`, { body: { notes: "Use blue headings." } });

  // before any process: the run info has the instructions, and no tools yet
  const early = await req("GET", `/api/workspaces/${id}/chat/run`);
  check("run info before a process: notes and the system text, no tools, not ready", early.status === 200 && early.body.instructions?.notes === "Use blue headings." && typeof early.body.instructions?.system === "string" && early.body.instructions.system.length > 50 && early.body.tools === null && early.body.ready === false, early.text.slice(0, 300));
  check("run info: the AI and its name", early.body.agent === "claude" && early.body.agentName === "Claude" && early.body.terminalProject === false && early.body.instructions.note === null);

  const sent = await req("POST", `/api/workspaces/${id}/chat`, { body: { text: "please launch a helper" } });
  check("a message is sent", sent.status === 200, sent.text);
  const chat = async () => (await req("GET", `/api/workspaces/${id}/chat?after=0`)).body;
  check("the turn ends", await waitFor(async () => (await chat()).events?.some((e) => e.kind === "done"), 20000));

  const snap = await chat();
  const node = snap.helperTree?.[0];
  check("the helper survives the turn's result (it runs in the background)", snap.helperTree?.length === 1 && node.status === "running" && node.background === true, JSON.stringify(snap.helperTree));
  check("helperTree has the documented shape", node && ["id", "taskId", "parentId", "label", "kind", "model", "status", "background", "startedAt", "endedAt", "tools", "tokens", "lastTool", "summary", "canStop"].every((k) => k in node), JSON.stringify(node));
  check("its fields: id, task, label, kind", node?.id === "tu-1" && node.taskId === "bg-t1" && node.label === "Look around" && node.kind === "Explore" && node.parentId === null);
  check("its model is the one on the helper's own line", node?.model === "claude-haiku-4-5");
  check("its counts and last step come from the progress lines", node?.tools === 2 && node.tokens === 900 && node.lastTool === "Grep" && node.summary === "Reading the page", JSON.stringify(node));
  check("it can be stopped while the CLI lists it", node?.canStop === true && snap.background === 1 && snap.tasks?.[0]?.id === "bg-t1");
  check("the older helpers list is still a list", Array.isArray(snap.helpers));
  const done = snap.events.filter((e) => e.kind === "done").at(-1);
  check("the done line carries the model and the tokens", done?.model === "haiku" && done.tokens?.in === 100 && done.tokens?.out === 25, JSON.stringify(done));

  // the run info after the process started
  const run = await req("GET", `/api/workspaces/${id}/chat/run`);
  check("run info: built-in tools by name, tool servers with a status", run.body.ready === true && run.body.tools?.builtin?.join() === "Read,Bash,Task" && JSON.stringify(run.body.tools.mcp) === '[{"name":"browser","status":"connected"}]', run.text.slice(0, 300));
  check("run info holds no command line, secret or environment", !run.text.includes("SECRET-COMMAND") && !run.text.includes("--mcp-config") && !run.text.includes(KEY) && !/"env"|"command"/.test(run.text));

  // stop
  const nope = await req("POST", `/api/workspaces/${id}/chat/control`, { body: { action: "stop_task", value: "not-listed" } });
  check("stopping a task that is not listed -> 400", nope.status === 400, `${nope.status} ${nope.text}`);
  const stopped = await req("POST", `/api/workspaces/${id}/chat/control`, { body: { action: "stop_task", value: "bg-t1" } });
  check("stopping the listed task -> 200", stopped.status === 200, `${stopped.status} ${stopped.text}`);
  check("then it is stopped and cannot be stopped again", await waitFor(async () => {
    const s = await chat();
    return s.helperTree?.[0]?.status === "stopped" && s.helperTree[0].canStop === false && s.background === 0;
  }, 8000));

  // a new turn drops the finished helper
  await req("POST", `/api/workspaces/${id}/chat`, { body: { text: "just talk" } });
  check("the next turn starts without the finished helper", await waitFor(async () => {
    const s = await chat();
    return s.events.filter((e) => e.kind === "done").length >= 2 && s.helperTree?.length === 0;
  }, 15000));

  // a helper that ends by itself
  await req("POST", `/api/workspaces/${id}/chat`, { body: { text: "launch again" } });
  check("a second helper runs", await waitFor(async () => (await chat()).helperTree?.[0]?.status === "running", 15000));
  await waitFor(async () => (await chat()).events.filter((e) => e.kind === "done").length >= 3, 10000);
  writeFileSync(join(fakeDir, "finish"), "");
  check("its notification ends it as done, with its summary", await waitFor(async () => {
    const n2 = (await chat()).helperTree?.[0];
    return n2?.status === "done" && n2.summary === "Looked around" && n2.canStop === false;
  }, 8000));

  // who may read the run info
  const shared = await req("POST", `/api/workspaces/${id}/share`);
  const viaShare = await req("GET", `/api/workspaces/${id}/chat/run`, { key: "", query: `share=${shared.body?.share}` });
  check("a share link -> 403", viaShare.status === 403, `${viaShare.status} ${viaShare.text}`);
  check("no credentials -> 401", (await req("GET", `/api/workspaces/${id}/chat/run`, { key: "" })).status === 401);
  const other = await req("POST", "/api/users", { body: { id: "helpcheck-other", name: "Other", role: "member" } });
  made.push("helpcheck-other"); // removed in finally even if the answer was odd
  const outsider = await req("GET", `/api/workspaces/${id}/chat/run`, { key: other.body?.key });
  check("a member outside the project -> 403", other.status === 200 && outsider.status === 403, `${other.status} ${outsider.status} ${outsider.text}`);
  check("only GET is allowed on it", (await req("POST", `/api/workspaces/${id}/chat/run`, { body: {} })).status === 405);
  check("an unknown project -> not a success", (await req("GET", "/api/workspaces/nope/chat/run")).status >= 400);
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}\n${serverLog.slice(-600)}`);
} finally {
  for (const id of made) await fetch(`${BASE}/api/users/${id}?key=${encodeURIComponent(KEY)}`, { method: "DELETE" }).catch(() => {});
  try {
    server?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  const pids = existsSync(join(fakeDir, "stream.pids")) ? readFileSync(join(fakeDir, "stream.pids"), "utf8").split("\n").filter(Boolean).map(Number) : [];
  for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  killDaemon(socket);
  await sleep(300); // killed fakes may still be closing files
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp folder is not a failure */
  }
}

console.log(failures ? `\n${failures} failed` : "\nall chat helper checks passed");
process.exit(failures ? 1 : 0);
