/**
 * Team mode (v2.8): a Lead, Builders, a Reviewer and a Tester work on one goal in the project's repository.
 * Every agent is a hidden chat workspace (chat.ts does the talking); this module plans, schedules, merges and lands.
 * The server drives: a 2 s tick reads what finished, sends the next message, and wakes the Lead only when it must.
 * Storage, digests, budgets and git live in team-store.ts and team-git.ts.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { chown, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NeedsYou, RoleKind, Spent, Team, TeamEvent, TeamRole, TeamTask } from "./team-types";
import type { Mode, Workspace } from "./types";
import { addSpent, appendEvent, areasOverlap, budgetState, briefFor, digestFor, findRoleByToken, listActiveTeamIds, newTeam, pickAssignments, readEvents, readTeam, reviewMessageFor, roleSettings, teamDir, teamView, validArea, wakeNeeded, withTeam, type TeamFile } from "./team-store";
import { addTree, commitAll, changedFiles, diffText, headOf, landSquash, mergeInto, mergeKeepingConflicts, removeTree, resetTree, type Who } from "./team-git";
import { eventsAfter, send as chatSend } from "./chat";
import { getAccount, usableBy } from "./accounts";
import { cleanRules } from "./policy";
import { audit, brainRoot, chatBusy, chatKillers, deleteWorkspace, getWorkspace, identityOf, loadState, mutateState, ownBase, worktreeIsClean, worktreePath, wsDir } from "./lib";

// ponytail: the scheduler is one 2 s interval per team and a global counter of busy agents; upgrade to a queue when teams multiply.
const TICK_MS = 2000;
const IDLE_MS = 60_000;
const WAKE_GAP_MS = 3000;
const MAX_WAKES = 40;
const MAX_CALLS = 300;
const CALL_WINDOW_MS = 10 * 60_000;
const MAX_MESSAGES = 20;
const messages = new Map<string, number[]>();
const DIFF_CAP = 24 * 1024;
/** The hard cap across all teams: agents that may run at once. ordinary chats are not counted (ponytail). */
const GLOBAL_CAP = Math.max(1, Math.floor(Number(process.env.KOHLAB_TEAM_MAX_AGENTS ?? 3)) || 3);
const LIVE: string[] = ["running", "paused", "awaiting_approval", "landing"];
const MODES: Mode[] = ["default", "acceptEdits", "auto", "plan", "full"];
const TOOL_KINDS: Record<string, RoleKind[]> = {
  create_task: ["lead"],
  assign: ["lead"],
  message: ["lead", "builder", "reviewer", "tester"],
  poll: ["lead", "builder", "reviewer", "tester"],
  wait: ["lead", "builder"],
  request_review: ["lead"],
  finish: ["lead"],
  submit_result: ["builder", "reviewer", "tester"],
};

/** A refusal the person or the agent can read: the status is the HTTP answer. */
export class TeamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---- in-memory state (lost on restart; resumeTeams re-queues what was running) ----

/** Member workspaces with a turn in flight from a team: the global cap counts these. */
const busy = new Set<string>();
/** The last event number read from each member's transcript, for its done lines. */
const cursors = new Map<string, number>();
/** When each member's last turn ended: the idle reaper's clock. */
const lastTurn = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
/** project id -> its live team id (one at a time). */
const activeByProject = new Map<string, string>();
const lastWake = new Map<string, number>();
const calls = new Map<string, number[]>();

const now = () => Date.now();
const str = (x: unknown, max: number): string => (typeof x === "string" ? x.trim().slice(0, max) : "");
const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e9 ? x : undefined);
const zero = (): Spent => ({ tokens: 0, ms: 0, turns: 0 });
const roleById = (t: Team, id: string | undefined) => (id ? t.roles.find((r) => r.id === id) : undefined);
const taskById = (t: Team, id: string | undefined) => (id ? t.tasks.find((x) => x.id === id) : undefined);
const nameOfRole = (t: Team, id: string) => roleById(t, id)?.name ?? id;
const inUse = (t: Team) => t.roles.filter((r) => r.state === "working").length;
const freeSlots = (t: Team) => Math.min(t.maxAgents - inUse(t), GLOBAL_CAP - busy.size);

/** A task's work is still the builder's: it has not been merged, nor left for a new builder. */
const pending = (t: Team, r: TeamRole) => {
  const task = taskById(t, r.taskId);
  return !!task && task.status !== "done";
};
/** The builder is in the middle of its task (a message reaches it now, not after the merge). */
const isWorking = (t: Team, r: TeamRole) => taskById(t, r.taskId)?.status === "working";

// ---- paths -------------------------------------------------------------------------

const memberId = (projectId: string, teamId: string, roleId: string) => `${projectId}-team-${teamId}-${roleId}`;
const builderBranch = (teamId: string, roleId: string) => `kohlab/team-${teamId}-${roleId}`;
/** Where a team's own folders sit: beside the project's agents, under the owner's root for isolated owners. */
const teamHome = (project: Workspace, teamId: string) => join(dirname(wsDir(project)), `team-${teamId}`);
const intTreeOf = (project: Workspace, teamId: string) => join(teamHome(project, teamId), "int");
const inArea = (file: string, area: string[]) =>
  area.some((a) => {
    const p = a.replace(/\/?\*+$/, "");
    return p === "" || file === p || file.startsWith(p + "/");
  });

// ---- store helpers -----------------------------------------------------------------

