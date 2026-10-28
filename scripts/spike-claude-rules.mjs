#!/usr/bin/env node
/**
 * Spike S2 (v2.6): what Claude answers to list_permission_rules, whether --allowedTools shows in it, and whether an
 * allow with updatedPermissions [{type:"addRules", destination:"session"}] stops the next ask.
 *
 *   node scripts/spike-claude-rules.mjs probe     no model call: initialize + list_permission_rules only
 *   node scripts/spike-claude-rules.mjs turn      ONE short haiku turn (the owner authorised exactly one): asks to run `echo hi` twice
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "probe";
const dir = mkdtempSync(join(tmpdir(), "kohlab-s2-"));
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--setting-sources", "project,local", "--disable-slash-commands", "--strict-mcp-config", "--allowedTools", "Bash(npm test:*),Edit"];
if (mode === "turn") args.push("--model", "haiku", "--tools", "Bash");
const env = { PATH: process.env.PATH, HOME: homedir(), LANG: "C.UTF-8" };
const child = spawn("claude", args, { cwd: dir, env, stdio: ["pipe", "pipe", "ignore"] });
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const log = (...a) => console.log(...a);
let asks = 0;
const t0 = Date.now();
const waiting = new Map();
const call = (request_id, request) => new Promise((res) => { waiting.set(request_id, res); send({ type: "control_request", request_id, request }); });
createInterface({ input: child.stdout }).on("line", async (l) => {
  let m; try { m = JSON.parse(l); } catch { return; }
  if (m.type === "control_response" && waiting.has(m.response?.request_id)) { waiting.get(m.response.request_id)(m.response); waiting.delete(m.response.request_id); return; }
  if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
    asks++;
    log(`ASK #${asks} tool=${m.request.tool_name} input=${JSON.stringify(m.request.input)} suggestions=${JSON.stringify(m.request.permission_suggestions ?? null)}`);
    const response = { behavior: "allow", updatedInput: m.request.input };
    if (asks === 1) response.updatedPermissions = [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "echo hi:*" }], behavior: "allow", destination: "session" }];
    send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
    if (asks === 1) log("RULES after allow:", JSON.stringify((await call("r2", { subtype: "list_permission_rules" })).response ?? null));
    return;
  }
  if (m.type === "result") { log(`RESULT ${m.subtype} asks=${asks} after ${Date.now() - t0}ms`); await finish(); }
});
async function finish() {
  log("RULES at end:", JSON.stringify(await call("r3", { subtype: "list_permission_rules" })));
  child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); process.exit(0);
}
const init = await call("i1", { subtype: "initialize" });
log("init ok:", init.subtype);
log("RULES at start:", JSON.stringify(await call("r1", { subtype: "list_permission_rules" })));
if (mode === "probe") await finish();
else {
  send({ type: "user", message: { role: "user", content: "Use the Bash tool to run `echo hi`. When it has finished, use the Bash tool to run `echo hi` a second time in a separate call. Then say done." }, parent_tool_use_id: null });
  setTimeout(() => { log("timeout"); child.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); process.exit(2); }, 90_000);
}
