// Team state: one JSON file per team (team.json, 0600, written atomically) and an
// append-only events.jsonl beside it. Also the pure rules the team scheduler uses
// (areas, budgets, who picks up which task, the text sent to agents). No git here:
// team-git.ts does that. scripts/check-team-core.mjs covers both.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { WORKS_DIR } from "./lib";
import type { Workspace, Effort, Mode } from "./types";
import type { Budget, Spent, Team, TeamEvent, TeamRole, TeamTask, RoleKind, TeamStatus } from "./team-types";

/** Per agent: the 2 s tick and the 60 s idle reaper are the scheduler's; these are the caps the store enforces. */
export const MAX_TASKS = 30;
export const MAX_BUILDERS = 4;
export const DIGEST_CAP = 1500;
export const BRIEF_CAP = 3000;
export const REVIEW_DIFF_CAP = 24 * 1024;
const EVENTS_KEEP = 4000;
const EVENTS_ROTATE_AT = 5000;

/** Team ids are hex from newTeam; anything else never becomes a path. */
const ID = /^[a-f0-9]{12}$/;
function assertId(id: string): void {
  if (!ID.test(id)) throw new Error("bad team id");
}

export const teamDir = (id: string): string => {
  assertId(id);
  return join(WORKS_DIR, "teams", id);
};

/**
 * An area is a list of path prefixes a task may change. Trailing `/**`, `/*`, `*` and `/` are
 * dropped, so `src/auth/**` is the prefix `src/auth`. Null when the input is not a valid area.
 */