function log(f: TeamFile, e: { kind: TeamEvent["kind"]; from: string; to?: string; task?: string; text: string }): TeamEvent {
  return appendEvent(f, e);
}
function setState(r: TeamRole, state: TeamRole["state"], line?: string): void {
  r.state = state;
  if (line !== undefined) r.line = line.slice(0, 100);
  if (state === "working") r.since = now();
}
/** A task stops for a reason the Lead should hear about: the event carries the task, so the Lead's wake sees it blocked. */
function blockTask(f: TeamFile, task: TeamTask, why: string): void {
  task.status = "blocked";
  task.updated = now();
  log(f, { kind: "task", from: task.assignee ?? "lead", task: task.id, text: `${task.id} blocked: ${why}` });
}
function ask(t: Team, n: NeedsYou): void {
  t.needsYou = [...t.needsYou.filter((x) => !(x.kind === n.kind && x.task === n.task && x.role === n.role)), n].slice(-20);
}
function settle(t: Team, pred: (n: NeedsYou) => boolean): void {
  t.needsYou = t.needsYou.filter((n) => !pred(n));
}
/** A message to the Lead: the only thing that wakes it (with budgets and stalls, which the store's wakeNeeded reads). */
function toLead(f: TeamFile, from: string, text: string, task?: string): void {
  log(f, { kind: "message", from, to: "lead", task, text });
}
/** The events for a role after its last read; marks them read when asked. */
function unread(f: TeamFile, r: TeamRole, mark: boolean): TeamEvent[] {
  const all = readEvents(f.team.id, r.inboxRead, 500);
  if (mark && all.length) r.inboxRead = all[all.length - 1].n;
  return all.filter((e) => e.to === r.id);
}
function inboxText(f: TeamFile, r: TeamRole): string {
  const lines = unread(f, r, true).map((e) => `<team-message from="${nameOfRole(f.team, e.from)}">${e.text.slice(0, 600)}</team-message>`);
  return lines.length ? `${lines.join("\n")}\n\n` : "";
}
const lastN = (member: string): number => eventsAfter(member, 0).at(-1)?.n ?? 0;

// ---- workspaces ----------------------------------------------------------------------

/** The team's hidden agent workspace, made on first use: its tree is a worktree of the project's (or of the integration branch). */
async function ensureMember(f: TeamFile, r: TeamRole): Promise<Workspace> {
  const t = f.team;
  const project = await getWorkspace(t.project);
  if (!r.member) r.member = memberId(project.id, t.id, r.id);
  const id = r.member;
  if (!(await loadState()).workspaces.some((w) => w.id === id)) {
    const who = identityOf(project);
    const dir = join(dirname(wsDir(project)), id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (who) await chown(dir, who.uid, who.gid);
    const head = await headOf(intTreeOf(project, t.id), who);
    const branch = r.kind === "builder" ? builderBranch(t.id, r.id) : null;
    await addTree(worktreePath(project), join(dir, "tree"), branch, head, who);
    await mutateState((s) => {
      if (s.workspaces.some((w) => w.id === id)) return;
      s.workspaces.push({
        id,
        repo: project.repo,
        task: r.name,
        agent: "claude",
        created: now(),
        started: null,
        stopped: null,
        ownerId: project.ownerId,
        dir,
        asAgent: project.asAgent,
        chat: true,
        agentPinned: true,
        team: { id: t.id, role: r.id },
        brainDir: brainRoot(project),
      });
    });
  }
  return getWorkspace(id);
}

/** The member's settings for its role: model, effort, mode, notes (its prompt), account and rules. A fresh session starts in a new process. */
async function syncMember(f: TeamFile, r: TeamRole, fresh: boolean): Promise<Workspace> {
  const ws = await ensureMember(f, r);
  const s = roleSettings(r.kind);
  let account: string | undefined;
  if (r.account) {
    const a = getAccount(r.account);
    if (!a || a.provider !== "claude" || !usableBy(a, ws)) throw new TeamError(400, `${r.name} cannot use that sign-in.`);
    account = a.id;
  }
  if (fresh) chatKillers.get(ws.id)?.(); // a new session: the old process goes first
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === ws.id);
    if (!w) return;
    w.model = r.model ?? s.model;
    w.effort = r.effort ?? s.effort;
    w.permissionMode = r.mode ?? s.mode;
    w.account = account;
    w.notes = [s.prompt, r.instructions].filter(Boolean).join("\n\n").slice(0, 4000);
    w.allowRules = cleanRules(s.allowRules);
    if (fresh) w.chatSession = undefined;
  });
  return getWorkspace(ws.id);
}

// ---- the scheduler's pieces -------------------------------------------------------------

/** One turn's end: what it cost, and whether the role submitted. A builder that did not submit is blocked and the Lead is told. */
function finishTurn(f: TeamFile, r: TeamRole): void {
  const t = f.team;
  const m = r.member;
  const evs = eventsAfter(m, cursors.get(m) ?? 0);
  let tokens = 0;
  let ms = 0;
  let turns = 0;
  for (const e of evs) {
    if (e.kind !== "done") continue;
    turns++;
    ms += e.worked ?? 0;
    tokens += (e.tokens?.in ?? 0) + (e.tokens?.out ?? 0);
  }
  if (evs.length) cursors.set(m, evs[evs.length - 1].n);
  busy.delete(m);
  lastTurn.set(m, now());
  if (!turns) ms = now() - r.since;
  const task = taskById(t, r.taskId);
  const add = (s: Spent) => addSpent(s, tokens, ms);
  r.spent = add(r.spent);
  t.spent = add(t.spent);
  if (task) task.spent = add(task.spent);
  if (r.state !== "working") return;
  if (r.kind === "lead") return setState(r, "idle", "Waiting");
  if (task && task.status === "working") blockTask(f, task, "stopped without submitting");
  setState(r, "idle", "Stopped without submitting");
  toLead(f, r.id, `${r.name} stopped without submitting${task ? ` ${task.id}` : ""}.`, task?.id);
}

/** Pauses the team: running agents are stopped, and their turn is counted as lost. */
function pauseTeam(f: TeamFile, why: string): void {
  const t = f.team;
  t.status = "paused";
  for (const r of t.roles) {
    if (r.member && busy.has(r.member)) {
      chatKillers.get(r.member)?.();
      busy.delete(r.member);
    }
    if (r.state === "working" || r.state === "queued") setState(r, "paused", "Paused");
  }
  ask(t, { kind: "budget", text: why });
  log(f, { kind: "state", from: "you", text: why });
}

