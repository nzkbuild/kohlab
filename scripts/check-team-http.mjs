#!/usr/bin/env node
/**
 * Team mode over HTTP, through the real server on its own port, state and socket. The `claude` on PATH is a fake: it speaks
 * stream-json, and for each turn it runs the steps its role's behaviour file names. Its tool calls go through the real
 * team-mcp.cjs (started from the member's own kohlab-mcp.json) over JSON-RPC, so the server decides every answer.
 * No real Claude, no network, no model.
 *
 *  - access: members are hidden from the list; a member's own routes are 403 except chat, diff and log; the project chat is 409 while a team runs
 *  - tokens: a wrong token, another team and an unknown id all get the same 404; a builder calling create_task is refused
 *  - a team of three tasks, two builders: at most two agents work at once, the overlapping task waits for the first to merge
 *  - a builder's changes outside its paths are refused, then fixed; review approve merges into the team's branch with the files listed
 *  - a reviewer's changes send the builder back with the notes (rounds goes up); a new task starts a fresh session
 *  - the Lead is woken for the goal and once when everything is done (not per submit); each wake and each brief is capped
 *  - finish runs the Tester, then awaiting approval; landing into the project leaves the work as uncommitted changes, and Keep commits it
 *  - a project that moved on in the same file: landing is a plain conflict and the tree is left as it was
 *  - a builder over its token budget stops: state budget, a needs-you card; the team's routes answer what they should
 *  - kohlab-mcp.json has the browser only for the Tester; no spawn uses bypassPermissions
 *
 * Run:  node scripts/check-team-http.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonOn } from "./kill-daemon.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY = "team-check-key";
let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${String(detail).slice(0, 400)}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await Promise.resolve(fn()).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
}
const jsonLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

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

/**
 * The fake claude. Runs under node. For a turn it reads its role's behaviour file (behaviour-<role>.json): a map from the
 * kind of message (brief:T1, changes:T1, review:T1, continue:T1, test, lead, other) to a queue of attempts, each a list of
 * steps. A step is { write: [path, text] } | { rm: path } | { sleep: ms } | { mcp: tool, args } | { list: true } | { usage: {...} }.
 * Everything it does is logged in the fake's directory: spawns.log (its arguments), msgs-<role>.log (what it was sent),
 * mcp-<role>.log (what the team tools answered), list-<role>.log (the tool names it was offered).
 */
