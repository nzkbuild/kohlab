/** Pure helpers for the Team view: meters, the agent's run-strip line, the board, the feed and the words. No React, no fetches: scripts/check-team-text.mjs runs these. */
import type { Mode } from "../types";
import type { AgentState, Budget, Spent, TaskStatus, TeamEvent, TeamRole, TeamStatus, TeamTask } from "../team-types";
import { durationText, MODE_LABEL, stripText, tokensText } from "./aiHub";

/* ------------------------------------------------------------ polling -- */

/** Team state is read every 2 s while the page is visible and the team is working, otherwise every 10 s. */
export const isLive = (status: TeamStatus): boolean => status === "running" || status === "landing";
export const pollDelay = (visible: boolean, live: boolean): number => (visible && live ? 2_000 : 10_000);

/** The events the feed keeps: a list of events already seen, plus the newer ones, in order, without repeats. */
export function mergeEvents(have: TeamEvent[], more: TeamEvent[], cap = 300): TeamEvent[] {
  const seen = new Set(have.map((e) => e.n));
  const fresh = more.filter((e) => !seen.has(e.n));
  return [...have, ...fresh].sort((a, b) => a.n - b.n).slice(-cap);
}

/** The newest event number the feed has, so the next read asks only for what is after it. */
export const lastEventN = (events: TeamEvent[]): number => events.reduce((m, e) => Math.max(m, e.n), 0);

/* -------------------------------------------------------------- meters -- */

/** 0 to 100, rounded and capped; null when the limit is missing or zero (no meter then). */
export function meterPercent(used: number, limit: number | undefined): number | null {
  if (!limit || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

export interface MeterLine {
  key: "tokens" | "minutes";
  percent: number | null;
  text: string;
}

/** The budget's meters, tokens first: "120k tokens of 300k tokens", "4 of 20 min". Only the limits that are set. */
export function budgetLines(b: Budget, s: Spent): MeterLine[] {
  const out: MeterLine[] = [];
  if (b.tokens) out.push({ key: "tokens", percent: meterPercent(s.tokens, b.tokens), text: `${tokensText(s.tokens)} of ${tokensText(b.tokens)}` });
  if (b.minutes) out.push({ key: "minutes", percent: meterPercent(s.ms, b.minutes * 60_000), text: `${Math.floor(s.ms / 60_000)} of ${b.minutes} min` });
  return out;
}

/** "Nearly used up" from 80%, "Used up" from 100%, nothing before that. */
export function budgetWord(b: Budget, s: Spent): string | null {
  const worst = Math.max(meterPercent(s.tokens, b.tokens) ?? 0, meterPercent(s.ms, b.minutes ? b.minutes * 60_000 : undefined) ?? 0);
  if (worst >= 100) return "Used up";
  if (worst >= 80) return "Nearly used up";
  return null;
}

/* ------------------------------------------------------------- agents -- */

const AGENT_WORD: Record<AgentState, string> = {
  idle: "Idle",
  queued: "Waiting for a turn",
  working: "Working",
  parked: "Waiting",
  needs_you: "Needs you",
  paused: "Paused",
  budget: "Budget used up",
  stopped: "Stopped",
  error: "Problem",
};

/** "Working on T3 · 4m 10s" while an agent works (its timer from `since`), otherwise the state's word. */
export function roleStateText(r: Pick<TeamRole, "state" | "since" | "taskId">, now: number): string {
  if (r.state !== "working") return AGENT_WORD[r.state] ?? "Idle";
  const on = r.taskId ? ` on ${r.taskId}` : "";
  return `Working${on} · ${durationText(Math.max(0, now - r.since))}`;
}

/** The run-strip line on an agent's card: "Claude · work@x.com · Haiku 4.5 · Edits allowed · Working 2m". Same parts and joining as the AI hub's strip. */
export function agentStripLine(p: { account?: string | null; model?: string | null; mode: Mode; state: string }, phone = false): string {
  return stripText({ ai: "Claude", account: p.account, model: p.model, mode: MODE_LABEL[p.mode] ?? MODE_LABEL.default, state: p.state }, phone);
}

/** The agent to show when nobody is picked: one that needs you, then one that works, then the Lead. */
export function defaultRole(roles: TeamRole[]): TeamRole | undefined {
  return roles.find((r) => r.state === "needs_you") ?? roles.find((r) => r.state === "working") ?? roles.find((r) => r.kind === "lead") ?? roles[0];
}

/* -------------------------------------------------------------- board -- */

export const BOARD_COLUMNS: { id: string; label: string; statuses: TaskStatus[] }[] = [
  { id: "todo", label: "To do", statuses: ["todo", "blocked"] },
  { id: "working", label: "Working", statuses: ["working"] },
  { id: "review", label: "Review", statuses: ["review"] },
  { id: "done", label: "Done", statuses: ["done"] },
];

/** The four board columns with their tasks, in the order the team made them. */
export function boardGroups(tasks: TeamTask[]): { id: string; label: string; tasks: TeamTask[] }[] {
  return BOARD_COLUMNS.map((c) => ({ id: c.id, label: c.label, tasks: tasks.filter((t) => c.statuses.includes(t.status)) }));
}

const TASK_WORD: Record<TaskStatus, string> = { todo: "Not started", working: "Working", review: "In review", done: "Done", blocked: "Blocked" };
export const taskWord = (status: TaskStatus): string => TASK_WORD[status] ?? "Not started";

/** "2 of 5 tasks done", "0 of 1 task done". */
export function tasksLine(tasks: TeamTask[]): string {
  const done = tasks.filter((t) => t.status === "done").length;
  return `${done} of ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} done`;
}

/* ---------------------------------------------------------- the team -- */

const TEAM_WORD: Record<TeamStatus, string> = {
  running: "Working",
  paused: "Paused",
  awaiting_approval: "Ready to check",
  landing: "Bringing it into your project",
  done: "Done",
  stopped: "Stopped",
};
export const teamWord = (status: TeamStatus): string => TEAM_WORD[status] ?? "Working";

/** The one primary button a team view may show: only when the work waits for the person to bring it in. */
export const LAND_LABEL = "Approve and bring into project";
export const primaryAction = (status: TeamStatus): "land" | null => (status === "awaiting_approval" ? "land" : null);

/** Who an event is from, and to: "Builder 1 to Reviewer". Names come from the team's roles; an unknown id is shown as it is. */
export function eventTitle(e: Pick<TeamEvent, "from" | "to">, names: Record<string, string>): string {
  const from = names[e.from] ?? e.from;
  return e.to ? `${from} to ${names[e.to] ?? e.to}` : from;
}