/** Lead wakes: the first is the goal. The store's wakeNeeded decides; a state-only wake (stall, all done) fires once per quiet spell. */
function maybeWake(f: TeamFile): void {
  const t = f.team;
  const lead = roleById(t, "lead");
  if (!lead || t.status !== "running" || (lead.state !== "idle" && lead.state !== "parked")) return;
  if (t.wakes >= MAX_WAKES) {
    if (!t.needsYou.some((n) => n.kind === "stalled")) ask(t, { kind: "stalled", text: "The Lead has been woken 40 times. Read the board, then talk to the Lead or stop the team." });
    return;
  }
  const inbox = unread(f, lead, false);
  if (!wakeNeeded(t, inbox, now())) return;
  if (!inbox.length && (lastWake.get(t.id) ?? 0) >= t.updated) return;
  if (now() - (lastWake.get(t.id) ?? 0) < WAKE_GAP_MS) return;
  lead.state = "queued";
  lastWake.set(t.id, now());
}

/** Sends a queued role its next message, after making its tree and session ready for that job. */
async function dispatch(f: TeamFile, r: TeamRole): Promise<void> {
  const t = f.team;
  const project = await getWorkspace(t.project);
  const who = identityOf(project);
  const intHead = await headOf(intTreeOf(project, t.id), who);
  const task = taskById(t, r.taskId);
  let ws: Workspace;
  let text: string;
  if (r.kind === "lead") {
    ws = await syncMember(f, r, false);
    await resetTree(worktreePath(ws), null, intHead, who);
    const inbox = unread(f, r, true);
    text = (t.wakes === 0 ? `[team] Goal: ${t.goal}\n` : "") + digestFor(t, r, inbox);
    t.wakes++;
  } else if (r.kind === "builder") {
    if (!task || task.status === "done") return setState(r, "idle", "Waiting");
    const dep = task.deps.map((d) => taskById(t, d)?.summary ?? "").filter(Boolean);
    if (task.review?.verdict === "changes" && task.rounds > 0) {
      ws = await syncMember(f, r, false);
      text = `${inboxText(f, r)}The reviewer asked for changes to ${task.id} (${task.title}):\n${task.review.notes}\n\nMake them in your tree, then call submit_result for ${task.id} again.`;
    } else if (task.conflict?.length) {
      ws = await syncMember(f, r, false);
      const other = t.tasks.find((x) => x.id !== task.id && x.status === "done" && x.files?.some((p) => task.conflict!.includes(p)));
      text = `Your work on ${task.id} conflicts with work already merged in ${task.conflict.join(", ")}. The conflict markers are in those files in your tree.${other ? ` ${other.id} (${other.summary ?? other.title}) is the other side.` : ""} Keep both intentions, remove the markers, then call submit_result for ${task.id}.`;
      task.status = "working";
    } else if (!task.base) {
      // a new task: a fresh session, on the integration branch's head
      ws = await syncMember(f, r, true);
      task.base = intHead;
      task.branch = builderBranch(t.id, r.id);
      await resetTree(worktreePath(ws), task.branch, intHead, who);
      text = briefFor(t, task, t.goal, dep);
    } else {
      ws = await syncMember(f, r, false);
      text = `${inboxText(f, r)}Continue ${task.id} where you stopped. Call submit_result when it is done.`;
    }
  } else if (r.kind === "reviewer") {
    if (!task || !task.head || !task.base) return setState(r, "idle", "Waiting");
    ws = await syncMember(f, r, true);
    await resetTree(worktreePath(ws), null, task.head, who);
    const d = await diffText(worktreePath(ws), task.base, task.head, DIFF_CAP, who);
    text = reviewMessageFor(t, task, d.stat, d.diff, d.truncated);
  } else {
    ws = await syncMember(f, r, true);
    await resetTree(worktreePath(ws), null, intHead, who);
    text = `${digestFor(t, r, unread(f, r, true))}\n\nTest the integrated work in your tree the way the person would use it. Then call submit_result with verdict pass or fail and a short summary.`;
  }
  if (chatBusy.has(ws.id)) return; // a turn is still in flight (a stale queue entry)
  cursors.set(ws.id, lastN(ws.id));
  busy.add(ws.id);
  setState(r, "working", r.kind === "lead" ? "Planning" : task ? `Working on ${task.id}` : "Working");
  try {
    await chatSend(ws.id, text.slice(0, 3000));
  } catch (e) {
    busy.delete(ws.id);
    setState(r, "error", (e as Error).message);
    toLead(f, r.id, `${r.name} could not start: ${(e as Error).message}`, task?.id);
  }
}

/** Merges an approved task into the integration branch. A first conflict hands the builder the markers; a second blocks the task for the Lead. */
async function mergeTask(f: TeamFile, task: TeamTask): Promise<void> {
  const t = f.team;
  const project = await getWorkspace(t.project);
  const who = identityOf(project);
  const intTree = intTreeOf(project, t.id);
  const b = roleById(t, task.assignee);
  const res = await mergeInto(intTree, task.branch!, `${task.id}: ${task.title}`, who);
  if (res.ok) return finishMerge(f, task, res.head);
  const other = t.tasks.find((x) => x.id !== task.id && x.status === "done" && x.files?.some((p) => res.files.includes(p)));
  const text = `${task.id} and ${other?.id ?? "the work already merged"} both changed ${res.files.join(", ")}.`;
  if (!task.conflict?.length) {
    // first conflict: the builder resolves it in its own tree, with the integration branch merged in
    task.conflict = res.files;
    task.status = "working";
    if (b?.member) await mergeKeepingConflicts(worktreePath(await getWorkspace(b.member)), t.int, who);
    if (b) setState(b, "queued", `Resolving ${task.id}`);
    ask(t, { kind: "conflict", task: task.id, text });
    log(f, { kind: "merge", from: b?.id ?? "lead", task: task.id, text });
    return;
  }
  task.conflict = res.files;
  blockTask(f, task, "still in conflict after a resolve");
  ask(t, { kind: "conflict", task: task.id, text });
  toLead(f, "lead", `${task.id} still conflicts after a resolve (${res.files.join(", ")}). Assign it again or split it.`, task.id);
}

function finishMerge(f: TeamFile, task: TeamTask, head: string): void {
  const t = f.team;
  task.status = "done";
  task.merged = head;
  task.conflict = undefined;
  task.updated = now();
  const b = roleById(t, task.assignee);
  if (b && b.taskId === task.id) b.taskId = undefined;
  settle(t, (n) => n.task === task.id);
  log(f, { kind: "merge", from: b?.id ?? "lead", task: task.id, text: `${task.id} merged${b ? ` (${b.name})` : ""}.` });
}

