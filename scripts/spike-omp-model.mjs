#!/usr/bin/env node
/**
 * Spike S5 (v2.6): does the model id the hub shows for omp (`omp models --json` selector) equal what `omp acp` offers
 * in session/new configOptions[model]? And does session/set_config_option stick for a first, middle and last value?
 * No message is sent, so no model is called.
 *
 *   node scripts/spike-omp-model.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const sel = (JSON.parse(spawnSync("omp", ["models", "--json"], { encoding: "utf8", maxBuffer: 20e6 }).stdout).models ?? []).map((m) => m.selector ?? `${m.provider}/${m.id}`);
const cwd = mkdtempSync(join(tmpdir(), "kohlab-s5-"));
const c = spawn("omp", ["acp"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
let seq = 0; const waits = new Map();
createInterface({ input: c.stdout }).on("line", (l) => { let m; try { m = JSON.parse(l); } catch { return; } if (m.id !== undefined && waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } });
const rpc = (method, params) => new Promise((res) => { const id = ++seq; waits.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => res({ timeout: true }), 60_000); });
await rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
const opened = (await rpc("session/new", { cwd, mcpServers: [] })).result;
const opt = (opened?.configOptions ?? []).find((o) => o.id === "model");
const offered = (opt?.options ?? []).map((o) => o.value);
console.log("hub selectors:", sel.length, "e.g.", sel.slice(0, 3));
console.log("acp offers:", offered.length, "e.g.", offered.slice(0, 3), "current:", opt?.currentValue);
console.log("every offered value is a selector:", offered.every((v) => sel.includes(v)), "| every selector offered:", sel.every((v) => offered.includes(v)));
console.log("offered but not a selector:", offered.filter((v) => !sel.includes(v)).slice(0, 5));
for (const v of [offered[0], offered[Math.floor(offered.length / 2)], offered.at(-1), "no-such/model"]) {
  const r = await rpc("session/set_config_option", { sessionId: opened.sessionId, configId: "model", value: v });
  const cur = (r.result?.configOptions ?? []).find((o) => o.id === "model")?.currentValue;
  console.log(`set ${v} -> ${r.error ? "ERROR " + JSON.stringify(r.error).slice(0, 120) : "ok"} currentValue=${cur}`);
}
c.kill("SIGKILL"); rmSync(cwd, { recursive: true, force: true }); process.exit(0);
