#!/usr/bin/env bun
/**
 * The AI hub's words: which AIs the model picker lists, how the helpers tree is laid out, the run strip's line,
 * the reply rows and the usage text. Pure functions only; nothing is fetched.
 *
 * Run:  bun scripts/check-run-text.mjs
 */
import {
  accountLabel,
  agoText,
  durationText,
  flattenHelpers,
  helperForest,
  helperWord,
  orderCards,
  pickerGroups,
  replyLine,
  replyRows,
  resetsText,
  stateWord,
  stripBrief,
  stripText,
  tokensText,
  usageText,
} from "../web/src/lib/aiHub.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}
function checkTrue(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond || !detail ? "" : `  (${detail})`}`);
}

/* ---------------------------------------------------------- fixtures -- */
const model = (value, label, group) => ({ value, label, ...(group ? { group } : {}) });
const account = (over = {}) => ({
  id: "default",
  label: "you@example.com",
  email: "you@example.com",
  plan: "max",
  auth: "oauth",
  state: "connected",
  isolation: {},
  usage: null,
  models: [model("default", "Default")],
  modelsAt: 1,
  ...over,
});
const card = (id, name, state, over = {}) => ({
  id,
  name,
  kind: "cli",
  installed: state !== "not_installed",
  version: "1.0.0",
  state,
  checkedAt: 1,
  stale: false,
  accounts: state === "connected" || state === "limited" ? [account({ label: name, email: null })] : [],
  actions: [],
  ...over,
});

const claude = card("claude", "Claude", "connected", { accounts: [account({ models: [model("default", "Default"), model("claude-sonnet-5-5", "Sonnet 5.5")] })] });
const codex = card("codex", "Codex", "signed_out");
const hermes = card("hermes", "Hermes", "limited", { accounts: [account({ label: "openrouter", email: null, state: "limited", models: [] })] });
const omp = card("omp", "omp", "error");
const gone = card("gemini", "Gemini", "not_installed");

/* ------------------------------------------------------- pickerGroups -- */
const mixed = [codex, hermes, gone, omp, claude];
const owner = pickerGroups(mixed, true);
check("picker lists connected and limited AIs only, Claude first (one group per account: id is AI:account)", owner.map((g) => g.id), ["claude:default", "hermes:default"]);
check("a group names its AI and its account", owner.map((g) => [g.agent, g.accountId]), [["claude", "default"], ["hermes", "default"]]);
check("signed-out Codex is not in the picker", owner.some((g) => g.agent === "codex"), false);
check("not-installed and error AIs are not in the picker", owner.some((g) => g.agent === "gemini" || g.agent === "omp"), false);
check("owner sees the account in the heading", owner[0].label, "Claude · you@example.com");
check("a provider label that is not an email still names the account", owner[1].label, "Hermes · openrouter");
const member = pickerGroups(mixed, false);
check("a member sees the AI's name only", member.map((g) => g.label), ["Claude", "Hermes"]);
checkTrue("no email reaches a member's picker", !JSON.stringify(member).includes("@"));
check("an AI with no models yet is still a group", owner[1].models, []);
const twice = pickerGroups(
  [card("claude", "Claude", "connected", { accounts: [account({ models: [model("a", "A")] }), account({ id: "two", models: [model("a", "A"), model("b", "B")] })] })],
  true,
);
check("two accounts are two groups, each with its own models", twice.map((g) => [g.id, g.models.map((m) => m.value)]), [["claude:default", ["a"]], ["claude:two", ["a", "b"]]]);
check("a signed-out account gives no group", pickerGroups([card("claude", "Claude", "connected", { accounts: [account({ state: "signed_out", models: [model("x", "X")] })] })], true), []);
check("accountLabel: owner gets the email", accountLabel(claude, true), "you@example.com");
check("accountLabel: member gets none", accountLabel(claude, false), null);
check("accountLabel: a label equal to the AI's name is no account", accountLabel(card("codex", "Codex", "connected"), true), null);
check("orderCards: Claude, connected, signed out, not installed", orderCards([gone, codex, hermes, claude]).map((c) => c.id), ["claude", "hermes", "codex", "gemini"]);
check("state words", ["connected", "signed_out", "not_installed", "limited", "error", "checking"].map(stateWord), ["Connected", "Signed out", "Not installed", "Limit reached", "Problem", "Checking"]);

/* ------------------------------------------------------ flattenHelpers -- */
const node = (id, parentId, over = {}) => ({
  id,
  taskId: null,
  parentId,
  label: id,
  kind: null,
  model: null,
  status: "running",
  background: false,
  startedAt: 0,
  endedAt: null,
  tools: null,
  tokens: null,
  lastTool: null,
  summary: null,
  canStop: false,
  ...over,
});
const rows = flattenHelpers([node("a", null), node("a1", "a"), node("a1x", "a1"), node("b", null), node("a2", "a")]);
check("depth follows the parents, each parent before its children", rows.map((r) => `${r.node.id}:${r.depth}`), ["a:0", "a1:1", "a1x:2", "a2:1", "b:0"]);
check("a child listed before its parent still comes after it", flattenHelpers([node("c", "p"), node("p", null)]).map((r) => `${r.node.id}:${r.depth}`), ["p:0", "c:1"]);
check("a helper whose parent is not in the list is a root", flattenHelpers([node("o", "gone")]).map((r) => `${r.node.id}:${r.depth}`), ["o:0"]);
check("a helper that is its own parent is a root", flattenHelpers([node("s", "s")]).map((r) => `${r.node.id}:${r.depth}`), ["s:0"]);
const loop = flattenHelpers([node("x", "y"), node("y", "x")]);
check("a loop of parents cannot hang or lose helpers", loop.map((r) => r.node.id).sort(), ["x", "y"]);
const many = Array.from({ length: 80 }, (_, i) => node(`n${i}`, i === 0 ? null : "n0"));
check("the list is capped at 50", flattenHelpers(many).length, 50);
check("helperForest nests children", helperForest([node("a", null), node("b", "a")])[0].children.map((c) => c.node.id), ["b"]);
check("helper status words", ["running", "done", "failed", "stopped"].map(helperWord), ["Working", "Done", "Failed", "Stopped"]);

/* --------------------------------------------------------- replyRows -- */
const done = (n, extra = {}) => ({ n, at: 1000 * n, kind: "done", ...extra });
const events = [
  { n: 1, at: 1, kind: "user", text: "hi" },
  done(2, { worked: 72_000, model: "claude-sonnet-5-5", tokens: { in: 12000, out: 345 } }),
  { n: 3, at: 3, kind: "plan", planDelta: 4.2 },
  done(4),
  done(5, { worked: 5000, model: "claude-haiku-5-5", tokens: { in: 10, out: 5 }, planDelta: 0.2 }),
];
const rr = replyRows(events, true, 20, (m) => m.toUpperCase());
check("newest reply first", rr.map((r) => r.n), [5, 4, 2]);
check("model, time and tokens", [rr[2].model, rr[2].time, rr[2].tokens], ["CLAUDE-SONNET-5-5", "1m 12s", "12.3k tokens"]);
check("plan share from the line that follows a done event (owner)", rr[2].plan, "4% of your plan");
check("a plan share under 1% is not shown", rr[0].plan, null);
check("a reply with nothing known has no parts", [rr[1].model, rr[1].time, rr[1].tokens, rr[1].plan], [null, null, null, null]);
check("members see no plan share", replyRows(events, false).every((r) => r.plan === null), true);
check("replyLine joins what is known", replyLine(rr[2]), "CLAUDE-SONNET-5-5 · 1m 12s · 12.3k tokens · 4% of your plan");
check("a reply under a second has no time (no 0s)", replyRows([done(1, { worked: 900 })], false)[0].time, null);
check("only the last 20 replies", replyRows(Array.from({ length: 30 }, (_, i) => done(i + 1)), false).length, 20);

/* ---------------------------------------------------------- the words -- */
check("tokens: small", tokensText(980), "980 tokens");
check("tokens: one", tokensText(1), "1 token");
check("tokens: thousands with a decimal", tokensText(1234), "1.2k tokens");
check("tokens: round thousands drop the .0", tokensText(2000), "2k tokens");
check("tokens: tens of thousands", tokensText(12345), "12.3k tokens");
check("tokens: hundreds of thousands", tokensText(234567), "235k tokens");
check("tokens: millions", tokensText(1_500_000), "1.5M tokens");
check("tokens: nonsense is empty", tokensText(-3), "");
check("duration", [durationText(900), durationText(12_000), durationText(65_000)], ["0s", "12s", "1m 05s"]);
check("ago", [agoText(0, 10_000), agoText(0, 120_000), agoText(0, 3 * 3_600_000), agoText(0, 2 * 86_400_000)], ["just now", "2 min ago", "3 hr ago", "2 days ago"]);

/* --------------------------------------------------------- stripText -- */
const full = { ai: "Claude", account: "you@example.com", model: "Sonnet 5.5", mode: "Asks first", state: "Working 1m 12s", stateShort: "Working" };
check("strip: every part, joined with ·", stripText(full), "Claude · you@example.com · Sonnet 5.5 · Asks first · Working 1m 12s");
check("strip: no account when unknown", stripText({ ...full, account: null }), "Claude · Sonnet 5.5 · Asks first · Working 1m 12s");
check("strip: no mode for an AI without modes", stripText({ ...full, mode: null }), "Claude · you@example.com · Sonnet 5.5 · Working 1m 12s");
check("strip: extra words come after the state", stripText({ ...full, extra: "2 helpers working" }), "Claude · you@example.com · Sonnet 5.5 · Asks first · Working 1m 12s · 2 helpers working");
check("strip: a phone keeps AI, model and the short state", stripText(full, true), "Claude · Sonnet 5.5 · Working");
check("strip: a phone drops extra words", stripText({ ...full, extra: "2 helpers working" }, true), "Claude · Sonnet 5.5 · Working");
check("strip: empty parts are left out", stripText({ ai: "Claude", account: "", model: "  ", mode: null, state: "Ready" }), "Claude · Ready");

/* ------------------------------------------------------- stripBrief -- */
check("stripBrief: account and state (the composer chips say the AI, model and mode)", stripBrief(full), "you@example.com · Working 1m 12s");
check("stripBrief: no account when unknown", stripBrief({ ...full, account: null }), "Working 1m 12s");
check("stripBrief: extra words come after the state", stripBrief({ ...full, extra: "2 helpers working" }), "you@example.com · Working 1m 12s · 2 helpers working");
check("stripBrief: the next-message model is named", stripBrief({ ...full, next: "Haiku 4.5" }), "you@example.com · Working 1m 12s · next message: Haiku 4.5");
check("stripBrief: a phone keeps the account and the short state", stripBrief(full, true), "you@example.com · Working");
check("stripBrief: a phone drops extra words", stripBrief({ ...full, extra: "2 helpers working" }, true), "you@example.com · Working");
check("stripBrief: ready with no account is the state alone", stripBrief({ ai: "Claude", account: null, model: "Opus 5.5", mode: "Auto", state: "Ready" }), "Ready");
check("stripBrief: the label keeps AI, model and mode", stripText({ ...full, state: "Ready", extra: null }), "Claude · you@example.com · Sonnet 5.5 · Asks first · Ready");

/* ------------------------------------------------------- resetsText -- */
const now = new Date(2026, 9, 20, 9, 0, 0);
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const t = (h, m) => new Date(2026, 9, 20, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
check("resets today", resetsText(at(20, 19, 20), now), `resets at ${t(19, 20)}`);
check("resets tomorrow", resetsText(at(21, 9, 0), now), `resets tomorrow at ${t(9, 0)}`);
checkTrue("resets later in the week names the day", /^resets \w+ at /.test(resetsText(at(24, 9, 0), now) ?? ""), String(resetsText(at(24, 9, 0), now)));
check("a bad time gives nothing", [resetsText(null, now), resetsText("not a date", now)], [null, null]);
check("usage line", usageText(34, at(20, 19, 20), false, now), `34% used · resets at ${t(19, 20)}`);
check("usage line without a reset time", usageText(34.4, null, false, now), "34% used");
check("usage is clamped", [usageText(140, null, false, now), usageText(-5, null, false, now)], ["100% used", "0% used"]);
check("a full window says so", usageText(100, at(20, 19, 20), true, now), `Limit reached. Resets at ${t(19, 20)}`);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall run text checks passed");