export function validArea(x: unknown): string[] | null {
  if (!Array.isArray(x) || x.length < 1 || x.length > 8) return null;
  const out: string[] = [];
  for (const raw of x) {
    if (typeof raw !== "string" || raw.length > 200) return null;
    if (!/^[A-Za-z0-9._/*@-]+$/.test(raw) || raw.includes("..") || raw.startsWith("/") || raw.startsWith("-")) return null;
    const p = raw.replace(/\/?\*+$/, "").replace(/\/+$/, "");
    if (!p || p === "." || p.includes("*")) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Two areas overlap when one prefix is the other or sits inside it, on path boundaries (`src/a` does not cover `src/ab`). */
export function areasOverlap(a: string[], b: string[]): boolean {
  return a.some((p) => b.some((q) => p === q || p.startsWith(q + "/") || q.startsWith(p + "/")));
}

/** How far a budget has been used: the larger of tokens and wall time, as a fraction. Null when the budget sets neither. */
function budgetRatio(b: Budget, s: Spent): number | null {
  const r: number[] = [];
  if (b.tokens) r.push(s.tokens / b.tokens);
  if (b.minutes) r.push(s.ms / (b.minutes * 60_000));
  return r.length ? Math.max(...r) : null;
}

export function budgetState(b: Budget, s: Spent): "ok" | "near" | "over" {
  const r = budgetRatio(b, s) ?? 0;
  return r >= 1 ? "over" : r >= 0.8 ? "near" : "ok";
}

/** Whole percent used, for the digest's "goal 41%". 0 when the budget sets no limit. */
export function budgetPct(b: Budget, s: Spent): number {
  return Math.floor((budgetRatio(b, s) ?? 0) * 100);
}

export function addSpent(s: Spent, tokens: number, ms: number): Spent {
  return { tokens: s.tokens + tokens, ms: s.ms + ms, turns: s.turns + 1 };
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, undefined, { numeric: true });

/**
 * Which todo tasks go to which idle builders this tick. Tasks in id order, builders in role order.
 * A task needs every dependency done, and its area must not overlap a working, review or blocked
 * task, nor a task picked earlier in this same call. At most `freeSlots` picks.
 */
export function pickAssignments(t: Team, freeSlots: number): { task: string; role: string }[] {
  const picks: { task: string; role: string }[] = [];
  const busy = t.tasks.filter((x) => x.status === "working" || x.status === "review" || x.status === "blocked").flatMap((x) => x.area);
  const done = new Set(t.tasks.filter((x) => x.status === "done").map((x) => x.id));
  const idle = t.roles.filter((r) => r.kind === "builder" && r.state === "idle");
  for (const task of t.tasks.filter((x) => x.status === "todo").sort(byId)) {
    if (picks.length >= freeSlots || idle.length === picks.length) break;
    if (!task.deps.every((d) => done.has(d))) continue;
    if (areasOverlap(task.area, busy)) continue;
    const role = idle.find((r) => !picks.some((p) => p.role === r.id));
    if (!role) break;
    picks.push({ task: task.id, role: role.id });
    busy.push(...task.area);
  }
  return picks;
}

// ---- what agents read -------------------------------------------------------------

const short = (id: string) => id.replace(/^builder-/, "B");
const nameOf = (t: Team, id: string) => (id === "you" ? "you" : t.roles.find((r) => r.id === id)?.name ?? id);
const taskOf = (t: Team, id?: string) => (id ? t.tasks.find((x) => x.id === id) : undefined);

/**
 * The short status line an agent reads on poll or wake. Server-built, capped at DIGEST_CAP.
 * Unread messages are agent text, so they go in wrapped as <team-message>, five at most, and
 * only as many as fit: the task, board and budget lines always make it.
 */
export function digestFor(t: Team, role: TeamRole, inbox: TeamEvent[]): string {
  const mine = taskOf(t, role.taskId);
  const who = (x: TeamTask) => x.id + (x.assignee ? `(${short(x.assignee)})` : "");
  const group = (s: string, f: (x: TeamTask) => string = (x) => x.id) => {
    const xs = t.tasks.filter((x) => x.status === s).map(f);
    return xs.length ? xs.join(" ") : "-";
  };
  const fixed = [
    `[team] ${role.name}.${mine ? ` Your task: ${mine.id} "${mine.title.slice(0, 80)}" (${mine.status}).` : ""}`,
    `Board: todo ${group("todo")} | working ${group("working", who)} | review ${group("review", who)} | blocked ${group("blocked")} | done ${group("done")}.`,
    `Budget: goal ${budgetPct(t.budget, t.spent)}%, you ${budgetPct(role.budget, role.spent)}%.`,
  ];
  const tail = "Act or end your turn.";
  const reserve = 30; // room for "(N more unread)"
  let used = fixed.join("\n").length + tail.length + reserve + 2;
  const unread: string[] = [];
  for (const e of inbox.slice(0, 5)) {
    const line = `<team-message from="${nameOf(t, e.from)}">${e.text.slice(0, 200)}</team-message>`;
    if (used + line.length + 1 > DIGEST_CAP) break;
    unread.push(line);
    used += line.length + 1;
  }
  if (inbox.length > unread.length) unread.push(`(${inbox.length - unread.length} more unread)`);
  return [...fixed, ...unread, tail].join("\n").slice(0, DIGEST_CAP);
}

/** The first message to a builder for a task: goal, task, allowed paths, the dependencies' summaries. No transcript. */
export function briefFor(_t: Team, task: TeamTask, goalLine: string, depSummaries: string[]): string {
  const parts = [
    `Team goal: ${goalLine.slice(0, 300)}`,
    `Your task ${task.id}: ${task.title.slice(0, 80)}`,
    task.brief.slice(0, 1200),
    `You may change only these paths: ${task.area.join(", ")}. For anything else, use recall. Finish with submit_result and a short summary. Do not commit.`,
  ];
  if (depSummaries.length) parts.push(`Work this task builds on:\n${depSummaries.slice(0, 8).map((s) => `- ${s.slice(0, 200)}`).join("\n")}`);
  return parts.join("\n\n").slice(0, BRIEF_CAP);
}

/** The message to a reviewer: brief, builder summary, diff stat and the diff itself, capped at 24 KB (bytes). */
export function reviewMessageFor(t: Team, task: TeamTask, stat: string, diff: string, truncated: boolean): string {
  let body = diff;
  let cut = truncated;
  if (Buffer.byteLength(body) > REVIEW_DIFF_CAP) {
    body = Buffer.from(body).subarray(0, REVIEW_DIFF_CAP).toString("utf8");
    cut = true;
  }
  return [
    `Review ${task.id}: ${task.title.slice(0, 80)} (goal: ${t.goal.slice(0, 200)})`,
    `Brief: ${task.brief.slice(0, 1200)}`,
    `Builder summary: ${(task.summary ?? "").slice(0, 600)}`,
    `Changed:\n${stat.slice(0, 2000)}`,
    `Diff:\n${body}${cut ? "\n… the diff is cut at 24 KB. Read the files for the rest." : ""}`,
    "Finish with submit_result: verdict approve or changes, and notes if changes.",
  ].join("\n\n");
}

/**
 * Why the Lead should be woken, or null. `inbox` is the events since the Lead's last wake.
 * State checks (all done, stalled) only fire after 30 s without any change, so they do not
 * race the agents that are still working.
 */
export function wakeNeeded(t: Team, inbox: TeamEvent[], now: number): string | null {
  for (const e of inbox) {
    const task = taskOf(t, e.task);
    if ((e.kind === "message" || e.kind === "you") && e.to === "lead") return `message from ${nameOf(t, e.from)}`;
    if (e.kind === "budget") return "budget";
    if (e.kind === "task" && task?.status === "blocked") return `${task.id} blocked`;
    if (e.kind === "task" && task && task.rounds >= 2 && task.review?.verdict === "changes") return `${task.id} rejected twice`;
    if (e.kind === "state" && t.roles.find((r) => r.id === e.from)?.kind === "builder" && t.roles.find((r) => r.id === e.from)?.state === "stopped") {
      return `${nameOf(t, e.from)} stopped without submitting`;
    }
    if (e.from === "tester" && (e.kind === "task" || e.kind === "message")) return "Tester result";
  }
  const quiet = now - t.updated >= 30_000;
  const moving = t.roles.some((r) => r.state === "working" || r.state === "queued") || t.tasks.some((x) => x.status === "working" || x.status === "review");
  if (t.status === "running" && quiet && !moving) {
    if (t.tasks.length > 0 && t.tasks.every((x) => x.status === "done")) return "all tasks done, no finish";
    if (pickAssignments(t, MAX_BUILDERS).length === 0) return "stalled";
  }
  return null;
}

// ---- roles ------------------------------------------------------------------------

const ROLE_SETTINGS: Record<RoleKind, { model: string; effort: Effort; mode: Mode; allowRules: string[]; budget: Budget; prompt: string }> = {
  lead: {
    model: "sonnet", effort: "high", mode: "plan",
    allowRules: ["mcp__team__*", "mcp__brain__*", "Read", "Grep", "Glob"],
    budget: { tokens: 300_000, minutes: 30 },
    prompt: "You lead a team of AI agents on one project. Split the goal into small tasks with create_task, naming the paths each task may change. Use poll to read the board, and wait only when you have nothing to do. Do not edit files yourself, and never call ExitPlanMode. When every task is merged, call finish with a short summary.",
  },
  builder: {
    model: "haiku", effort: "low", mode: "acceptEdits",
    allowRules: ["mcp__team__*", "mcp__brain__recall"],
    budget: { tokens: 200_000, minutes: 20 },
    prompt: "You build one task on a team. Change only the paths in your brief. Finish with submit_result and a short summary. Do not commit; the server does it. Answer the Lead with message when asked.",
  },
  reviewer: {
    model: "sonnet", effort: "medium", mode: "default",
    allowRules: ["Read", "Grep", "Glob", "mcp__team__*"],
    budget: { tokens: 100_000, minutes: 10 },
    prompt: "You review one task's diff for a team. Read the brief and the diff. Reply with submit_result: verdict approve or changes, and short notes on what to change. Do not edit files.",
  },
  tester: {
    model: "haiku", effort: "low", mode: "acceptEdits",
    allowRules: ["mcp__team__*"],
    budget: { tokens: 100_000, minutes: 10 },
    prompt: "You test the team's integrated result: run the app and its checks. Reply with submit_result: verdict pass or fail, and what failed. Do not edit files.",
  },
};

export function roleSettings(kind: RoleKind): { model: string; effort: Effort; mode: Mode; allowRules: string[]; budget: Budget; prompt: string } {
  const r = ROLE_SETTINGS[kind];
  return { ...r, allowRules: [...r.allowRules], budget: { ...r.budget } };
}

// ---- state files --------------------------------------------------------------------

/** What is stored per team. `secrets` holds each role's MCP token; it never leaves the server (teamView). */
export interface TeamFile {
  team: Team;
  secrets: Record<string, string>;
}

const teamFile = (id: string) => join(teamDir(id), "team.json");
const eventsFile = (id: string) => join(teamDir(id), "events.jsonl");
const ACTIVE: TeamStatus[] = ["running", "paused", "awaiting_approval", "landing"];

/** Written beside the target, then renamed over it, so a crash never leaves half a file. */
function writeAtomic(file: string, text: string): void {
  const tmp = join(dirname(file), `.${randomBytes(8).toString("hex")}.tmp`);
  writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
  renameSync(tmp, file);
}

function saveTeam(f: TeamFile): void {
  writeAtomic(teamFile(f.team.id), JSON.stringify(f, null, 2));
}

/** A new team on disk, in `running`, with one random token per role. */
export function newTeam(
  project: Workspace,
  goal: string,
  o: { maxAgents: number; gate: "final" | "each"; builders: number; reviewer: boolean; tester: boolean },
  base: string,
): TeamFile {
  if (!goal.trim()) throw new Error("the goal is empty");
  const id = randomBytes(6).toString("hex");
  const now = Date.now();
  const role = (rid: string, kind: RoleKind, name: string): TeamRole => {
    const s = roleSettings(kind);
    return { id: rid, kind, name, member: "", mode: s.mode, model: s.model, effort: s.effort, instructions: "", budget: s.budget, spent: { tokens: 0, ms: 0, turns: 0 }, state: "idle", line: "", since: now, inboxRead: 0 };
  };
  const builders = Math.min(MAX_BUILDERS, Math.max(1, Math.floor(o.builders)));
  const roles = [
    role("lead", "lead", "Lead"),
    ...Array.from({ length: builders }, (_, i) => role(`builder-${i + 1}`, "builder", `Builder ${i + 1}`)),
    ...(o.reviewer ? [role("reviewer", "reviewer", "Reviewer")] : []),
    ...(o.tester ? [role("tester", "tester", "Tester")] : []),
  ];
  const secrets = Object.fromEntries(roles.map((r) => [r.id, randomBytes(24).toString("base64url")]));
  const f: TeamFile = {
    team: {
      id, project: project.id, goal: goal.trim(),
      status: "running", created: now, updated: now,
      base, int: `kohlab/team-${id}`,
      maxAgents: Math.min(3, Math.max(1, Math.floor(o.maxAgents))), gate: o.gate,
      budget: { tokens: 1_200_000, minutes: 60 }, spent: { tokens: 0, ms: 0, turns: 0 },
      roles, tasks: [], needsYou: [], seq: 0, wakes: 0,
    },
    secrets,
  };
  mkdirSync(teamDir(id), { recursive: true, mode: 0o700 });
  saveTeam(f);
  return f;
}

export function readTeam(id: string): TeamFile | null {
  const file = teamFile(id);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as TeamFile) : null;
}

/** Teams that still run or wait on the owner. Finished teams stay on disk until the project is deleted. */
export function listActiveTeamIds(): string[] {
  const root = join(WORKS_DIR, "teams");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => ID.test(d))
    .filter((d) => ACTIVE.includes(readTeam(d)?.team.status as TeamStatus));
}

// Per-team queue: each withTeam call runs after the previous one for the same team.
const chains = new Map<string, Promise<unknown>>();

/** Runs fn on the team's file, then saves it (also when fn throws, so the event counter stays right). */
export function withTeam<T>(id: string, fn: (f: TeamFile) => T | Promise<T>): Promise<T> {
  teamDir(id);
  const prev = chains.get(id) ?? Promise.resolve();
  const run = prev.then(async () => {
    const f = readTeam(id);
    if (!f) throw new Error("no such team");
    try {
      return await fn(f);
    } finally {
      saveTeam(f);
    }
  });
  const tail = run.catch(() => {});
  chains.set(id, tail);
  void tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id);
  });
  return run;
}