// ---- the tick ----------------------------------------------------------------------

async function step(f: TeamFile): Promise<void> {
  const t = f.team;
  for (const r of t.roles) if (r.member && busy.has(r.member) && !chatBusy.has(r.member)) finishTurn(f, r);

  // budgets: a role over its budget stops at once (mid-turn wall time, or tokens at the turn's end); a team over its goal budget pauses
  for (const r of t.roles) {
    if (!r.member || r.state === "budget") continue;
    const used: Spent = { ...r.spent, ms: r.spent.ms + (r.state === "working" ? now() - r.since : 0) };
    if (budgetState(r.budget, used) !== "over") continue;
    if (busy.has(r.member)) {
      chatKillers.get(r.member)?.();
      busy.delete(r.member);
    }
    const task = taskById(t, r.taskId);
    setState(r, "budget", "Budget used up");
    if (task && task.status === "working") blockTask(f, task, "the builder is over budget");
    ask(t, { kind: "budget", role: r.id, task: task?.id, text: `${r.name} used its budget. Raise it to let it go on.` });
    toLead(f, r.id, `${r.name} reached its budget.`, task?.id);
  }
  if (t.status === "running" && budgetState(t.budget, t.spent) === "over") pauseTeam(f, "The team used its goal budget. Raise it to continue.");
  if (t.status !== "running") return;

  // merges: a task the reviewer approved merges when the gate is the final one, or when the person clicked Merge
  for (const task of t.tasks) if (task.status === "review" && task.review?.verdict === "approve" && (t.gate === "final" || task.review.by === "you")) await mergeTask(f, task);

  maybeWake(f);

  // a reviewer job: the first task waiting for a review
  const reviewer = roleById(t, "reviewer");
  const waiting = t.tasks.find((x) => x.status === "review" && !x.review && x.head);
  if (reviewer && reviewer.state === "idle" && waiting) {
    reviewer.taskId = waiting.id;
    setState(reviewer, "queued", `Reviewing ${waiting.id}`);
  }

  // builders: the store's picks, with a builder still holding an unmerged task left out
  const view: Team = { ...t, roles: t.roles.map((r) => (r.kind === "builder" && r.state === "idle" && pending(t, r) ? { ...r, state: "working" as const } : r)) };
  for (const p of pickAssignments(view, freeSlots(t))) {
    const task = taskById(t, p.task);
    const b = roleById(t, p.role);
    if (task && b) assignTask(t, task, b);
  }

  // who runs next: reviewer, tester, lead, then builders
  const order = [...t.roles].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  for (const r of order) {
    if (r.state !== "queued" || freeSlots(t) <= 0) continue;
    if (r.member && busy.has(r.member)) continue;
    await dispatch(f, r);
  }

  // the idle reaper: a process no turn is using for a minute is stopped (it resumes with its session)
  for (const r of t.roles) {
    if (r.member && !busy.has(r.member) && (lastTurn.get(r.member) ?? 0) < now() - IDLE_MS) {
      chatKillers.get(r.member)?.();
      lastTurn.delete(r.member);
    }
  }
}

const rank = (r: TeamRole) => ({ reviewer: 0, tester: 1, lead: 2, builder: 3 })[r.kind];

/** Gives a task to a builder. Used by the Lead, the person, and the scheduler. The builder starts it fresh on its next dispatch. */
function assignTask(t: Team, task: TeamTask, b: TeamRole): void {
  const old = roleById(t, task.assignee);
  if (old && old.id !== b.id && old.taskId === task.id) old.taskId = undefined;
  task.status = "working";
  task.assignee = b.id;
  task.base = undefined;
  task.head = undefined;
  task.review = undefined;
  task.rounds = 0;
  task.conflict = undefined;
  task.summary = undefined;
  task.files = undefined;
  task.updated = now();
  b.taskId = task.id;
  setState(b, "queued", `Starting ${task.id}`);
}

function ensureTicker(id: string): void {
  if (!timers.has(id)) timers.set(id, setInterval(() => tick(id), TICK_MS));
}
function clearTicker(id: string): void {
  const h = timers.get(id);
  if (h) clearInterval(h);
  timers.delete(id);
}
function sync(f: TeamFile): void {
  const t = f.team;
  if (LIVE.includes(t.status)) activeByProject.set(t.project, t.id);
  else if (activeByProject.get(t.project) === t.id) activeByProject.delete(t.project);
  if (t.status === "running") ensureTicker(t.id);
  else clearTicker(t.id);
}
/** Every change to a team goes through here: the file is locked, saved, and its ticker and project lock follow its status. */
function update<T>(id: string, fn: (f: TeamFile) => T | Promise<T>): Promise<T> {
  return withTeam(id, async (f) => {
    try {
      return await fn(f);
    } finally {
      sync(f);
    }
  });
}
function tick(id: string): void {
  if (!readTeam(id)) return clearTicker(id);
  update(id, step).catch((e) => console.warn(`[team] tick: ${(e as Error).message}`));
}
function kick(id: string): void {
  setTimeout(() => tick(id), 0);
}

// ---- agent tools (the server decides; the matrix is the same one team-mcp.cjs offers) ----

const refuse = (text: string) => ({ text, refused: true });
const ok = (text: string) => ({ text, refused: false });

