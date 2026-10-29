#!/usr/bin/env bun
/**
 * The Team view's words and numbers: meters, durations, the agent's run-strip line, the board grouping, the feed's
 * merge and titles, the poll rhythm, and the frozen contract (web/src/team-types.ts must match the server's copy).
 * Pure functions only; nothing is fetched.
 *
 * Run:  bun scripts/check-team-text.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import {
  agentStripLine,
  boardGroups,
  budgetLines,
  budgetWord,
  defaultRole,
  eventTitle,
  isLive,
  lastEventN,
  meterPercent,
  mergeEvents,
  pollDelay,
  primaryAction,
  roleStateText,
  tasksLine,
  taskWord,
  teamWord,
} from "../web/src/lib/team.ts";

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
const role = (over = {}) => ({
  id: "builder-1",
  kind: "builder",
  name: "Builder 1",
  member: "",
  mode: "acceptEdits",
  instructions: "",
  budget: { tokens: 200000, minutes: 20 },
  spent: { tokens: 0, ms: 0, turns: 0 },
  state: "idle",
  line: "",
  since: 0,
  inboxRead: 0,
  ...over,
});
const task = (id, status, over = {}) => ({
  id,
  title: `Task ${id}`,
  brief: "",
  area: [],
  deps: [],
  status,
  rounds: 0,
  spent: { tokens: 0, ms: 0, turns: 0 },
  created: 1,
  updated: 1,
  ...over,
});
const ev = (n, over = {}) => ({ n, at: n, kind: "message", from: "lead", text: `event ${n}`, ...over });

/* ------------------------------------------------------------ meters -- */
check("a half-used limit is 50%", meterPercent(150, 300), 50);
check("an over-used limit caps at 100%", meterPercent(900, 300), 100);
check("no limit means no meter", meterPercent(10, undefined), null);
check("a zero limit means no meter", meterPercent(10, 0), null);
check(
  "budget lines: tokens then minutes, only the limits that are set",
  budgetLines({ tokens: 300000, minutes: 30 }, { tokens: 120000, ms: 4 * 60_000, turns: 3 }).map((l) => [l.key, l.percent, l.text]),
  [
    ["tokens", 40, "120k tokens of 300k tokens"],
    ["minutes", 13, "4 of 30 min"],
  ],
);
check("a budget with only tokens has one line", budgetLines({ tokens: 1000 }, { tokens: 0, ms: 0, turns: 0 }).length, 1);
check("budget words: nothing below 80%", budgetWord({ tokens: 100 }, { tokens: 79, ms: 0, turns: 0 }), null);
check("budget words: nearly used up from 80%", budgetWord({ tokens: 100 }, { tokens: 80, ms: 0, turns: 0 }), "Nearly used up");
check("budget words: used up from 100%", budgetWord({ minutes: 1 }, { tokens: 0, ms: 60_000, turns: 1 }), "Used up");

/* ------------------------------------------------------ agent lines -- */
check("a working agent names its task and its timer", roleStateText({ state: "working", since: 0, taskId: "T3" }, 250_000), "Working on T3 · 4m 10s");
check("a working agent with no task shows only the timer", roleStateText({ state: "working", since: 0 }, 5_000), "Working · 5s");
check("a waiting agent shows its word, no timer", roleStateText({ state: "needs_you", since: 0 }, 99_000_000), "Needs you");
check("an idle agent says idle", roleStateText({ state: "idle", since: 0 }, 1), "Idle");
check(
  "the strip line: Claude, account, model, mode, state",
  agentStripLine({ account: "work@x.com", model: "Haiku 4.5", mode: "acceptEdits", state: "Working 2m" }),
  "Claude · work@x.com · Haiku 4.5 · Edits allowed · Working 2m",
);
check("the strip line leaves out an account nobody can see", agentStripLine({ account: null, model: "Haiku 4.5", mode: "default", state: "Idle" }), "Claude · Haiku 4.5 · Asks first · Idle");
check("the phone strip keeps AI, model and state only", agentStripLine({ account: "work@x.com", model: "Haiku 4.5", mode: "plan", state: "Working" }, true), "Claude · Haiku 4.5 · Working");
check("a plan-first agent says Plan first", agentStripLine({ model: "Sonnet 4.6", mode: "plan", state: "Idle" }), "Claude · Sonnet 4.6 · Plan first · Idle");

