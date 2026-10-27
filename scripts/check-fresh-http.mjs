#!/usr/bin/env node
/**
 * Continue fresh, through the real server. The `claude` on PATH is a fake that speaks stream-json,
 * reports how full its memory is (a number a test sets), and answers the handoff request with a
 * ```handoff block. No real Claude, no network, no model call.
 *
 *  - 86% full, idle: after the turn a handoff request is sent to the old session, then a NEW session starts
 *    (no --resume), its first message holds the note and the project's notes, the chat keeps its history,
 *    nothing is shown as a message from the person
 *  - 86% full with background work: it waits ("pending"), then goes when the work ends
 *  - the person's switch is off: nothing happens by itself; the manual way writes the note, takes an edited
 *    one back, and is refused (409) while the AI works
 *
 * Run:  node scripts/check-fresh-http.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY = "fresh-check-key";
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
  fs.appendFileSync(path.join(dir, "spawns.log"), JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\n");
  const sid = `fake-${process.pid}`;
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const percent = () => {
    try {
      return Number(fs.readFileSync(path.join(dir, "percent"), "utf8"));
    } catch {
      return 5;
    }
  };
  let listed = false;
  setInterval(() => {
    if (listed && fs.existsSync(path.join(dir, "finish"))) {
      fs.unlinkSync(path.join(dir, "finish"));
      listed = false;
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
        const reply = (response) => out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
        const sub = m.request.subtype;
        if (sub === "get_context_usage") reply({ totalTokens: percent() * 2000, maxTokens: 200000 });
        else if (sub === "get_usage") reply({ rate_limits_available: false });
        else reply({ commands: [], models: [{ value: "default", displayName: "Default" }] });
      } else if (m.type === "user") {
        const text = typeof m.message?.content === "string" ? m.message.content : "";
        fs.appendFileSync(path.join(dir, "msgs.log"), JSON.stringify({ pid: process.pid, text }) + "\n");
        out({ type: "system", subtype: "init", session_id: sid, model: "haiku", permissionMode: "default" });
        if (text.includes("stall")) continue; // a turn that never ends
        if (text.includes("write a handoff note")) {
          out({ type: "assistant", message: { content: [{ type: "text", text: "Here you go.\n```handoff\n## Goal\nBuild the page\n## Done\nThe header\n## In progress\nThe footer\n## Next steps\nAdd links\n```" }] } });
        } else {
          out({ type: "assistant", message: { content: [{ type: "text", text: "Done: " + text.slice(0, 30) }] } });
        }
        if (text.includes("background")) {
          listed = true;
          out({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "bg-1", task_type: "local_bash", description: "sleep 300" }] });
        }
        out({ type: "result", subtype: "success", result: "ok", session_id: sid });
      }
    }
  });
}

const tmp = mkdtempSync(join(tmpdir(), "kohlab-freshcheck-"));
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
const jsonLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const setPercent = (n) => writeFileSync(join(fakeDir, "percent"), String(n));

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server = null;
let serverLog = "";

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}`, {
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
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket, PATH: `${fakeDir}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
  const up = await waitFor(() => fetch(`${BASE}/api/auth/required`).then((r) => r.ok), 20000);
  if (!up) throw new Error(`throwaway server did not start:\n${serverLog.slice(-800)}`);

  const project = async (notes) => {
    const made = await req("POST", "/api/workspaces", { repo: repoDir, agent: "claude", chat: true });
    if (typeof made.body?.id !== "string") throw new Error(`no project: ${made.text}`);
    if (notes) await req("POST", `/api/workspaces/${made.body.id}/notes`, { notes });
    return made.body.id;
  };
  const chatOf = async (id) => (await req("GET", `/api/workspaces/${id}/chat?after=0`)).body;
  const control = (id, action, value) => req("POST", `/api/workspaces/${id}/chat/control`, { action, value });

  // ── A: 86% full and idle ──────────────────────────────────────────────────
  setPercent(86);
  const a = await project("Use blue headings.");
  const first = await req("POST", `/api/workspaces/${a}/chat`, { text: "build the page" });
  check("a message is sent", first.status === 200, first.text);
  check("a handoff request goes to the old session, then a first message to a new one", await waitFor(async () => jsonLines(join(fakeDir, "msgs.log")).length >= 3, 30000), JSON.stringify(jsonLines(join(fakeDir, "msgs.log")).map((m) => m.text.slice(0, 30))));
  setPercent(5); // the new session starts with plenty of room
  const msgs = jsonLines(join(fakeDir, "msgs.log"));
  const spawns = jsonLines(join(fakeDir, "spawns.log"));
  check("the second message asks for the handoff note", msgs[1]?.text.includes("write a handoff note") && msgs[1].text.includes("```handoff") && msgs[1].pid === msgs[0].pid);
  check("the third goes to a different process", msgs[2]?.pid !== msgs[0].pid, JSON.stringify(msgs.map((m) => m.pid)));
  check("the new process does not resume the old session", spawns.length >= 2 && spawns[1].args.includes("--resume") === false && !spawns[1].args.includes("fake-" + msgs[0].pid), JSON.stringify(spawns[1]?.args));
  check("its first message holds the note, the project's notes and the way on", /We are continuing in a fresh session/.test(msgs[2]?.text) && msgs[2].text.includes("## In progress\nThe footer") && msgs[2].text.includes("Project notes:\nUse blue headings.") && msgs[2].text.endsWith("Continue with the next step."), msgs[2]?.text);
  check("the notes also go into its system prompt", spawns[1]?.args.some((x) => x.includes("Use blue headings.")));

  check("the chat shows the handoff card and the fresh-memory note", await waitFor(async () => {
    const ev = (await chatOf(a)).events;
    return ev.some((e) => e.kind === "handoff" && e.text.includes("The footer")) && ev.some((e) => e.kind === "note" && e.text === "Continued with a fresh memory");
  }, 10000));
  const snap = await chatOf(a);
  const kinds = snap.events.map((e) => e.kind);
  check("the history is kept", snap.events.some((e) => e.kind === "user" && e.text === "build the page") && snap.events.some((e) => e.kind === "assistant" && e.text.startsWith("Done: build the page")));
  check("only the person's own message is a message from the person", snap.events.filter((e) => e.kind === "user").length === 1, kinds.join());
  check("the note was announced and the reply is not shown as a normal message", snap.events.some((e) => e.kind === "note" && e.text === "Writing a handoff note…") && !snap.events.some((e) => e.kind === "assistant" && e.text.includes("```handoff")), JSON.stringify(snap.events.map((e) => [e.kind, (e.text ?? "").slice(0, 30)])));
  check("the hidden request is not in the chat as text anywhere", !JSON.stringify(snap.events).includes("write a handoff note so a new session"));
  check("after the first message of the new session the chat is idle again", await waitFor(async () => (await chatOf(a)).busy === false, 15000));
  await sleep(2500);
  check("it happened once, not in a loop", jsonLines(join(fakeDir, "msgs.log")).filter((m) => m.text.includes("write a handoff note")).length === 1);
  check("the snapshot says the switch is on and nothing is waiting", (await chatOf(a)).fresh?.auto === true && (await chatOf(a)).freshPending === false);

  // ── B: 86% full with background work: it waits, then goes ─────────────────
  const before = jsonLines(join(fakeDir, "msgs.log")).length;
  setPercent(86);
  const b = await project();
  await req("POST", `/api/workspaces/${b}/chat`, { text: "start background work" });
  check("with background work it waits, and says so", await waitFor(async () => {
    const s = await chatOf(b);
    return s.busy === false && s.background === 1 && s.freshPending === true;
  }, 20000));
  await sleep(1000);
  check("nothing was sent to the AI while it waits", jsonLines(join(fakeDir, "msgs.log")).length === before + 1);
  setPercent(5);
  writeFileSync(join(fakeDir, "finish"), "");
  check("when the background work ends it asks for the note and starts fresh", await waitFor(async () => jsonLines(join(fakeDir, "msgs.log")).length >= before + 3, 30000));
  check("and it is no longer pending", await waitFor(async () => (await chatOf(b)).freshPending === false, 10000));

  // ── C: switched off, then the manual way ──────────────────────────────────
  setPercent(95);
  const c = await project("Be brief.");
  check("the switch can be turned off", (await control(c, "autoFresh", false)).status === 200 && (await chatOf(c)).fresh?.auto === false);
  check("the switch must be on or off", (await control(c, "autoFresh", "yes")).status === 400);
  const n0 = jsonLines(join(fakeDir, "msgs.log")).length;
  await req("POST", `/api/workspaces/${c}/chat`, { text: "hello there" });
  check("the turn ends", await waitFor(async () => (await chatOf(c)).events.some((e) => e.kind === "done"), 15000));
  await sleep(1500);
  check("switched off, nothing is done by itself", jsonLines(join(fakeDir, "msgs.log")).length === n0 + 1);
  setPercent(5);
  const draft = await control(c, "fresh", { draft: true });
  check("the manual way writes the note and gives it back, starting nothing", draft.status === 200 && /In progress\nThe footer/.test(draft.body?.note ?? "") && !(await chatOf(c)).events.some((e) => e.kind === "handoff"), draft.text);
  check("the draft turn is not shown as a message", !(await chatOf(c)).events.some((e) => e.kind === "assistant" && e.text.includes("```handoff")));
  const nBefore = jsonLines(join(fakeDir, "msgs.log")).filter((m) => m.text.includes("write a handoff note")).length;
  check("the empty note is refused", (await control(c, "fresh", { note: "  " })).status === 400);
  const edited = "## Goal\nA calmer page\n## In progress\nThe edited footer";
  const used = await control(c, "fresh", { note: edited });
  check("the edited note starts the fresh session", used.status === 200, used.text);
  const n1 = jsonLines(join(fakeDir, "msgs.log"));
  check("the new session is sent the edited note", await waitFor(async () => jsonLines(join(fakeDir, "msgs.log")).some((m) => m.text.includes("The edited footer") && m.text.includes("Project notes:\nBe brief.")), 15000), JSON.stringify(n1.map((m) => m.text.slice(0, 40))));
  const evC = (await chatOf(c)).events;
  check("confirming with a note writes no new note", jsonLines(join(fakeDir, "msgs.log")).filter((m) => m.text.includes("write a handoff note")).length === nBefore);
  check("the chat shows the edited note as its card", evC.some((e) => e.kind === "handoff" && e.text === edited));

  // a note with nothing in progress waits for the person
  const d = await project();
  setPercent(5);
  await req("POST", `/api/workspaces/${d}/chat`, { text: "hello again" });
  await waitFor(async () => (await chatOf(d)).events.some((e) => e.kind === "done"), 15000);
  const n2 = jsonLines(join(fakeDir, "msgs.log")).length;
  const idleNote = "## Goal\nBuild\n## Done\nEverything\n## In progress\nNone\n## Next steps\nNone";
  check("a note with no work left starts the session without sending anything", (await control(d, "fresh", { note: idleNote })).status === 200 && (await sleep(1500), jsonLines(join(fakeDir, "msgs.log")).length === n2));
  await req("POST", `/api/workspaces/${d}/chat`, { text: "what next" });
  check("it goes with the person's next message", await waitFor(async () => jsonLines(join(fakeDir, "msgs.log")).some((m) => m.text.includes("what next") && m.text.includes("## Done\nEverything")), 15000));

  // refused while the AI works
  const e = await project();
  await req("POST", `/api/workspaces/${e}/chat`, { text: "stall for a while" });
  check("busy", await waitFor(async () => (await chatOf(e)).busy === true, 10000));
  const busy = await control(e, "fresh", { draft: true });
  check("while the AI works the manual way is refused with a plain sentence", busy.status === 409 && /still working/.test(busy.body?.error ?? ""), busy.text);
  const busyApply = await control(e, "fresh", { note: "## In progress\nx" });
  check("starting from a note is refused too", busyApply.status === 409);
  check("it needs a project", (await control("nope", "fresh", {})).status >= 400);
} catch (err) {
  failures++;
  console.log(`FAIL  ${err.message}\n${serverLog.slice(-600)}`);
} finally {
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

console.log(failures ? `\n${failures} failed` : "\nall continue-fresh checks passed");
process.exit(failures ? 1 : 0);
