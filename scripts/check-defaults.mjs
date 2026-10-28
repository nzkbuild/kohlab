#!/usr/bin/env bun
/**
 * AI defaults for new projects (defaults.ts, PUT /api/ai/defaults): which setting comes from where, the order
 * project > default > built in, the AI and account pinned by the first message, terminal projects ignoring the defaults,
 * "reset", "default" stored as a choice of its own, and what the route refuses. A fake claude; no model is called.
 *
 * Run:  bun scripts/check-defaults.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchDefaults, resolveAi } from "../defaults.ts";
import { makeCheck, startKit, waitFor } from "./ai-check-kit.mjs";

const { check, finish } = makeCheck();
const ws = (over = {}) => ({ id: "p", repo: "", task: "t", agent: "claude", created: 0, started: null, stopped: null, chat: true, ...over });

// ---- resolveAi, pure ----
{
  const none = resolveAi(ws(), undefined);
  check("nothing set: built in", none.model.source === "builtin" && none.model.value === "default" && none.mode.value === "default" && none.autoFresh.value === true && none.effort.value === null && none.account.value === null && none.agent.source === "builtin");
  const d = { model: "sonnet", effort: "high", mode: "acceptEdits", autoFresh: false, agent: "omp", account: "w" };
  const r = resolveAi(ws(), d);
  check("a default shows as 'default'", r.model.value === "sonnet" && r.model.source === "default" && r.effort.source === "default" && r.mode.value === "acceptEdits" && r.autoFresh.value === false && r.autoFresh.source === "default");
  check("before the first message the AI and account follow the default", r.agent.value === "omp" && r.agent.source === "default" && r.account.value === "w" && r.account.source === "default");
  const own = resolveAi(ws({ model: "opus", effort: "low", permissionMode: "plan", autoFresh: true, agentPinned: true, agent: "claude", account: "z" }), d);
  check("the project's own value wins", own.model.value === "opus" && own.model.source === "project" && own.effort.value === "low" && own.mode.value === "plan" && own.mode.source === "project" && own.autoFresh.value === true && own.autoFresh.source === "project");
  check("once pinned, the AI and account are the project's", own.agent.value === "claude" && own.agent.source === "project" && own.account.value === "z" && own.account.source === "project");
  const pinnedNone = resolveAi(ws({ agentPinned: true }), d);
  check("pinned with no account: the AI's own login, and it is the project's", pinnedNone.account.value === null && pinnedNone.account.source === "project");
  check('"default" is a choice of its own', resolveAi(ws({ model: "default", agentPinned: true }), d).model.value === "default" && resolveAi(ws({ model: "default", agentPinned: true }), d).model.source === "project");
  check("an ACP project reads agentModel, not model", resolveAi(ws({ agent: "omp", agentPinned: true, agentModel: "x/y", model: "opus" }), d).model.value === "x/y");
  check("false is a value, not 'unset'", resolveAi(ws({ autoFresh: false }), { autoFresh: true }).autoFresh.value === false);
  const term = resolveAi(ws({ chat: undefined, permissionMode: "acceptEdits" }), d);
  check("a terminal project ignores the defaults", term.model.source === "builtin" && term.effort.value === null && term.autoFresh.value === true && term.agent.source === "builtin" && term.mode.value === "acceptEdits" && term.mode.source === "project");
  check("dontAsk reads as the default mode", resolveAi(ws({ permissionMode: "dontAsk" }), {}).mode.value === "default");
}

// ---- patchDefaults, pure ----
{
  const ok = { installed: (a) => a === "claude" || a === "omp", accountOk: (id) => id === "w", owner: true };
  const p = (cur, patch, o = ok) => patchDefaults(cur, patch, o);
  check("a good patch merges", JSON.stringify(p({ model: "a" }, { effort: "max" }).defaults) === '{"model":"a","effort":"max"}');
  check("null clears a key", JSON.stringify(p({ model: "a", effort: "low" }, { model: null }).defaults) === '{"effort":"low"}');
  check("not the owner -> 403", p({}, { model: "a" }, { ...ok, owner: false }).status === 403);
  const bad = [{ agent: "nope" }, { agent: 4 }, { account: "ghost" }, { model: "" }, { model: "a b" }, { model: "x".repeat(201) }, { effort: "ultra" }, { mode: "dontAsk" }, { mode: "root" }, { autoFresh: "yes" }, { colour: "red" }];
  check("every bad value -> 400 with a sentence", bad.every((b) => { const r = p({}, b); return r.status === 400 && /\.$/.test(r.error); }), JSON.stringify(bad.map((b) => p({}, b).status)));
  check("a body that is not an object -> 400", p({}, null).status === 400 && p({}, [1]).status === 400 && p({}, "x").status === 400);
  check("full is a mode that can be set (by the owner)", p({}, { mode: "full" }).defaults?.mode === "full");
  check("an account that does not fit the AI is dropped", p({ account: "w", agent: "claude" }, { agent: "omp" }, { ...ok, accountOk: (id, agent) => id === "w" && agent === "claude" }).defaults?.account === undefined);
}

// ---- through the server ----
const kit = await startKit();
try {
  const get = async () => (await kit.req("GET", "/api/ai/defaults")).body;
  const put = (b) => kit.req("PUT", "/api/ai/defaults", b);
  const projectNoAgent = async () => {
    const made = await kit.req("POST", "/api/workspaces", { repo: kit.repoDir, chat: true });
    return made.body.id;
  };
  const state = () => JSON.parse(readFileSync(join(kit.works, "state.json"), "utf8"));
  check("defaults start empty", JSON.stringify((await get()).defaults) === "{}");

  // refusals
  for (const [name, body] of [["an AI that is not installed", { agent: "gemini-nope" }], ["an unknown account", { account: "ghost" }], ["a bad effort", { effort: "ultra" }], ["a bad mode", { mode: "nonsense" }], ["a model with a space", { model: "a b" }], ["an unknown key", { colour: 1 }]]) {
    const r = await put(body);
    check(`PUT refuses ${name} (400)`, r.status === 400 && typeof r.body.error === "string", r.text);
  }
  check("nothing was saved by the refusals", JSON.stringify((await get()).defaults) === "{}");

  // a viewer may read and not write
  const made = await kit.req("POST", "/api/users", { id: "defcheck-viewer", name: "defcheck-viewer", role: "viewer" });
  const vk = made.body?.key;
  try {
    check("a viewer can be created", !!vk, made.text);
    check("a viewer reads the defaults", (await kit.req("GET", "/api/ai/defaults", undefined, vk)).status === 200);
    check("a viewer cannot change them (403)", (await kit.req("PUT", "/api/ai/defaults", { model: "opus" }, vk)).status === 403);
    check("a viewer cannot read the accounts' keys, or add an account", (await kit.req("POST", "/api/ai/accounts", { provider: "claude", kind: "login", label: "x" }, vk)).status === 403);
  } finally {
    await kit.req("DELETE", "/api/users/defcheck-viewer");
  }

  const r1 = await put({ model: "sonnet", effort: "high", mode: "acceptEdits", autoFresh: false });
  check("PUT saves and returns the defaults", r1.status === 200 && r1.body.defaults.model === "sonnet" && r1.body.defaults.autoFresh === false, r1.text);
  check("it is audited", JSON.stringify((await kit.req("GET", "/api/audit?limit=50")).body).includes("ai.defaults"));

  // a new project inherits
  const a = await kit.project();
  let ai = (await kit.run(a)).ai;
  check("a new project inherits model, effort, mode and 'continue fresh'", ai.model.source === "default" && ai.model.value === "sonnet" && ai.effort.value === "high" && ai.mode.value === "acceptEdits" && ai.autoFresh.value === false && ai.autoFresh.source === "default", JSON.stringify(ai));
  check("the chat view shows the inherited mode and model", (await kit.chat(a)).mode === "acceptEdits" && (await kit.chat(a)).fresh.auto === false);
  await kit.send(a, "hello");
  await kit.idle(a);
  const sp = kit.spawns().at(-1);
  check("Claude started with the default model and mode", sp.args[sp.args.indexOf("--model") + 1] === "sonnet" && sp.args[sp.args.indexOf("--permission-mode") + 1] === "acceptEdits", JSON.stringify(sp.args));
  check("and the default effort was applied", kit.controls().some((c) => c.sub === "apply_flag_settings" && c.request.settings.effortLevel === "high"));
  ai = (await kit.run(a)).ai;
  check("the first message pins the AI", ai.agent.source === "project" && ai.account.source === "project" && ai.model.source === "default");

  // a later default never moves a running conversation
  await put({ model: "haiku", mode: "default" });
  ai = (await kit.run(a)).ai;
  check("a changed default reaches settings the project does not own", ai.model.value === "haiku" && ai.mode.value === "default");
  await put({ agent: "omp" });
  ai = (await kit.run(a)).ai;
  check("but not the AI of a project that has had a message", ai.agent.value === "claude" && ai.agent.source === "project");

  // an own choice
  const c1 = await kit.control(a, "model", "default");
  check('choosing "default" is accepted', c1.status === 200, c1.text);
  check('and stored as the string "default"', state().workspaces.find((w) => w.id === a).model === "default");
  ai = (await kit.run(a)).ai;
  check("it overrides the server default", ai.model.value === "default" && ai.model.source === "project");
  await kit.control(a, "mode", "plan");
  ai = (await kit.run(a)).ai;
  check("an own mode is the project's", ai.mode.value === "plan" && ai.mode.source === "project");

  // reset
  for (const field of ["model", "mode", "effort", "autoFresh"]) {
    const r = await kit.control(a, "reset", field);
    check(`reset ${field} -> 200`, r.status === 200, r.text);
  }
  ai = (await kit.run(a)).ai;
  check("after reset they inherit again", ai.model.source === "default" && ai.model.value === "haiku" && ai.mode.source === "default" && ai.autoFresh.source === "default", JSON.stringify(ai));
  const w = state().workspaces.find((x) => x.id === a);
  check("the project fields are really gone", w.model === undefined && w.permissionMode === undefined && w.effort === undefined && w.autoFresh === undefined);
  check("reset of something that cannot be reset -> 400", (await kit.control(a, "reset", "notes")).status === 400);
  await kit.control(a, "effort", "low");
  const live = kit.controls().length;
  await kit.control(a, "reset", "effort");
  check("a live Claude is moved back to the default effort", kit.controls().length > live);

  // the AI follows the default until the first message
  await put({ agent: "claude" });
  const first = await projectNoAgent();
  check("a project made with no AI named starts on the default AI", (await kit.run(first)).ai.agent.value === "claude" && (await kit.run(first)).ai.agent.source === "default");
  await put({ agent: "omp" });
  const second = await projectNoAgent();
  const r2 = await kit.run(second);
  check("with a different default AI, a new project is on it (until its first message)", r2.agent === "omp" && r2.ai.agent.source === "default", JSON.stringify(r2.ai.agent));
  await put({ agent: "claude" });
  const r3 = await kit.run(second);
  check("changing the default moves a project that has had no message", r3.agent === "claude" && r3.ai.agent.source === "default", JSON.stringify(r3.ai.agent));
  await kit.send(second, "go");
  await kit.idle(second);
  await put({ agent: "omp" });
  const r4 = await kit.run(second);
  check("after its first message it stays", r4.agent === "claude" && r4.ai.agent.source === "project", JSON.stringify(r4.ai.agent));
  // a project whose AI was picked on purpose keeps it
  await put({ agent: "claude" });
  const picked = await kit.req("POST", "/api/workspaces", { repo: kit.repoDir, agent: "omp", chat: true });
  await put({ agent: "hermes" });
  check("an AI picked at creation is the project's own", (await kit.run(picked.body.id)).agent === "omp");

  // clearing
  const cleared = await put({ model: null, effort: null, mode: null, autoFresh: null, agent: null });
  check("null clears the defaults", JSON.stringify(cleared.body.defaults) === "{}", cleared.text);
  const fresh = await kit.project();
  const fa = (await kit.run(fresh)).ai;
  check("a project made after it is on the built-in values", fa.model.source === "builtin" && fa.mode.source === "builtin" && fa.autoFresh.source === "builtin");
  check("--model is not passed for 'default'", await (async () => { await kit.send(fresh, "hi"); await kit.idle(fresh); return !kit.spawns().at(-1).args.includes("--model"); })());
  const everything = JSON.stringify(state());
  check("no key of the old defaults is left in the state", !/"effort":"high"/.test(JSON.stringify(state().defaults ?? {})) && typeof everything === "string");
  void waitFor;
} finally {
  await kit.stop();
}

finish("defaults");
