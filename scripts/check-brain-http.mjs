#!/usr/bin/env node
/**
 * The project brain over HTTP and MCP, through the real server on its own port, state and socket. The `claude` on PATH is
 * a fake: it speaks stream-json and, when a message starts with "TOOLS [", runs those calls against the chat's brain MCP server
 * (brain-mcp.cjs, started from the workspace's own kohlab-mcp.json) the way Claude would. No real Claude, no network, no model.
 *
 *  - access: no key 401; a share link 403 and no brain token in the share listing; another member 403; a viewer 403 (read and write)
 *  - the graph, notes, links, backlinks, search, names sanitised, 413 for big bodies, 400 for a bad type, the export as a gzip tar
 *  - a terminal project has no brain (400)
 *  - a turn's recall and remember go through the tool endpoint; the done event lists the recalled notes; the summary reaches Claude at start
 *    and a brain change does not restart it
 *  - Keep (commit) leaves a Version and File notes; Undo (discard) leaves the vault byte-identical
 *  - the tool endpoint: no token, a wrong token, another workspace's token and an unknown id all get the same 404; 60 calls per 10 minutes, then 429
 *  - brain-mcp.cjs over stdio: initialize, tools/list, tools/call remember and recall; a dead server gives isError without the token or URL
 *
 * Run:  node scripts/check-brain-http.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killDaemonOn } from "./kill-daemon.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const KEY = "brain-check-key";
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
const enc = encodeURIComponent;
const jsonLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
/** Every file in a folder with its bytes, for "unchanged" checks. */
const snapshotDir = (dir) => (existsSync(dir) ? readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]) : []);

// The fake claude. It runs as a separate process, so it is written as a string-able function and started with node.
function fakeClaude() {
  const fs = require("node:fs");
  const path = require("node:path");
  const cp = require("node:child_process");
  const dir = path.dirname(process.argv[1]);
  if (!process.argv.includes("--input-format")) return;
  const args = process.argv.slice(2);
  fs.appendFileSync(path.join(dir, "spawns.log"), JSON.stringify({ pid: process.pid, args }) + "\n");
  fs.appendFileSync(path.join(dir, "stream.pids"), `${process.pid}\n`);
  const sid = `fake-${process.pid}`;
  const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  // The JSON array that starts the text (anything after it is ignored).
  const firstJsonArray = (t) => {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(t.slice(0, i + 1)); } catch { return []; }
        }
      }
    }
    return [];
  };
  // Runs the calls against the brain server named in the --mcp-config file, one server per turn, and returns the results.
  const callTools = (calls) =>
    new Promise((resolve) => {
      const i = args.indexOf("--mcp-config");
      const cfg = i >= 0 ? JSON.parse(fs.readFileSync(args[i + 1], "utf8")) : {};
      const entry = cfg.mcpServers?.brain;
      if (!entry) return resolve([{ error: "no brain server configured" }]);
      const child = cp.spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, stdio: ["pipe", "pipe", "ignore"] });
      let buf = "";
      let seq = 0;
      const waiting = new Map();
      child.stdout.on("data", (d) => {
        buf += d;
        let j;
        while ((j = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, j);
          buf = buf.slice(j + 1);
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const r = waiting.get(msg.id);
          if (r) {
            waiting.delete(msg.id);
            r(msg.result ?? msg.error);
          }
        }
      });
      const rpc = (method, params) =>
        new Promise((ok) => {
          const id = ++seq;
          waiting.set(id, ok);
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      (async () => {
        const results = [];
        await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
        results.push({ tools: ((await rpc("tools/list", {})) ?? {}).tools?.map((t) => t.name) });
        for (const c of calls) results.push(await rpc("tools/call", c));
        child.kill("SIGKILL");
        resolve(results);
      })();
    });
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
        if (sub === "get_context_usage") reply({ totalTokens: 2000, maxTokens: 200000 });
        else if (sub === "get_usage") reply({ rate_limits_available: false });
        else reply({ commands: [], models: [{ value: "default", displayName: "Default" }] });
      } else if (m.type === "user") {
        const content = m.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
        out({ type: "system", subtype: "init", session_id: sid, model: "haiku", permissionMode: "default" });
        fs.appendFileSync(path.join(dir, "msgs.log"), JSON.stringify({ text }) + "\n");
        const at = text.indexOf("TOOLS [");
        const work = at >= 0 ? firstJsonArray(text.slice(at + 6)) : [];
        callTools(work).then((results) => {
          fs.appendFileSync(path.join(dir, "tools.log"), JSON.stringify(results) + "\n");
          out({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
          out({ type: "result", subtype: "success", result: "ok", session_id: sid });
        });
      }
    }
  });
}

