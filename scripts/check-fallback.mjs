#!/usr/bin/env bun
/**
 * Usage-limit fallback: what counts as a limit (and what does not), the order tried, and the whole thing through the real
 * server with a fake claude and a fake Codex agent that run out of plan. The raw error never reaches the chat, the message is
 * delivered once, the way back after the limit lifts. No model is called.
 *
 * Run:  bun scripts/check-fallback.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSteps, limitReached, resetHint } from "../policy.ts";
import { friendlyError } from "../chat.ts";
import { jsonLines, killDaemon, makeCheck, startKit, waitFor } from "./ai-check-kit.mjs";

const { check, finish } = makeCheck();
const now = Date.parse("2026-10-27T10:00:00");

// ---- what is a limit, pure ----
for (const raw of ["Claude AI usage limit reached", "You've hit your usage limit. Your limit resets 2:49pm", "5-hour limit reached ∙ resets 3pm", "Weekly limit reached", "rate_limit_error: slow down", "API Error: 429 Too Many Requests", "You have reached your limit for today", "Error: usage limit reached"]) check(`a limit: ${raw.slice(0, 44)}`, limitReached(raw, now) !== null);
for (const raw of ["API Error: 529 overloaded_error", "Overloaded", "overloaded_error (529)", "network down", "invalid api key", "", "Something went wrong"]) check(`not a limit: ${raw.slice(0, 40) || "(empty)"}`, limitReached(raw, now) === null);
check("overload is its own message, not the usage-limit one", /busy/.test(friendlyError("529 overloaded")) && /usage limit/.test(friendlyError("usage limit reached")) && !/usage limit/.test(friendlyError("Overloaded")));
check("'resets 2:49pm' is read as the next 2:49 pm", new Date(limitReached("usage limit reached, resets 2:49pm", now).until).getHours() === 14 && new Date(limitReached("usage limit reached, resets 2:49pm", now).until).getMinutes() === 49);
check("a reset time already past today means tomorrow", resetHint("resets 9am", now) - now > 20 * 3600e3);
check("else the account's full window says when", limitReached("usage limit reached", now, [{ resetsAt: new Date(now + 7200e3).toISOString(), severity: "limit" }, { resetsAt: new Date(now + 9000e3).toISOString() }]).until === now + 7200e3);
check("else half an hour from now", limitReached("usage limit reached", now).until === now + 30 * 60e3);

// ---- the order, pure ----
const lanes = (...l) => l.map(([id, connected = true, limited = false]) => ({ id, connected, limited }));
check("other accounts first, then cheaper Claude models", JSON.stringify(defaultSteps({ agent: "claude", account: null, model: "default", accounts: lanes([null], ["a"], ["b"]) })) === '[{"account":"a"},{"account":"b"},{"model":"haiku"}]', JSON.stringify(defaultSteps({ agent: "claude", account: null, model: "default", accounts: lanes([null], ["a"], ["b"]) })));
check("a limited or signed-out account is skipped", JSON.stringify(defaultSteps({ agent: "claude", account: null, model: "opus", accounts: lanes([null], ["a", true, true], ["b", false]) })) === '[{"model":"haiku"},{"model":"sonnet"}]');
check("the default login is a step (account: null) for a project on an account", JSON.stringify(defaultSteps({ agent: "claude", account: "a", model: "haiku", accounts: lanes([null], ["a"]) })) === '[{"account":null}]');
check("other AIs have no model step", JSON.stringify(defaultSteps({ agent: "codex", account: null, model: null, accounts: lanes([null]) })) === "[]");

// ---- a fake Codex agent (ACP) that runs out of plan ----
function fakeCodexAcp() {
  const fs = require("node:fs");
  const path = require("node:path");
  const dir = path.dirname(process.argv[1]);
  const home = process.env.CODEX_HOME ?? null;
  const who = home ? path.basename(home) : "default";
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
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
      if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: `acp-${who}-${process.pid}` } });
      else if (m.method === "session/prompt") {
        const text = m.params.prompt.map((p) => p.text).join("");
        fs.appendFileSync(path.join(dir, "acp-msgs.log"), JSON.stringify({ pid: process.pid, who, codexHome: home, text }) + "\n");
        if (fs.existsSync(path.join(dir, `acp-limit-${who}`))) send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "You've hit your usage limit. Upgrade to Pro or try again later." } });
        else {
          send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: m.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Codex says ${who}` } } } });
          send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } });
        }
      } else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
    }
  });
}

// ---- E: only the model changes (a server of its own: what is known about limits is remembered per server) ----
{
  const kE = await startKit();
  const events = async (id) => (await kE.chat(id)).events;
  const text = (e) => e.map((x) => x.text ?? "").join("\n");
  try {
  // ---- E: only the model changes (same account, same session) ----
    const e1 = await kE.project();
  await kE.send(e1, "start here");
  await kE.idle(e1);
  const pidBefore = kE.spawns().filter((s) => s.cwd.includes(`/${e1}/tree`)).length;
  kE.flag("behave-default", "limit-once");
  await kE.send(e1, "make it smaller");
  check("a cheaper model takes the message, in the same session", await waitFor(() => kE.msgs().some((m) => m.text.includes("make it smaller") && m.model === "haiku"), 20000), JSON.stringify(kE.msgs().slice(-3)));
  await kE.idle(e1);
  const ee = await events(e1);
  check("the Claude process is the same one (no restart), told by set_model", kE.spawns().filter((s) => s.cwd.includes(`/${e1}/tree`)).length === pidBefore && kE.controls().some((c) => c.sub === "set_model" && c.request.model === "haiku"));
  check("the note names the model", ee.some((e) => e.kind === "note" && e.text === "Claude hit its limit — continued on Haiku 4.5"), JSON.stringify(ee.filter((e) => e.kind === "note")));
  check("delivered once, raw error hidden", kE.msgs().filter((m) => m.text.includes("make it smaller")).length === 2 && !/hit your usage limit/.test(text(ee)));

  } finally {
    await kE.stop();
  }
}

const kit = await startKit({ bins: { "codex-acp": `#!/usr/bin/env node\n(${fakeCodexAcp.toString()})();\n` } });
try {
  const acc = `${kit.works}/accounts`;
  const makeLogin = async (provider, label) => {
    const r = await kit.req("POST", "/api/ai/accounts", { provider, kind: "login", label });
    const id = r.body.account.id;
    mkdirSync(join(acc, id), { recursive: true });
    writeFileSync(join(acc, id, "signed-in"), "1");
    return id;
  };
  const events = async (id) => (await kit.chat(id)).events;
  const text = (e) => e.map((x) => x.text ?? "").join("\n");
  const wid = await makeLogin("claude", "Work");

  // ---- A: the default sign-in runs out; the message moves to Work, once ----
  const a = await kit.project();
  await kit.send(a, "first words"); // the default answers normally and starts a session
  await kit.idle(a);
  const row = (id) => JSON.parse(readFileSync(join(kit.works, "state.json"), "utf8")).workspaces.find((w) => w.id === id);
  const firstSession = row(a).chatSession;
  kit.flag("behave-default", "limit-once");
  await kit.send(a, "build the page");
  check("the message is delivered to the second account", await waitFor(() => kit.msgs().some((m) => m.who === wid && m.text.includes("build the page")), 20000), JSON.stringify(kit.msgs().map((m) => [m.who, m.text.slice(0, 20)])));
  await kit.idle(a);
  const ev = await events(a);
  const hop = ev.find((e) => e.kind === "note" && /hit its limit/.test(e.text));
  check("the note says who hit the limit and where it went, with the time it lifts", hop?.text === "Claude hit its limit — continued on Work" && typeof hop.until === "number" && hop.until > Date.now(), JSON.stringify(hop));
  check("the raw error is not in the chat", !/hit your usage limit|Claude AI usage limit|error_during_execution/i.test(text(ev)) && !ev.some((e) => e.kind === "error"), text(ev).slice(-300));
  check("the person's message is there once", ev.filter((e) => e.kind === "user" && e.text === "build the page").length === 1);
  check("it was delivered once to Work and not again to the default", kit.msgs().filter((m) => m.text.includes("build the page")).length === 2 && kit.msgs().filter((m) => m.who === wid && m.text.includes("build the page")).length === 1);
  check("the turn ended once, with the answer from the second account", ev.filter((e) => e.kind === "assistant").length === 2 && ev.filter((e) => e.kind === "done").length === 2, JSON.stringify(ev.map((e) => e.kind)));
  let info = await kit.run(a);
  check("the project is on Work and says why, with the way back", info.account?.id === wid && info.limit?.from === "Claude" && info.limit.to === "Work" && info.limit.fromAccount === null && info.limit.until > Date.now(), JSON.stringify(info.limit));
  const wsRow = row(a);
  check("its session is Work's own, and the default's is kept for the way back", wsRow?.chatSession?.startsWith(`fake-${wid}-`) && wsRow.agentSessions?.claude === firstSession && !!firstSession, JSON.stringify([wsRow?.chatSession, wsRow?.agentSessions]));
  check("the limited account is not called for the resend", kit.spawns().filter((s) => s.who === "default").length === 1);

  // the next message goes to Work without another hop
  await kit.send(a, "keep going");
  await kit.idle(a);
  check("later messages stay on Work (no loop, no second note)", kit.msgs().at(-1).who === wid && (await events(a)).filter((e) => /hit its limit/.test(e.text ?? "")).length === 1);

  // ---- C: a message that already moved once is not moved again (no loop) ----
  const wid2 = await makeLogin("claude", "Spare");
  kit.flag("behave-default", "limit");
  kit.flag(`behave-${wid}`, "limit");
  kit.flag(`behave-${wid2}`, "limit");
  const c = await kit.project();
  await kit.control(c, "fallback", { auto: true, steps: [{ account: wid }, { account: wid2 }] });
  await kit.send(c, "loop check");
  await waitFor(async () => (await events(c)).some((e) => e.kind === "error"), 25000);
  await kit.idle(c);
  const ec = await events(c);
  check("the default was known to be at its limit, so it moved before sending; then one hop on the failure, then the plain error", ec.filter((e) => /hit its limit/.test(e.text ?? "")).length === 2 && ec.filter((e) => e.kind === "error").length === 1 && /usage limit/.test(ec.find((e) => e.kind === "error").text), JSON.stringify(ec.filter((e) => e.kind === "note" || e.kind === "error").map((e) => e.text)));
  check("the message reached the two other accounts once each, and never the default", kit.msgs().filter((m) => m.text.includes("loop check")).map((m) => m.who).join() === `${wid},${wid2}`, JSON.stringify(kit.msgs().filter((m) => m.text.includes("loop check")).map((m) => m.who)));

  // ---- B: every step is at a limit: one clear error ----
  const b = await kit.project();
  await kit.control(b, "fallback", { auto: true, steps: [{ account: wid }, { account: wid2 }] });
  await kit.send(b, "again");
  check("every AI at its limit: one clear error with the time", await waitFor(async () => (await events(b)).some((e) => e.kind === "error"), 20000));
  await kit.idle(b);
  const eb = await events(b);
  const errs = eb.filter((e) => e.kind === "error");
  check("exactly one error, in the words of the plan", errs.length === 1 && /^Every AI in your fallback list is at its limit until \d\d:\d\d UTC\.$/.test(errs[0].text) && typeof errs[0].until === "number", JSON.stringify(errs));
  check("and a note with the time just before it", eb.findIndex((e) => e.kind === "note" && /at its limit/.test(e.text) && typeof e.until === "number") === eb.findIndex((e) => e.kind === "error") - 1);
  check("the raw error is still not shown", !/hit your usage limit/.test(text(eb)));
  check("the chat is free again", (await kit.chat(b)).busy === false);

  // ---- D: fallback switched off ----
  kit.flag("behave-default", "limit-once");
  const d = await kit.project();
  await kit.control(d, "fallback", { auto: false });
  await kit.send(d, "no hop please");
  await waitFor(async () => (await events(d)).some((e) => e.kind === "error"), 15000);
  await kit.idle(d);
  check("with fallback off the usual error is shown and nothing moves", (await events(d)).some((e) => e.kind === "error" && /usage limit/.test(e.text)) && (await kit.run(d)).account === null && !(await events(d)).some((e) => /hit its limit/.test(e.text ?? "")));
  check("the list says it is off, and what it would have been", (await kit.run(d)).fallback.auto === false);
  await kit.control(d, "fallback", null);
  const fb = (await kit.run(d)).fallback;
  check("null puts back the suggested order", fb.custom === false && fb.steps.length > 0, JSON.stringify(fb));
  const badFb = [{ steps: "x" }, { steps: [{}] }, { steps: [{ account: "ghost-9" }] }, { steps: [{ model: "a b" }] }, { auto: "yes" }, { steps: Array(11).fill({ model: "haiku" }) }];
  check("bad fallback lists are refused (400)", (await Promise.all(badFb.map((v) => kit.control(d, "fallback", v)))).every((r) => r.status === 400));

  // ---- F: a Claude that dies with the limit on stderr ----
  const f = await kit.project();
  await kit.send(f, "warm up");
  await kit.idle(f);
  kit.flag("behave-default", "exit-limit");
  await kit.send(f, "die please");
  check("a process that prints the limit and exits also falls back", await waitFor(async () => (await events(f)).some((e) => /hit its limit/.test(e.text ?? "")), 20000) || (await events(f)).some((e) => e.kind === "error"), JSON.stringify((await events(f)).map((e) => e.text)));
  kit.flag("behave-default", "ok");

  // ---- G: a fake Codex agent (ACP) runs out of plan ----
  const cx = await makeLogin("codex", "Codex two");
  const g = (await kit.req("POST", "/api/workspaces", { repo: kit.repoDir, agent: "codex", chat: true })).body.id;
  const sw = await kit.control(g, "account", cx);
  check("a project can use a second Codex login", sw.status === 200, sw.text);
  writeFileSync(join(kit.fakeDir, `acp-limit-${cx}`), "1");
  await kit.send(g, "codex please");
  check("the Codex agent's limit also moves the message", await waitFor(() => jsonLines(join(kit.fakeDir, "acp-msgs.log")).some((m) => m.who === "default" && m.text.includes("codex please")), 25000), JSON.stringify(jsonLines(join(kit.fakeDir, "acp-msgs.log"))));
  await kit.idle(g);
  const eg = await events(g);
  const acpMsgs = jsonLines(join(kit.fakeDir, "acp-msgs.log"));
  check("it ran under the second login's own CODEX_HOME first", acpMsgs[0]?.codexHome === join(acc, cx));
  check("the note, the answer from the other login, no raw error", eg.some((e) => e.kind === "note" && e.text === "Codex two hit its limit — continued on Codex") && eg.some((e) => e.kind === "assistant" && e.text === "Codex says default") && !/hit your usage limit/.test(text(eg)) && !eg.some((e) => e.kind === "error"), JSON.stringify(eg.map((e) => [e.kind, e.text])));
  check("delivered once to each", acpMsgs.filter((m) => m.text.includes("codex please")).length === 2);
  check("the default Codex login has no CODEX_HOME of an account", acpMsgs.at(-1).codexHome === null);
  check("the project is back on the default sign-in (account null) with the reason kept", (await kit.run(g)).account === null && (await kit.run(g)).limit?.fromAccount === cx);
} finally {
  await kit.stop();
}

// ---- the way back, with the clock moved on, in-process (fake claude on PATH) ----
{
  const k2 = await startKit();
  const tmp = mkdtempSync(join(tmpdir(), "kohlab-fallback-back-"));
  try {
    const code = `
      const real = Date.now; let offset = 0; Date.now = () => real() + offset;
      const acc = await import(process.env.ROOT + "accounts.ts");
      const lib = await import(process.env.ROOT + "lib.ts");
      const chat = await import(process.env.ROOT + "chat.ts");
      const fs = require("node:fs");
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const idle = async (id) => { for (let i = 0; i < 200; i++) { if (!(await chat.snapshot(id, 0)).busy) return; await sleep(100); } };
      const alt = acc.createLogin("claude", "Alt");
      fs.writeFileSync(acc.dirOf(alt.id) + "/signed-in", "1");
      const ws = await lib.createWorkspace({ repo: process.env.REPO_DIR, task: "t", agent: "claude", chat: true });
      await chat.send(ws.id, "one"); await idle(ws.id);
      fs.writeFileSync(process.env.FAKE_DIR + "/behave-default", "limit-once");
      await chat.send(ws.id, "two"); await sleep(1500); await idle(ws.id);
      const mid = await lib.getWorkspace(ws.id);
      const out = { midAccount: mid.account === alt.id, midLimit: !!mid.limit };
      offset = 3 * 86400e3; // the limit has lifted
      await chat.send(ws.id, "three"); await idle(ws.id);
      const end = await lib.getWorkspace(ws.id);
      out.endAccount = end.account ?? null; out.endLimit = end.limit ?? null;
      out.events = (await chat.snapshot(ws.id, 0)).events.filter((e) => e.kind === "note").map((e) => e.text);
      console.log(JSON.stringify(out));
      process.exit(0);
    `;
    const sub = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, WORKS_DIR: join(tmp, "works"), PATH: `${k2.fakeDir}:${process.env.PATH}`, ROOT: new URL("..", import.meta.url).pathname, REPO_DIR: k2.repoDir, FAKE_DIR: k2.fakeDir, PTY_SOCKET: join(tmp, "pty.sock") } });
    const line = sub.stdout.toString().trim().split("\n").pop() ?? "";
    let o = {};
    try { o = JSON.parse(line); } catch { /* shown below */ }
    check("in-process: the limit moved the project to the second account", o.midAccount === true && o.midLimit === true, line + sub.stderr.toString().slice(-300));
    check("after the limit lifts, the next message goes back to the first account", o.endAccount === null && o.endLimit === null, line);
    check("and says so in plain words", o.events?.some((e) => /is available again/.test(e)) === true, line);
    const msgs = k2.msgs();
    const spawns = k2.spawns();
    check("the first account resumed its own session", spawns.at(-1)?.who === "default" && spawns.at(-1).args.includes("--resume"), JSON.stringify(spawns.map((s) => s.who)));
    check("its message carried what the other account did meanwhile", msgs.at(-1)?.who === "default" && /three/.test(msgs.at(-1).text) && /Context: this conversation started with another assistant/.test(msgs.at(-1).text), msgs.at(-1)?.text.slice(0, 200));
  } finally {
    await k2.stop();
    killDaemon(join(tmp, "pty.sock")); // the in-process chat above started one
    rmSync(tmp, { recursive: true, force: true });
  }
}

void existsSync, readFileSync;
finish("fallback");