async function toolOn(f: TeamFile, roleId: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; refused: boolean }> {
  const t = f.team;
  const r = roleById(t, roleId);
  if (!r) return refuse("This tool is not available to your role.");
  if (t.status === "stopped" || (t.status === "paused" && tool !== "poll") || ["stopped", "paused", "budget"].includes(r.state)) return refuse("Stop now. The team is paused or your budget is used up.");
  switch (tool) {
    case "create_task": {
      const title = str(args.title, 80);
      const brief = str(args.brief, 1200);
      const area = validArea(args.area);
      if (!title || !brief) return refuse("A task needs a title and a brief.");
      if (!area) return refuse("Area must be paths inside the project, such as src/auth/** or README.md.");
      if (t.tasks.length >= 30) return refuse("The board has 30 tasks already. Finish the ones there first.");
      const deps = Array.isArray(args.deps) ? args.deps.map(String).slice(0, 8) : [];
      if (deps.some((d) => !taskById(t, d))) return refuse("A dependency is not a task on the board.");
      const id = `T${t.tasks.length + 1}`;
      t.tasks.push({ id, title, brief, area, deps, status: "todo", rounds: 0, spent: zero(), created: now(), updated: now() });
      log(f, { kind: "tool", from: r.id, task: id, text: `${r.name} created ${id} '${title}' for ${area[0]}` });
      const b = roleById(t, str(args.builder, 20));
      if (b && b.kind === "builder") {
        const why = assignError(t, taskById(t, id)!, b);
        if (why) return ok(`Created ${id}. Not assigned: ${why}`);
        assignTask(t, taskById(t, id)!, b);
        return ok(`Created ${id} and gave it to ${b.name}.`);
      }
      return ok(`Created ${id}.`);
    }
    case "assign": {
      const task = taskById(t, str(args.task, 10));
      const b = roleById(t, str(args.builder, 20));
      if (!task) return refuse("No such task.");
      if (!b || b.kind !== "builder") return refuse("No such builder.");
      const why = assignError(t, task, b);
      if (why) return refuse(why);
      assignTask(t, task, b);
      log(f, { kind: "tool", from: r.id, task: task.id, text: `${r.name} gave ${task.id} to ${b.name}` });
      return ok(`${task.id} is with ${b.name}.`);
    }
    case "message": {
      const to = str(args.to, 20);
      const text = str(args.text, 600);
      if (!text) return refuse("The message is empty.");
      if (to === "you") {
        if (r.kind !== "lead") return refuse("Only the Lead writes to the person.");
        log(f, { kind: "message", from: r.id, to: "you", text });
        ask(t, { kind: "ask", role: r.id, text });
        return ok("Sent to the person.");
      }
      const target = roleById(t, to);
      if (!target) return refuse("No such role.");
      if (r.kind !== "lead" && target.kind !== "lead") return refuse("Write to the Lead. Only the Lead writes to other roles.");
      log(f, { kind: "message", from: r.id, to: target.id, text });
      if (r.kind === "lead" && target.kind === "builder" && isWorking(t, target) && (target.state === "idle" || target.state === "parked")) setState(target, "queued", target.line);
      return ok(`Sent to ${target.name}.`);
    }
    case "poll": {
      const inbox = unread(f, r, true);
      return ok(digestFor(t, r, inbox));
    }
    case "wait": {
      setState(r, "parked", "Waiting");
      return ok("Parked. End your turn now; you will be woken.");
    }
    case "request_review": {
      const id = str(args.task, 10);
      if (id === "final") return refuse("There is no separate final review yet. Call finish when every task is done; a Tester runs first if the team has one.");
      const task = taskById(t, id);
      if (!task || task.status !== "blocked" || !task.head) return refuse("Only a blocked task with a submitted result can be sent for review again.");
      task.status = "review";
      task.review = undefined;
      task.updated = now();
      if (!roleById(t, "reviewer")) task.review = { verdict: "approve", notes: "", by: "auto", at: now() };
      log(f, { kind: "task", from: r.id, task: id, text: `${id} is up for review again.` });
      return ok(`${id} is up for review.`);
    }
    case "finish": {
      const summary = str(args.summary, 800);
      const left = t.tasks.filter((x) => x.status !== "done");
      if (!t.tasks.length || left.length) return refuse(`Every task must be done first. Left: ${left.map((x) => `${x.id} (${x.status})`).join(", ") || "no tasks yet"}.`);
      const tester = roleById(t, "tester");
      log(f, { kind: "state", from: r.id, text: `The Lead finished: ${summary}` });
      if (tester) {
        setState(tester, "queued", "Testing");
        return ok("Finished. The Tester runs next.");
      }
      t.status = "awaiting_approval";
      ask(t, { kind: "approve", text: "The team finished. Approve to bring its work into your project." });
      return ok("Finished. The person reviews the result next.");
    }
    case "submit_result":
      return submit(f, r, args);
    default:
      return refuse("This tool is not available to your role.");
  }
}

function assignError(t: Team, task: TeamTask, b: TeamRole): string | null {
  if (task.status !== "todo" && task.status !== "blocked") return `${task.id} is already ${task.status}.`;
  if (task.deps.some((d) => taskById(t, d)?.status !== "done")) return `${task.id} waits for work it depends on.`;
  const current = taskById(t, b.taskId);
  if (b.state !== "idle" || (current && current.id !== task.id && current.status !== "done")) return `${b.name} is busy.`;
  const running = t.tasks.find((x) => x.id !== task.id && (x.status === "working" || x.status === "review") && areasOverlap(x.area, task.area));
  if (running) return `${task.id} overlaps ${running.id}, which is running. Wait for it.`;
  return null;
}