function fakeTeamClaude() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawn } = require("node:child_process");
  const dir = path.dirname(process.argv[1]);
  const argv = process.argv.slice(2);
  const cwd = process.cwd();
  const m = /-team-[a-f0-9]{12}-(lead|builder-\d+|reviewer|tester)\/tree$/.exec(cwd);
  const role = m ? m[1] : "other";
  if (!argv.includes("--input-format")) process.exit(0);
  const sid = `team-fake-${role}-${process.pid}`;
  const mcpFile = argv.includes("--mcp-config") ? argv[argv.indexOf("--mcp-config") + 1] : null;
  const modelArg = argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "default";
  const modeArg = argv.includes("--permission-mode") ? argv[argv.indexOf("--permission-mode") + 1] : "default";
  fs.appendFileSync(
    path.join(dir, "spawns.log"),
    JSON.stringify({ pid: process.pid, role, args: argv, cwd, resume: argv.includes("--resume") }) + "\n",
  );
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const logFile = (name) => path.join(dir, `${name}-${role}.log`);
  const append = (name, obj) => fs.appendFileSync(logFile(name), JSON.stringify(obj) + "\n");
  const behaviourFile = path.join(dir, `behaviour-${role}.json`);
  const readB = () => {
    try {
      return JSON.parse(fs.readFileSync(behaviourFile, "utf8"));
    } catch {
      return {};
    }
  };
  const writeB = (b) => fs.writeFileSync(behaviourFile, JSON.stringify(b));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mcpCfg = () => (mcpFile ? JSON.parse(fs.readFileSync(mcpFile, "utf8")).mcpServers?.team : null);
  /** One JSON-RPC session with the team MCP server: initialize, then one request (tools/list or tools/call). */
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const cfg = mcpCfg();
      if (!cfg) return resolve({ error: "no team tools" });
      const child = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "ignore"] });
      let buf = "";
      const done = (v) => {
        child.kill();
        resolve(v);
      };
      child.stdout.on("data", (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === 2) done(msg.result ?? msg);
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) + "\n");
      setTimeout(() => done({ error: "timeout" }), 15000);
    });
  let usage = { input_tokens: 100, output_tokens: 10 };
  const runSteps = async (steps) => {
    for (const s of steps) {
      if (s.write) {
        const [p, text] = s.write;
        fs.mkdirSync(path.dirname(path.join(cwd, p)), { recursive: true });
        fs.writeFileSync(path.join(cwd, p), text);
      } else if (s.rm) {
        fs.rmSync(path.join(cwd, s.rm), { force: true });
      } else if (s.sleep) {
        await sleep(s.sleep);
      } else if (s.mcp) {
        const r = await rpc("tools/call", { name: s.mcp, arguments: s.args ?? {} });
        append("mcp", { tool: s.mcp, text: r?.content?.[0]?.text ?? JSON.stringify(r), isError: !!r?.isError });
      } else if (s.list) {
        const r = await rpc("tools/list", {});
        append("list", { names: (r?.tools ?? []).map((t) => t.name) });
      } else if (s.usage) {
        usage = s.usage;
      }
    }
  };
  const keyOf = (text) => {
    let x;
    if ((x = /Your task (T\d+)/.exec(text))) return `brief:${x[1]}`;
    if ((x = /asked for changes to (T\d+)/.exec(text))) return `changes:${x[1]}`;
    if ((x = /Continue (T\d+) where/.exec(text))) return `continue:${x[1]}`;
    if ((x = /^Review (T\d+)/m.exec(text))) return `review:${x[1]}`;
    if (/Test the integrated work/.test(text)) return "test";
    if (/\[team\]/.test(text)) return "lead";
    return "other";
  };
  let buf = "";
  let busy = false;
  const handle = async (text) => {
    busy = true;
    append("msgs", { text });
    out({ type: "system", subtype: "init", session_id: sid, model: modelArg, permissionMode: modeArg });
    const key = keyOf(text);
    const b = readB();
    const queue = Array.isArray(b[key]) ? b[key] : [];
    const attempt = queue.length ? queue.shift() : (b.default ?? []);
    if (queue.length || (Array.isArray(b[key]) && b[key].length === 0 && queue !== undefined)) {
      b[key] = queue;
      writeB(b);
    }
    usage = { input_tokens: 100, output_tokens: 10 };
    await runSteps(attempt);
    out({ type: "result", subtype: "success", result: "ok", session_id: sid, usage });
    busy = false;
  };
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "control_request") {
        const response = msg.request?.subtype === "initialize" ? { commands: [], models: [] } : {};
        out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
      } else if (msg.type === "user") {
        const text = typeof msg.message?.content === "string" ? msg.message.content : "";
        if (busy) continue;
        handle(text).catch(() => {});
      }
    }
  });
}

