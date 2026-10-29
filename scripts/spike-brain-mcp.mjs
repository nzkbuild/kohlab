#!/usr/bin/env node
/**
 * Spike S1 (v2.7 Project Brain): does `claude -p` start the brain MCP server, complete its handshake, and call its tool
 * without a prompt-tool ask when --allowedTools lists mcp__brain__recall?
 *
 *   node scripts/spike-brain-mcp.mjs [path/to/server.cjs]
 *
 * Default server: brain-mcp.cjs next to this script. It runs with KOHLAB_BRAIN_URL pointing at a throwaway local HTTP
 * endpoint here, which answers "S1-OK <query>" and counts hits. ONE short haiku turn (the owner authorised exactly one).
 * Verdict: PASS only when all of Q1-Q3 hold. Manual only, never in check-all.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const serverPath = process.argv[2] ?? fileURLToPath(new URL("../brain-mcp.cjs", import.meta.url));
const token = randomBytes(24).toString("base64url");
const dir = mkdtempSync(join(tmpdir(), "kohlab-s1-"));
const log = (...a) => console.log(...a);

// Throwaway endpoint standing in for /api/brain-tool/:id. It only answers the right token.
const hits = [];
const endpoint = createServer((req, res) => {
  if (req.method !== "POST" || req.headers["x-kohlab-brain"] !== token) { res.writeHead(404).end(); return; }
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const m = JSON.parse(body || "{}");
    hits.push(m);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: `S1-OK ${m.args?.query ?? ""}` }));
  });
});
await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${endpoint.address().port}/api/brain-tool/s1`;

const mcpFile = join(dir, "mcp.json");
writeFileSync(mcpFile, JSON.stringify({ mcpServers: { brain: { command: process.execPath, args: [serverPath], env: { KOHLAB_BRAIN_URL: url, KOHLAB_BRAIN_TOKEN: token } } } }));

const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--setting-sources", "project,local", "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", mcpFile, "--allowedTools", "mcp__brain__recall", "--model", "haiku", "--max-budget-usd", "0.05"];
const env = { PATH: process.env.PATH, HOME: homedir(), LANG: "C.UTF-8" };
const child = spawn("claude", args, { cwd: dir, env, stdio: ["pipe", "pipe", "ignore"] });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const waiting = new Map();
const call = (request_id, request) => new Promise((res) => { waiting.set(request_id, res); send({ type: "control_request", request_id, request }); });

let brainInit = null;      // mcp_servers entry for "brain" from the system init event
let brainCalls = 0;        // tool_use blocks named mcp__brain__*
let toolResultOk = false;  // a tool_result carrying the endpoint's answer
let brainAsks = 0;         // can_use_tool requests for mcp__brain__* (must stay 0)
let asksAll = 0;
let resultSubtype = null;
const t0 = Date.now();

async function finish(code) {
  clearTimeout(timer);
  child.kill("SIGKILL");
  endpoint.close();
  rmSync(dir, { recursive: true, force: true });
  const q1 = brainInit?.status === "connected" && hits.length > 0;
  const q2 = brainCalls > 0 && toolResultOk;
  const q3 = brainAsks === 0;
  log("");
  log(`Q1 handshake: brain server connected in init and the endpoint was reached (init=${JSON.stringify(brainInit)} hits=${hits.length}) -> ${q1 ? "YES" : "NO"}`);
  log(`Q2 tools/call: mcp__brain__ tool_use seen (${brainCalls}) and its tool_result carried S1-OK -> ${q2 ? "YES" : "NO"}`);
  log(`Q3 no prompt-tool ask for brain tools (asks=${brainAsks}, all asks=${asksAll}) -> ${q3 ? "YES" : "NO"}`);
  log(`Turn result: ${resultSubtype ?? "none"} after ${Date.now() - t0}ms`);
  log(`S1 ${q1 && q2 && q3 && resultSubtype === "success" ? "PASS" : "FAIL"}`);
  process.exit(code ?? (q1 && q2 && q3 ? 0 : 1));
}

const timer = setTimeout(() => { log("timeout after 120s"); finish(2); }, 120_000);

createInterface({ input: child.stdout }).on("line", async (l) => {
  let m;
  try { m = JSON.parse(l); } catch { return; }
  if (m.type === "control_response" && waiting.has(m.response?.request_id)) { waiting.get(m.response.request_id)(m.response); waiting.delete(m.response.request_id); return; }
  if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
    asksAll++;
    if (String(m.request.tool_name).startsWith("mcp__brain__")) brainAsks++;
    log(`ASK tool=${m.request.tool_name}`);
    // Allow so the turn can finish; the ask itself is what Q3 counts.
    send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { behavior: "allow", updatedInput: m.request.input } } });
    return;
  }
  if (m.type === "system" && m.subtype === "init") {
    brainInit = (m.mcp_servers ?? []).find((s) => s.name === "brain") ?? null;
    log(`INIT mcp_servers=${JSON.stringify(m.mcp_servers ?? null)}`);
    return;
  }
  const blocks = m.message?.content;
  if (Array.isArray(blocks)) for (const b of blocks) {
    if (b.type === "tool_use" && String(b.name).startsWith("mcp__brain__")) { brainCalls++; log(`TOOL_USE ${b.name} ${JSON.stringify(b.input)}`); }
    if (b.type === "tool_result") {
      const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join("") : String(b.content ?? "");
      if (text.includes("S1-OK")) toolResultOk = true;
      log(`TOOL_RESULT error=${b.is_error ?? false} ${text.slice(0, 120)}`);
    }
  }
  if (m.type === "result") { resultSubtype = m.subtype; await finish(); }
});

const init = await call("i1", { subtype: "initialize" });
log("initialize:", init.subtype);
send({ type: "user", message: { role: "user", content: "Use the mcp__brain__recall tool once with query \"spike\". Then reply with the single word done." }, parent_tool_use_id: null });