/** submit_result, by the role's kind: a builder's task (committed, checked against its paths), a review, or a test. */
async function submit(f: TeamFile, r: TeamRole, args: Record<string, unknown>): Promise<{ text: string; refused: boolean }> {
  const t = f.team;
  const summary = str(args.summary, 600);
  const task = taskById(t, r.taskId);
  if (r.kind === "builder") {
    if (!task || task.status !== "working" || task.assignee !== r.id) return refuse("You have no task to submit.");
    const project = await getWorkspace(t.project);
    const who = identityOf(project);
    const ws = await getWorkspace(r.member);
    const { head } = await commitAll(worktreePath(ws), `${task.id}: ${task.title}`, who);
    const files = await changedFiles(worktreePath(ws), task.base!, who);
    const outside = files.filter((p) => !inArea(p, task.area));
    if (outside.length) return refuse(`You changed files outside your area: ${outside.slice(0, 8).join(", ")}. Revert them or message the Lead.`);
    task.head = head;
    task.files = files.slice(0, 200);
    task.summary = summary;
    task.status = "review";
    task.review = undefined;
    task.updated = now();
    setState(r, "idle", `Waiting for review of ${task.id}`);
    log(f, { kind: "task", from: r.id, task: task.id, text: `${task.id} is ready for review: ${summary}` });
    if (!roleById(t, "reviewer")) {
      task.review = { verdict: "approve", notes: "", by: "auto", at: now() };
      if (t.gate === "each") ask(t, { kind: "approve", task: task.id, text: `${task.id} is ready to merge.` });
    }
    return ok(`Submitted ${task.id}.`);
  }
  if (r.kind === "reviewer") {
    if (!task || task.status !== "review") return refuse("You have no review to give.");
    const verdict = args.verdict === "approve" ? "approve" : args.verdict === "changes" ? "changes" : null;
    if (!verdict) return refuse("The verdict is approve or changes.");
    const notes = str(args.notes, 1500);
    task.review = { verdict, notes, by: r.id, at: now() };
    task.updated = now();
    setState(r, "idle", "Waiting");
    log(f, { kind: "task", from: r.id, task: task.id, text: `${r.name} ${verdict === "approve" ? "approved" : "asked for changes to"} ${task.id}${notes ? `: ${notes.slice(0, 200)}` : ""}` });
    if (verdict === "approve") {
      if (t.gate === "each") ask(t, { kind: "approve", task: task.id, text: `${task.id} is approved and ready to merge.` });
      return ok("Approved.");
    }
    task.rounds++;
    const builder = roleById(t, task.assignee);
    if (task.rounds >= 2 || !builder) {
      blockTask(f, task, "sent back for changes twice");
      toLead(f, r.id, `${task.id} was sent back for changes twice. Assign it again or split it.`, task.id);
    } else {
      task.status = "working";
      setState(builder, "queued", `Changes to ${task.id}`);
    }
    return ok("Sent back for changes.");
  }
  // the Tester
  const verdict = args.verdict === "pass" ? "pass" : args.verdict === "fail" ? "fail" : null;
  if (!verdict) return refuse("The verdict is pass or fail.");
  setState(r, "idle", verdict === "pass" ? "Passed" : "Failed");
  log(f, { kind: "task", from: r.id, text: `Tester ${verdict === "pass" ? "passed" : "failed"} the work: ${summary}` });
  if (verdict === "pass" || r.spent.turns >= 2) {
    t.status = "awaiting_approval";
    ask(t, { kind: "approve", text: "The team finished and the Tester passed it. Approve to bring its work into your project." });
  } else {
    toLead(f, r.id, `Tester failed the work: ${summary}`);
  }
  return ok("Result sent.");
}

// ---- the public surface: teams for the routes, the agent tools, the MCP config, boot ------------

/** The project's live team, or the latest one. */
function currentTeam(projectId: string): string | null {
  return activeByProject.get(projectId) ?? teamIdsOf(projectId)[0] ?? null;
}
function teamIdsOf(projectId: string): string[] {
  const root = dirname(teamDir("000000000000"));
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((id) => readTeam(id))
    .filter((f): f is TeamFile => !!f && f.team.project === projectId)
    .sort((a, b) => b.team.created - a.team.created)
    .map((f) => f.team.id);
}

/** A project with a live team: its own chat is locked until the team is stopped, landed or closed. */
export function teamActive(projectId: string): boolean {
  return activeByProject.has(projectId);
}

/** The team view for a project (no secrets), and the events after `after`. */
export function teamGet(projectId: string, after: number): { team: Team | null; events: TeamEvent[] } {
  const id = currentTeam(projectId);
  const f = id ? readTeam(id) : null;
  if (!f) return { team: null, events: [] };
  return { team: teamView(f), events: readEvents(f.team.id, after, 200) };
}

/** The MCP server config for a team agent: the team tools, with the role's own token and kind. Null when node, the address or the team is missing. */
export async function teamMcp(ws: Workspace): Promise<Record<string, { command: string; args: string[]; env: Record<string, string> }> | null> {
  const node = Bun.which("node");
  const base = ownBase();
  if (!node || !base || !ws.team) return null;
  const f = readTeam(ws.team.id);
  const r = f ? roleById(f.team, ws.team.role) : undefined;
  const token = f?.secrets[ws.team.role];
  if (!f || !r || !token) return null;
  return { team: { command: node, args: [join(import.meta.dir, "team-mcp.cjs")], env: { KOHLAB_TEAM_URL: `${base}/api/team-tool/${f.team.id}`, KOHLAB_TEAM_TOKEN: token, KOHLAB_TEAM_ROLE: r.kind } } };
}

