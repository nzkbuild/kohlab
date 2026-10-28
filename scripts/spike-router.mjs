#!/usr/bin/env node
/**
 * Spike S4 (v2.6): Claude through a router, against a FAKE router (no paid call, no real key).
 * Questions: does Claude send the router's model id as is (--model and set_model), which background model ids does it
 * ask for (what ANTHROPIC_DEFAULT_*_MODEL must be set to), which header carries the key, and does Claude's Bash tool see
 * its environment (the canary token)?
 *
 *   node scripts/spike-router.mjs [port]
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const port = Number(process.argv[2] ?? 17995);
const CANARY = "sk-canary-spike-4f9a";
const seen = [];
const sse = (res, events) => { res.writeHead(200, { "content-type": "text/event-stream" }); for (const [e, d] of events) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`); res.end(); };
const msg = (model) => ({ id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } });
const router = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    let j = {}; try { j = JSON.parse(body); } catch {}
    const auth = req.headers.authorization ? "authorization:Bearer(len " + req.headers.authorization.length + ")" : "";
    const xkey = req.headers["x-api-key"] ? "x-api-key(len " + req.headers["x-api-key"].length + ")" : "";
    const lastUser = JSON.stringify(j.messages?.at(-1)?.content ?? "").slice(0, 400);
    seen.push({ url: req.url, model: j.model, stream: j.stream, headers: [auth, xkey].filter(Boolean).join(","), lastUser });
    if (req.url.startsWith("/v1/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "dsk/deepseek-flash" }, { id: "dsk/deepseek-v4-pro" }, { id: "cc/claude-sonnet-4" }] })); }
    if (!req.url.startsWith("/v1/messages")) { res.writeHead(404); return res.end("{}"); }
    const model = j.model ?? "x";
    const hasResult = JSON.stringify(j.messages ?? []).includes("tool_result");
    if (j.stream !== true) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ...msg(model), content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })); }
    const wantsEnv = JSON.stringify(j.messages ?? []).includes("ENVTEST") && !hasResult && (j.tools ?? []).some((t) => t.name === "Bash");
    if (wantsEnv) {
      return sse(res, [["message_start", { type: "message_start", message: msg(model) }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Bash", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "env | grep -E '^ANTHROPIC|^KOHLAB' | sed 's/=.*/=<set>/'; echo end", description: "check env" }) } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }],
        ["message_stop", { type: "message_stop" }]]);
    }
    sse(res, [["message_start", { type: "message_start", message: msg(model) }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }],
      ["message_stop", { type: "message_stop" }]]);
  });
}).listen(port, "127.0.0.1");

async function session(label, extraEnv, args, steps) {
  const base = mkdtempSync(join(tmpdir(), "kohlab-s4-"));
  const cfg = join(base, "cfg"), home = join(base, "home"), cwd = join(base, "cwd");
  for (const d of [cfg, home, cwd]) mkdirSync(d, { mode: 0o700 });
  seen.length = 0;
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: cfg, LANG: "C.UTF-8", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_AUTH_TOKEN: CANARY, ...extraEnv };
  const c = spawn("claude", ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--setting-sources", "project,local", "--strict-mcp-config", ...args], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const out = [];
  const waiting = new Map();
  createInterface({ input: c.stdout }).on("line", (l) => {
    let m; try { m = JSON.parse(l); } catch { return; }
    if (m.type === "control_response" && waiting.has(m.response?.request_id)) { waiting.get(m.response.request_id)(m.response); waiting.delete(m.response.request_id); }
    else if (m.type === "control_request" && m.request?.subtype === "can_use_tool") { out.push(`ASK ${m.request.tool_name}`); c.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: { behavior: "allow", updatedInput: m.request.input } } }) + "\n"); }
    else if (m.type === "system" && m.subtype === "init") out.push(`init model=${m.model}`);
    else if (m.type === "user") { for (const b of m.message?.content ?? []) if (b.type === "tool_result") out.push("TOOL_RESULT " + JSON.stringify(b.content).slice(0, 300)); }
    else if (m.type === "result") { out.push(`result ${m.subtype}`); waiting.get("__result")?.(m); }
  });
  const call = (id, request) => new Promise((res) => { waiting.set(id, res); c.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n"); setTimeout(() => res({ timeout: true }), 15000); });
  const turn = (text) => new Promise((res) => { waiting.set("__result", res); c.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n"); setTimeout(() => res({ timeout: true }), 30000); });
  console.log(`\n== ${label}`);
  try { await steps({ call, turn }); } catch (e) { console.log("error", e.message); }
  console.log(out.join("\n"));
  console.log("router saw:", JSON.stringify(seen.map(({ url, model, stream, headers }) => ({ url, model, stream, headers })), null, 0));
  c.kill("SIGKILL"); rmSync(base, { recursive: true, force: true });
}

await session("A: initialize only (env token, no login)", {}, [], async ({ call }) => {
  const r = await call("i1", { subtype: "initialize" });
  console.log("init subtype:", r.subtype, "account:", JSON.stringify(r.response?.account ?? null), "models:", JSON.stringify((r.response?.models ?? []).map((m) => m.value)));
});
await session("B: --model dsk/deepseek-flash, one turn, Bash env check", {}, ["--model", "dsk/deepseek-flash"], async ({ call, turn }) => {
  await call("i1", { subtype: "initialize" });
  const r = await turn("ENVTEST please run the command");
  console.log("turn:", r.subtype ?? r.timeout);
});
await session("C: set_model dsk/deepseek-v4-pro then turn, with ANTHROPIC_DEFAULT_*_MODEL set", { ANTHROPIC_DEFAULT_OPUS_MODEL: "dsk/deepseek-v4-pro", ANTHROPIC_DEFAULT_SONNET_MODEL: "dsk/deepseek-flash", ANTHROPIC_DEFAULT_HAIKU_MODEL: "dsk/deepseek-flash" }, [], async ({ call, turn }) => {
  await call("i1", { subtype: "initialize" });
  const r = await call("m1", { subtype: "set_model", model: "dsk/deepseek-v4-pro" });
  console.log("set_model:", JSON.stringify(r).slice(0, 200));
  const t = await turn("hello");
  console.log("turn:", t.subtype ?? t.timeout);
});
router.close();
process.exit(0);