/** Adds an event to events.jsonl and bumps the team's counter. Caller holds withTeam. Text is capped at 600. */
export function appendEvent(f: TeamFile, e: Omit<TeamEvent, "n" | "at">): TeamEvent {
  const ev: TeamEvent = { ...e, n: ++f.team.seq, at: Date.now(), text: e.text.slice(0, 600) };
  f.team.updated = ev.at; // every event is a change: the scheduler reads updated for "quiet"
  appendFileSync(eventsFile(f.team.id), JSON.stringify(ev) + "\n", { mode: 0o600 });
  // ponytail: rotation rewrites the whole file, once per 1000 events; fine at this size.
  if (ev.n > EVENTS_ROTATE_AT && ev.n % 1000 === 0) {
    const lines = readFileSync(eventsFile(f.team.id), "utf8").split("\n").filter(Boolean);
    writeAtomic(eventsFile(f.team.id), lines.slice(-EVENTS_KEEP).join("\n") + "\n");
  }
  return ev;
}

/** Events after `after` (their n), oldest first, at most `limit`. Malformed lines are skipped. */
export function readEvents(id: string, after: number, limit = 200): TeamEvent[] {
  const file = eventsFile(id);
  if (!existsSync(file)) return [];
  const out: TeamEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let ev: TeamEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.n > after) {
      out.push(ev);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The team as the API may show it. Tokens live beside it in TeamFile.secrets and are never copied here. */
export function teamView(f: TeamFile): Team {
  return structuredClone(f.team);
}

/** The role a token belongs to. Every token is hashed and compared in full, so timing does not show which one is close. */
export function findRoleByToken(f: TeamFile, token: string): TeamRole | null {
  if (typeof token !== "string" || !token) return null;
  const want = createHash("sha256").update(token).digest();
  let hit: TeamRole | null = null;
  for (const role of f.team.roles) {
    const secret = f.secrets[role.id];
    if (!secret) continue;
    const same = timingSafeEqual(createHash("sha256").update(secret).digest(), want);
    if (same && !hit) hit = role;
  }
  return hit;
}