/** POST /api/team-tool/<team>, from an agent's team MCP server. The role comes from its token; a wrong team or token is the same 404. */
export async function teamToolCall(teamId: string, token: string, body: { tool?: unknown; args?: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  const f0 = readTeam(teamId);
  const role = f0 ? findRoleByToken(f0, token) : null;
  if (!f0 || !role || !role.member) return { status: 404, body: { error: "not found" } };
  const key = `${teamId}:${role.id}`;
  const recent = (calls.get(key) ?? []).filter((x) => now() - x < CALL_WINDOW_MS);
  calls.set(key, recent);
  if (recent.length >= MAX_CALLS) return { status: 429, body: { text: "Too many team calls. Wait a few minutes.", refused: true } };
  recent.push(now());
  const tool = String(body.tool ?? "");
  if (tool === "message") {
    const msgs = (messages.get(key) ?? []).filter((x) => now() - x < CALL_WINDOW_MS);
    messages.set(key, msgs);
    if (msgs.length >= MAX_MESSAGES) return { status: 200, body: { text: "You have sent many messages. Keep working and use poll.", refused: true } };
    msgs.push(now());
  }
  if (!TOOL_KINDS[tool]?.includes(role.kind)) return { status: 200, body: { text: "This tool is not available to your role.", refused: true } };
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
  const out = await update(teamId, (f) => toolOn(f, role.id, tool, args));
  kick(teamId);
  return { status: 200, body: { text: out.text, refused: out.refused } };
}

/** The user's team actions, from the Team tab. Refusals are TeamError. Owners only: full access for a role. */
export async function teamPost(projectId: string, body: Record<string, unknown>, who: { owner: boolean; actor: string }): Promise<Record<string, unknown>> {
  const action = String(body.action ?? "");
  if (action === "start") return startTeam(projectId, body, who);
  const id = currentTeam(projectId);
  if (!id) throw new TeamError(404, "There is no team on this project.");
  const result = await update(id, (f) => userAction(f, action, body, who));
  audit(who.actor, `team.${action}`, projectId, str(body.role ?? body.task, 40) || undefined).catch(() => {});
  kick(id);
  return { ...teamGet(projectId, Number(body.after) || 0), ...result };
}

async function startTeam(projectId: string, body: Record<string, unknown>, who: { owner: boolean; actor: string }): Promise<Record<string, unknown>> {
  const project = await getWorkspace(projectId);
  if (activeByProject.has(projectId)) throw new TeamError(409, "A team is already working on this project. Open Team, or stop it first.");
  const goal = str(body.goal, 2000);
  if (!goal) throw new TeamError(400, "Say what the team should do.");
  if (!(await worktreeIsClean(projectId))) throw new TeamError(409, "Keep or undo your changes first.");
  const maxAgents = Math.min(GLOBAL_CAP, Math.max(1, Math.floor(Number(body.maxAgents ?? 2)) || 2));
  const builders = Math.min(4, Math.max(1, Math.floor(Number(body.builders ?? 2)) || 2));
  const gate = body.gate === "each" ? "each" : "final";
  const who0 = identityOf(project);
  const base = await headOf(worktreePath(project), who0);
  const f = newTeam(project, goal, { maxAgents, gate, builders, reviewer: body.reviewer !== false, tester: body.tester === true }, base);
  const id = f.team.id;
  await mkdir(teamHome(project, id), { recursive: true, mode: 0o700 });
  if (who0) await chown(teamHome(project, id), who0.uid, who0.gid);
  await addTree(worktreePath(project), intTreeOf(project, id), f.team.int, base, who0);
  audit(who.actor, "team.start", projectId, goal.slice(0, 80)).catch(() => {});
  await update(id, (g) => {
    const lead = roleById(g.team, "lead");
    if (lead) setState(lead, "queued", "Starting");
    log(g, { kind: "state", from: "you", text: `Team started: ${goal.slice(0, 200)}` });
  });
  kick(id);
  return teamGet(projectId, 0);
}

async function userAction(f: TeamFile, action: string, body: Record<string, unknown>, who: { owner: boolean; actor: string }): Promise<Record<string, unknown>> {
  const t = f.team;
  switch (action) {
    case "pause": {
      const rid = str(body.role, 20);
      if (rid) {
        const r = roleById(t, rid);
        if (!r) throw new TeamError(404, "No such role.");
        if (r.member && busy.has(r.member)) {
          chatKillers.get(r.member)?.();
          busy.delete(r.member);
        }
        if (r.state === "working" || r.state === "queued") setState(r, "paused", "Paused");
        return { ok: true };
      }
      if (t.status !== "running") throw new TeamError(409, "The team is not running.");
      pauseTeam(f, "Paused by you.");
      return { ok: true };
    }
    case "resume": {
      const rid = str(body.role, 20);
      if (rid) {
        const r = roleById(t, rid);
        if (!r || r.state !== "paused") throw new TeamError(409, "That role is not paused.");
        setState(r, "queued", "Resuming");
        return { ok: true };
      }
      if (t.status !== "paused") throw new TeamError(409, "The team is not paused.");
      t.status = "running";
      for (const r of t.roles) if (r.state === "paused") setState(r, "queued", "Resuming");
      return { ok: true };
    }
    case "stop": {
      const rid = str(body.role, 20);
      if (rid) {
        const r = roleById(t, rid);
        if (!r) throw new TeamError(404, "No such role.");
        if (r.member && busy.has(r.member)) {
          chatKillers.get(r.member)?.();
          busy.delete(r.member);
        }
        setState(r, "stopped", "Stopped");
        return { ok: true };
      }
      t.status = "stopped";
      for (const r of t.roles) {
        if (r.member && busy.has(r.member)) {
          chatKillers.get(r.member)?.();
          busy.delete(r.member);
        }
        if (["working", "queued", "paused", "parked"].includes(r.state)) setState(r, "stopped", "Stopped");
      }
      t.needsYou = [];
      log(f, { kind: "state", from: "you", text: "Stopped by you." });
      return { ok: true };
    }
    case "land": {
      if (t.status !== "awaiting_approval") throw new TeamError(409, "Nothing is waiting to come into the project.");
      const project = await getWorkspace(t.project);
      const who0 = identityOf(project);
      const parent = worktreePath(project);
      if (!(await isAncestor(parent, t.base, who0))) throw new TeamError(409, "The project changed in a way the team's work does not fit. Undo the team.");
      t.status = "landing";
      const r = await landSquash(parent, t.int, t.base, who0);
      if (r.ok) {
        t.status = "done";
        t.needsYou = [];
        log(f, { kind: "merge", from: "you", text: `Brought ${r.files.length} file${r.files.length === 1 ? "" : "s"} into your project. Keep or undo them there.` });
        return { ok: true, files: r.files };
      }
      t.status = "awaiting_approval";
      if (r.reason === "dirty") throw new TeamError(409, "Keep or undo your changes first.");
      ask(t, { kind: "conflict", text: "Your project changed while the team worked, so its work does not fit. Try again after you Keep your changes, or Undo the team." });
      return { ok: false, files: r.files ?? [] };
    }
    case "merge": {
      const task = taskById(t, str(body.task, 10));
      if (!task || task.status !== "review" || task.review?.verdict !== "approve") throw new TeamError(409, "That task is not waiting to merge.");
      task.review.by = "you";
      return { ok: true };
    }
    case "decide": {
      const task = taskById(t, str(body.task, 10));
      if (!task || task.status !== "blocked" || !task.conflict?.length) throw new TeamError(409, "That task has no conflict to decide.");
      const choice = str(body.choice, 10);
      if (choice === "lead") {
        toLead(f, "you", `The person left the conflict on ${task.id} to you.`, task.id);
        return { ok: true };
      }
      if (choice !== "builder" && choice !== "merged") throw new TeamError(400, "The choice is builder, merged or lead.");
      const project = await getWorkspace(t.project);
      const res = await mergeInto(intTreeOf(project, t.id), task.branch!, `${task.id}: ${task.title}`, identityOf(project), choice === "builder" ? "theirs" : "ours");
      if (!res.ok) throw new TeamError(409, `Still conflicting in ${res.files.join(", ")}.`);
      finishMerge(f, task, res.head);
      return { ok: true };
    }
    case "reassign": {
      const task = taskById(t, str(body.task, 10));
      const b = roleById(t, str(body.role ?? body.builder, 20));
      if (!task || !b || b.kind !== "builder") throw new TeamError(404, "No such task or builder.");
      const why = assignError(t, task, b);
      if (why) throw new TeamError(409, why);
      assignTask(t, task, b);
      return { ok: true };
    }
    case "say": {
      const r = roleById(t, str(body.role, 20));
      const text = str(body.text, 600);
      if (!r || !text) throw new TeamError(400, "Say who, and what.");
      log(f, { kind: "you", from: "you", to: r.id, text });
      if (r.kind === "lead" && (r.state === "idle" || r.state === "parked")) setState(r, "queued", r.line);
      if (r.kind === "builder" && isWorking(t, r) && (r.state === "idle" || r.state === "parked")) setState(r, "queued", r.line);
      return { ok: true };
    }
    case "role": {
      const r = roleById(t, str(body.role, 20));
      if (!r) throw new TeamError(404, "No such role.");
      const p = (body.patch && typeof body.patch === "object" ? body.patch : body) as Record<string, unknown>;
      if (p.mode !== undefined) {
        if (!MODES.includes(p.mode as Mode)) throw new TeamError(400, "That mode is not one a team uses.");
        if (p.mode === "full" && !who.owner) throw new TeamError(403, "Full access is only for the owner.");
        if (p.mode === "full") audit(who.actor, "ai.fullaccess", t.project, `team ${r.name}`).catch(() => {});
        r.mode = p.mode as Mode;
      }
      if (p.model !== undefined) r.model = str(p.model, 60) || undefined;
      if (p.effort !== undefined) r.effort = (["low", "medium", "high", "xhigh", "max"].includes(String(p.effort)) ? p.effort : undefined) as TeamRole["effort"];
      if (p.account !== undefined) r.account = str(p.account, 60) || undefined;
      if (p.instructions !== undefined) r.instructions = str(p.instructions, 1500);
      if (p.budget && typeof p.budget === "object") {
        const b = p.budget as Record<string, unknown>;
        r.budget = { ...(num(b.tokens) !== undefined ? { tokens: num(b.tokens) } : {}), ...(num(b.minutes) !== undefined ? { minutes: num(b.minutes) } : {}) };
        if (r.state === "budget") setState(r, "idle", "Waiting");
      }
      return { ok: true };
    }
    case "budget": {
      const b = (body.budget ?? {}) as Record<string, unknown>;
      const next = { ...(num(b.tokens) !== undefined ? { tokens: num(b.tokens) } : {}), ...(num(b.minutes) !== undefined ? { minutes: num(b.minutes) } : {}) };
      const rid = str(body.role, 20);
      if (rid) {
        const r = roleById(t, rid);
        if (!r) throw new TeamError(404, "No such role.");
        r.budget = next;
        if (r.state === "budget") setState(r, "idle", "Waiting");
        return { ok: true };
      }
      t.budget = next;
      return { ok: true };
    }
    case "close": {
      if (t.status === "running" || t.status === "paused" || t.status === "landing") throw new TeamError(409, "Stop the team first.");
      await removeTeamTrees(f);
      return { ok: true };
    }
    default:
      throw new TeamError(400, "That team action is not available.");
  }
}

/** Whether `base` is HEAD or one of its ancestors in the project. Hardened git, like team-git. */
function isAncestor(tree: string, base: string, who?: Who): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "safe.directory=*", "-C", tree, "merge-base", "--is-ancestor", base, "HEAD"],
      { uid: who?.uid, gid: who?.gid },
      (err) => resolve(!err),
    );
  });
}