/* ------------------------------------------------------------ choosing -- */
const roles = [role({ id: "lead", kind: "lead", name: "Lead" }), role({ id: "builder-1" }), role({ id: "builder-2", state: "working" })];
check("the agent to show is the Lead when nobody works", defaultRole([roles[0], roles[1]])?.id, "lead");
check("the agent to show is one that works before the Lead", defaultRole(roles)?.id, "builder-2");
check("an agent that needs you comes before one that works", defaultRole([roles[2], role({ id: "builder-3", state: "needs_you" })])?.id, "builder-3");

/* -------------------------------------------------------------- board -- */
const tasks = [task("T1", "done"), task("T2", "working"), task("T3", "todo"), task("T4", "blocked"), task("T5", "review"), task("T6", "done")];
const groups = boardGroups(tasks);
check("the board has four columns in order", groups.map((g) => g.label), ["To do", "Working", "Review", "Done"]);
check("blocked tasks sit in To do with todo tasks", groups[0].tasks.map((t) => t.id), ["T3", "T4"]);
check("each task is in one column", groups.reduce((n, g) => n + g.tasks.length, 0), tasks.length);
check("done tasks are in Done", groups[3].tasks.map((t) => t.id), ["T1", "T6"]);
check("a blocked task says Blocked", taskWord("blocked"), "Blocked");
check("the task count reads as a sentence", tasksLine(tasks), "2 of 6 tasks done");
check("one task reads singular", tasksLine([task("T1", "done")]), "1 of 1 task done");

/* -------------------------------------------------------------- team -- */
check("a team waiting on the person has the Land primary", primaryAction("awaiting_approval"), "land");
check("a running team has no primary", primaryAction("running"), null);
check("a finished team has no primary", primaryAction("done"), null);
check("ready to check is the word for awaiting approval", teamWord("awaiting_approval"), "Ready to check");
check("only running and landing are live", ["running", "landing", "paused", "awaiting_approval", "done", "stopped"].map((s) => isLive(s)), [true, true, false, false, false, false]);
check("the feed polls every 2 s while visible and live", pollDelay(true, true), 2000);
check("the feed polls every 10 s when hidden", pollDelay(false, true), 10000);
check("the feed polls every 10 s when not live", pollDelay(true, false), 10000);

/* ------------------------------------------------------------- events -- */
const merged = mergeEvents([ev(1), ev(2), ev(3)], [ev(3), ev(4), ev(5)]);
check("events merge in order without repeats", merged.map((e) => e.n), [1, 2, 3, 4, 5]);
check("the feed keeps the newest events", mergeEvents([], [ev(1), ev(2), ev(3), ev(4)], 2).map((e) => e.n), [3, 4]);
check("the next read asks after the newest event", lastEventN(merged), 5);
check("no events means read from zero", lastEventN([]), 0);
check("a message between two builders reads from and to", eventTitle({ from: "b1", to: "rv" }, { b1: "Builder 1", rv: "Reviewer" }), "Builder 1 to Reviewer");
check("an event from the Lead reads as its name", eventTitle({ from: "lead" }, { lead: "Lead" }), "Lead");
check("an unknown id is shown as it is", eventTitle({ from: "gone" }, {}), "gone");

/* ------------------------------------------------------ the contract -- */
const web = readFileSync(new URL("../web/src/team-types.ts", import.meta.url), "utf8");
checkTrue("the web contract declares the Team type", /export interface Team \{/.test(web));
checkTrue("the web contract carries no secrets", !/secrets/.test(web.replace(/\/\/ server-only.*$/m, "")));
const server = new URL("../team-types.ts", import.meta.url);
if (existsSync(server)) {
  const same = readFileSync(server, "utf8").trim() === web.trim();
  checkTrue("web/src/team-types.ts is identical to the server's team-types.ts", same, "copy the contract again");
} else {
  console.log("skip  server team-types.ts is not in the tree yet, identity not checked");
}

console.log(failures ? `\n${failures} failed` : "\nall team text checks passed");
process.exit(failures ? 1 : 0);