const tmp = mkdtempSync(join(tmpdir(), "kohlab-braincheck-"));
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

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
let server = null;
let serverLog = "";
const JSON_HEADERS = { "content-type": "application/json" };

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}${path.includes("?") ? "&" : "?"}key=${enc(KEY)}`, {
    method,
    headers: body ? JSON_HEADERS : undefined,
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
const brainPath = (id, sub = "") => `/api/workspaces/${id}/brain${sub}`;
/** Runs brain-mcp.cjs with `env`, sends the lines, and returns its answers once `ids` have come back (or the time runs out). */
function runMcp(env, lines, ids, ms = 15000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, "brain-mcp.cjs")], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    for (const l of lines) child.stdin.write(JSON.stringify(l) + "\n");
    const isAnswer = (x, id) => {
      try {
        return JSON.parse(x).id === id;
      } catch {
        return false;
      }
    };
    const got = () => ids.every((id) => out.split("\n").some((x) => x.trim() && isAnswer(x, id)));
    const timer = setInterval(() => got() && finish(), 50);
    const limit = setTimeout(finish, ms);
    let ended = false;
    function finish() {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      clearTimeout(limit);
      child.kill("SIGKILL");
      const parsed = out.split("\n").filter(Boolean).map((l) => {
        try {
          return { ok: true, msg: JSON.parse(l) };
        } catch {
          return { ok: false, line: l };
        }
      });
      resolve({ out, err, parsed, responses: parsed.filter((p) => p.ok).map((p) => p.msg) });
    }
  });
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

  const project = async (chat = true) => {
    const made = await req("POST", "/api/workspaces", { repo: repoDir, agent: "claude", chat, task: "Build the page" });
    if (typeof made.body?.id !== "string") throw new Error(`no project: ${made.text}`);
    return made.body.id;
  };
  const chatOf = async (id) => (await req("GET", `/api/workspaces/${id}/chat?after=0`)).body;
  const doneCount = async (id) => ((await chatOf(id)).events ?? []).filter((e) => e.kind === "done").length;
  const invite = async (id, role) => {
    const invited = await req("POST", "/api/invites", { id, name: id, role });
    const token = (invited.body?.path ?? "").split("#")[1];
    const joined = await fetch(`${BASE}/api/join`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token }) }).then((r) => r.json());
    return joined.key;
  };

  // ── Project A: the one most checks use ──
  const A = await project();
  check("the task's own turn ends first", await waitFor(async () => (await doneCount(A)) >= 1, 30000));
  const notesSaved = await req("POST", `/api/workspaces/${A}/notes`, { notes: "Use blue headings." });
  check("saving the project notes is ok", notesSaved.status === 200, notesSaved.text);
  const pn = await req("GET", brainPath(A, `/note?name=${enc("Project notes")}`));
  check("saving project notes creates the Project notes Fact", pn.status === 200 && pn.body.type === "Fact" && pn.body.body.includes("blue headings"), pn.text.slice(0, 200));

  // ── access ──
  const noKey = await fetch(`${BASE}${brainPath(A)}`);
  check("no key: 401", noKey.status === 401, `got ${noKey.status}`);
  const shared = await req("POST", `/api/workspaces/${A}/share`);
  const shareToken = shared.body?.share;
  // a share parameter is refused even alongside a key (a key-less share request is 401 like any other, checked by the gate)
  const shareGraph = await fetch(`${BASE}${brainPath(A)}?share=${shareToken}&key=${enc(KEY)}`);
  check("a share link cannot read the brain: 403", shareGraph.status === 403, `got ${shareGraph.status}`);
  const shareList = await fetch(`${BASE}/api/workspaces?share=${shareToken}`).then((r) => r.json());
  check("the share listing has no brain token", Array.isArray(shareList) && shareList.length === 1 && !("brainToken" in shareList[0]), JSON.stringify(shareList).slice(0, 200));
  const memberKey = await invite("brain-member", "member");
  const asMember = await fetch(`${BASE}${brainPath(A)}?key=${memberKey}`);
  check("another member cannot read this project's brain: 403", asMember.status === 403, `got ${asMember.status}`);
  const viewerKey = await invite("brain-viewer", "viewer");
  const asViewer = await fetch(`${BASE}${brainPath(A)}?key=${viewerKey}`);
  check("a viewer cannot read it: 403", asViewer.status === 403, `got ${asViewer.status}`);
  const viewerPut = await fetch(`${BASE}${brainPath(A, "/note")}?key=${viewerKey}`, { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ name: "Nope", body: "x" }) });
  check("a viewer cannot write: 403", viewerPut.status === 403, `got ${viewerPut.status}`);

  // ── graph, notes, links, search, names, limits, export (the owner) ──
  const g0 = await req("GET", brainPath(A));
  check("the graph has nodes, edges, the cap and the summary size", g0.status === 200 && Array.isArray(g0.body.nodes) && Array.isArray(g0.body.edges) && g0.body.cap === 400 && typeof g0.body.summary?.tokens === "number", g0.text.slice(0, 200));
  const put1 = await req("PUT", brainPath(A, "/note"), { name: "Use SQLite", type: "Decision", body: "Use SQLite for the store. See [[Db Choice]]." });
  check("PUT creates a note and returns it", put1.status === 200 && put1.body.name === "Use SQLite" && put1.body.type === "Decision", put1.text.slice(0, 200));
  const put2 = await req("PUT", brainPath(A, "/note"), { name: "Db Choice", body: "Picked after a short test." });
  check("a new note with no type is a Fact", put2.status === 200 && put2.body.type === "Fact", put2.text.slice(0, 200));
  const link = await req("GET", brainPath(A, `/note?name=${enc("Db Choice")}`));
  check("GET shows the backlink from Use SQLite", link.body.backlinks?.some((b) => b.name === "Use SQLite"), link.text.slice(0, 200));
  const hits = await req("GET", brainPath(A, `/search?q=${enc("sqlite")}`));
  check("search finds the note", hits.status === 200 && hits.body.hits?.some((h) => h.name === "Use SQLite"), hits.text.slice(0, 200));
  const traversal = await req("PUT", brainPath(A, "/note"), { name: "../../etc/passwd", body: "x" });
  check("a path-like name is sanitised to a flat name", traversal.status === 200 && traversal.body.name === "etc passwd", traversal.text.slice(0, 200));
  const slash = await req("PUT", brainPath(A, "/note"), { name: "a/b", body: "x" });
  check("a name with a slash is sanitised", slash.status === 200 && slash.body.name === "a b", slash.text.slice(0, 200));
  const badType = await req("PUT", brainPath(A, "/note"), { name: "Odd", type: "Nope", body: "x" });
  check("an unknown type is 400", badType.status === 400, `got ${badType.status}`);
  const huge = await req("PUT", brainPath(A, "/note"), { name: "Huge", body: "x".repeat(70 * 1024) });
  check("a 70 KB body is 413", huge.status === 413, `got ${huge.status}`);
  const long = await req("PUT", brainPath(A, "/note"), { name: "Long", body: "x".repeat(8001) });
  check("a body over 8000 characters is 413", long.status === 413, `got ${long.status}`);
  const delNote = await req("DELETE", brainPath(A, `/note?name=${enc("Db Choice")}`));
  check("DELETE removes the note", delNote.status === 200 && delNote.body.ok === true, delNote.text);
  const gone = await req("GET", brainPath(A, `/note?name=${enc("Db Choice")}`));
  check("a deleted note is 404", gone.status === 404, `got ${gone.status}`);
  for (const n of ["etc passwd", "a b"]) await req("DELETE", brainPath(A, `/note?name=${enc(n)}`));
  const ex = await fetch(`${BASE}${brainPath(A, "/export")}?key=${KEY}`);
  const tgz = join(tmp, "brain.tgz");
  const bytes = Buffer.from(await ex.arrayBuffer());
  writeFileSync(tgz, bytes);
  const listing = spawnSync("tar", ["-tzf", tgz], { encoding: "utf8" }).stdout ?? "";
  check("the export is a gzip tar of the vault", ex.status === 200 && bytes[0] === 0x1f && bytes[1] === 0x8b && listing.includes("brain/Use SQLite.md"), listing.slice(0, 200));

  // A terminal project has no brain
  const T = await project(false);
  const tBrain = await req("GET", brainPath(T));
  check("a terminal project has no brain: 400", tBrain.status === 400, `got ${tBrain.status}`);

  // ── a turn: recall and remember through the tool endpoint, the summary at start ──
  const turn = [
    { name: "recall", arguments: { query: "sqlite" } },
    { name: "remember", arguments: { type: "decision", title: "Ship the brain", body: "Decided in the check.", links: ["Use SQLite", "Ghost"] } },
  ];
  const sent = await req("POST", `/api/workspaces/${A}/chat`, { text: `TOOLS ${JSON.stringify(turn)}` });
  check("the turn is sent", sent.status === 200, sent.text.slice(0, 200));
  check("the turn ends", await waitFor(async () => (await doneCount(A)) >= 2, 30000));
  const runs = jsonLines(join(fakeDir, "tools.log"));

  // runs[0] is the task's own turn (sent at creation); runs[1] is the turn with the tool calls
  const first = runs[1] ?? [];
  check("the MCP server lists recall and remember", JSON.stringify(first[0]?.tools) === JSON.stringify(["recall", "remember"]), JSON.stringify(first[0] ?? runs));
  check("recall answers with the matching note", first[1]?.content?.[0]?.text?.includes("Use SQLite") && first[1]?.isError === false, JSON.stringify(first[1] ?? runs).slice(0, 300));
  check("remember saves it and reports the unresolved link", first[2]?.content?.[0]?.text?.includes("Saved") && first[2].content[0].text.includes("Ghost"), JSON.stringify(first[2] ?? runs).slice(0, 300));
  const doneEv = ((await chatOf(A)).events ?? []).filter((e) => e.kind === "done").at(-1);
  check("the done event lists the recalled notes", Array.isArray(doneEv?.recalled) && doneEv.recalled.includes("Use SQLite"), JSON.stringify(doneEv));
  const spawns = jsonLines(join(fakeDir, "spawns.log"));
  const sp = spawns.at(-1)?.args ?? [];
  check("Claude starts with the brain tools allowed and strict MCP", sp.join(" ").includes("mcp__brain__recall,mcp__brain__remember") && sp.includes("--strict-mcp-config"), JSON.stringify(sp).slice(0, 300));
  const spawnsAtTurn = spawns.length;
  await req("POST", `/api/workspaces/${A}/chat`, { text: "TOOLS []" });
  check("the next turn runs in the same Claude (a brain change does not restart it)", await waitFor(async () => (await doneCount(A)) >= 3, 30000) && jsonLines(join(fakeDir, "spawns.log")).length === spawnsAtTurn);
  // The summary is read at a start. Stop the chat, then send: the new Claude gets the notes and decisions as they are now.
  await req("POST", `/api/workspaces/${A}/stop`);
  await req("POST", `/api/workspaces/${A}/chat`, { text: "TOOLS []" });
  check("a new start gets the summary", await waitFor(async () => jsonLines(join(fakeDir, "spawns.log")).length > spawnsAtTurn, 30000));
  await waitFor(async () => (await doneCount(A)) >= 4, 30000);
  const restarted = jsonLines(join(fakeDir, "spawns.log")).at(-1)?.args ?? [];
  const sysAt = restarted.indexOf("--append-system-prompt");
  const sys = sysAt >= 0 ? restarted[sysAt + 1] : "";
  const brainPart = sys.slice(sys.indexOf("<project-brain>"));
  check("the summary reaches Claude at start, within 4000 characters", sys.includes("<project-brain>") && brainPart.length <= 4000 && brainPart.includes("Use SQLite") && brainPart.includes("Ship the brain"), `len=${brainPart.length}`);

  // ── Keep and Undo ──
  const tree = join(works, A, "tree");
  writeFileSync(join(tree, "new.txt"), "hello\n");
  const kept = await req("POST", `/api/workspaces/${A}/commit`, { message: "add new.txt" });
  check("Keep is ok", kept.status === 200, kept.text.slice(0, 200));
  const afterKeep = await req("GET", brainPath(A));
  const names = afterKeep.body.nodes.map((n) => n.name);
  check("Keep leaves a Version and a File note", names.some((n) => n.startsWith("Version ")) && names.includes("File new.txt"), names.join(", "));
  const vault = join(works, A, "brain");
  const beforeUndo = JSON.stringify(snapshotDir(vault));
  writeFileSync(join(tree, "unkept.txt"), "unsaved\n");
  await req("POST", `/api/workspaces/${A}/stop`);
  const undone = await req("POST", `/api/workspaces/${A}/discard`);
  check("Undo is ok", undone.status === 200, undone.text.slice(0, 200));
  check("Undo leaves the vault byte-identical", JSON.stringify(snapshotDir(vault)) === beforeUndo);

  // ── the tool endpoint: auth and limits ──
  const cfgA = JSON.parse(readFileSync(join(works, A, "kohlab-mcp.json"), "utf8"));
  const tokenA = cfgA.mcpServers.brain.env.KOHLAB_BRAIN_TOKEN;
  const callTool = (id, token, body) =>
    fetch(`${BASE}/api/brain-tool/${id}`, { method: "POST", headers: { ...JSON_HEADERS, ...(token ? { "x-kohlab-brain": token } : {}) }, body: JSON.stringify(body) });
  const recallBody = { tool: "recall", args: { query: "sqlite" } };
  const noTok = await callTool(A, null, recallBody);
  const noTokText = await noTok.text();
  const wrong = await callTool(A, "not-the-token", recallBody);
  const wrongText = await wrong.text();
  const unknown = await callTool("no-such-workspace", tokenA, recallBody);
  const unknownText = await unknown.text();
  check("no token, a wrong token and an unknown id all get the same 404", noTok.status === 404 && wrong.status === 404 && unknown.status === 404 && noTokText === wrongText && wrongText === unknownText, `${noTok.status} ${wrong.status} ${unknown.status}`);
  const B = await project();
  await waitFor(async () => (await doneCount(B)) >= 1, 30000);
  const bReady = await waitFor(async () => existsSync(join(works, B, "kohlab-mcp.json")), 20000);
  const tokenB = bReady ? JSON.parse(readFileSync(join(works, B, "kohlab-mcp.json"), "utf8")).mcpServers.brain.env.KOHLAB_BRAIN_TOKEN : "";
  const otherTok = await callTool(A, tokenB, recallBody);
  check("another workspace's token is refused with the same 404", bReady && otherTok.status === 404 && (await otherTok.text()) === unknownText, `status ${otherTok.status}`);
  const direct = await callTool(A, tokenA, recallBody);
  const directBody = await direct.json();
  check("the endpoint answers the right token with text", direct.status === 200 && typeof directBody.text === "string" && directBody.text.includes("Use SQLite"), JSON.stringify(directBody).slice(0, 200));
  const ownerList = await req("GET", "/api/workspaces");
  check("the owner's listing has no brain or hook token", ownerList.status === 200 && !ownerList.text.includes(tokenA) && ownerList.body.every((w) => !("brainToken" in w) && !("hookToken" in w)), ownerList.text.slice(0, 120));

  // ── brain-mcp.cjs over stdio ──
  // Two sessions, so the recall runs after the remember has been answered (the server handles calls as they come).
  const stdioEnv = { KOHLAB_BRAIN_URL: `${BASE}/api/brain-tool/${A}`, KOHLAB_BRAIN_TOKEN: tokenA };
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "check", version: "1" } } };
  const stdio1 = await runMcp(stdioEnv, [init, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: { type: "fact", title: "Via MCP", body: "saved over stdio" } } }, { jsonrpc: "2.0", id: 5, method: "nope" }], [1, 2, 3, 5]);
  const stdio2 = await runMcp(stdioEnv, [init, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "recall", arguments: { query: "stdio" } } }], [1, 4]);
  const stdio = { parsed: [...stdio1.parsed, ...stdio2.parsed], responses: [...stdio1.responses, ...stdio2.responses] };
  const byId = (id) => stdio.responses.find((r) => r.id === id);
  check("stdout carries only JSON-RPC lines", stdio.parsed.every((p) => p.ok), stdio.parsed.filter((p) => !p.ok).map((p) => p.line).join(" | ").slice(0, 200));
  check("initialize answers with the server's name and the client's protocol", byId(1)?.result?.serverInfo?.name === "kohlab-brain" && byId(1)?.result?.protocolVersion === "2025-03-26", JSON.stringify(byId(1)));
  check("tools/list has recall and remember", JSON.stringify(byId(2)?.result?.tools?.map((t) => t.name)) === JSON.stringify(["recall", "remember"]));
  check("tools/call remember saves over stdio", byId(3)?.result?.content?.[0]?.text?.includes("Saved") && byId(3).result.isError === false, JSON.stringify(byId(3) ?? null).slice(0, 200));
  check("tools/call recall reads it back", byId(4)?.result?.content?.[0]?.text?.includes("Via MCP"), JSON.stringify(byId(4) ?? null).slice(0, 200));
  check("an unknown method gets -32601", byId(5)?.error?.code === -32601, JSON.stringify(byId(5)));
  const deadPort = await freePort();
  const deadUrl = `http://127.0.0.1:${deadPort}/api/brain-tool/${A}`;
  const SECRET = "SECRET-TOKEN-XYZ-123";
  const dead = await runMcp({ KOHLAB_BRAIN_URL: deadUrl, KOHLAB_BRAIN_TOKEN: SECRET }, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: { query: "x" } } }], [1]);
  const deadRes = dead.responses.find((r) => r.id === 1)?.result;
  check("a dead server gives isError with a plain sentence", deadRes?.isError === true && deadRes.content?.[0]?.text === "Memory is not available right now.", JSON.stringify(deadRes));
  check("the token and the URL never appear in its output", !dead.out.includes(SECRET) && !dead.err.includes(SECRET) && !dead.out.includes(String(deadPort)), dead.out.slice(0, 200));

  // ── the rate limit, last, on a project of its own (so nothing else has used its calls) ──
  const C = await project();
  await waitFor(async () => (await doneCount(C)) >= 1, 30000);
  const tokenC = JSON.parse(readFileSync(join(works, C, "kohlab-mcp.json"), "utf8")).mcpServers.brain.env.KOHLAB_BRAIN_TOKEN;
  let ok = 0;
  let limited = false;
  for (let i = 0; i < 70 && !limited; i++) {
    const r = await callTool(C, tokenC, recallBody);
    if (r.status === 429) limited = true;
    else if (r.status === 200) ok++;
  }
  check("60 calls in ten minutes, then 429", ok === 60 && limited, `ok=${ok} limited=${limited}`);
  // last, so its own task turn cannot shift the fake's run log above
  const fresh = await project();
  const peek = await req("GET", brainPath(fresh) + "?peek=1");
  check("a peek counts the notes and never creates the vault", peek.status === 200 && peek.body.count === 0 && !existsSync(join(works, fresh, "brain")), `${peek.status} ${peek.text.slice(0, 120)}`);
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
  killDaemonOn(socket);
  await sleep(300); // killed fakes may still be closing files
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* a leftover temp folder is not a failure */
  }
}

console.log(failures ? `\n${failures} failed` : "\nall project brain HTTP and MCP checks passed");
process.exit(failures ? 1 : 0);