/** Stops the team's agents and takes its worktrees, branches and agent workspaces away. The team file stays, finished. */
async function removeTeamTrees(f: TeamFile): Promise<void> {
  const t = f.team;
  const project = await getWorkspace(t.project).catch(() => null);
  for (const r of t.roles) {
    if (r.member && busy.has(r.member)) busy.delete(r.member);
    if (r.member) chatKillers.get(r.member)?.();
  }
  if (project) {
    const who = identityOf(project);
    const parent = worktreePath(project);
    for (const r of t.roles) {
      if (!r.member) continue;
      const exists = (await loadState()).workspaces.some((w) => w.id === r.member);
      if (exists) {
        await removeTree(parent, worktreePath(await getWorkspace(r.member)), r.kind === "builder" ? builderBranch(t.id, r.id) : null, who).catch(() => {});
        await deleteWorkspace(r.member).catch((e) => console.warn(`[team] member not removed: ${(e as Error).message}`));
      }
      r.member = "";
    }
    await removeTree(parent, intTreeOf(project, t.id), t.int, who).catch(() => {});
    await rm(teamHome(project, t.id), { recursive: true, force: true }).catch(() => {});
  }
  for (const r of t.roles) if (["working", "queued", "paused", "parked", "idle"].includes(r.state)) setState(r, "stopped", "Closed");
  t.status = "stopped";
  t.needsYou = [];
}

/** A project is being deleted: its teams' agents, branches and folders go with it. */
export async function teamCleanup(projectId: string): Promise<void> {
  for (const id of teamIdsOf(projectId)) {
    await update(id, (f) => removeTeamTrees(f)).catch((e) => console.warn(`[team] cleanup: ${(e as Error).message}`));
    clearTicker(id);
    await rm(teamDir(id), { recursive: true, force: true }).catch(() => {});
  }
  activeByProject.delete(projectId);
}

/** Boot: live teams are known again at once; agents that were mid-turn when the server stopped are queued to resume. */
export async function resumeTeams(): Promise<void> {
  for (const id of listActiveTeamIds()) {
    const f = readTeam(id);
    if (f) activeByProject.set(f.team.project, id);
    await update(id, (g) => {
      for (const r of g.team.roles) if (r.state === "working") setState(r, "queued", "Resuming");
    }).catch((e) => console.warn(`[team] resume: ${(e as Error).message}`));
  }
}