/** A throwaway server with the fake claude on PATH and a repo to build in. */
async function startServer() {
  const tmp = mkdtempSync(join(tmpdir(), "kohlab-teamcheck-"));
  const fakeDir = join(tmp, "fake-bin");
  const works = join(tmp, "works");
  const socket = join(tmp, "pty.sock");
  const repoDir = join(tmp, "repo");
  mkdirSync(fakeDir);
  mkdirSync(repoDir);
  writeFileSync(join(fakeDir, "claude"), `#!/usr/bin/env node\n(${fakeTeamClaude.toString()})();\n`);
  chmodSync(join(fakeDir, "claude"), 0o755);
  const git = (args, cwd = repoDir) => spawnSync("git", ["-c", "user.name=check", "-c", "user.email=check@kohlab.local", ...args], { cwd, encoding: "utf8" });
  git(["init", "-q"]);
  writeFileSync(join(repoDir, "README.md"), "# check\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const server = spawn("bun", ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket, PATH: `${fakeDir}:${process.env.PATH}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  const up = await waitFor(() => fetch(`${base}/api/auth/required`).then((r) => r.ok), 20000);
  if (!up) {
    server.kill("SIGKILL");
    throw new Error(`throwaway server did not start:\n${log.slice(-800)}`);
  }
  const req = async (method, path, body, asKey = KEY, headers = {}) => {
    const res = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(asKey)}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json", ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, text };
  };
  return {
    tmp,
    fakeDir,
    works,
    repoDir,
    base,
    req,
    git,
    log: () => log,
    fake: (name) => join(fakeDir, name),
    behaviour: (role, b) => writeFileSync(join(fakeDir, `behaviour-${role}.json`), JSON.stringify(b)),
    async stop() {
      server.kill("SIGKILL");
      killDaemonOn(socket);
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** The team's own file (secrets included: this check reads the tokens the way a role's MCP config does). */
const teamFile = (works, id) => JSON.parse(readFileSync(join(works, "teams", id, "team.json"), "utf8"));
const teamOf = async (s, pid) => (await s.req("GET", `/api/workspaces/${pid}/team?after=0`)).body;

/** Behaviour for the Lead's scripted turns: the first wake creates three tasks and waits; the second finishes. */
const LEAD_A = {
  lead: [
    [
      { mcp: "create_task", args: { title: "Hello file", brief: "Create hello.txt with one line: hello.", area: ["hello.txt"] } },
      { mcp: "create_task", args: { title: "Second greeting", brief: "Rewrite hello.txt with the line: hello two.", area: ["hello.txt"] } },
      { mcp: "create_task", args: { title: "Bye file", brief: "Create bye.txt with one line: bye.", area: ["bye.txt"] } },
      { mcp: "wait", args: {} },
    ],
    [{ mcp: "finish", args: { summary: "Hello and bye are in place." } }],
  ],
};
/** Behaviour shared by the two builders: each task's own steps. */
const BUILDER_A = {
  "brief:T1": [[{ write: ["hello.txt", "hello\n"] }, { sleep: 800 }, { mcp: "submit_result", args: { task: "T1", summary: "Wrote hello.txt" } }]],
  "changes:T1": [[{ write: ["hello.txt", "Hello, world\n"] }, { mcp: "submit_result", args: { task: "T1", summary: "Fixed the greeting" } }]],
  "brief:T2": [[{ list: true }, { write: ["hello.txt", "hello two\n"] }, { mcp: "submit_result", args: { task: "T2", summary: "Second greeting" } }]],
  // a stray file outside the paths first: refused, then removed and submitted again
  "brief:T3": [
    [
      { write: ["other.txt", "stray\n"] },
      { write: ["bye.txt", "bye\n"] },
      { sleep: 1500 },
      { mcp: "submit_result", args: { task: "T3", summary: "Wrote bye.txt" } },
      { rm: "other.txt" },
      { mcp: "submit_result", args: { task: "T3", summary: "Wrote bye.txt" } },
    ],
  ],
};
const REVIEWER_A = {
  "review:T1": [[{ mcp: "submit_result", args: { task: "T1", verdict: "changes", notes: "Say hello, world." } }], [{ mcp: "submit_result", args: { task: "T1", verdict: "approve", notes: "" } }]],
  "review:T2": [[{ mcp: "submit_result", args: { task: "T2", verdict: "approve", notes: "" } }]],
  "review:T3": [[{ mcp: "submit_result", args: { task: "T3", verdict: "approve", notes: "" } }]],
};
const TESTER_A = { test: [[{ mcp: "submit_result", args: { verdict: "pass", summary: "Both files are there." } }]] };

async function main() {
  const s = await startServer();
  try {
    const pid = await (async () => {
      const made = await s.req("POST", "/api/workspaces", { repo: s.repoDir, agent: "claude", chat: true });
      return made.body?.id;
    })();
    check("a chat project can be created", typeof pid === "string");

    // ---- team A: the whole flow ----
    s.behaviour("lead", LEAD_A);
    s.behaviour("builder-1", BUILDER_A);
    s.behaviour("builder-2", BUILDER_A);
    s.behaviour("reviewer", REVIEWER_A);
    s.behaviour("tester", TESTER_A);
    const started = await s.req("POST", `/api/workspaces/${pid}/team`, {
      action: "start",
      goal: "Make hello.txt and bye.txt",
      maxAgents: 2,
      builders: 2,
      reviewer: true,
      tester: true,
      gate: "final",
    });
    check("a team starts", started.status === 200 && started.body?.team?.status === "running", started.text.slice(0, 300));
    const teamId = started.body?.team?.id;
    const tf0 = teamFile(s.works, teamId);
    check("the project's own chat is refused while the team runs (409)", (await s.req("POST", `/api/workspaces/${pid}/chat`, { text: "hi" })).status === 409);
    check("a second team on the same project is refused (409)", (await s.req("POST", `/api/workspaces/${pid}/team`, { action: "start", goal: "again" })).status === 409);
    check("the team's secrets stay out of its API view", !JSON.stringify(await teamOf(s, pid)).includes(tf0.secrets["builder-1"]));

    // watch the team: the most agents at once, the members, the awaiting-approval state
    let maxWorking = 0;
    let members = null;
    const deadline = Date.now() + 240_000;
    let view = null;
    while (Date.now() < deadline) {
      view = (await teamOf(s, pid)).team;
      if (view) {
        maxWorking = Math.max(maxWorking, view.roles.filter((r) => r.state === "working").length);
        if (!members && view.roles.every((r) => r.member)) members = view.roles;
        if (view.status === "awaiting_approval") break;
      }
      await sleep(250);
    }
    check("the team reaches awaiting approval", view?.status === "awaiting_approval", JSON.stringify(view?.needsYou ?? view?.status));
    check("at most two agents work at once (maxAgents 2)", maxWorking <= 2, `saw ${maxWorking}`);
    check("two agents did work at the same time", maxWorking === 2, `saw ${maxWorking}`);
    const byId = Object.fromEntries((view?.tasks ?? []).map((t) => [t.id, t]));
    check("all three tasks are done", ["T1", "T2", "T3"].every((id) => byId[id]?.status === "done"), JSON.stringify(view?.tasks?.map((t) => [t.id, t.status])));
    check("the reviewer's changes sent T1 back once (rounds 1)", (byId.T1?.rounds ?? 0) >= 1, JSON.stringify(byId.T1?.rounds));
    check("the approved work lists its files", (byId.T3?.files ?? []).includes("bye.txt"), JSON.stringify(byId.T3?.files));
    check("each approved task has its merge commit in the team's branch", ["T1", "T2", "T3"].every((id) => /^[0-9a-f]{40}$/.test(byId[id]?.merged ?? "")));
    check("the Lead was woken twice (the goal, then all done), not per submit", view?.wakes === 2, `wakes ${view?.wakes}`);
    check("the Tester passed the work", (view?.needsYou ?? []).some((n) => n.kind === "approve"));

    const memberOf = (role) => members?.find((r) => r.id === role)?.member;
    const builderMember = memberOf("builder-1");
    const leadMember = memberOf("lead");
    const testerMember = memberOf("tester");
    check("the team's agents are hidden from the project list", !(await s.req("GET", "/api/workspaces")).body.some((w) => w.team));
    check("a team agent's files route is 403", !!builderMember && (await s.req("GET", `/api/workspaces/${builderMember}/files`)).status === 403);
    check("a team agent cannot be stopped by hand (403)", !!leadMember && (await s.req("POST", `/api/workspaces/${leadMember}/stop`)).status === 403);
    check("a team agent's chat is readable (its own route)", !!leadMember && (await s.req("GET", `/api/workspaces/${leadMember}/chat?after=0`)).status === 200);

    const spawns = jsonLines(s.fake("spawns.log"));
    check("no spawn uses bypassPermissions", spawns.every((x) => !JSON.stringify(x.args).includes("bypass")));
    const b1 = spawns.filter((x) => x.role === "builder-1");
    check("a builder's new task starts a fresh session (no --resume after its first task)", b1.length >= 2 && !b1.at(-1).resume, JSON.stringify(b1.map((x) => x.resume)));
    const leadSpawns = spawns.filter((x) => x.role === "lead");
    check("the Lead resumes its session when it starts again", leadSpawns.length < 2 || leadSpawns.at(-1).resume);

    const msgs = (role) => jsonLines(s.fake(`msgs-${role}.log`));
    const leadMsgs = msgs("lead");
    check("each Lead wake is at most 1500 characters", leadMsgs.length > 0 && leadMsgs.every((m) => m.text.length <= 1500), String(Math.max(...leadMsgs.map((m) => m.text.length))));
    const firstBrief = msgs("builder-1").find((m) => m.text.includes("Your task"));
    check("a builder's first message is at most 3000 characters and carries no transcript", !!firstBrief && firstBrief.text.length <= 3000 && !/assistant|\buser:/i.test(firstBrief.text));
    const refusals = [...jsonLines(s.fake("mcp-builder-1.log")), ...jsonLines(s.fake("mcp-builder-2.log"))];
    check("a builder's change outside its paths is refused, and the refusal says so", refusals.some((r) => /outside your area/.test(r.text)), JSON.stringify(refusals).slice(0, 300));
    const offered = jsonLines(s.fake("list-builder-1.log")).at(-1)?.names ?? [];
    check("a builder is offered its tools only (no create_task, submit_result yes)", offered.includes("submit_result") && !offered.includes("create_task") && !offered.includes("finish"), offered.join(","));
    const bcfg = JSON.parse(readFileSync(join(s.works, builderMember, "kohlab-mcp.json"), "utf8")).mcpServers;
    check("a builder's MCP config has the team tools and no browser", !!bcfg.team && !bcfg.browser, Object.keys(bcfg).join(","));
    const tcfg = JSON.parse(readFileSync(join(s.works, testerMember, "kohlab-mcp.json"), "utf8")).mcpServers;
    check("only the Tester gets the browser", !!tcfg.browser && !!tcfg.team, Object.keys(tcfg).join(","));

    // tokens: a builder's token cannot create a task; wrong and foreign ones get the same 404
    const tokBuilder = tf0.secrets["builder-1"];
    const bad = await s.req("POST", `/api/team-tool/${teamId}`, { tool: "create_task", args: { title: "x", brief: "x", area: ["x"] } }, KEY, { "x-kohlab-team": tokBuilder });
    check("a builder calling create_task is refused", bad.status === 200 && bad.body.refused === true && /not available/.test(bad.body.text), bad.text.slice(0, 200));
    const wrong = await s.req("POST", `/api/team-tool/${teamId}`, { tool: "poll", args: {} }, KEY, { "x-kohlab-team": "nope" });
    const otherTeam = await s.req("POST", `/api/team-tool/${"0".repeat(12)}`, { tool: "poll", args: {} }, KEY, { "x-kohlab-team": tokBuilder });
    check("a wrong token and another team get the same 404", wrong.status === 404 && otherTeam.status === 404 && wrong.text === otherTeam.text);

    // landing: the project moves on in the same file, so landing is a plain conflict and the tree stays as it was
    const tree = join(s.works, pid, "tree");
    writeFileSync(join(tree, "hello.txt"), "the project's own\n");
    s.git(["add", "-A"], tree);
    s.git(["commit", "-qm", "project's own change"], tree);
    const conflict = await s.req("POST", `/api/workspaces/${pid}/team`, { action: "land" });
    check("landing into a project that changed the same file is a plain conflict", conflict.status === 200 && conflict.body.ok === false, conflict.text.slice(0, 200));
    check("the project tree is clean after the refused landing", s.git(["status", "--porcelain"], tree).stdout.trim() === "");
    s.git(["reset", "-q", "--hard", "HEAD~1"], tree);

    const land = await s.req("POST", `/api/workspaces/${pid}/team`, { action: "land" });
    check("landing brings the work in", land.status === 200 && land.body.ok === true, land.text.slice(0, 200));
    check("the work arrives as uncommitted changes", s.git(["status", "--porcelain"], tree).stdout.includes("bye.txt") && !s.git(["log", "--oneline", "-1"], tree).stdout.includes("hello"));
    const kept = await s.req("POST", `/api/workspaces/${pid}/commit`, { message: "Team work" });
    check("Keep commits the landed work", kept.status === 200 && s.git(["log", "--oneline", "-1"], tree).stdout.includes("Team work"), kept.text.slice(0, 200));
    check("the team is done after landing", (await teamOf(s, pid)).team?.status === "done");
    check("the project chat is open again after a team is done", (await s.req("GET", `/api/workspaces/${pid}/chat?after=0`)).status === 200);

    // ---- team B: a token budget ----
    s.behaviour("lead", { lead: [[{ mcp: "create_task", args: { title: "Budget file", brief: "Create budget.txt.", area: ["budget.txt"], builder: "builder-1" } }, { mcp: "wait", args: {} }]] });
    s.behaviour("builder-1", {
      "brief:T1": [[{ sleep: 1000 }, { write: ["budget.txt", "x\n"] }, { usage: { input_tokens: 8000, output_tokens: 0 } }, { mcp: "submit_result", args: { task: "T1", summary: "Wrote budget.txt" } }]],
    });
    const teamB = await s.req("POST", `/api/workspaces/${pid}/team`, { action: "start", goal: "Make budget.txt", maxAgents: 1, builders: 1, reviewer: false, tester: false, gate: "final" });
    check("a second team starts after the first is done", teamB.status === 200, teamB.text.slice(0, 200));
    const lim = await s.req("POST", `/api/workspaces/${pid}/team`, { action: "role", role: "builder-1", patch: { budget: { tokens: 5000 } } });
    check("the person sets a builder's token budget", lim.status === 200, lim.text.slice(0, 200));
    const budgeted = await waitFor(async () => {
      const v = (await teamOf(s, pid)).team;
      return v?.roles.find((r) => r.id === "builder-1")?.state === "budget";
    }, 60_000);
    const vb = (await teamOf(s, pid)).team;
    check("a builder over its token budget stops (state budget)", budgeted, JSON.stringify(vb?.roles.map((r) => [r.id, r.state])));
    check("the budget stop is a needs-you card for the person", (vb?.needsYou ?? []).some((n) => n.kind === "budget" && n.role === "builder-1"), JSON.stringify(vb?.needsYou));
    check("the goal and the builder count their tokens", (vb?.roles.find((r) => r.id === "builder-1")?.spent?.tokens ?? 0) >= 5000);

    const said = await s.req("POST", `/api/workspaces/${pid}/team`, { action: "say", role: "lead", text: "Keep it short." });
    check("say to a role is accepted", said.status === 200, said.text.slice(0, 200));
    check("reassign with unknown ids is 404", (await s.req("POST", `/api/workspaces/${pid}/team`, { action: "reassign", task: "T9", builder: "builder-1" })).status === 404);
    const stopped = await s.req("POST", `/api/workspaces/${pid}/team`, { action: "stop" });
    check("stop ends the team", stopped.status === 200 && (await teamOf(s, pid)).team?.status === "stopped", stopped.text.slice(0, 200));
    check("pause on a stopped team is 409", (await s.req("POST", `/api/workspaces/${pid}/team`, { action: "pause" })).status === 409);
    // No member user can reach a team over HTTP here, so the owner-only rule is asserted on the code that enforces it.
    const teamSrc = readFileSync(new URL("../team.ts", import.meta.url), "utf8");
    check("full access for a role is owner-only and audited in userAction", /p\.mode === "full" && !who\.owner\) throw new TeamError\(403/.test(teamSrc) && /ai\.fullaccess/.test(teamSrc));
    // Full access for a role is the owner's only (team.ts userAction). A member cannot reach a team here: the server refuses a
    // path-repo project for a member (403), and a member's own isolated project needs a git URL. Not covered by this check.
  } finally {
    await s.stop();
  }
  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
  console.log("\nall team HTTP checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
