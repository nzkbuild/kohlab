#!/usr/bin/env bun
/**
 * The model of an ACP agent (omp): the one picked in the hub sticks, and one the agent will not take shows as a plain line with
 * the model it is really on. A fake `omp acp` that rejects unknown ids and echoes the real currentValue. No model is called.
 *
 * Run:  bun scripts/check-omp-model.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acpModels } from "../acp.ts";
import { jsonLines, makeCheck, startKit, waitFor } from "./ai-check-kit.mjs";

const { check, finish } = makeCheck();

// the reply shape omp sends (spike S5): configOptions[model].options[].value is the hub's selector
const MODELS = ["p/a", "p/b", "p/c", "p/sticky"];
const reply = { sessionId: "s", configOptions: [{ id: "model", currentValue: "p/a", options: MODELS.map((value) => ({ value, name: value.toUpperCase() })) }] };
check("acpModels reads the config option's values as they are", acpModels(reply).models.map((m) => m.value).join() === MODELS.join() && acpModels(reply).current === "p/a" && acpModels(reply).how === "config");

function fakeOmp() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  const MODELS = ["p/a", "p/b", "p/c", "p/sticky"];
  const argv = process.argv.slice(2);
  if (argv[0] === "--version") {
    console.log("omp 0.0.0");
    process.exit(0);
  }
  if (argv[0] === "models") {
    console.log(JSON.stringify({ models: MODELS.map((m) => ({ provider: m.split("/")[0], id: m.split("/")[1], selector: m, name: m })) }));
    process.exit(0);
  }
  if (argv[0] !== "acp") process.exit(1);
  let current = "p/a";
  const waiting = new Map();
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const options = () => [{ id: "model", currentValue: current, options: MODELS.map((value) => ({ value, name: value })) }];
  let buf = "";
  process.stdin.on("end", () => process.exit(0));
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
      if (m.id !== undefined && !m.method && waiting.has(m.id)) {
        fs.appendFileSync(path.join(dir, "perm.log"), JSON.stringify(m.result) + "\n");
        send({ jsonrpc: "2.0", id: waiting.get(m.id), result: { stopReason: "end_turn" } });
        waiting.delete(m.id);
        continue;
      }
      if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s-" + process.pid, configOptions: options() } });
      else if (m.method === "session/set_config_option") {
        fs.appendFileSync(path.join(dir, "set.log"), JSON.stringify({ configId: m.params.configId, value: m.params.value }) + "\n");
        if (m.params.configId !== "model" || !MODELS.includes(m.params.value)) send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "Internal error", data: { details: "Unknown ACP model: " + m.params.value } } });
        else {
          if (m.params.value !== "p/sticky") current = m.params.value; // p/sticky is accepted and not applied
          send({ jsonrpc: "2.0", id: m.id, result: { configOptions: options() } });
        }
      } else if (m.method === "session/prompt") {
        const text = m.params.prompt.map((p) => p.text).join("");
        fs.appendFileSync(path.join(dir, "prompts.log"), JSON.stringify({ model: current, text }) + "\n");
        const perm = /PERM (execute|edit) (.+)/.exec(text);
        if (perm) {
          const rid = 9000 + Math.floor(Math.random() * 999);
          waiting.set(rid, m.id);
          send({ jsonrpc: "2.0", id: rid, method: "session/request_permission", params: { sessionId: m.params.sessionId, toolCall: { toolCallId: "t", title: perm[2], kind: perm[1], rawInput: perm[1] === "execute" ? { command: perm[2] } : { path: perm[2] } }, options: [{ optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
          continue;
        }
        send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on " + current } } } });
        send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
      } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });
}
const bin = `#!/usr/bin/env node\n(${fakeOmp.toString()})();\n`;
const state = (k) => JSON.parse(readFileSync(join(k.works, "state.json"), "utf8")).workspaces;
const notes = async (k, id) => (await k.chat(id)).events.filter((e) => e.kind === "note").map((e) => e.text);

// ---- a model picked in the hub sticks ----
{
  const kit = await startKit({ bins: { omp: bin } });
  try {
    const id = (await kit.req("POST", "/api/workspaces", { repo: kit.repoDir, agent: "omp", chat: true })).body.id;
    await kit.send(id, "hello");
    await kit.idle(id);
    check("the first message runs on the agent's own model", jsonLines(join(kit.fakeDir, "prompts.log"))[0]?.model === "p/a");
    for (const pick of ["p/b", "p/c", "p/a"]) {
      const r = await kit.control(id, "model", pick);
      const chat = await kit.chat(id);
      check(`picking ${pick}: accepted, and the chip shows it`, r.status === 200 && chat.model === pick, `${r.status} ${chat.model}`);
    }
    await kit.control(id, "model", "p/b");
    check("the project keeps it, as the hub's own value", state(kit).find((w) => w.id === id).agentModel === "p/b" && (await kit.run(id)).ai.model.value === "p/b" && (await kit.run(id)).ai.model.source === "project");
    await kit.send(id, "again");
    await kit.idle(id);
    check("the next message runs on it", jsonLines(join(kit.fakeDir, "prompts.log")).at(-1).model === "p/b");
    const stuck = await kit.control(id, "model", "p/sticky");
    check("a model the agent accepts but does not take is refused (409), and the chip still shows the real one", stuck.status === 409 && (await kit.chat(id)).model === "p/b" && state(kit).find((w) => w.id === id).agentModel === "p/b", stuck.text);
    check("an unknown model is refused (400) while the list is known", (await kit.control(id, "model", "p/none")).status === 400);
    check("a model that was never asked of the agent: not asked", !jsonLines(join(kit.fakeDir, "set.log")).some((s) => s.value === "p/none"));
    // Send with… on an ACP agent, and back
    const one = await kit.send(id, "just this once", "p/c");
    await kit.idle(id);
    check("one message with another model: accepted", one.status === 200, one.text);
    const prompts = jsonLines(join(kit.fakeDir, "prompts.log"));
    check("it ran on that model", prompts.at(-1).text.includes("just this once") && prompts.at(-1).model === "p/c");
    check("the line for it says which model", (await kit.chat(id)).events.some((e) => e.kind === "user" && e.text === "just this once" && e.with === "p/c"));
    await kit.send(id, "and back");
    await kit.idle(id);
    check("the next one is back on the project's model; the project was never changed", jsonLines(join(kit.fakeDir, "prompts.log")).at(-1).model === "p/b" && state(kit).find((w) => w.id === id).agentModel === "p/b");
    const refusedOne = await kit.send(id, "never sent", "p/sticky");
    check("a model that cannot be used: 409, and nothing is sent", refusedOne.status === 409 && !jsonLines(join(kit.fakeDir, "prompts.log")).some((p) => p.text === "never sent") && (await kit.chat(id)).busy === false && !(await kit.chat(id)).events.some((e) => e.text === "never sent"), refusedOne.text);
    check("an unknown one-message model: 400", (await kit.send(id, "x", "p/none")).status === 400);
  } finally {
    await kit.stop();
  }
}

// ---- the permission mode decides for an ACP agent (Codex, Hermes, omp) ----
{
  const kit = await startKit({ bins: { omp: bin } });
  try {
    const id = (await kit.req("POST", "/api/workspaces", { repo: kit.repoDir, agent: "omp", chat: true })).body.id;
    const perms = () => jsonLines(join(kit.fakeDir, "perm.log"));
    const asks = async () => (await kit.chat(id)).events.filter((e) => e.kind === "ask");
    await kit.send(id, "PERM execute npm test");
    check("Asks first: a command waits for the person, and offers an Always allow", await waitFor(async () => (await asks()).length === 1, 10000) && (await asks())[0].always?.rule === "Bash(npm test:*)", JSON.stringify(await asks()));
    const a1 = (await asks())[0];
    await kit.req("POST", `/api/workspaces/${id}/chat/answer`, { requestId: a1.requestId, allow: true, always: true });
    await kit.idle(id);
    check("the answer reached the agent as its 'allow once'", perms().at(-1)?.outcome?.optionId === "yes");
    check("the rule is saved on the project", (await kit.run(id)).rules.some((r) => r.rule === "Bash(npm test:*)" && r.removable));
    await kit.send(id, "PERM execute npm test");
    await kit.idle(id);
    check("the same command is now allowed at once, nothing asked", (await asks()).length === 1 && perms().length === 2 && perms().at(-1).outcome.optionId === "yes");
    await kit.send(id, "PERM execute npm test && rm -rf x");
    check("a compound command is not covered by it", await waitFor(async () => (await asks()).length === 2, 10000) && !(await asks())[1].always);
    const a2 = (await asks())[1];
    await kit.req("POST", `/api/workspaces/${id}/chat/answer`, { requestId: a2.requestId, allow: false, always: true });
    await kit.idle(id);
    check("a refusal answers 'reject' and saves nothing", perms().at(-1).outcome.optionId === "no" && (await kit.run(id)).rules.length === 1);
    await kit.control(id, "mode", "acceptEdits");
    await kit.send(id, "PERM edit src/a.txt");
    await kit.idle(id);
    check("Edits allowed: a file change goes through", (await asks()).length === 2 && perms().at(-1).outcome.optionId === "yes");
    await kit.control(id, "mode", "auto");
    await kit.send(id, "PERM execute ls -la");
    await kit.idle(id);
    check("Auto: an ordinary command goes through", (await asks()).length === 2);
    await kit.send(id, "PERM execute sudo rm -rf /");
    check("Auto: a risky one still asks", await waitFor(async () => (await asks()).length === 3, 10000));
    // flipping to Full access answers what waits
    const before = perms().length;
    await kit.control(id, "mode", "full");
    check("Full access answers the waiting ask by itself", await waitFor(() => perms().length === before + 1 && perms().at(-1).outcome.optionId === "yes", 10000));
    await kit.idle(id);
    await kit.send(id, "PERM execute sudo rm -rf /");
    await kit.idle(id);
    check("and then asks nothing", (await asks()).length === 3);
    check("plan mode is Claude's only", (await kit.control(id, "mode", "plan")).status === 400);
  } finally {
    await kit.stop();
  }
}

// ---- a model the agent will not take at its start: a plain line, forgotten, the real model shown ----
for (const [bad, why] of [["p/gone", "refuses"], ["p/sticky", "stays elsewhere"]]) {
  const kit = await startKit({ bins: { omp: bin } });
  try {
    const id = (await kit.req("POST", "/api/workspaces", { repo: kit.repoDir, agent: "omp", chat: true })).body.id;
    const saved = await kit.control(id, "model", bad); // before the agent has ever listed its models, the choice is saved as it is
    check(`(${why}) before the list is known the choice is saved`, saved.status === 200 && state(kit).find((w) => w.id === id).agentModel === bad, saved.text);
    await kit.send(id, "hello");
    await kit.idle(id);
    check(`(${why}) the chat says so, in words, naming both models`, await waitFor(async () => (await notes(kit, id)).includes(`Omp could not switch to ${bad} and stays on p/a.`), 10000), JSON.stringify(await notes(kit, id)));
    check(`(${why}) the message still ran, on the real model`, jsonLines(join(kit.fakeDir, "prompts.log")).at(-1)?.model === "p/a");
    check(`(${why}) the saved choice is forgotten`, await waitFor(() => state(kit).find((w) => w.id === id).agentModel === undefined, 5000));
    check(`(${why}) the chip shows the real model`, (await kit.chat(id)).model === "p/a");
    check(`(${why}) it is said once, not on every start`, (await notes(kit, id)).filter((t) => t.includes("could not switch")).length === 1);
  } finally {
    await kit.stop();
  }
}

finish("omp model");
