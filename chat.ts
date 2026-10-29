/**
 * Chat workspaces: talk to the claude CLI through its JSON-lines mode, so the web
 * UI can show a chat with Allow / Don't allow buttons for risky actions. The
 * recipe is docs/spikes/claude-chat-protocol.mjs.
 *
 * ponytail: the claude process is a child of the server, so a server restart ends
 * it. The next message resumes the conversation with --resume, but a turn in
 * flight at restart is lost. Upgrade path: host it in the PTY daemon.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, chownSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import type { AiDefaults, AiResolved, Fallback, FallbackStep, LimitState, PermissionRule, Workspace } from "./types";
import { accountEnv, childEnv, clearLimit, configDirOf, envOfAccount, getAccount, laneKey, limitedUntil, listAccounts, markLimited, overlayOf, runAsOf, signedInOf, usableBy } from "./accounts";
import { RESET_FIELDS, resolveAi } from "./defaults";
import { PERSONAL_ASKS, claudeArgsFor, cleanRules, defaultSteps, describeRule, isMode, limitReached, ruleFor, validRule } from "./policy";
import { notifyNeedsYou } from "./push";
import { browserToolPolicy, browserUrl, writeBrowserMcp, type OwnPages } from "./browser";
import { devServerOrigin } from "./devserver";
import { goBackTo, snapshotTree, turnChanges, type TurnFile } from "./checkpoints";
import { ACP_AGENTS, AcpClient, acpStartFailure, isAcpAgent, type AcpHost } from "./acp";
import { chatBusy, chatBackground, resumeOpen, chatKillers, chatWaiting, audit, closeMain, getWorkspace, identityOf, isAlive, loadState, markStarted, mutateState, notifyWorkspaceDone, ownBase, parseModel, worktreeIsClean, worktreePath, brainRoot, ensureBrainToken } from "./lib";
import { rel, describeTool, toolFile, toolDetail, resultText, describeAsk, askForm, answerResponse, friendlyError, AGENT_NAMES, handoffText, noticeText, taskFinishedLine, clockText, MAX_TEXT } from "./chat-text";
import type { Body, ChatEvent, Todo } from "./chat-text";
import { chatsDir, transcriptPath, cursorPath, TAIL_BYTES, FIRST_IMPORT, transcriptFile, readCursor, writeCursor, HIDDEN_TOOLS, transcriptEvents } from "./chat-transcript";
import { noteDecision, noteHandoff, openRoot, summaryOf } from "./brain";
import { helperLabel, applyHelperLine, helpersNewTurn, helpersAtResult, helpersAtExit, doneFields } from "./chat-helpers";
import type { HelperNode } from "./chat-helpers";
import { HANDOFF_REQUEST, HANDOFF_CAP, extractHandoff, handoffHasWork, freshMessage, freshDecision } from "./chat-fresh";
export { describeTool, toolFile, toolDetail, resultText, describeAsk, askForm, answerResponse, friendlyError, handoffText, noticeText } from "./chat-text";
export type { AskQuestion, Body, ChatEvent, Todo } from "./chat-text";
export { transcriptEvents } from "./chat-transcript";
export { helperLabel, applyHelperLine, helpersNewTurn, helpersAtResult, helpersAtExit, doneFields } from "./chat-helpers";
export type { HelperNode } from "./chat-helpers";
export { FRESH_BANNER_PERCENT, FRESH_AUTO_PERCENT, HANDOFF_REQUEST, extractHandoff, handoffHasWork, freshMessage, freshDecision } from "./chat-fresh";

/** The environment a child agent gets: the allowlisted keys from the server's, its own HOME, and an account's own variables (accounts.ts). */
export { childEnv };

/** Appended to claude's system prompt: who it talks to, and the Preview / Keep / Undo buttons it can rely on. */
const CHAT_SYSTEM_PROMPT =
  "The person you are working with is not a programmer. Use plain, friendly language and avoid jargon. Write short plain sentences; avoid Markdown headings. " +
  "When a picture explains better than words (a chart, a diagram, a quick mockup), you may put a self-contained ```html block in your reply (inline CSS and JavaScript; libraries from a CDN are fine) or a ```mermaid diagram, and Kohlab draws it right in the chat; to show a picture from the project, use ![description](path/inside/project.png). " +
  "When they ask for something visual (a website, page, game or small tool), build it with plain HTML, CSS and JavaScript " +
  "and put an index.html at the project root, so it works by opening that file; use another technology only if they ask for it. " +
  "Kohlab shows them a Preview button that opens index.html, and Keep / Undo buttons to save or throw away your changes. " +
  "Never tell the person to open a file in their browser; tell them to press Preview. " +
  "Never mention git, commits, branches, repositories or terminals to the person. " +
  "Call the person's site \"your page\". Do not name files, folders or code (such as index.html) in what you say to them unless they ask. " +
  "When you finish, end with one short sentence saying what to look at in Preview. " +
  "Files the person attaches are saved in the uploads folder of the project; open them with your Read tool, and use pictures from there directly in the page when they ask for that. " +
  "When you run a command, always give it a short plain-English description of what it does and why. " +
  "You have a real browser that the person watches live: after you change a page, open it there and check it, using the http://127.0.0.1 address of a dev server you started, or else the project's Preview.";
/** The standing notes a chat gets: trimmed, "" when none. Only chat projects get them; a terminal's Claude keeps its own settings. Pure. */
export function notesOf(ws: Pick<Workspace, "chat" | "notes">): string {
  return ws.chat ? (ws.notes ?? "").trim() : "";
}

/** Claude's system prompt for a chat: the chat's rules, then the person's standing notes, then the project brain's summary. Pure. */
export function systemPromptFor(notes: string, brain = ""): string {
  const base = notes ? `${CHAT_SYSTEM_PROMPT} The person's standing notes for this project (always follow them): ${notes}` : CHAT_SYSTEM_PROMPT;
  return brain ? `${base}\n\n${brain}` : base;
}

/** The text put before the person's first message in a new ACP session: the notes and the brain's summary, or "" when none. Pure. */
export function notesMessagePrefix(notes: string, brain = ""): string {
  return [notes ? `Project notes from the person (always follow them):\n${notes}\n\n` : "", brain ? `${brain}\n\n` : ""].filter(Boolean).join("");
}

/** The brain's MCP server for a chat: node runs brain-mcp.cjs, which calls back to this server with the workspace's own token. Null when node, the server's address or the token is missing. */
async function brainMcp(ws: Workspace): Promise<Record<string, { command: string; args: string[]; env: Record<string, string> }> | null> {
  const node = Bun.which("node");
  const base = ownBase();
  if (!node || !base) return null;
  try {
    const token = await ensureBrainToken(ws.id);
    return { brain: { command: node, args: [join(import.meta.dir, "brain-mcp.cjs")], env: { KOHLAB_BRAIN_URL: `${base}/api/brain-tool/${ws.id}`, KOHLAB_BRAIN_TOKEN: token } } };
  } catch (e) {
    console.warn(`[brain] its tools are left out of this start: ${(e as Error).message}`);
    return null;
  }
}

/** An approved plan, kept as a Decision in the project brain. Chats only; a failure is logged and never blocks the approval. */
async function keepPlan(id: string, plan: string): Promise<void> {
  try {
    const ws = await getWorkspace(id);
    if (!ws.chat) return;
    const root = brainRoot(ws);
    openRoot(root, ws.task);
    noteDecision(root, plan);
  } catch (e) {
    console.warn(`[brain] plan not kept: ${(e as Error).message}`);
  }
}

/** The brain's size for the Run panel: its note count and the summary's tokens, or null when the AI gets no summary (or not a chat). Reads only. */
function brainStatOf(ws: Workspace): { notes: number; tokens: number } | null {
  if (!ws.chat) return null;
  try {
    const s = summaryOf(brainRoot(ws));
    return s.text ? { notes: s.notes, tokens: s.tokens } : null;
  } catch {
    return null;
  }
}

/** The project brain's summary for a chat's prompt: "" for a terminal project or on any error. Reads only: never creates the vault. */
export function brainSummaryOf(ws: Workspace): string {
  if (!ws.chat) return "";
  try {
    return summaryOf(brainRoot(ws)).text;
  } catch {
    return "";
  }
}

export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Live {
  child: ChildProcess;
  cwd: string;
  /** unanswered permission asks: requestId -> the tool and its input (echoed back on allow), and the rule an "Always allow" would save */
  asks: Map<string, { tool: string; input: Record<string, unknown>; always?: { rule: string; label: string } }>;
  /** Full access: Kohlab answers every permission ask itself (never AskUserQuestion or ExitPlanMode). Claude stays in its "default" mode. */
  fullAccess: boolean;
  /** the message sent with another model: the model to go back to when its turn ends (never written to the project) */
  restoreModel?: string;
  /** the person's own words for the message in flight, to send again after a usage limit moved the conversation on */
  rawMsg?: string;
  stderr: string;
  /** killed on purpose (stop or delete): its exit is not an error */
  stopping: boolean;
  closed: boolean;
  /** session id passed to --resume, until the CLI confirms it with its init line */
  resuming?: string;
  /** the message being answered, kept to retry once if the resume fails */
  msg?: string;
  /** Claude's reply so far, streamed as text arrives. In memory only: not persisted, not an event. */
  draft: string;
  /** the session this process writes to, from its init line */
  sid?: string;
  /** terminal projects: the home that holds Claude's transcript, so the turn's own lines can be skipped */
  transcriptHome?: string;
  /** when the current turn started (ms), by a send or by Claude itself; cleared at its result */
  busySince?: number;
  /** the plan's five-hour percent when the current turn started (from the last reading); the done line's planDelta is taken from it */
  planStart?: number;
  /** the project's notes (trimmed) this process was started with; changed notes restart it at the next send */
  notes: string;
  /** background tasks still running (Bash or helper runs), from the CLI's own list */
  tasks: BgTask[];
  /** the checklist Claude's last TodoWrite sent (the full list) */
  todos: Todo[];
  /** TaskCreate calls waiting for their result (which carries the id), by tool_use id */
  newTasks: Map<string, { subject: string; form?: string }>;
  /** helper agents still running, by tool_use id, with a label for each */
  helpers: Map<string, string>;
  /** the helper agents of the run view (tree), from the CLI's own lines. In memory only. */
  helperTree: HelperNode[];
  /** the tool names and tool servers the CLI reported in its init line; null until it has */
  tools: string[] | null;
  mcp: { name: string; status: string }[];
  /** the init line has come */
  inited?: boolean;
  /** tool_use ids whose line was shown, so their result can follow (and is dropped once it has) */
  shownTools: Set<string>;
  /** the CLI is retrying a failed request: which try, and how many tries in all */
  retry?: { attempt: number; max: number };
  /** the model and permission mode the CLI reports in its init line */
  model: string | null;
  mode: string | null;
  /** the permission mode in force before plan mode, restored when an approved plan leaves plan mode */
  beforePlan?: string;
  /** control requests waiting for the CLI's reply, by request id */
  pending: Map<string, Pending>;
  /** the init reply: the menus are known once it has come */
  ready?: Promise<unknown>;
  /** the person stopped the turn: its non-success result is not an error */
  interrupted: boolean;
  /** effort level set in this process; a new process starts at the model's own default */
  effort?: string;
}

interface Pending {
  resolve: (r: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A background task the CLI is running: its id (to stop it), its kind and what it does. */
export interface BgTask {
  id: string;
  type: string;
  description: string;
}

/** A plan window's use (percent) and when it resets. */
export interface UsageWindow {
  percent: number;
  resetsAt: string | null;
}

/** The context window in use, and the plan's limits, as the CLI reports them. Read when a turn ends. */
export interface Usage {
  context: { used: number; limit: number; percent: number } | null;
  plan: { subscription: string | null; fiveHour: UsageWindow | null; week: UsageWindow | null } | null;
}

/** What the CLI says it can do, for the chat's menus. Kept after the process exits, and in chats/<id>.caps.json across restarts. */
export interface Caps {
  commands: { name: string; description: string; argumentHint: string }[];
  models: { value: string; displayName: string; description: string; supportedEffortLevels: string[] }[];
}

/** chats/<id>.caps.json: the menus, and the model and mode last seen, so a restarted server can show them before Claude starts. */
export type CapsFile = Caps & { model: string | null; mode: string | null; savedAt?: number };

interface Chat {
  events: ChatEvent[];
}

/** In-memory transcript per workspace id, loaded from the file on first access. */
const chats = new Map<string, Chat>();
/** Live claude processes per workspace id. */
const procs = new Map<string, Live>();
/** Live ACP agents per workspace id (chat workspaces whose agent speaks ACP; see acp.ts). */
const acps = new Map<string, AcpClient>();
/** Commands and models per workspace id, from the CLI's init reply and its command list. */
const caps = new Map<string, Caps>();
/** Context and plan usage per workspace id, read when a turn ends. Kept after the process exits, like caps. */
const usages = new Map<string, Usage>();
/** When each workspace's usage was last read, and which reads are running: a failed read is not retried on every poll. */
const usageAt = new Map<string, number>();
const usageReading = new Set<string>();
let requestSeq = 0;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk", "full"];

function capsOf(id: string): Caps {
  let c = caps.get(id);
  if (!c) caps.set(id, (c = { commands: [], models: [] }));
  return c;
}

function commandList(x: any): Caps["commands"] {
  return Array.isArray(x)
    ? x.filter((c) => typeof c?.name === "string").map((c) => ({ name: c.name, description: String(c.description ?? ""), argumentHint: String(c.argumentHint ?? "") }))
    : [];
}

function modelList(x: any): Caps["models"] {
  return Array.isArray(x)
    ? x
        .filter((m) => typeof m?.value === "string")
        .map((m) => ({
          value: m.value,
          displayName: String(m.displayName ?? m.value),
          description: String(m.description ?? ""),
          supportedEffortLevels: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((l: unknown) => typeof l === "string") : [],
        }))
    : [];
}

/** Send a control request to the CLI and wait for its reply. Gives up after 10 s. */
function ask(live: Live, request: Record<string, unknown>, requestId = `ctl-${++requestSeq}`): Promise<any> {
  return new Promise((resolve, reject) => {
    if (live.closed || live.stopping) return reject(new Error("Claude stopped"));
    const timer = setTimeout(() => {
      live.pending.delete(requestId);
      reject(new Error("Claude did not answer in time"));
    }, 10_000);
    live.pending.set(requestId, { resolve, reject, timer });
    live.child.stdin!.write(JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n");
  });
}

const capsPath = (id: string) => join(chatsDir(), `${id}.caps.json`);
/** A caps file's contents, or null when it is missing or corrupt. Never throws. */
export function readCapsFile(file: string): Omit<CapsFile, "savedAt"> | null {
  try {
    // never through a link, though only root writes this folder
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let j: any;
    try {
      j = JSON.parse(readFileSync(fd, "utf8"));
    } finally {
      closeSync(fd);
    }
    if (!j || typeof j !== "object") return null;
    return {
      commands: commandList(j.commands),
      models: modelList(j.models),
      model: typeof j.model === "string" ? j.model : null,
      mode: typeof j.mode === "string" && MODES.includes(j.mode) ? j.mode : null,
    };
  } catch {
    return null;
  }
}

/** Writes a caps file atomically: a temp file beside it, then a rename, so a crash never leaves half a file. */
export function writeCapsFile(file: string, data: CapsFile): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  // temp files left by a crash mid-write
  for (const f of readdirSync(dirname(file))) if (f.startsWith(`${basename(file)}.`) && f.endsWith(".tmp")) rmSync(join(dirname(file), f), { force: true });
}

/** The background tasks a background_tasks_changed line lists. Pure. */
function bgTasks(x: unknown): BgTask[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((t) => typeof t?.task_id === "string")
    .map((t) => ({ id: t.task_id, type: String(t.task_type ?? ""), description: String(t.description ?? "").slice(0, 200) }));
}

/** Show the active form while a task is active, the subject otherwise. */
const shown = (t: Todo): Todo => ({ ...t, text: (t.status === "active" && t.form ? t.form : t.subject ?? t.text).slice(0, 200) });

/** A TaskCreate result: the new task's id, from the structured result or the text ("Task #1 created ..."). Pure. */
export function newTaskId(structured: unknown, text: unknown): string | null {
  const id = (structured as { task?: { id?: unknown } } | null)?.task?.id;
  if (typeof id === "string" || typeof id === "number") return String(id);
  const m = typeof text === "string" ? /Task #(\w+) created/.exec(text) : null;
  return m ? m[1] : null;
}

/** The checklist after a TaskCreate finished (id known) or a TaskUpdate was called. Pure. */
export function applyTaskEvent(list: Todo[], ev: { create: { id: string; subject: string; form?: string } } | { update: unknown }): Todo[] {
  if ("create" in ev) {
    const { id, subject, form } = ev.create;
    if (list.some((t) => t.id === id)) return list;
    return [...list, shown({ id, subject, form, text: subject, status: "pending" })].slice(0, 50);
  }
  const u = (ev.update ?? {}) as { taskId?: unknown; status?: unknown; subject?: unknown; activeForm?: unknown };
  const id = String(u.taskId ?? "");
  if (u.status === "deleted") return list.filter((t) => t.id !== id);
  return list.map((t) => {
    if (t.id !== id) return t;
    const status = u.status === "in_progress" ? "active" : u.status === "completed" ? "done" : u.status === "pending" ? "pending" : t.status;
    return shown({
      ...t,
      status,
      subject: typeof u.subject === "string" && u.subject ? u.subject : t.subject,
      form: typeof u.activeForm === "string" && u.activeForm ? u.activeForm : t.form,
    });
  });
}

/** The checklist a TodoWrite call sends (the full list). Pure. */
export function todosOf(input: unknown): Todo[] {
  const list = (input as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(list)) return [];
  return list
    .filter((t) => typeof t?.content === "string")
    .slice(0, 50)
    .map((t) => {
      const status = t.status === "in_progress" ? "active" : t.status === "completed" ? "done" : "pending";
      const text = status === "active" && typeof t.activeForm === "string" && t.activeForm ? t.activeForm : t.content;
      return { text: text.slice(0, 200), status } as Todo;
    });
}

/** The usage the footer shows, from the two replies: get_context_usage and get_usage. Pure. */
export function usageOf(context: any, plan: any): Usage {
  const used = Number(context?.totalTokens);
  const limit = Number(context?.maxTokens);
  const rl = plan?.rate_limits;
  const window = (w: any): UsageWindow | null =>
    w && typeof w.utilization === "number" ? { percent: Math.round(w.utilization), resetsAt: typeof w.resets_at === "string" ? w.resets_at : null } : null;
  return {
    context: Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? { used, limit, percent: Math.round((used / limit) * 100) } : null,
    plan: plan?.rate_limits_available && rl
      ? { subscription: typeof plan.subscription_type === "string" ? plan.subscription_type : null, fiveHour: window(rl.five_hour), week: window(rl.seven_day) }
      : null,
  };
}

/** A terminal project: copy the lines the terminal's Claude wrote since the last look into the chat. Also runs once for a chat project that switched to an earlier conversation. Never throws. */
async function syncFromTerminal(ws: Workspace): Promise<void> {
  const sid = ws.chatSession;
  if (chatBusy.has(ws.id) || !sid || !/^[\w-]+$/.test(sid)) return;
  try {
    const cwd = worktreePath(ws);
    const file = transcriptFile(identityOf(ws)?.home || homedir(), cwd, sid, configDirOf(ws));
    if (!existsSync(file)) return;
    // The server runs as root and the folder may be writable by the agent: never follow a link.
    if (!lstatSync(file).isFile()) return;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = fstatSync(fd).size;
      const cur = readCursor(ws.id);
      const mine = cur !== null && cur.sid === sid ? cur : null;
      const first = mine === null;
      let start = mine && mine.offset <= size ? mine.offset : 0;
      if (first && size > TAIL_BYTES) start = size - TAIL_BYTES;
      const buf = Buffer.alloc(size - start);
      const got = readSync(fd, buf, 0, buf.length, start);
      const nl = buf.subarray(0, got).lastIndexOf(0x0a);
      if (nl < 0) return; // no whole new line yet
      let chunk = buf.subarray(0, nl + 1);
      // a window that starts mid-line: its first, partial line is not ours
      if (first && start > 0) chunk = chunk.subarray(chunk.indexOf(0x0a) + 1);
      let events = transcriptEvents(chunk.toString("utf8").split("\n"), cwd);
      if (first) events = events.slice(-FIRST_IMPORT);
      for (const body of events) emit(ws.id, body);
      writeCursor(ws.id, sid, start + nl + 1);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    console.warn(`[chat] terminal sync: ${(e as Error).message}`);
  }
}

/** A terminal project: the turn's own lines are already in the chat, so the import skips past them. ponytail: a server restart mid-turn re-imports that turn once. */
function markSeen(id: string, live: Live) {
  if (!live.transcriptHome || !live.sid) return;
  try {
    const file = transcriptFile(live.transcriptHome, live.cwd, live.sid);
    writeCursor(id, live.sid, existsSync(file) ? statSync(file).size : 0);
  } catch (e) {
    console.warn(`[chat] terminal cursor: ${(e as Error).message}`);
  }
}

function load(id: string): Chat {
  const have = chats.get(id);
  if (have) return have;
  const events: ChatEvent[] = [];
  const file = transcriptPath(id);
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* a torn last line after a crash: skip it */
      }
    }
  }
  const c: Chat = { events };
  chats.set(id, c);
  chatKillers.set(id, () => stop(id));
  return c;
}

/** A handoff note being written: the reply is caught here instead of shown, and the turn's end settles it. */
const captures = new Map<string, { text: string; settle: (text: string | null) => void }>();

/** Projects whose message already moved to another account or model once: a second limit on the same message is shown, not hopped again. Cleared when a turn ends. */
const hopped = new Set<string>();
/** Projects whose Claude restarts at the next idle moment (a saved rule was removed; the process holds it until then). */
const restartAtIdle = new Set<string>();

/** The project-memory notes each chat's current turn has read (the brain's recall), taken into that turn's done event. */
const recalledNow = new Map<string, Set<string>>();
export function noteRecalled(id: string, titles: string[]): void {
  const set = recalledNow.get(id) ?? new Set<string>();
  for (const t of titles) set.add(t);
  recalledNow.set(id, set);
}

function emit(id: string, body: Body): ChatEvent {
  if (body.kind === "done") hopped.delete(id);
  const cap = captures.get(id);
  if (cap && (body.kind === "assistant" || body.kind === "done" || body.kind === "error")) {
    if (body.kind === "assistant") cap.text += (cap.text ? "\n" : "") + body.text;
    else cap.settle(body.kind === "done" ? cap.text : null);
    return { n: 0, at: Date.now(), ...body } as ChatEvent; // not kept: this turn is not part of the visible chat
  }
  const seen = body.kind === "done" ? recalledNow.get(id) : undefined;
  if (body.kind === "done") recalledNow.delete(id);
  const recalled = seen?.size ? { recalled: [...seen].slice(0, 8) } : {};
  const c = load(id);
  const ev = { n: (c.events.at(-1)?.n ?? 0) + 1, at: Date.now(), ...body, ...recalled } as ChatEvent;
  c.events.push(ev);
  mkdirSync(chatsDir(), { recursive: true, mode: 0o700 });
  appendFileSync(transcriptPath(id), JSON.stringify(ev) + "\n", { mode: 0o600 });
  return ev;
}

/** The chat's text as a note line: a quiet divider, from Kohlab itself (Keep, Undo all). */
export function noteChat(id: string, text: string): void {
  emit(id, { kind: "note", text });
}

/** The plan's five-hour percent as last read for a project, or undefined. */
const planPercent = (id: string): number | undefined => usages.get(id)?.plan?.fiveHour?.percent;

/** A Claude turn begins (a send, a retry, or Claude starting one itself): its clock starts, and the plan reading it starts from is kept. */
function turnBegan(id: string, live: Live) {
  live.helperTree = helpersNewTurn(live.helperTree);
  live.busySince = Date.now();
  live.planStart = planPercent(id);
}

/** A Claude turn ends: the done line is written at once. The plan share comes after it as a plan line, once the usage is read (at most 3 s), so the reply never waits for it.
 *  ponytail: if a usage read is already running, the reading taken here may be a little stale. Accepted. */
function turnDone(id: string, live: Live, result?: any) {
  const since = live.busySince;
  const planStart = live.planStart;
  const worked = since !== undefined ? Date.now() - since : undefined;
  const hidden = captures.has(id); // a handoff note's turn: no done line, no plan share
  emit(id, { kind: "done", ...(worked !== undefined ? { worked } : {}), ...doneFields(live.model, result?.usage) });
  void Promise.race([readUsage(id, live, true), new Promise((r) => setTimeout(r, 3000))]).then(() => {
    const end = planPercent(id);
    const planDelta = planStart !== undefined && end !== undefined && end >= planStart ? end - planStart : undefined;
    if (planDelta !== undefined && !hidden) emit(id, { kind: "plan", planDelta });
    maybeAutoFresh(id);
  });
}

/** Ends a Claude process that was started before the project's notes changed, so the next start has the new notes. The conversation resumes with --resume. Only when no turn runs. */
function retireStale(id: string, ws: Workspace) {
  const live = procs.get(id);
  if (!live || live.closed || live.notes === notesOf(ws)) return;
  procs.delete(id);
  chatBackground.delete(id); // the old process's background work is not this one's
  live.stopping = true;
  live.child.kill("SIGTERM");
}

/** Kill the claude process (stop or delete). The transcript cache is dropped and reloaded from file later. */
function stop(id: string) {
  const live = procs.get(id);
  procs.delete(id);
  chats.delete(id);
  if (live && chatBusy.has(id)) markSeen(id, live); // the cut-off turn is already in the chat
  chatBusy.delete(id);
  chatWaiting.delete(id);
  chatBackground.delete(id);
  if (live) {
    live.stopping = true;
    live.child.kill("SIGTERM");
  }
  const acp = acps.get(id);
  acps.delete(id);
  acp?.stop();
}

/** Tell the phone that Claude is waiting on a question. A failed push must never stall the chat. */
function pingNeedsYou(id: string, question: string) {
  getWorkspace(id)
    .then((ws) => notifyNeedsYou(ws, question))
    .catch((e) => console.warn(`[chat] needs-you push failed: ${(e as Error).message}`));
}

/** Mark the run finished, as the watcher does for a PTY: stop time, cleanliness, then notify. */
async function finish(id: string): Promise<void> {
  // a removed rule: the process that still holds it ends now, and the next message resumes the conversation without it
  if (restartAtIdle.has(id) && !chatBusy.has(id)) {
    restartAtIdle.delete(id);
    stop(id);
  }
  const clean = await worktreeIsClean(id);
  const w = await mutateState((st) => {
    const ws = st.workspaces.find((x) => x.id === id);
    if (!ws || !ws.started || ws.stopped || chatBusy.has(id)) return null; // a newer turn began while we awaited
    ws.stopped = Date.now();
    ws.stoppedClean = clean;
    return ws;
  });
  if (w) notifyWorkspaceDone(w);
}

function persistSession(id: string, sid: string) {
  void mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (w && w.chatSession !== sid) w.chatSession = sid;
  }).catch((e) => console.error("[chat] session save:", (e as Error).message));
}

/** The model and mode last reported per project: kept after the process exits, so the footer stays between turns. */
const lastSeen = new Map<string, { model: string | null; mode: string | null }>();
/** Projects whose caps file has been looked at since this server started. */
const capsLoaded = new Set<string>();
/** The content last saved (or loaded) per project, so an unchanged caps file is not rewritten. */
const capsSaved = new Map<string, string>();

/** After a restart: the menus and settings last saved for a project, until its Claude reports again. Looked at once per project; never overwrites what is already known. */
function loadCaps(id: string): void {
  if (capsLoaded.has(id)) return;
  capsLoaded.add(id);
  const saved = readCapsFile(capsPath(id));
  if (!saved || caps.has(id) || lastSeen.has(id)) return;
  caps.set(id, { commands: saved.commands, models: saved.models });
  lastSeen.set(id, { model: saved.model, mode: saved.mode });
  capsSaved.set(id, JSON.stringify(saved));
}

/** What is kept per ACP agent, across projects: the models it offered when last seen, and the one the person chose last. A caps file in the agent's name. */
const agentInfos = new Map<string, { models: Caps["models"]; lastModel: string | null }>();
const agentFile = (agent: string) => join(chatsDir(), `agent-${agent}.models.json`);
function agentInfo(agent: string) {
  let a = agentInfos.get(agent);
  if (!a) {
    const saved = readCapsFile(agentFile(agent));
    agentInfos.set(agent, (a = { models: saved?.models ?? [], lastModel: saved?.model ?? null }));
  }
  return a;
}
function saveAgentInfo(agent: string): void {
  const a = agentInfo(agent);
  try {
    writeCapsFile(agentFile(agent), { commands: [], models: a.models, model: a.lastModel, mode: null, savedAt: Date.now() });
  } catch (e) {
    console.warn(`[chat] agent models save: ${(e as Error).message}`);
  }
}
/** The model an ACP project runs on: its own choice, else the server default when the agent offers it, else the agent's own (undefined). */
const wantedModel = (ws: Workspace, defaults?: AiDefaults): string | undefined => {
  if (ws.agentModel) return ws.agentModel;
  const d = ws.chat ? defaults?.model : undefined;
  return isAcp(ws) && d && d !== "default" && agentInfo(ws.agent).models.some((m) => m.value === d) ? d : undefined;
};

/** The server's defaults for new projects. */
const defaultsOf = async (): Promise<AiDefaults | undefined> => (await loadState()).defaults;

/** A project, as it is now. A chat that has had no message yet follows the server defaults for its AI and account, so a changed default reaches it before it is pinned by its first message. */
async function wsOf(id: string): Promise<Workspace> {
  const ws = await getWorkspace(id);
  if (!ws.chat || ws.agentPinned || chatBusy.has(id)) return ws;
  const d = (await defaultsOf()) ?? {};
  const agent = d.agent && (d.agent === "claude" || isAcpAgent(d.agent)) && Bun.which(agentBin(d.agent)) ? d.agent : ws.agent;
  const acct = d.account ? getAccount(d.account) : undefined;
  const account = acct && acct.provider === agent && usableBy(acct, ws) ? acct.id : undefined;
  if (agent === ws.agent && account === ws.account) return ws;
  stop(id); // an AI warmed up for its model list is not this project's any more
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w || w.agentPinned) return;
    w.agent = agent;
    w.account = account;
    w.chatSession = undefined;
    w.agentModel = undefined;
  });
  loadCaps(id);
  capsOf(id).models = [];
  lastSeen.delete(id);
  warmed.delete(id);
  persistCaps(id);
  return getWorkspace(id);
}

/** The command that starts an AI. */
const agentBin = (agent: string): string => (agent === "claude" ? "claude" : (ACP_AGENTS[agent]?.[0] ?? agent));

/** Saves the menus and settings when they differ from the file. Never throws: a failed save must not stop the chat. */
function persistCaps(id: string): void {
  const c = caps.get(id);
  const s = lastSeen.get(id);
  const body = { commands: c?.commands ?? [], models: c?.models ?? [], model: s?.model ?? null, mode: s?.mode ?? null };
  const key = JSON.stringify(body);
  if (capsSaved.get(id) === key) return;
  capsSaved.set(id, key);
  try {
    writeCapsFile(capsPath(id), { ...body, savedAt: Date.now() });
  } catch (e) {
    capsSaved.delete(id);
    console.warn(`[chat] caps save: ${(e as Error).message}`);
  }
}

/** A line that opens a turn. Only the opening lines count: a stream_event or assistant line can trail a result, and would leave the chat stuck working. */
function isTurnStart(m: any): boolean {
  if (m.parent_tool_use_id) return false;
  if (m.type === "system") return m.subtype === "init" || (m.subtype === "status" && m.status === "requesting");
  return m.type === "stream_event" && m.event?.type === "message_start";
}

function onLine(id: string, live: Live, line: string) {
  if (live.stopping) return;
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return; // not JSON: ignore
  }
  // The helper tree reads every line, including a helper's own (which the chat itself drops below). A bad line must never break the chat.
  try {
    live.helperTree = applyHelperLine(live.helperTree, m, Date.now());
  } catch (e) {
    console.warn("[chat] helper tree:", (e as Error).message);
  }
  // Claude can start a turn by itself (a background task finished): show it as working, as a send does.
  if (isTurnStart(m) && !chatBusy.has(id)) {
    chatBusy.add(id);
    turnBegan(id, live);
  }
  // A finished background task, live. A terminal project's importer reads the same line from the transcript, so it stays quiet there.
  if (m.type === "system" && m.subtype === "task_notification") {
    if (!live.transcriptHome) emit(id, { kind: "note", text: taskFinishedLine(`<summary>${String(m.summary ?? "")}</summary>`) });
    return;
  }
  if (m.type === "system" && m.subtype === "background_tasks_changed") {
    live.tasks = bgTasks(m.tasks);
    // the CLI sends an empty list when the last task ends, so this clears the flag too
    // only the current process counts: a retired or stopped one may still print lines before it exits
    if (procs.get(id) === live) {
      if (live.tasks.length) chatBackground.add(id);
      else {
        chatBackground.delete(id);
        maybeAutoFresh(id); // a continue-fresh that waited for the background work
      }
    }
    return;
  }
  // A retry notice lasts until the next line that is not one.
  if (!(m.type === "system" && m.subtype === "api_retry")) live.retry = undefined;
  if (m.type === "system" && m.subtype === "api_retry") {
    live.retry = { attempt: Number(m.attempt) || 1, max: Number(m.max_retries) || 0 };
    return;
  }
  // A model switch always shows. A compaction shows once: a terminal project's importer reads it from the transcript.
  if (m.type === "system" && (m.subtype === "model_fallback" || m.subtype === "compact_boundary")) {
    const text = noticeText(m);
    if (text && (m.subtype === "model_fallback" || !live.transcriptHome)) emit(id, { kind: "note", text });
    return;
  }
  if (m.type === "system" && m.subtype === "commands_changed") {
    capsOf(id).commands = commandList(m.commands);
    persistCaps(id);
    return;
  }
  if (m.type === "control_response") {
    const r = m.response ?? {};
    if (r.request_id === "init-1" && r.subtype === "success") {
      const c = capsOf(id);
      c.commands = commandList(r.response?.commands);
      c.models = modelList(r.response?.models);
      persistCaps(id);
      if (c.models.length) {
        agentInfo("claude").models = c.models;
        saveAgentInfo("claude");
      }
    }
    const waiting = live.pending.get(r.request_id);
    if (waiting) {
      live.pending.delete(r.request_id);
      clearTimeout(waiting.timer);
      if (r.subtype === "success") waiting.resolve(r.response);
      else waiting.reject(new Error(String(r.error ?? "Claude refused that")));
    }
    return;
  }
  if (m.type === "system" && m.subtype === "init") {
    live.resuming = undefined;
    if (typeof m.model === "string") live.model = m.model;
    if (typeof m.permissionMode === "string") live.mode = m.permissionMode;
    live.inited = true;
    // names only: never a tool server's command line or settings
    if (Array.isArray(m.tools)) live.tools = m.tools.filter((t: unknown) => typeof t === "string").slice(0, 200).map((t: string) => t.slice(0, 100));
    if (Array.isArray(m.mcp_servers)) {
      live.mcp = m.mcp_servers
        .filter((x: any) => typeof x?.name === "string")
        .slice(0, 50)
        .map((x: any) => ({ name: x.name.slice(0, 100), status: typeof x.status === "string" ? x.status.slice(0, 40) : "unknown" }));
    }
    lastSeen.set(id, { model: live.model, mode: live.mode });
    persistCaps(id);
    if (typeof m.session_id === "string") {
      live.sid = m.session_id;
      persistSession(id, m.session_id);
    }
    return;
  }
  if (m.type === "stream_event") {
    if (m.parent_tool_use_id) return; // a helper agent's work, not the conversation
    if (m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") live.draft += m.event.delta.text ?? "";
    return;
  }
  if (m.type === "assistant") {
    if (m.parent_tool_use_id) return; // a helper agent's work, not the conversation
    live.draft = ""; // the full message replaces the streamed draft
    for (const b of m.message?.content ?? []) {
      if (b?.type === "text" && b.text) emit(id, { kind: "assistant", text: b.text });
      else if (b?.type === "tool_use" && b.name === "TodoWrite") live.todos = todosOf(b.input);
      else if (b?.type === "tool_use" && b.name === "TaskCreate") {
        if (typeof b.input?.subject === "string") live.newTasks.set(b.id, { subject: b.input.subject, form: b.input.activeForm });
      } else if (b?.type === "tool_use" && b.name === "TaskUpdate") live.todos = applyTaskEvent(live.todos, { update: b.input });
      else if (b?.type === "tool_use" && !HIDDEN_TOOLS.has(b.name)) {
        if (b.name === "Task" || b.name === "Agent") live.helpers.set(b.id, helperLabel(b.input));
        const detail = toolDetail(b.name, b.input ?? {}, live.cwd);
        const file = toolFile(b.name, b.input ?? {}, live.cwd);
        live.shownTools.add(b.id);
        emit(id, { kind: "tool", text: describeTool(b.name, b.input ?? {}, live.cwd), toolId: b.id, ...(detail !== undefined ? { detail } : {}), ...(file !== undefined ? { file } : {}) });
      }
    }
    return;
  }
  // A tool that finished: a helper agent that returned is no longer working.
  if (m.type === "user" && !m.parent_tool_use_id) {
    for (const b of m.message?.content ?? []) {
      if (b?.type !== "tool_result") continue;
      if (live.shownTools.has(b.tool_use_id)) {
        live.shownTools.delete(b.tool_use_id);
        const output = resultText(b.content);
        if (output !== "" || b.is_error) emit(id, { kind: "result", toolId: b.tool_use_id, output, ...(b.is_error ? { failed: true } : {}) });
      }
      live.helpers.delete(b.tool_use_id);
      const made = live.newTasks.get(b.tool_use_id);
      if (!made) continue;
      live.newTasks.delete(b.tool_use_id);
      const text = Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? "").join("") : b.content;
      const tid = newTaskId(m.tool_use_result, text);
      if (tid) live.todos = applyTaskEvent(live.todos, { create: { id: tid, ...made } });
    }
    return;
  }
  if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
    const input = (m.request.input ?? {}) as Record<string, unknown>;
    const tool = String(m.request.tool_name ?? "");
    if (live.fullAccess && !PERSONAL_ASKS.has(tool)) {
      // Full access: Kohlab says yes itself. A question or a plan is still the person's to answer.
      writeAnswer(live, m.request_id, answerResponse(tool, input, true, {}).response);
      return;
    }
    if (browserToolPolicy(tool, null, NO_OWN_PAGES) === null) askPerson(id, live, m.request_id, tool, input, null);
    else {
      // fail closed: any error while working out the page or the own pages asks the person, never allows and never leaves Claude waiting
      void browserAsk(id, live, m.request_id, tool, input).catch((e) => {
        console.error("[chat] browser ask:", (e as Error).message);
        if (!live.stopping && !live.closed && live.child.stdin) askPerson(id, live, m.request_id, tool, input, null);
      });
    }
    return;
  }
  if (m.type === "result") {
    live.draft = "";
    const byPerson = live.interrupted; // a stopped turn ends without an error
    live.interrupted = false;
    restoreOneShot(live);
    if (m.subtype !== "success" && resumeFailed(id, live)) return;
    markSeen(id, live);
    if (m.subtype !== "success" && !byPerson) {
      const raw = String(m.result ?? m.subtype ?? "unknown");
      console.warn("[chat] claude result error:", raw.slice(0, 200));
      const lim = limitReached(raw, Date.now(), planWindows(id));
      if (lim) {
        void limitFlow(id, live, raw, lim.until, m); // the message moves on, or the person is told why it cannot
        return;
      }
      emit(id, { kind: "error", text: friendlyError(raw) });
    }
    endClaudeTurn(id, live, m);
  }
}

/** A Claude turn is over: the done line, and the project is free again. */
function endClaudeTurn(id: string, live: Live, m: any) {
  turnDone(id, live, m); // reads the start of the turn's clock first; the done line follows its plan reading
  chatBusy.delete(id);
  live.busySince = undefined;
  live.helpers.clear();
  live.helperTree = helpersAtResult(live.helperTree, Date.now());
  if (live.todos.every((t) => t.status === "done")) live.todos = [];
  finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
}

/** A message sent with another model: Claude goes back to the model the project is on. */
function restoreOneShot(live: Live) {
  if (live.restoreModel === undefined) return;
  const back = live.restoreModel;
  live.restoreModel = undefined;
  ask(live, { subtype: "set_model", model: back })
    .then(() => {
      live.model = back;
    })
    .catch((e) => console.warn("[chat] could not go back to the model:", (e as Error).message));
}

/** The plan windows last read for a project, as limitReached wants them (a full window is a limit). */
function planWindows(id: string): { resetsAt: string | null; severity?: string }[] {
  const p = usages.get(id)?.plan;
  return [p?.fiveHour, p?.week].flatMap((w) => (w ? [{ resetsAt: w.resetsAt, ...(w.percent >= 100 ? { severity: "limit" } : {}) }] : []));
}

/** A Claude turn failed on a usage limit: try the fallback list. Moved on: nothing more here. Otherwise the turn ends as an error. */
async function limitFlow(id: string, live: Live, raw: string, until: number, m: any) {
  const r = await onLimit(id, live.rawMsg, until).catch((e) => {
    console.warn("[chat] fallback:", (e as Error).message);
    return "off" as const;
  });
  if (r === "moved") {
    live.busySince = undefined;
    live.helpers.clear();
    return;
  }
  if (r === "off") emit(id, { kind: "error", text: friendlyError(raw) });
  endClaudeTurn(id, live, m);
}

function onExit(id: string, live: Live) {
  if (live.closed) return;
  live.closed = true;
  if (procs.get(id) === live) {
    procs.delete(id);
    chatWaiting.delete(id);
  }
  if (!procs.has(id)) chatBackground.delete(id); // this process's background work ends with it
  live.asks.clear();
  live.helperTree = helpersAtExit(live.helperTree, Date.now());
  for (const p of live.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error("Claude stopped"));
  }
  live.pending.clear();
  if (live.stopping || !chatBusy.has(id)) return;
  if (resumeFailed(id, live)) return;
  markSeen(id, live);
  const last = live.stderr.trim().split("\n").pop()?.trim() ?? "";
  console.warn("[chat] claude stopped unexpectedly:", last.slice(0, 200));
  const lim = limitReached(last);
  const endDead = () => {
    emit(id, { kind: "done" });
    chatBusy.delete(id); // the turn died with the process: without this, send() answers 409 forever
    live.busySince = undefined;
    finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
  };
  if (lim) {
    void onLimit(id, live.rawMsg, lim.until)
      .catch(() => "off" as const)
      .then((r) => {
        if (r === "moved") return;
        if (r === "off") emit(id, { kind: "error", text: friendlyError(last) });
        endDead();
      });
    return;
  }
  emit(id, { kind: "error", text: friendlyError(last) });
  endDead();
}

/** The old session could not be resumed (e.g. it lived under another config dir): forget it and answer in a fresh one. Quiet for the user. */
function resumeFailed(id: string, live: Live): boolean {
  if (!live.resuming || live.msg === undefined) return false;
  live.stopping = true;
  live.child.kill("SIGTERM");
  if (procs.get(id) === live) procs.delete(id);
  chatBackground.delete(id);
  retryFresh(id, live.msg).catch((e) => {
    chatBusy.delete(id);
    console.error("[chat] could not start:", (e as Error).message);
    emit(id, { kind: "error", text: friendlyError((e as Error).message) });
    finish(id).catch(() => {});
  });
  return true;
}

async function retryFresh(id: string, msg: string) {
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (w) w.chatSession = undefined;
  });
  const live = await start(await getWorkspace(id), id);
  live.msg = msg;
  turnBegan(id, live);
  live.child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: msg }, parent_tool_use_id: null }) + "\n");
}

async function start(ws: Workspace, id: string, opts: { model?: string } = {}): Promise<Live> {
  loadCaps(id); // before the new process can save over the file
  const s = await loadState();
  const ai = resolveAi(ws, s.defaults);
  const cmd = (s.agents?.claude || "claude").split(/\s+/)[0];
  const bin = Bun.which(cmd);
  if (!bin) throw new Error(`${cmd} is not installed on this server`);
  const who = identityOf(ws);
  const home = who?.home || homedir();
  // A terminal project's chat continues the person's own Claude (their settings, skills and MCP servers), as their terminal does.
  const term = !ws.chat;
  // Chat users get a clean Claude with the same login: no user settings, skills, MCP servers or CLAUDE.md.
  // A copy of the owner's CLAUDE_CONFIG_DIR was rejected: token refresh would split the credentials into two copies. A second account is a
  // fresh directory signed in once, here, so it is the only copy: its Claude gets that directory (accounts.ts) and nothing else of the account.
  // --include-partial-messages streams Claude's reply as it is written (stream_event lines). --model only when the project (or the default) chose one; otherwise the account default.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
  // The mode the person picked in the chat. Otherwise a terminal project keeps its own settings, as its terminal does, and chat users get "default".
  const picked = MODES.includes(ws.permissionMode ?? "") ? ws.permissionMode : undefined;
  const mode = term ? picked : ai.mode.value;
  const policy = mode ? claudeArgsFor(mode) : null;
  if (policy) args.push("--permission-mode", policy.permissionMode);
  // the project brain's MCP server, chats only; left out when node or the callback cannot be had
  const brainExtra = term ? null : await brainMcp(ws);
  // what the person chose "Always allow" for, so it holds from this start on; a chat's brain tools are allowed too (they only read and save this project's notes)
  const rules = cleanRules(ws.allowRules);
  const allowed = [...rules, ...(brainExtra ? ["mcp__brain__recall", "mcp__brain__remember"] : [])];
  if (allowed.length) args.push("--allowedTools", allowed.join(","));
  if (!term) args.push("--setting-sources", "project,local", "--disable-slash-commands", "--strict-mcp-config");
  // strict: only our browser tools (and the brain's) load, never the user's MCP servers
  const mcpFile = writeBrowserMcp(ws, who, brainExtra ?? {});
  if (mcpFile) args.push("--mcp-config", mcpFile);
  if (!term) args.push("--append-system-prompt", systemPromptFor(notesOf(ws), brainSummaryOf(ws)));
  if (ws.chatSession) args.push("--resume", ws.chatSession);
  const wantModel = term ? ws.model : ai.model.value;
  const useModel = opts.model ?? wantModel;
  if (useModel && useModel !== "default") args.push("--model", useModel);
  const env = childEnv(home, term ? undefined : accountEnv(ws));
  // A copy of each file before Claude edits it, so Undo can put it back.
  // ponytail: the copies live under this home's .claude/file-history and grow with every edit; nothing prunes them yet.
  env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING = "1";
  // Gives -p mode the task tools (TaskCreate, TaskUpdate), which feed the progress checklist.
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1";
  if (!term) env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = "1";
  const cwd = worktreePath(ws);
  const child = spawn(bin, args, { cwd, uid: who?.uid, gid: who?.gid, env, stdio: ["pipe", "pipe", "pipe"] });
  const live: Live = {
    child,
    cwd,
    asks: new Map(),
    fullAccess: policy?.fullAccess ?? false,
    // one message sent with another model: this process starts on it and goes back after the turn
    ...(opts.model !== undefined && opts.model !== wantModel ? { restoreModel: wantModel ?? "default" } : {}),
    stderr: "",
    stopping: false,
    closed: false,
    resuming: ws.chatSession,
    draft: "",
    sid: ws.chatSession,
    transcriptHome: term ? home : undefined,
    tasks: [],
    todos: [],
    newTasks: new Map(),
    helpers: new Map(),
    helperTree: [],
    tools: null,
    mcp: [],
    shownTools: new Set(),
    model: null,
    mode: null,
    pending: new Map(),
    interrupted: false,
    notes: notesOf(ws),
  };
  procs.set(id, live);
  child.stdin!.on("error", () => {}); // a dead process: its exit event reports it
  child.stderr!.on("data", (d) => {
    live.stderr = (live.stderr + d).slice(-2000);
  });
  createInterface({ input: child.stdout! }).on("line", (l) => onLine(id, live, l));
  child.on("error", () => onExit(id, live));
  child.on("exit", () => onExit(id, live));
  // The host announces itself first, as the SDK does; otherwise the CLI cannot ask us for permissions.
  live.ready = ask(live, { subtype: "initialize" }, "init-1");
  live.ready.catch(() => {}); // a missed init is reported to the control that waits for it
  // The effort level the person chose survives a restart: the new process starts at the model's own default.
  const effort = term ? ws.effort : ai.effort.value;
  if (effort && EFFORTS.includes(effort)) {
    live.ready
      .then(() => ask(live, { subtype: "apply_flag_settings", settings: { effortLevel: effort } }))
      .then(() => {
        live.effort = effort;
      })
      .catch((e) => console.warn("[chat] could not restore effort:", (e as Error).message));
  }
  return live;
}

/** The chat transcript after event `after`, and whether a turn is in flight. */
export async function snapshot(id: string, after: number, see: { usage: boolean; owner: boolean } = { usage: false, owner: false }) {
  const ws = await wsOf(id);
  const defaults = await defaultsOf();
  const ai = resolveAi(ws, defaults);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  loadCaps(id);
  if (term) await syncFromTerminal(ws);
  // the plan's share of a turn is the server owner's account data: other people see the turn's time only
  const events = load(id).events
    .filter((e) => e.n > after)
    .filter((e) => see.owner || e.kind !== "plan")
    .map((e): ChatEvent => {
      if (e.kind !== "done" || see.owner || e.planDelta === undefined) return e;
      const { planDelta: _plan, ...rest } = e;
      return rest;
    });
  const live = procs.get(id);
  // the first read of usage comes with the first poll that finds none (a restart, or a chat not yet used)
  if (live && !usages.has(id)) void readUsage(id, live, false);
  // an ACP project with no model list yet: its agent starts quietly, once, so the list is there before the first message
  if (isAcp(ws) && !acps.has(id) && !caps.get(id)?.models.length && !agentInfo(ws.agent).models.length && !warmed.has(id)) {
    warmed.add(id);
    startAcp(ws, id).catch((e) => console.warn("[chat] warm-up:", (e as Error).message));
  }
  // a Claude project with no model list yet: its process starts quietly, once, for the list. start() sends only the initialize request, no message.
  if (ws.chat && ws.agent === "claude" && !live && !caps.get(id)?.models.length && !agentInfo("claude").models.length && !warmed.has(id)) {
    warmed.add(id);
    start(ws, id).catch((e) => console.warn("[chat] warm-up:", (e as Error).message));
  }
  const cur = live ?? acps.get(id); // an ACP agent's chat keeps the same fields
  if (acps.has(id)) setPolicy(id, ws, defaults); // a changed default reaches a running agent at its next request
  const savedMode = ai.mode.source !== "builtin" ? (ai.mode.value as string) : undefined;
  const seenMode = cur?.mode ?? savedMode ?? lastSeen.get(id)?.mode ?? (ws.chat ? "default" : null);
  // Full access is Kohlab's, not Claude's: Claude itself reports "default"
  const shownMode = savedMode === "full" && (cur?.mode == null || cur.mode === "default") ? "full" : seenMode;
  return {
    events,
    busy: chatBusy.has(id),
    busySince: chatBusy.has(id) ? (cur?.busySince ?? null) : null,
    now: Date.now(),
    background: cur?.tasks.length ?? 0,
    tasks: cur?.tasks ?? [],
    todos: cur?.todos ?? [],
    helpers: [...(cur?.helpers.values() ?? [])],
    helperTree: (live?.helperTree ?? []).map((n): HelperNode => ({ ...n, canStop: n.status === "running" && n.taskId !== null && live!.tasks.some((t) => t.id === n.taskId) })),
    // continue-fresh: the person's switch for doing it by itself, and whether it waits for the turn or the background work to end
    fresh: { auto: ai.autoFresh.value !== false, pending: freshPending.has(id) },
    freshPending: freshPending.has(id),
    retry: cur?.retry ?? null,
    usage: see.usage ? shownUsage(usages.get(id), see.owner) : null,
    // one rule: a live process, else the project's saved choice, else what was last seen
    model: cur?.model ?? wantedModel(ws, defaults) ?? (ai.model.source !== "builtin" && ai.model.value !== "default" ? ai.model.value : null) ?? lastSeen.get(id)?.model ?? null,
    mode: shownMode,
    effort: cur?.effort ?? ai.effort.value ?? null,
    // clean chats run with --disable-slash-commands: they get no "/" menu
    commandsEnabled: term,
    commands: term ? (caps.get(id)?.commands ?? []).slice(0, 200) : [],
    models: caps.get(id)?.models.length ? caps.get(id)!.models : ws.chat ? agentInfo(ws.agent).models : [],
    waiting: cur?.asks.keys().next().value ?? null,
    draft: cur?.draft ?? "",
    terminalOpen: term && (await isAlive(ws)),
  };
}

/** A terminal project whose agent is Claude: its conversation can be read and sent to from the chat view. */
async function viaTerminal(ws: Workspace): Promise<boolean> {
  if (ws.chat) return false;
  const cmd = ((await loadState()).agents?.[ws.agent] || "").split(/\s+/)[0];
  return basename(cmd) === "claude";
}

/** A chat whose agent speaks ACP (see acp.ts). Terminal projects are Claude's own and never ACP. */
function isAcp(ws: Workspace): boolean {
  return ws.chat === true && isAcpAgent(ws.agent);
}

/** The permission mode and saved rules an ACP agent's requests are decided by, per project. Updated when they change; read at every request. */
const policies = new Map<string, { mode: string; rules: string[] }>();
function setPolicy(id: string, ws: Workspace, defaults: AiDefaults | undefined): void {
  const mode = resolveAi(ws, defaults).mode.value;
  policies.set(id, { mode: mode === "plan" ? "default" : (mode ?? "default"), rules: cleanRules(ws.allowRules) });
}

/** What an ACP agent reports back to the chat: the same events, state and saves as a Claude process. */
function acpHost(id: string, agent: string): AcpHost {
  return {
    emit: (body) => {
      emit(id, body);
    },
    persistSession: (sid) => persistSession(id, sid),
    finish: () => {
      finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
    },
    pingNeedsYou: (text) => pingNeedsYou(id, text),
    models: (list) => {
      capsOf(id).models = list;
      persistCaps(id);
      agentInfo(agent).models = list;
      saveAgentInfo(agent);
    },
    exited: (acp) => {
      if (acps.get(id) === acp) acps.delete(id);
    },
    policy: () => policies.get(id) ?? { mode: "default", rules: [] },
    note: (text) => {
      emit(id, { kind: "note", text });
    },
    // the model the person chose could not be used: it is forgotten, so the chip shows the model the agent is really on
    modelRefused: () => {
      void mutateState((s) => {
        const w = s.workspaces.find((x) => x.id === id);
        if (w) w.agentModel = undefined;
      }).catch(() => {});
    },
    limited: (raw) => {
      const lim = limitReached(raw);
      if (!lim) return false;
      const text = acpRaw.get(id);
      void onLimit(id, text, lim.until)
        .catch(() => "off" as const)
        .then((r) => {
          if (r === "moved") return;
          if (r === "off") emit(id, { kind: "error", text: "This AI has reached its usage limit for now. Try again in a little while." });
          emit(id, { kind: "done" });
          chatBusy.delete(id);
          finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
        });
      return true;
    },
  };
}

/** The person's own words for the message an ACP agent is working on, to send again after a usage limit moved the conversation on. */
const acpRaw = new Map<string, string>();

/** Starts the chat's ACP agent and opens its session (the chat's conversation, when the agent can load it). */
const acpStarting = new Map<string, Promise<AcpClient>>();
/** Projects whose agent was started for its model list: once each, so a failing agent is not respawned on every poll. ponytail: no idle stop, like Claude chats; the process lives until the project is reset or the server exits. */
const warmed = new Set<string>();
function startAcp(ws: Workspace, id: string): Promise<AcpClient> {
  const pending = acpStarting.get(id);
  if (pending) return pending;
  const p = startAcpNow(ws, id).finally(() => acpStarting.delete(id));
  acpStarting.set(id, p);
  return p;
}
async function startAcpNow(ws: Workspace, id: string): Promise<AcpClient> {
  const [cmd, ...args] = ACP_AGENTS[ws.agent];
  const bin = Bun.which(cmd);
  if (!bin) throw new Error(`${cmd} is not installed on this server`);
  const who = identityOf(ws);
  const defaults = await defaultsOf();
  setPolicy(id, ws, defaults);
  const acp = new AcpClient(id, ws.agent, acpHost(id, ws.agent));
  acps.set(id, acp);
  try {
    await acp.start({ bin, args, cwd: worktreePath(ws), uid: who?.uid, gid: who?.gid, env: childEnv(who?.home || homedir(), accountEnv(ws)), resumeSession: ws.chatSession, agentModel: wantedModel(ws, defaults) });
    // a model chosen while the agent was starting
    await acp.applyModel(wantedModel(await getWorkspace(id), defaults));
  } catch (e) {
    acp.stop();
    if (acps.get(id) === acp) acps.delete(id);
    throw e;
  }
  return acp;
}

/** The text an agent is sent for the person's message. After a switch of AI, its first message carries the conversation it has not seen; after "New chat from here", the conversation it starts from; after "Go back to here", a note. The chat still shows only the person's own words. */
function handoffMessage(id: string, ws: Workspace, text: string, skipLast = false): string {
  const parts: string[] = [];
  if (ws.handoffAfter !== undefined) {
    // a message sent again after a usage limit is already in the chat: it is the new message below, not part of what happened so far
    const all = load(id).events;
    const lastUser = skipLast ? all.findLast((e) => e.kind === "user") : undefined;
    const summary = handoffText(all.filter((e) => e.n > ws.handoffAfter! && e !== lastUser), ws.agent);
    if (summary) parts.push(`Context: this conversation started with another assistant. What happened so far:\n${summary}`);
  }
  if (ws.branchContext) parts.push(`Context: this conversation was started from an earlier one. What happened there:\n${ws.branchContext}`);
  if (ws.freshNote) parts.push(`Context: we are continuing in a fresh session. The handoff note from the previous session:\n${ws.freshNote}`);
  if (ws.restoredFrom !== undefined) parts.push(`Note: the person restored the project files to how they were before their message “${ws.restoredFrom}”. Files changed after that point were undone.`);
  if (parts.length === 0) return text;
  return `${parts.join("\n\n")}\n\nThe person's new message:\n${text}`;
}

/** Whether the next message still has a catch-up, a branch context or a restore note to carry. */
const hasPendingContext = (ws: Workspace) => ws.handoffAfter !== undefined || ws.branchContext !== undefined || ws.restoredFrom !== undefined || ws.freshNote !== undefined;

/** The catch-up, context and note a message carried are spent: that message has been sent. */
function clearHandoff(id: string) {
  return mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (w) {
      delete w.handoffAfter;
      delete w.branchContext;
      delete w.restoredFrom;
      delete w.freshNote;
    }
  });
}

/** Projects whose files are being put back: a message sent meanwhile would start on files mid-restore. */
const restoring = new Set<string>();

/** A message's text, shortened for a line or a note. */
const excerpt = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 60)}…` : t;
};

/** The user message with this event number. */
function userEventAt(id: string, n: unknown): Extract<ChatEvent, { kind: "user" }> {
  if (typeof n !== "number" || !Number.isInteger(n)) throw new ChatError(400, "The message number is required.");
  const ev = load(id).events.find((e) => e.n === n);
  if (!ev || ev.kind !== "user") throw new ChatError(404, "That message was not found.");
  return ev;
}

/** What a send may carry beyond the words. */
interface SendOpts {
  /** this one message goes to this model; the project's own choice is untouched */
  model?: string;
  /** the message is already in the chat (a usage limit moved the conversation on): no new line for it */
  resend?: boolean;
}

/** A message to an ACP agent: one prompt turn. A message sent while a turn runs is refused: the agent cannot take it mid-turn. */
async function sendAcp(ws: Workspace, id: string, t: string, opts: SendOpts = {}): Promise<void> {
  if (chatBusy.has(id)) throw new ChatError(409, "The AI is still working. Wait until it finishes, then try again.");
  chatBusy.add(id);
  chatWaiting.delete(id); // a new message clears a stale "needs you" from before
  if (!opts.resend) hopped.delete(id);
  acpRaw.set(id, t);
  // Send with…: the agent is on the chosen model before the message goes; if it cannot be, nothing is sent
  if (opts.model) {
    const ready = acps.get(id);
    const acp = ready && !ready.closed && !acpStarting.has(id) ? ready : await startAcp(ws, id).catch(() => undefined); // a start that fails is reported below, as usual
    if (acp) {
      const before = acp.model;
      try {
        await acp.setModel(opts.model);
        if (acp.model !== opts.model) throw new Error("the agent stayed on its model");
      } catch (e) {
        console.warn("[chat] could not use the model for one message:", (e as Error).message);
        if (before) await acp.setModel(before).catch(() => {});
        chatBusy.delete(id);
        throw new ChatError(409, "That model could not be used.");
      }
      acp.restoreModel = before ?? undefined;
    }
  }
  const sent = handoffMessage(id, ws, t, opts.resend);
  const tree = opts.resend ? null : await snapshotTree(worktreePath(ws)); // before the agent starts on this message
  if (!opts.resend) emit(id, { kind: "user", text: t, tree: tree ?? undefined, ...(opts.model ? { with: opts.model } : {}) });
  try {
    await markStarted(id);
    const cur = acps.get(id);
    const acp = cur && !cur.closed && !acpStarting.has(id) ? cur : await startAcp(ws, id);
    // the first message of a new agent session carries the project's notes; the mark is cleared only once it is sent
    const notes = notesOf(ws);
    const brain = brainSummaryOf(ws);
    acp.prompt(acp.freshSession && (notes || brain) ? notesMessagePrefix(notes, brain) + sent : sent);
    acp.freshSession = false;
    if (hasPendingContext(ws)) await clearHandoff(id).catch(() => {}); // only once the agent has the message
  } catch (e) {
    console.error("[chat] could not start:", (e as Error).message);
    emit(id, { kind: "error", text: acpStartFailure(ws.agent, e) });
    chatBusy.delete(id);
    await finish(id);
  }
}

/** The model ids a person added to this project's account, and a router's own models: known to Kohlab even when the AI's list does not name them. */
function extraModels(ws: Workspace): string[] {
  const out = overlayOf(ws.agent, ws.account ?? "default").custom.map((m) => m.value);
  const a = ws.account ? getAccount(ws.account) : undefined;
  if (a?.kind === "router") out.push(...(a.models ?? []));
  return out;
}

/** A model id the chat may be given: text up to 200 characters, no spaces. */
const modelText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\s\x00-\x1f]/.test(v);

/** The model an ACP chat runs on. With a live agent it is switched there; either way it is saved on the project for the next start. */
async function acpModel(id: string, value: unknown): Promise<void> {
  loadCaps(id);
  if (!modelText(value)) throw new ChatError(400, "That model is not available.");
  // The agent's list is known once it has started; before that, the choice is saved and the agent checks it at its start.
  const ws = await getWorkspace(id);
  const offered = capsOf(id).models.length ? capsOf(id).models : agentInfo(ws.agent).models;
  if (offered.length > 0 && !offered.some((m) => m.value === value) && !extraModels(ws).includes(value)) throw new ChatError(400, "That model is not available.");
  const acp = acps.get(id);
  if (acp && acp.started && !acp.closed) {
    await acp.setModel(value).catch((e) => {
      console.warn("[chat] could not switch the agent's model:", (e as Error).message);
      throw new ChatError(409, "The agent could not switch to that model. Try again.");
    });
    if (acp.model !== value) throw new ChatError(409, "The agent could not switch to that model. Try again.");
  }
  await mutateState((s) => {
    const w = s.workspaces.find((x) => x.id === id);
    if (w) w.agentModel = value;
  });
  agentInfo(ws.agent).lastModel = value;
  saveAgentInfo(ws.agent);
}

/** The permission mode of an ACP chat: kept on the project, and decided by Kohlab at each request, so no restart is needed. */
async function acpMode(id: string, value: unknown): Promise<void> {
  if (!isMode(value) || value === "plan") throw new ChatError(400, "That mode is not available.");
  await mutateState((s) => {
    const w = s.workspaces.find((x) => x.id === id);
    if (w) w.permissionMode = value;
  });
  setPolicy(id, await getWorkspace(id), await defaultsOf());
  const acp = acps.get(id);
  // Full access answers what is already waiting
  if (value === "full" && acp) for (const requestId of [...acp.asks.keys()]) acp.answer(requestId, true);
}

/** Controls an ACP chat supports: the model, the permission mode, and stopping the turn. The rest wait for ACP support. */
async function acpControl(id: string, action: unknown, value: unknown): Promise<{ ok: true }> {
  if (action === "model") {
    await acpModel(id, value);
    return { ok: true };
  }
  if (action === "mode") {
    await acpMode(id, value);
    return { ok: true };
  }
  if (action !== "interrupt") throw new ChatError(400, "This action is not available for this agent yet.");
  const acp = acps.get(id);
  if (!acp || acp.closed) throw new ChatError(409, "The agent is not running.");
  acp.cancel();
  return { ok: true };
}

/** Whether a model may be asked for in one message: the AI's own list, Claude's aliases, "default", or one added to the account. */
function oneShotModel(ws: Workspace, id: string, value: unknown): string {
  if (!modelText(value)) throw new ChatError(400, "That model is not available.");
  loadCaps(id);
  const listed = capsOf(id).models.length ? capsOf(id).models : agentInfo(ws.agent).models;
  const known = value === "default" || listed.some((m) => m.value === value) || extraModels(ws).includes(value) || (ws.agent === "claude" && parseModel(value) !== null);
  if (!known && (listed.length > 0 || ws.agent === "claude")) throw new ChatError(400, "That model is not available.");
  return value;
}

/** Send a user message. Starts the claude process if none is alive. `opts.model`: send this one message with another model (never saved on the project). */
export async function send(id: string, text: string, opts: SendOpts = {}): Promise<void> {
  const t = text.trim();
  if (!t) throw new ChatError(400, "The message is empty.");
  if (t.length > MAX_TEXT) throw new ChatError(400, `The message is over ${MAX_TEXT} characters.`);
  if (restoring.has(id)) throw new ChatError(409, "The project's files are being put back. Try again in a moment.");
  let ws = await wsOf(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  const model = opts.model === undefined ? undefined : oneShotModel(ws, id, opts.model);
  if (ws.chat && !chatBusy.has(id) && !opts.resend) ws = await limitCheck(id, ws);
  const so: SendOpts = { ...opts, model };
  if (isAcp(ws)) return sendAcp(ws, id, t, so);
  if (term) await syncFromTerminal(ws);
  if (!term && (await resumeOpen(id))) throw new ChatError(409, "Claude is open in the terminal. Close it there, then send your message again.");
  // The terminal's Claude moves into the chat: its terminal screen closes first, unless it is still working there.
  if (term && !procs.has(id)) {
    const now = await getWorkspace(id);
    if (await isAlive(now)) {
      if (now.promptAt && (!now.stopped || now.promptAt > now.stopped)) throw new ChatError(409, "Claude is still working in the terminal. Wait until it finishes, then send again.");
      await closeMain(id);
    }
    await mutateState((st) => {
      const w = st.workspaces.find((x) => x.id === id);
      if (w) w.resumeInTerminal = true;
    });
  }
  // check and claim in one synchronous step, so two posts cannot both start a turn.
  // While a turn runs, a live process takes the message as a queued one: the CLI runs it after the turn.
  const queued = chatBusy.has(id);
  if (!queued) retireStale(id, ws); // notes changed since this process started: the next one is started with them
  if (queued && !procs.has(id)) throw new ChatError(409, "The AI is still working. Wait until it finishes, then try again.");
  // One message with another model, while a turn runs, would change the model for the turn that is running
  if (queued && model !== undefined) throw new ChatError(409, "Wait until the current reply finishes, then send with another model.");
  if (!queued) chatBusy.add(id);
  if (!queued) chatWaiting.delete(id); // a new message clears a stale "needs you" from before
  if (!queued && !opts.resend) hopped.delete(id);
  // A live process is moved to the model for this message, and moved back when the turn ends. If it cannot be moved, nothing is sent.
  let restore: string | undefined;
  const had = procs.get(id);
  if (!queued && had && model !== undefined) {
    try {
      await had.ready;
      const back = (term ? ws.model : resolveAi(ws, await defaultsOf()).model.value) ?? "default";
      if (model !== back) {
        await ask(had, { subtype: "set_model", model });
        restore = back;
      }
    } catch (e) {
      console.warn("[chat] could not use the model for one message:", (e as Error).message);
      chatBusy.delete(id);
      throw new ChatError(409, "That model could not be used.");
    }
  }
  // The id is ours, so the message can be named for Undo at once. The CLI keeps the id it is sent with.
  const uuid = randomUUID();
  const sent = handoffMessage(id, ws, t, opts.resend);
  // A message queued behind a running turn gets no snapshot: the files are mid-turn, so it would mislead.
  const tree = queued || opts.resend ? null : await snapshotTree(worktreePath(ws));
  if (!opts.resend) emit(id, { kind: "user", text: t, uuid, tree: tree ?? undefined, ...(model !== undefined ? { with: model } : {}) });
  try {
    if (!queued) await markStarted(id);
    const live = (had && !had.closed ? had : undefined) ?? procs.get(id) ?? (await start(term ? await getWorkspace(id) : ws, id, model !== undefined ? { model } : {}));
    if (!queued) {
      live.msg = sent;
      live.rawMsg = t;
      if (restore !== undefined) live.restoreModel = restore;
      turnBegan(id, live);
    }
    live.child.stdin!.write(JSON.stringify({ type: "user", uuid, message: { role: "user", content: sent }, parent_tool_use_id: null }) + "\n");
    if (hasPendingContext(ws)) await clearHandoff(id).catch(() => {}); // only once Claude has the message
  } catch (e) {
    if (e instanceof ChatError) throw e;
    console.error("[chat] could not start:", (e as Error).message);
    emit(id, { kind: "error", text: friendlyError((e as Error).message) });
    if (!queued) {
      chatBusy.delete(id);
      await finish(id);
    }
  }
}

/** The project's live claude process, started if none runs. Waits for its init reply, so the menus are known. */
async function liveFor(id: string): Promise<Live> {
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  let live = procs.get(id);
  if (!live) {
    // a terminal's Claude runs in its own screen: the chat can only control a process it started
    if (term) throw new ChatError(409, "Send a message first, then change this.");
    live = await start(ws, id);
  }
  await live.ready;
  return live;
}

/** Plan usage is the server owner's account data: only people who can change this workspace see the context and windows, only the owner sees the plan name. */
function shownUsage(u: Usage | undefined, owner: boolean): Usage | null {
  if (!u) return null;
  return { context: u.context, plan: u.plan ? { ...u.plan, subscription: owner ? u.plan.subscription : null } : null };
}

/** Context and plan usage: read from the live process when a turn ends (or on the first poll that finds none), kept in memory. Never throws. */
async function readUsage(id: string, live: Live, force: boolean): Promise<void> {
  if (usageReading.has(id) || live.closed || live.stopping) return;
  const last = usageAt.get(id) ?? 0;
  if (!force && (usages.has(id) || Date.now() - last < 30_000)) return;
  usageReading.add(id);
  usageAt.set(id, Date.now());
  try {
    const [context, plan] = await Promise.all([ask(live, { subtype: "get_context_usage", detail: "summary" }), ask(live, { subtype: "get_usage" })]);
    usages.set(id, usageOf(context, plan));
  } catch (e) {
    console.warn("[chat] usage:", (e as Error).message);
  } finally {
    usageReading.delete(id);
  }
}

/** The plan usage a get_usage reply holds, as the Usage dialog shows it. Pure. */
export function planUsageOf(reply: any): Usage["plan"] {
  return usageOf(null, reply).plan;
}

/** The reply to one control request in a line of the CLI's stream: ok, and its body. Undefined for any other line. Pure. */
export function controlReplyOf(line: string, requestId: string): { ok: boolean; response: any } | undefined {
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return undefined;
  }
  const r = m?.type === "control_response" ? m.response : undefined;
  if (!r || r.request_id !== requestId) return undefined;
  return { ok: r.subtype === "success", response: r.response };
}

/** The freshest plan usage read by any workspace's live chat, with when it was read. */
function freshestPlan(): { plan: NonNullable<Usage["plan"]>; at: number } | null {
  let best: { plan: NonNullable<Usage["plan"]>; at: number } | null = null;
  for (const [id, u] of usages) {
    const at = usageAt.get(id) ?? 0;
    if (u.plan && (!best || at > best.at)) best = { plan: u.plan, at };
  }
  return best;
}

/** What one headless claude says about the account: who is signed in, the models it offers and the plan limits. */
export interface ClaudeProbe {
  /** the initialize reply's account (email, subscriptionType, apiProvider, apiKeySource, tokenSource); null when it had none */
  account: Record<string, unknown> | null;
  models: Caps["models"];
  /** the whole get_usage reply, for the hub's windows */
  planRaw: any;
  plan: Usage["plan"];
  at: number;
}

/** A claude that is only asked initialize and get_usage. No user message, so no model call. Killed after its replies, or at 12 s. With an account, under that account's own sign-in directory (the same one its chats use). */
async function headlessProbe(accountId?: string): Promise<ClaudeProbe> {
  const s = await loadState();
  const cmd = (s.agents?.claude || "claude").split(/\s+/)[0];
  const bin = Bun.which(cmd);
  if (!bin) throw new Error(`${cmd} is not installed on this server`);
  const acct = accountId ? getAccount(accountId) : undefined;
  if (accountId && (!acct || acct.provider !== "claude" || acct.kind !== "login")) throw new Error("That account cannot be read this way");
  const run = acct ? runAsOf(acct) : { uid: undefined, gid: undefined, home: homedir() };
  const dir = mkdtempSync(join(tmpdir(), "kohlab-usage-"));
  if (run.uid !== undefined) chownSync(dir, run.uid, run.gid ?? run.uid);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "project,local", "--disable-slash-commands", "--strict-mcp-config"];
  const child = spawn(bin, args, { cwd: dir, uid: run.uid, gid: run.gid, env: childEnv(run.home, acct ? envOfAccount(acct) : undefined), stdio: ["pipe", "pipe", "pipe"] });
  child.stdin!.on("error", () => {}); // a dead process: the exit below reports it
  child.stderr!.on("data", () => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<ClaudeProbe>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Claude did not answer in time")), 12_000);
      let init: any;
      let got: any;
      let bytes = 0;
      child.stdout!.on("data", (d: Buffer) => {
        bytes += d.length;
        if (bytes > 4 * 1024 * 1024) reject(new Error("Claude said too much"));
      });
      createInterface({ input: child.stdout! }).on("line", (l) => {
        const i = controlReplyOf(l, "usage-init");
        if (i && !i.ok) reject(new Error("Claude did not start"));
        else if (i) init = i.response ?? {};
        const g = controlReplyOf(l, "usage-get");
        if (g) {
          if (!g.ok) reject(new Error("Claude could not say its usage"));
          else got = g.response ?? {};
        }
        if (init !== undefined && got !== undefined) {
          const acctInfo = init.account && typeof init.account === "object" ? (init.account as Record<string, unknown>) : null;
          resolve({ account: acctInfo, models: modelList(init.models), planRaw: got, plan: planUsageOf(got), at: Date.now() });
        }
      });
      child.on("error", (e) => reject(e));
      child.on("exit", () => reject(new Error("Claude stopped")));
      child.stdin!.write(JSON.stringify({ type: "control_request", request_id: "usage-init", request: { subtype: "initialize" } }) + "\n");
      child.stdin!.write(JSON.stringify({ type: "control_request", request_id: "usage-get", request: { subtype: "get_usage" } }) + "\n");
    });
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The account, models and plan limits, from one headless claude per account. A reading younger than maxAgeMs is reused; callers at the same moment share one spawn, and no two spawns run at once, whatever the account. Throws when none can read it.
 *  ponytail: one spawn at a time, no warm process. Upgrade path: keep one warm if the hub is opened very often. */
const probeCaches = new Map<string, ClaudeProbe>();
const probeInflights = new Map<string, Promise<ClaudeProbe>>();
let probeTail: Promise<unknown> = Promise.resolve();
export function claudeProbe(maxAgeMs = 300_000, accountId?: string): Promise<ClaudeProbe> {
  const key = accountId ?? "default";
  const have = probeCaches.get(key);
  if (have && Date.now() - have.at < maxAgeMs) return Promise.resolve(have);
  let p = probeInflights.get(key);
  if (!p) {
    const run = probeTail.catch(() => {}).then(() => headlessProbe(accountId));
    probeTail = run;
    p = run
      .then((r) => {
        probeCaches.set(key, r);
        return r;
      })
      .finally(() => {
        probeInflights.delete(key);
      });
    probeInflights.set(key, p);
  }
  return p;
}

/** Forgets what was read for an account (it was removed, or signed in again). */
export function forgetProbe(accountId?: string): void {
  probeCaches.delete(accountId ?? "default");
}

/** The models an AI offered when last seen (its own list, from a chat with it). Empty until then. */
export function agentModels(agent: string): Caps["models"] {
  return agentInfo(agent).models;
}

/** The owner's plan usage for the Usage dialog. A reading under 2 minutes old is used as is; else a live chat reads it now; else a headless claude does (shared with the AI hub, reused up to 60 s). Throws when none can read it. */
export function ownerPlanUsage(): Promise<{ plan: Usage["plan"]; at: number }> {
  // Concurrent requests share one read.
  inflightUsage ??= readOwnerPlanUsage().finally(() => {
    inflightUsage = null;
  });
  return inflightUsage;
}
let inflightUsage: Promise<{ plan: Usage["plan"]; at: number }> | null = null;
async function readOwnerPlanUsage(): Promise<{ plan: Usage["plan"]; at: number }> {
  const now = Date.now();
  const fresh = freshestPlan();
  if (fresh && now - fresh.at < 120_000) return fresh;
  const dflt = probeCaches.get("default");
  if (dflt && now - dflt.at < 60_000) return dflt;
  for (const [id, live] of procs) {
    if (live.closed || live.stopping) continue;
    await readUsage(id, live, true);
    const got = freshestPlan();
    if (got && got.at >= now) return got;
    break;
  }
  const p = await claudeProbe(60_000);
  return { plan: p.plan, at: p.at };
}

const MENTION_CAP = 50;
const FILE_LIST_TTL_MS = 10_000;
const FILE_LIST_MS = 5_000;
const FILE_LIST_BYTES = 5 * 1024 * 1024;
/** Each workspace's file list for @ mentions, kept for FILE_LIST_TTL_MS. */
const fileLists = new Map<string, { at: number; paths: string[] }>();

/** The files of a worktree git knows about: tracked, or not ignored. Read as the server, as checkpoints.ts reads git. Empty on a timeout, an error, or no repo. */
function listFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const p = spawn("git", ["-c", "safe.directory=*", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let capped = false;
    let settled = false;
    const settle = (paths: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(paths);
    };
    const timer = setTimeout(() => {
      p.kill();
      settle([]);
    }, FILE_LIST_MS);
    p.stdout.on("data", (d: Buffer) => {
      if (capped) return;
      const room = FILE_LIST_BYTES - size;
      if (d.length > room) {
        chunks.push(d.subarray(0, room));
        size = FILE_LIST_BYTES;
        capped = true;
        p.kill();
      } else {
        chunks.push(d);
        size += d.length;
      }
    });
    p.stderr.resume();
    p.on("error", () => settle([]));
    p.on("close", (code) => {
      if (!capped && code !== 0) return settle([]);
      let out = Buffer.concat(chunks);
      if (capped) out = out.subarray(0, out.lastIndexOf(0) + 1); // a path cut in half is dropped
      settle(out.toString("utf8").split("\0").filter(Boolean));
    });
  });
}

/** The paths an @ mention matches: a case-insensitive substring of the path, with basename prefix matches first, at most MENTION_CAP. Pure. */
export function rankFiles(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  const hits = paths.filter((p) => p.toLowerCase().includes(q));
  const prefix = (p: string) => basename(p).toLowerCase().startsWith(q);
  return [...hits.filter(prefix), ...hits.filter((p) => !prefix(p))].slice(0, MENTION_CAP);
}

/** The files an @ mention can pick: the project's own list, for every agent, with or without a running process. */
async function fileMentions(id: string, query: unknown): Promise<string[]> {
  if (typeof query !== "string" || query.length > 200) return [];
  const hit = fileLists.get(id);
  let paths: string[];
  if (hit && Date.now() - hit.at < FILE_LIST_TTL_MS) paths = hit.paths;
  else {
    paths = await listFiles(worktreePath(await getWorkspace(id)));
    fileLists.set(id, { at: Date.now(), paths });
  }
  return rankFiles(paths, query);
}

/** Stop one background task the CLI listed. The id must be in the current list. */
async function stopTask(id: string, value: unknown): Promise<{ ok: true }> {
  const live = procs.get(id);
  const task = live?.tasks.find((t) => t.id === value);
  if (!live || !task) throw new ChatError(400, "That task is not running.");
  await ask(live, { subtype: "stop_task", task_id: task.id });
  return { ok: true };
}

/** A server message as a plain sentence: a capital first letter and a full stop. */
const sentence = (s: string) => {
  const t = s.trim();
  const up = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(up) ? up : `${up}.`;
};

/** Undo: the files Claude changed since a message. A dry run lists them; the real run puts them back. Only the last message can be undone. */
async function rewindFiles(id: string, value: unknown, dryRun: boolean): Promise<{ ok: true } & Record<string, unknown>> {
  if (typeof value !== "string") throw new ChatError(400, "The message is required.");
  if (chatBusy.has(id)) throw new ChatError(409, "Claude is still working. Wait until it finishes, then undo.");
  let last: string | undefined; // the newest message's id; a message from before this feature, or a terminal's, has none
  for (const e of load(id).events) if (e.kind === "user") last = e.uuid;
  if (last === undefined || last !== value) throw new ChatError(400, "Only the last message can be undone.");
  const live = await liveFor(id);
  const r = await ask(live, { subtype: "rewind_files", user_message_id: value, ...(dryRun ? { dry_run: true } : {}) });
  if (r?.canRewind === false || r?.error) throw new ChatError(409, r.error ? sentence(String(r.error)) : "Those changes can't be undone.");
  const raw: unknown[] = Array.isArray(r?.filesChanged) ? r.filesChanged : [];
  const inside = (p: unknown) => typeof p === "string" && (!isAbsolute(p) ? !p.split("/").includes("..") : p.startsWith(live.cwd + "/"));
  if (!raw.every(inside)) throw new ChatError(409, "Some of those changes are outside this project, so they can't be undone here.");
  const files = raw.map((p) => rel(p, live.cwd));
  return { ok: true, files, insertions: Number(r?.insertions) || 0, deletions: Number(r?.deletions) || 0 };
}

/** A model, mode or effort change. With a live process it goes to that process. With none, it is saved and the next start uses it. */
async function setting(id: string, action: "model" | "mode" | "effort", value: unknown): Promise<void> {
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  loadCaps(id);
  const live = procs.get(id);
  if (live) await live.ready;
  switch (action) {
    case "model": {
      const models = capsOf(id).models;
      const picked = parseModel(value);
      // "default" is a choice of its own (the account's own model) and overrides the server default; a terminal project has no server default to override
      const stored = (v: string): string | undefined => (v === "default" && term ? undefined : v);
      const custom = modelText(value) && extraModels(ws).includes(value);
      if (live) {
        const known = value === "default" || models.some((m) => m.value === value) || custom;
        if (!known) throw new ChatError(400, "That model is not available.");
        await ask(live, { subtype: "set_model", model: value });
        // "default" shows as chosen until the next init reports the real model
        live.model = String(value);
        lastSeen.set(id, { model: live.model, mode: live.mode });
        const levels = models.find((m) => m.value === value)?.supportedEffortLevels ?? [];
        const dropEffort = !!live.effort && !levels.includes(live.effort);
        if (dropEffort) live.effort = undefined;
        // the choice is kept, so a restarted process uses the same model
        if (typeof value === "string") {
          await mutateState((s) => {
            const w = s.workspaces.find((x) => x.id === id);
            if (!w) return;
            w.model = stored(value); // an alias, or a listed model's own name
            if (dropEffort) w.effort = undefined;
          });
        }
      } else {
        // no process: only an alias is saved, and a listed model when the list is known
        const known = (picked !== null && (picked === "default" || models.length === 0)) || models.some((m) => m.value === value) || custom;
        if (!known || typeof value !== "string") throw new ChatError(400, "That model is not available.");
        const levels = models.find((m) => m.value === value)?.supportedEffortLevels ?? [];
        await mutateState((s) => {
          const w = s.workspaces.find((x) => x.id === id);
          if (!w) return;
          w.model = stored(value); // an alias, or a listed model's own name
          if (w.effort && !levels.includes(w.effort)) w.effort = undefined;
        });
      }
      break;
    }
    case "mode": {
      if (typeof value !== "string" || !MODES.includes(value)) throw new ChatError(400, "That mode is not available.");
      if (live) await applyMode(id, live, ws, value);
      // saved on the project, so it survives a restart and applies when Claude next starts
      await mutateState((s) => {
        const w = s.workspaces.find((x) => x.id === id);
        if (w) w.permissionMode = value as Workspace["permissionMode"];
      });
      lastSeen.set(id, { model: live ? live.model : (lastSeen.get(id)?.model ?? null), mode: value });
      break;
    }
    case "effort": {
      if (typeof value !== "string" || !EFFORTS.includes(value)) throw new ChatError(400, "That effort level is not available.");
      if (live) {
        await ask(live, { subtype: "apply_flag_settings", settings: { effortLevel: value } });
        live.effort = value;
      }
      await mutateState((s) => {
        const w = s.workspaces.find((x) => x.id === id);
        if (w) w.effort = value as Workspace["effort"];
      });
      break;
    }
  }
  persistCaps(id);
}

/** Puts a live Claude in a permission mode. "Full access" is Claude's "default" with Kohlab answering the asks itself; a switch to it also answers what is waiting. */
async function applyMode(id: string, live: Live, ws: Workspace, value: string): Promise<void> {
  const pol = claudeArgsFor(value);
  const before = live.fullAccess ? "full" : (live.mode ?? (MODES.includes(ws.permissionMode ?? "") ? ws.permissionMode : undefined));
  await ask(live, { subtype: "set_permission_mode", mode: pol.permissionMode });
  if (value === "plan" && before !== "plan") live.beforePlan = before;
  live.mode = pol.permissionMode;
  live.fullAccess = pol.fullAccess;
  if (!pol.fullAccess) return;
  for (const [requestId, a] of [...live.asks]) {
    if (PERSONAL_ASKS.has(a.tool)) continue;
    live.asks.delete(requestId);
    writeAnswer(live, requestId, answerResponse(a.tool, a.input, true, {}).response);
    emit(id, { kind: "answer", requestId, allow: true });
  }
  if (live.asks.size === 0) chatWaiting.delete(id);
}

/** Where a conversation can go: an AI (Claude or an ACP agent) and, for Claude and Codex, an account. */
interface Lane {
  agent: string;
  /** an account id; null or undefined = the AI's own login. Left out = keep the current account when the AI stays the same. */
  account?: string | null;
}
interface LaneOptions {
  /** no "Switched to" line (the caller writes its own) */
  quiet?: boolean;
  /** switch even while a turn runs: the turn is over, only its bookkeeping is not yet */
  force?: boolean;
  /** the limit hop in force stays set */
  keepLimit?: boolean;
  /** the AI and account were chosen on purpose, so later changes to the defaults leave them alone (the default) */
  pin?: boolean;
}

/** Moves a chat project to another lane: an AI, or another account of it. Every lane keeps its own session and what it has seen, so switching back resumes it; the lane moved to is told what it has missed, with the person's next message. */
async function switchLane(id: string, to: Lane, o: LaneOptions = {}): Promise<{ ok: true }> {
  const ws = await getWorkspace(id);
  if (!ws.chat) throw new ChatError(400, "This is not a chat project.");
  const agent = to.agent;
  if (typeof agent !== "string" || (agent !== "claude" && !isAcpAgent(agent))) throw new ChatError(400, "That agent is not available.");
  const account = to.account === undefined ? (agent === ws.agent ? ws.account : undefined) : (to.account ?? undefined);
  if (account !== undefined) {
    const a = getAccount(account);
    if (!a || a.provider !== agent) throw new ChatError(400, "That account is not available.");
    if (!usableBy(a, ws)) throw new ChatError(403, "This project runs as its own account, so it keeps its own sign-in.");
  }
  const same = agent === ws.agent && (account ?? "") === (ws.account ?? "");
  if (same) {
    if (o.pin !== false && !ws.agentPinned) await mutateState((st) => void (st.workspaces.find((x) => x.id === id)!.agentPinned = true));
    return { ok: true };
  }
  const bin = agent === "claude" ? ((await loadState()).agents?.claude || "claude").split(/\s+/)[0] : ACP_AGENTS[agent][0];
  if (!Bun.which(bin)) throw new ChatError(400, `${AGENT_NAMES[agent] ?? agent} is not installed on this server.`);
  if (!o.force && chatBusy.has(id)) throw new ChatError(409, "Wait until the current reply finishes");
  // nothing awaits between this check and the stop, so no turn can start in between
  const lastN = load(id).events.at(-1)?.n ?? 0;
  stop(id);
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) return;
    const oldLane = laneKey(w.agent, w.account);
    const newLane = laneKey(agent, account);
    const sessions = { ...w.agentSessions };
    if (w.chatSession) sessions[oldLane] = w.chatSession;
    else delete sessions[oldLane];
    const seen = { ...w.agentSeen, [oldLane]: lastN };
    const resumed = sessions[newLane];
    const routers = [w.account, account].some((x) => x && getAccount(x)?.kind === "router");
    w.agentSessions = sessions;
    w.agentSeen = seen;
    if (w.agent !== agent) w.agentModel = undefined; // an ACP agent's model is its own: the new one starts on the default or its own
    if (routers) w.model = undefined; // a model of one router means nothing to another sign-in
    w.agent = agent;
    w.account = account;
    w.chatSession = resumed;
    // a new lane has seen nothing; one that resumes its own conversation has seen up to when it last spoke
    w.handoffAfter = resumed === undefined ? 0 : (seen[newLane] ?? 0);
    if (!o.keepLimit) delete w.limit;
    if (o.pin !== false) w.agentPinned = true;
  });
  // the menus are the new lane's: the old ones are cleared, and an ACP agent is warmed up again for its list
  loadCaps(id);
  capsOf(id).models = [];
  lastSeen.delete(id);
  warmed.delete(id);
  persistCaps(id);
  if (!o.quiet) emit(id, { kind: "note", text: agent !== ws.agent ? `Switched to ${AGENT_NAMES[agent] ?? agent}` : `Switched to ${laneLabel(agent, account)}` });
  return { ok: true };
}

/** What the person calls a lane: the account's name, or the AI's. */
function laneLabel(agent: string, account?: string | null): string {
  return (account ? getAccount(account)?.label : undefined) ?? AGENT_NAMES[agent] ?? agent;
}

/** The "agent" control: an AI by name, or {agent, account}. */
async function switchAgent(id: string, value: unknown): Promise<{ ok: true }> {
  const v = value as { agent?: unknown; account?: unknown } | null;
  if (typeof value === "string") return switchLane(id, { agent: value });
  if (v && typeof v === "object" && typeof v.agent === "string" && (v.account === undefined || v.account === null || typeof v.account === "string")) {
    return switchLane(id, { agent: v.agent, account: v.account as string | null | undefined });
  }
  throw new ChatError(400, "That agent is not available.");
}

/** The "account" control: another sign-in for the same AI (null = the AI's own). */
async function setAccount(id: string, value: unknown): Promise<{ ok: true }> {
  if (value !== null && typeof value !== "string") throw new ChatError(400, "That account is not available.");
  const ws = await getWorkspace(id);
  if (!ws.chat) throw new ChatError(400, "This is not a chat project.");
  return switchLane(id, { agent: ws.agent, account: value });
}

/** The "reset" control: a setting goes back to inheriting the server's default. */
async function resetField(id: string, value: unknown): Promise<{ ok: true }> {
  if (typeof value !== "string" || !(RESET_FIELDS as readonly string[]).includes(value)) throw new ChatError(400, "That setting cannot be reset.");
  const field = value as (typeof RESET_FIELDS)[number];
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  const d = (await defaultsOf()) ?? {};
  if (field === "agent" || field === "account") {
    if (!ws.chat) throw new ChatError(400, "This is not a chat project.");
    // before the first message the project simply follows the defaults again; after it, the conversation moves to them
    if (!ws.started) {
      stop(id);
      await mutateState((st) => {
        const w = st.workspaces.find((x) => x.id === id);
        if (!w) return;
        delete w.agentPinned;
        delete w.limit;
      });
      await wsOf(id);
      return { ok: true };
    }
    const agent = field === "agent" && d.agent ? d.agent : ws.agent;
    const acct = d.account && getAccount(d.account)?.provider === agent ? d.account : null;
    return switchLane(id, { agent, account: field === "account" ? acct : agent === ws.agent ? ws.account : acct });
  }
  const live = procs.get(id);
  if (live) await live.ready;
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) return;
    if (field === "model") {
      delete w.model;
      delete w.agentModel;
    } else if (field === "effort") delete w.effort;
    else if (field === "mode") delete w.permissionMode;
    else delete w.autoFresh;
  });
  const fresh = await getWorkspace(id);
  const ai = resolveAi(fresh, d);
  if (live && !live.closed) {
    if (field === "model") {
      await ask(live, { subtype: "set_model", model: ai.model.value ?? "default" }).catch((e) => console.warn("[chat] reset model:", (e as Error).message));
      live.model = ai.model.value ?? "default";
    } else if (field === "effort" && ai.effort.value) {
      await ask(live, { subtype: "apply_flag_settings", settings: { effortLevel: ai.effort.value } }).catch(() => {});
      live.effort = ai.effort.value;
    } else if (field === "effort") live.effort = undefined;
    else if (field === "mode") await applyMode(id, live, fresh, ai.mode.value ?? "default").catch((e) => console.warn("[chat] reset mode:", (e as Error).message));
  }
  if (field === "mode" && acps.has(id)) setPolicy(id, fresh, d);
  if (field === "autoFresh" && ai.autoFresh.value !== false) maybeAutoFresh(id);
  persistCaps(id);
  return { ok: true };
}

/** The "fallback" control: what to do at a usage limit. null = the suggested order. */
async function setFallback(id: string, value: unknown): Promise<{ ok: true }> {
  const ws = await getWorkspace(id);
  if (!ws.chat) throw new ChatError(400, "This is not a chat project.");
  let next: Workspace["fallback"] | undefined;
  if (value !== null) {
    const v = value as { auto?: unknown; steps?: unknown } | undefined;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new ChatError(400, "That fallback list is not valid.");
    if (v.auto !== undefined && typeof v.auto !== "boolean") throw new ChatError(400, "That setting must be on or off.");
    next = { ...ws.fallback };
    if (v.auto !== undefined) next.auto = v.auto;
    if (v.steps !== undefined) {
      if (!Array.isArray(v.steps) || v.steps.length > 10) throw new ChatError(400, "A fallback list has up to 10 steps.");
      next.steps = v.steps.map((x: any): FallbackStep => {
        if (!x || typeof x !== "object") throw new ChatError(400, "That fallback step is not valid.");
        const step: FallbackStep = {};
        if (x.account !== undefined) {
          if (x.account !== null && (typeof x.account !== "string" || getAccount(x.account)?.provider !== ws.agent)) throw new ChatError(400, "That account is not available.");
          step.account = x.account;
        }
        if (x.model !== undefined) {
          if (!modelText(x.model)) throw new ChatError(400, "That model is not valid.");
          step.model = x.model;
        }
        if (step.account === undefined && step.model === undefined) throw new ChatError(400, "A step needs an account or a model.");
        return step;
      });
    }
  }
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) return;
    if (next === undefined) delete w.fallback;
    else w.fallback = next;
  });
  return { ok: true };
}

/** The "rule_remove" control: the project stops allowing an action without asking. Claude holds its rules until it restarts, so that happens when the project is next idle (the next message resumes the conversation). */
async function removeRule(id: string, value: unknown, actor: string): Promise<{ ok: true }> {
  const ws = await getWorkspace(id);
  if (!ws.chat) throw new ChatError(400, "This is not a chat project.");
  if (typeof value !== "string" || !(ws.allowRules ?? []).includes(value)) throw new ChatError(404, "That action is not on the list.");
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) return;
    w.allowRules = (w.allowRules ?? []).filter((r) => r !== value);
    if (!w.allowRules.length) delete w.allowRules;
  });
  void audit(actor, "ai.rule.remove", id, value);
  if (acps.has(id)) setPolicy(id, await getWorkspace(id), await defaultsOf());
  if (procs.has(id)) {
    if (chatBusy.has(id)) restartAtIdle.add(id);
    else stop(id);
  }
  return { ok: true };
}

/** Saves the rule an "Always allow" asked for, when the ask offered one. Returns the rule that was saved. */
async function addRule(id: string, rule: string): Promise<boolean> {
  if (!validRule(rule)) return false;
  let saved = false;
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) return;
    const next = cleanRules([...(w.allowRules ?? []), rule]);
    saved = next.includes(rule);
    w.allowRules = next;
  });
  if (saved && acps.has(id)) setPolicy(id, await getWorkspace(id), await defaultsOf());
  return saved;
}

/** The chat's menu actions: stop the turn, or change the model, permission mode or effort (saved even with no process running).
 *  Also the reads and small actions the chat uses: "files" (@ mentions), "stop_task", "rewind_preview" and "rewind" (Undo), "agent" (switch the AI, or the AI and account), "account", "reset", "fallback" and "rule_remove".
 *  `who.owner`: Full access is the owner's to give, or any project that runs as its own OS account. */
export async function chatControl(id: string, action: unknown, value: unknown, who: { owner: boolean; actor?: string } = { owner: false }): Promise<{ ok: true } & Record<string, unknown>> {
  if (action === "agent") return switchAgent(id, value);
  if (action === "account") return setAccount(id, value);
  if (action === "reset") return resetField(id, value);
  if (action === "fallback") return setFallback(id, value);
  if (action === "rule_remove") return removeRule(id, value, who.actor ?? "system");
  if (action === "fresh") return freshControl(id, value);
  if (action === "autoFresh") return autoFreshSetting(id, value);
  if (action === "files") return { ok: true, files: await fileMentions(id, value) };
  if (action === "mode" && value === "full") {
    const ws = await getWorkspace(id);
    if (!who.owner && identityOf(ws) === undefined) throw new ChatError(403, "Full access is only for the owner.");
    void audit(who.actor ?? "system", "ai.fullaccess", id);
  }
  if (isAcp(await getWorkspace(id))) return acpControl(id, action, value);
  if (action === "stop_task") return stopTask(id, value);
  if (action === "rewind_preview" || action === "rewind") return rewindFiles(id, value, action === "rewind_preview");
  if (action === "model" || action === "mode" || action === "effort") {
    await setting(id, action, value);
    return { ok: true };
  }
  if (action === "interrupt" && !procs.has(id)) throw new ChatError(409, "Claude is not running.");
  const live = await liveFor(id);
  switch (action) {
    case "interrupt": {
      await ask(live, { subtype: "interrupt" });
      if (chatBusy.has(id)) {
        live.interrupted = true;
        const since = live.busySince;
        // the CLI ends the turn with a result; if none comes, end it here so the chat is not stuck working
        setTimeout(() => {
          if (procs.get(id) !== live || !chatBusy.has(id) || live.busySince !== since) return;
          live.interrupted = false;
          live.draft = "";
          markSeen(id, live);
          chatBusy.delete(id);
          live.busySince = undefined;
          emit(id, { kind: "done", ...(since !== undefined ? { worked: Date.now() - since } : {}) });
          finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
        }, 5000);
      }
      break;
    }
    default:
      throw new ChatError(400, "That action is not available.");
  }
  return { ok: true };
}

/** Claude's answer to a permission question: the response object is built by answerResponse. */
function writeAnswer(live: Live, requestId: string, response: Record<string, unknown>) {
  live.child.stdin!.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n");
}

/** Show a permission question to the person and ping them. `url` is the browser's page, when the tool acts on one.
 *  AskUserQuestion and ExitPlanMode get their own cards (askForm); every other tool gets the permission card. */
function askPerson(id: string, live: Live, requestId: string, tool: string, input: Record<string, unknown>, url: string | null) {
  // the rule an "Always allow" would save, when it is safe to offer one
  const always = askForm(tool, input as Record<string, any>) ? null : ruleFor(tool, input, live.cwd);
  live.asks.set(requestId, { tool, input, ...(always ? { always } : {}) });
  const wasWaiting = chatWaiting.has(id);
  chatWaiting.add(id);
  const form = askForm(tool, input as Record<string, any>);
  if (form) {
    emit(id, { kind: "ask", requestId, ...form });
    if (!wasWaiting) pingNeedsYou(id, form.text);
    return;
  }
  const { text, detail, why } = describeAsk(tool, input as Record<string, any>, live.cwd, url);
  emit(id, { kind: "ask", requestId, text, ...(detail !== undefined ? { detail } : {}), ...(why !== undefined ? { why } : {}), ...(always ? { always } : {}) });
  if (!wasWaiting) pingNeedsYou(id, text);
}

/** A browser tool's permission question: read-only tools are allowed at once, interaction tools on the project's own page too, the rest are asked. */
async function browserAsk(id: string, live: Live, requestId: string, tool: string, input: Record<string, unknown>) {
  // only a tool that acts on the page needs its address and the workspace's own pages; a read does not touch the browser
  const ws = browserToolPolicy(tool, null, NO_OWN_PAGES) === "ask" ? await getWorkspace(id).catch(() => null) : null;
  const url = ws ? await browserUrl(ws).catch(() => null) : null;
  if (live.stopping || live.closed) return;
  if (browserToolPolicy(tool, url, ownPagesOf(ws)) === "allow") writeAnswer(live, requestId, answerResponse(tool, input, true, {}).response);
  else askPerson(id, live, requestId, tool, input, url);
}

const NO_OWN_PAGES: OwnPages = { previewPrefix: null, devOrigin: null };

/** This workspace's own pages: its static preview under its token, and its running dev server. */
function ownPagesOf(ws: Workspace | null): OwnPages {
  const base = ownBase();
  return {
    previewPrefix: ws?.previewToken && base ? `${base}/p/${ws.previewToken}/` : null,
    devOrigin: ws ? devServerOrigin(ws) : null,
  };
}

/** Answer a pending permission question. With `always`, an allow also saves the rule the ask offered (Kohlab keeps the rule; the client only says yes). Returns the rule that was saved, if any. */
export async function answer(id: string, requestId: string, allow: boolean, extra: { answers?: Record<string, string>; message?: string; always?: boolean } = {}): Promise<{ rule?: string }> {
  const acp = acps.get(id);
  if (acp) {
    const entry = acp.asks.get(requestId);
    if (!entry) throw new ChatError(404, "That question is no longer waiting.");
    const rule = allow && extra.always && entry.always ? entry.always.rule : undefined;
    acp.answer(requestId, allow);
    return rule && (await addRule(id, rule)) ? { rule } : {};
  }
  const live = procs.get(id);
  if (!live || !live.asks.has(requestId)) throw new ChatError(404, "That question is no longer waiting.");
  const { tool, input, always } = live.asks.get(requestId)!;
  live.asks.delete(requestId);
  if (live.asks.size === 0) chatWaiting.delete(id);
  const rule = allow && extra.always && always ? always.rule : undefined;
  const { response, reply } = answerResponse(tool, input, allow, { ...extra, ...(rule ? { remember: rule } : {}) });
  writeAnswer(live, requestId, response);
  emit(id, { kind: "answer", requestId, allow, ...(reply ? { reply } : {}) });
  // an approved plan leaves plan mode for the mode it was entered from (default if unknown), through the mode menu's own path, without holding up the reply
  if (tool === "ExitPlanMode" && allow) {
    const back = live.beforePlan && live.beforePlan !== "plan" ? live.beforePlan : "default";
    live.beforePlan = undefined;
    setting(id, "mode", back).catch((e) => console.warn(`[chat] leave plan mode: ${(e as Error).message}`));
    keepPlan(id, String(input.plan ?? ""));
  }
  return rule && (await addRule(id, rule)) ? { rule } : {};
}

/** After a server restart: a chat whose newest question has nothing answered after it is still waiting, so its "needs you" dot comes back. */
export function restoreWaiting(): void {
  if (!existsSync(chatsDir())) return;
  for (const f of readdirSync(chatsDir())) {
    if (!f.endsWith(".jsonl")) continue;
    const id = f.slice(0, -".jsonl".length);
    const events: ChatEvent[] = [];
    let text: string;
    try {
      text = readFileSync(join(chatsDir(), f), "utf8");
    } catch {
      continue; // unreadable: skip it, a restart must not fail on one bad file
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* a torn last line after a crash: skip it */
      }
    }
    let lastAsk = -1;
    for (let i = 0; i < events.length; i++) if (events[i].kind === "ask") lastAsk = i;
    if (lastAsk < 0) continue;
    const answered = events.slice(lastAsk + 1).some((e) => e.kind === "answer" || e.kind === "done" || e.kind === "error" || e.kind === "user");
    if (!answered) chatWaiting.add(id);
  }
}

/** How much of an earlier conversation is read to title it, and the title's length. */
const TITLE_BYTES = 256 * 1024;
const TITLE_CHARS = 80;
const MAX_SESSIONS = 30;

/** The first thing the person asked in one conversation file, as a short title; null when it has no message of theirs. Reads at most TITLE_BYTES. */
function titleOf(file: string, cwd: string): string | null {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let chunk: Buffer;
  try {
    const size = fstatSync(fd).size;
    chunk = Buffer.alloc(Math.min(size, TITLE_BYTES));
    const got = readSync(fd, chunk, 0, chunk.length, 0);
    chunk = chunk.subarray(0, got);
    if (got < size) chunk = chunk.subarray(0, chunk.lastIndexOf(0x0a) + 1); // a window cut mid-line: its last line is not read
  } finally {
    closeSync(fd);
  }
  for (const e of transcriptEvents(chunk.toString("utf8").split("\n"), cwd)) {
    if (e.kind !== "user") continue;
    const t = e.text.replace(/\s+/g, " ").trim();
    return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS)}…` : t;
  }
  return null;
}

/** A Claude project's earlier conversations, newest first, each titled by what the person first asked. Reads only the folder given. Never throws for one bad file. */
export function listSessions(dir: string, cwd: string): { id: string; title: string; at: number }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no folder yet: no earlier conversations
  }
  const found: { id: string; title: string; at: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!/^[\w-]+$/.test(id)) continue;
    try {
      const file = join(dir, name);
      const st = lstatSync(file);
      if (!st.isFile()) continue; // never follow a link
      const title = titleOf(file, cwd);
      if (title !== null) found.push({ id, title, at: st.mtimeMs });
    } catch (e) {
      console.warn(`[chat] conversation list: ${(e as Error).message}`); // one bad file is skipped
    }
  }
  return found.sort((a, b) => b.at - a.at).slice(0, MAX_SESSIONS);
}

/** Claude's folder for a project's conversations: the transcripts of its worktree. */
function sessionDir(ws: Workspace): string {
  return dirname(transcriptFile(identityOf(ws)?.home || homedir(), worktreePath(ws), "x", configDirOf(ws)));
}

/** A Claude project's earlier conversations, and which one is current (null for a new one). */
export async function sessions(id: string): Promise<{ current: string | null; sessions: { id: string; title: string; at: number }[] }> {
  const ws = await getWorkspace(id);
  if (!ws.chat && !(await viaTerminal(ws))) throw new ChatError(400, "This is not a Claude project.");
  return { current: ws.chatSession ?? null, sessions: listSessions(sessionDir(ws), worktreePath(ws)) };
}

/** Start a new conversation (sid null), or switch to an earlier one. The chat's file is kept as one backup, and an earlier conversation's last messages are imported. */
export async function switchSession(id: string, sid: unknown): Promise<void> {
  if (sid !== null && typeof sid !== "string") throw new ChatError(400, "That conversation is not valid.");
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a Claude project.");
  if (chatBusy.has(id)) throw new ChatError(409, "Claude is working. Stop it or wait, then try again.");
  if (term ? await isAlive(ws) : await resumeOpen(id)) throw new ChatError(409, "Claude is open in the terminal. Stop it there first.");
  if (typeof sid === "string" && !listSessions(sessionDir(ws), worktreePath(ws)).some((s) => s.id === sid)) {
    throw new ChatError(404, "That conversation was not found.");
  }
  if (chatBusy.has(id)) throw new ChatError(409, "Claude is working. Stop it or wait, then try again."); // a send began while we looked
  stop(id);
  // one backup of the chat as it was: the person's messages are never deleted outright
  if (existsSync(transcriptPath(id))) renameSync(transcriptPath(id), `${transcriptPath(id)}.prev`);
  rmSync(cursorPath(id), { force: true });
  usages.delete(id);
  usageAt.delete(id);
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) return;
    w.chatSession = sid ?? undefined;
    w.chatReset = Date.now();
    if (!w.chat) w.resumeInTerminal = sid !== null;
  });
  if (typeof sid === "string") await syncFromTerminal(await getWorkspace(id));
}

/** "What this changed": the files one message changed, up to the next message, or up to the files as they are now for the newest. */
export async function chatTurn(id: string, n: unknown): Promise<{ files: TurnFile[]; diff: string }> {
  const ev = userEventAt(id, n);
  if (!ev.tree) throw new ChatError(404, "There is no saved copy of the files from before that message.");
  const next = load(id).events.find((e): e is Extract<ChatEvent, { kind: "user" }> => e.kind === "user" && e.n > ev.n);
  const ws = await getWorkspace(id);
  const to = next ? next.tree : await snapshotTree(worktreePath(ws));
  if (!to) throw new ChatError(next ? 404 : 503, next ? "There is no saved copy of the files from the message after that one." : "Could not read the project's files just now. Try again.");
  return turnChanges(worktreePath(ws), ev.tree, to);
}

/** "Go back to here": the files return to how they were before this message. Refused while the AI works. The files as they are now are saved as a version first, so going back can itself be undone from Earlier versions. */
export async function chatGoBack(id: string, n: unknown): Promise<{ ok: true }> {
  const ev = userEventAt(id, n);
  if (!ev.tree) throw new ChatError(409, "There is no saved copy of the files from before that message.");
  if (chatBusy.has(id)) throw new ChatError(409, "Wait until the AI has finished, then try again.");
  if (restoring.has(id)) throw new ChatError(409, "The project's files are already being put back.");
  restoring.add(id);
  try {
    const ws = await getWorkspace(id);
    const note = excerpt(ev.text);
    await goBackTo(worktreePath(ws), ev.tree, `Went back to before: “${note}”`);
    await mutateState((st) => {
      const w = st.workspaces.find((x) => x.id === id);
      if (!w) throw new Error(`no workspace '${id}'`);
      w.lastCommitAt = Date.now();
      w.restoredFrom = note; // the next message is told the files were put back
    });
    emit(id, { kind: "note", text: `Went back to before: “${note}”` });
  } finally {
    restoring.delete(id);
  }
  return { ok: true };
}

/** "New chat from here": a new conversation whose first message carries what was said up to this one. The files are not touched. */
export async function chatBranch(id: string, n: unknown): Promise<void> {
  const ev = userEventAt(id, n);
  if (restoring.has(id)) throw new ChatError(409, "The project's files are being put back. Try again in a moment.");
  const ws = await getWorkspace(id);
  const summary = handoffText(load(id).events.filter((e) => e.n <= ev.n), ws.agent);
  await switchSession(id, null);
  if (summary) {
    await mutateState((st) => {
      const w = st.workspaces.find((x) => x.id === id);
      if (w) w.branchContext = summary;
    });
  }
}

// ---- Continue fresh: a new AI session that picks up from a handoff note the old one wrote ----

/** Projects where a continue-fresh is under way, and those where it waits for the turn or the background work to end. */
const freshing = new Set<string>();
const freshPending = new Set<string>();
/** When each project last continued fresh: a second one right after would loop if the new session starts full. */
const lastFreshAt = new Map<string, number>();

/** A message the person did not write, sent to the AI as one is, with no bubble in the chat. Claude or an ACP agent. */
async function sendHidden(id: string, text: string): Promise<void> {
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  if (chatBusy.has(id)) throw new ChatError(409, "The AI is still working. Wait until it finishes, then try again.");
  chatBusy.add(id);
  chatWaiting.delete(id);
  try {
    await markStarted(id);
    if (isAcp(ws)) {
      const cur = acps.get(id);
      const acp = cur && !cur.closed && !acpStarting.has(id) ? cur : await startAcp(ws, id);
      const notes = notesOf(ws);
      const brain = brainSummaryOf(ws);
      acp.prompt(acp.freshSession && (notes || brain) ? notesMessagePrefix(notes, brain) + text : text);
      acp.freshSession = false;
      return;
    }
    retireStale(id, ws);
    const live = procs.get(id) ?? (await start(term ? await getWorkspace(id) : ws, id));
    live.msg = text;
    turnBegan(id, live);
    live.child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }) + "\n");
  } catch (e) {
    chatBusy.delete(id);
    await finish(id).catch(() => {});
    throw e;
  }
}

/** Why a continue-fresh cannot start right now, as a plain sentence; null when it can. */
async function freshBlocker(id: string, ws: Workspace, term: boolean): Promise<string | null> {
  if (chatBusy.has(id)) return "The AI is still working. Wait until it finishes, then try again.";
  if (chatWaiting.has(id)) return "The AI is waiting for your answer. Answer it first, then try again.";
  if (chatBackground.has(id)) return "The AI is still doing work in the background. Wait until it finishes, then try again.";
  if (restoring.has(id)) return "The project's files are being put back. Try again in a moment.";
  if (term ? await isAlive(ws) : await resumeOpen(id)) return "Claude is open in the terminal. Close it there first.";
  return null;
}

/** Asks the current session for its handoff note and catches the reply (it is not shown as a message). Falls back to a summary of the chat when there is no block, an error, or no answer in 120 s. */
async function writeHandoff(id: string): Promise<string> {
  const ws = await getWorkspace(id);
  emit(id, { kind: "note", text: "Writing a handoff note…" });
  const caught = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => settle(null), 120_000);
    const settle = (text: string | null) => {
      clearTimeout(timer);
      captures.delete(id);
      resolve(text);
    };
    captures.set(id, { text: "", settle });
    sendHidden(id, HANDOFF_REQUEST).catch((e) => {
      console.warn("[chat] handoff request:", (e as Error).message);
      settle(null);
    });
  });
  // a turn that did not end in time is cut off, so the chat is free again
  if (chatBusy.has(id)) stop(id);
  return (caught !== null ? extractHandoff(caught) : null) ?? handoffText(load(id).events, ws.agent, 7500).slice(0, HANDOFF_CAP);
}

/** Starts the fresh session: the old one is kept in the project's history, the chat stays as it is, and the new session gets the note with the next message, or at once when the note has work in progress. */
async function applyFresh(id: string, note: string): Promise<void> {
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  const blocked = await freshBlocker(id, ws, term);
  if (blocked) throw new ChatError(409, blocked);
  const todos = (procs.get(id)?.todos ?? acps.get(id)?.todos ?? []).map((t) => ({ text: t.text, status: t.status }));
  // nothing awaits between the check and the stop, so no turn can start in between
  stop(id);
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (!w) return;
    if (w.chatSession) w.agentSessions = { ...w.agentSessions, [w.agent]: w.chatSession };
    w.chatSession = undefined;
    w.freshNote = note;
    delete w.handoffAfter; // the note replaces any catch-up: the new session starts from it
    delete w.branchContext;
    if (!w.chat) w.resumeInTerminal = true; // the terminal's Claude resumes the new session
  });
  rmSync(cursorPath(id), { force: true });
  usages.delete(id);
  usageAt.delete(id);
  lastFreshAt.set(id, Date.now());
  freshPending.delete(id);
  // kept in the project brain before the new session starts from it; chats only, and a failure never blocks the fresh start
  if (ws.chat) {
    try {
      const root = brainRoot(ws);
      openRoot(root, ws.task);
      noteHandoff(root, note);
    } catch (e) {
      console.warn(`[brain] handoff not kept: ${(e as Error).message}`);
    }
  }
  emit(id, { kind: "handoff", text: note });
  emit(id, { kind: "note", text: "Continued with a fresh memory" });
  if (!handoffHasWork(note)) return; // the new session waits for the person; the note goes with their first message
  try {
    await sendHidden(id, freshMessage(note, notesOf(await getWorkspace(id)), todos));
    await clearHandoff(id).catch(() => {});
  } catch (e) {
    console.warn("[chat] fresh first message:", (e as Error).message);
    emit(id, { kind: "error", text: friendlyError((e as Error).message) }); // the note stays, and goes with the next message
  }
}

/** The "fresh" control. With {draft: true} (or no note): writes the handoff note and answers {ok, note} (null when none could be made), starting nothing: the dialog shows it. With {note}: starts the fresh session from exactly that note, writing no new one. */
async function freshControl(id: string, value: unknown): Promise<{ ok: true } & Record<string, unknown>> {
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  if (freshing.has(id)) throw new ChatError(409, "A fresh start is already under way.");
  const note = (value as { note?: unknown } | null)?.note;
  if (note !== undefined && (typeof note !== "string" || !note.trim())) throw new ChatError(400, "The note is empty.");
  freshing.add(id);
  try {
    if (typeof note === "string") {
      await applyFresh(id, note.trim().slice(0, HANDOFF_CAP));
      return { ok: true };
    }
    const blocked = await freshBlocker(id, ws, term);
    if (blocked) throw new ChatError(409, blocked);
    if (term && !procs.has(id)) throw new ChatError(409, "Send a message first, then continue fresh.");
    const text = await writeHandoff(id);
    return { ok: true, note: text || null };
  } finally {
    freshing.delete(id);
  }
}

/** The switch for continuing fresh by itself. */
async function autoFreshSetting(id: string, value: unknown): Promise<{ ok: true }> {
  if (typeof value !== "boolean") throw new ChatError(400, "The setting must be on or off.");
  const ws = await getWorkspace(id);
  if (!ws.chat && !(await viaTerminal(ws))) throw new ChatError(400, "This is not a chat project.");
  await mutateState((st) => {
    const w = st.workspaces.find((x) => x.id === id);
    if (w) w.autoFresh = value;
  });
  if (value) maybeAutoFresh(id);
  else freshPending.delete(id);
  return { ok: true };
}

/** After a turn ends, or the background work does: continue fresh by itself when the chat is full, allowed, and idle; else remember to. Never throws. */
function maybeAutoFresh(id: string): void {
  void (async () => {
    const ws = await getWorkspace(id).catch(() => null);
    if (!ws || !(ws.chat || (await viaTerminal(ws)))) return;
    const d = freshDecision({
      percent: usages.get(id)?.context?.percent ?? null,
      auto: resolveAi(ws, await defaultsOf()).autoFresh.value !== false,
      busy: chatBusy.has(id),
      waiting: chatWaiting.has(id),
      background: chatBackground.has(id),
      recent: Date.now() - (lastFreshAt.get(id) ?? 0) < 600_000,
      running: freshing.has(id),
    });
    if (d === "pending") freshPending.add(id);
    else freshPending.delete(id);
    if (d !== "now") return;
    freshing.add(id);
    try {
      await applyFresh(id, await writeHandoff(id));
    } finally {
      freshing.delete(id);
    }
  })().catch((e) => console.warn("[chat] continue fresh:", (e as Error).message));
}

// ---- Usage limits: move the message on to the next account or model ----

/** A model's name for a sentence: the list's own name, else the alias capitalised. */
function modelName(id: string, value: string): string {
  return capsOf(id).models.find((m) => m.value === value)?.displayName ?? (/^[a-z]+$/.test(value) ? value.charAt(0).toUpperCase() + value.slice(1) : value);
}

/** The lanes a project's AI could fall back to, as defaultSteps wants them: the AI's own login first, then each account this project may use. */
function laneCandidates(ws: Workspace): { id: string | null; connected: boolean; limited: boolean }[] {
  const provider = ws.agent;
  const accounts = provider === "claude" || provider === "codex" ? listAccounts(provider).filter((a) => usableBy(a, ws)) : [];
  return [
    { id: null, connected: true, limited: limitedUntil(provider, null) > 0 },
    ...accounts.map((a) => ({ id: a.id as string | null, connected: signedInOf(a.id) !== false, limited: limitedUntil(provider, a.id) > 0 })),
  ];
}

/** The fallback list in force: the project's own, else the suggested order. */
async function fallbackOf(ws: Workspace): Promise<Fallback> {
  const ai = resolveAi(ws, await defaultsOf());
  const custom = ws.fallback?.steps !== undefined;
  return {
    auto: ws.fallback?.auto !== false,
    steps: ws.fallback?.steps ?? defaultSteps({ agent: ws.agent, account: ws.account ?? null, model: ai.model.value, accounts: laneCandidates(ws) }),
    custom,
  };
}

/** Moves the conversation to the next usable step of the fallback list. Returns where it went, "empty" when there is no list to try, or null when every step is at a limit or unusable. Writes the "hit its limit" line. */
async function fallbackHop(id: string, ws: Workspace, until: number): Promise<{ to: string } | "empty" | null> {
  const provider = ws.agent;
  const acct = ws.account ?? null;
  const steps = (await fallbackOf(ws)).steps;
  if (steps.length === 0) return "empty";
  const from = laneLabel(provider, acct);
  const ai = resolveAi(ws, await defaultsOf());
  const arrived = async (to: string, fromModel?: string | null) => {
    const prior = ws.limit;
    const limit: LimitState = prior ? { ...prior, to, at: Date.now() } : { from, to, until, at: Date.now(), fromAccount: acct, ...(fromModel !== undefined ? { fromModel } : {}) };
    await mutateState((st) => void (st.workspaces.find((x) => x.id === id)!.limit = limit));
    emit(id, { kind: "note", text: `${from} hit its limit — continued on ${to}`, until });
    return { to };
  };
  for (const step of steps) {
    if (step.account !== undefined) {
      const target = step.account;
      if (target === acct || limitedUntil(provider, target)) continue;
      if (target) {
        const a = getAccount(target);
        if (!a || a.provider !== provider || !usableBy(a, ws) || signedInOf(target) === false) continue;
      }
      try {
        await switchLane(id, { agent: provider, account: target }, { quiet: true, force: true, keepLimit: true });
        if (step.model && provider === "claude") await setting(id, "model", step.model).catch(() => {});
      } catch (e) {
        console.warn("[chat] fallback step:", (e as Error).message);
        continue;
      }
      return arrived(step.model ? `${laneLabel(provider, target)} (${modelName(id, step.model)})` : laneLabel(provider, target));
    }
    if (step.model && provider === "claude") {
      if (step.model === ai.model.value) continue;
      try {
        await setting(id, "model", step.model);
      } catch (e) {
        console.warn("[chat] fallback step:", (e as Error).message);
        continue;
      }
      return arrived(modelName(id, step.model), ws.model ?? null);
    }
  }
  return null;
}

/** A turn failed on a usage limit. Marks the account, then moves the message on to the next step of the fallback list and sends it again there (once per message; the old account is not called). "moved": the message is on its way. "none": every step is at a limit, and the person has been told. "off": nothing was done (switched off, nothing to fall back to, or this message already moved once), the caller shows the usual error. */
async function onLimit(id: string, text: string | undefined, until: number): Promise<"moved" | "none" | "off"> {
  const ws = await getWorkspace(id).catch(() => null);
  if (!ws || !ws.chat) return "off";
  markLimited(ws.agent, ws.account, until);
  if (ws.fallback?.auto === false || hopped.has(id) || text === undefined) return "off";
  const hop = await fallbackHop(id, ws, until);
  if (hop === "empty") return "off";
  if (hop === null) {
    const all = [...laneCandidates(ws).filter((l) => l.limited).map((l) => limitedUntil(ws.agent, l.id)), until];
    const last = Math.max(...all);
    emit(id, { kind: "note", text: "Every AI in your fallback list is at its limit", until: last });
    emit(id, { kind: "error", text: `Every AI in your fallback list is at its limit until ${clockText(last)}.`, until: last });
    return "none";
  }
  hopped.add(id);
  chatBusy.delete(id);
  chatWaiting.delete(id);
  send(id, text, { resend: true }).catch((e) => {
    console.warn("[chat] could not send again:", (e as Error).message);
    emit(id, { kind: "error", text: friendlyError((e as Error).message) });
    emit(id, { kind: "done" });
    finish(id).catch(() => {});
  });
  return "moved";
}

/** Before a message goes: back to the account that was at its limit once its time has passed, or on to the next step when it is known (from the cache, never a probe) to be at one. Never throws. */
async function limitCheck(id: string, ws: Workspace): Promise<Workspace> {
  try {
    if (ws.limit) {
      // ponytail: no timer; the way back is checked when the next message is sent
      if (ws.limit.until !== null && Date.now() >= ws.limit.until && !limitedUntil(ws.agent, ws.limit.fromAccount)) {
        const lim = ws.limit;
        if (lim.fromModel !== undefined) {
          if (lim.fromModel === null) await resetField(id, "model");
          else await setting(id, "model", lim.fromModel);
        } else await switchLane(id, { agent: ws.agent, account: lim.fromAccount }, { quiet: true, keepLimit: true });
        await mutateState((st) => void delete st.workspaces.find((x) => x.id === id)!.limit);
        emit(id, { kind: "note", text: `${lim.from} is available again, so this message goes there` });
        return getWorkspace(id);
      }
      return ws;
    }
    if (ws.fallback?.auto === false || (ws.agent !== "claude" && ws.agent !== "codex" && !isAcpAgent(ws.agent))) return ws;
    const until = limitedUntil(ws.agent, ws.account);
    if (until && typeof (await fallbackHop(id, ws, until)) === "object") return getWorkspace(id);
  } catch (e) {
    console.warn("[chat] limit check:", (e as Error).message);
  }
  return ws;
}

/** An account was removed: projects on it go back to the AI's own sign-in, with a note. Their conversation there starts from what the chat said so far. */
export async function forgetAccount(accountId: string, label: string): Promise<void> {
  const moved: string[] = [];
  await mutateState((st) => {
    if (st.defaults?.account === accountId) delete st.defaults.account;
    for (const w of st.workspaces) {
      for (const k of Object.keys(w.agentSessions ?? {})) if (k.endsWith(`@${accountId}`)) delete w.agentSessions![k];
      if (w.limit?.fromAccount === accountId) delete w.limit;
      if (w.fallback?.steps) w.fallback.steps = w.fallback.steps.filter((x) => x.account !== accountId);
      if (w.account !== accountId) continue;
      w.account = undefined;
      w.chatSession = w.agentSessions?.[w.agent];
      w.handoffAfter = w.chatSession ? (w.agentSeen?.[w.agent] ?? 0) : 0;
      moved.push(w.id);
    }
  });
  for (const wid of moved) {
    stop(wid);
    clearLimit(((await getWorkspace(wid).catch(() => null)) ?? { agent: "claude" }).agent, accountId);
    emit(wid, { kind: "note", text: `${label} was removed. This project is back on its own sign-in.` });
  }
}

// ---- Run info: what the AI was told and what it can use (names only, no secrets) ----

export interface RunInfo {
  agent: string;
  agentName: string;
  terminalProject: boolean;
  /** brain: the project memory summary the AI gets at the start (null when none, or not a chat) */
  instructions: { system: string | null; notes: string; note: string | null; brain?: { notes: number; tokens: number } | null };
  tools: { builtin: string[]; mcp: { name: string; status: string }[] } | null;
  ready: boolean;
  /** every setting with where it comes from */
  ai: AiResolved;
  /** the sign-in in use; null = the AI's own login */
  account: { id: string; label: string; kind: "login" | "router" } | null;
  fallback: Fallback;
  /** set while the conversation is on another account or model after a limit */
  limit: LimitState | null;
  /** what the AI may do without asking: Kohlab's saved ones, and (a live Claude) the ones Claude lists */
  rules: PermissionRule[];
  /** in Full access: what that means for this project, in words */
  accessNote: string | null;
}

/** Claude's own list of the rules it holds, as plain rows. Only allow rules; nothing it cannot say is guessed. Never throws: without an answer there are none. */
async function claudeRules(live: Live | undefined, known: Set<string>): Promise<PermissionRule[]> {
  if (!live || live.closed || live.stopping || !live.inited) return [];
  try {
    const r = await Promise.race([ask(live, { subtype: "list_permission_rules" }), new Promise<never>((_, no) => setTimeout(() => no(new Error("no answer")), 2000))]);
    const rows: any[] = Array.isArray(r?.state?.rules) ? r.state.rules : [];
    const out: PermissionRule[] = [];
    for (const x of rows) {
      if (x?.behavior !== "allow" || typeof x.rule !== "string" || !validRule(x.rule) || known.has(x.rule)) continue;
      const source = String(x.source ?? "");
      if (source === "toolsNarrowing" || source === "cliArg") continue; // ours, or the tool list's own
      out.push({ rule: x.rule, label: describeRule(x.rule), source: source === "session" ? "session" : "claude-settings", removable: false });
      if (out.length >= 100) break;
    }
    return out;
  } catch (e) {
    console.warn("[chat] rule list:", (e as Error).message);
    return [];
  }
}

/** What the AI of a project was told, and the tool names it reported. Never a tool server's settings, command line or environment. */
export async function runInfo(id: string): Promise<RunInfo> {
  const ws = await wsOf(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "This is not a chat project.");
  const agent = ws.chat ? ws.agent : "claude";
  const acp = isAcp(ws);
  const live = acp ? undefined : procs.get(id);
  const instructions = acp
    ? { system: null, notes: notesOf(ws), note: "Kohlab adds your notes before your first message. The AI's own built-in instructions are not shown." }
    : term
      ? { system: null, notes: "", note: "This project uses your own Claude settings." }
      : { system: CHAT_SYSTEM_PROMPT, notes: notesOf(ws), note: null };
  const defaults = await defaultsOf();
  const ai = resolveAi(ws, defaults);
  const acct = ws.chat && ws.account ? getAccount(ws.account) : undefined;
  const mine = cleanRules(ws.allowRules);
  const rules: PermissionRule[] = [
    ...mine.map((rule): PermissionRule => ({ rule, label: describeRule(rule), source: "kohlab", removable: true })),
    ...(await claudeRules(live, new Set(mine))),
  ];
  const name = AGENT_NAMES[agent] ?? agent;
  return {
    agent,
    agentName: name,
    terminalProject: !ws.chat,
    instructions: { ...instructions, brain: brainStatOf(ws) },
    tools: live?.tools ?{ builtin: live.tools.filter((t) => !t.startsWith("mcp__")), mcp: live.mcp } : null,
    ready: acp ? (acps.get(id)?.started ?? false) : live?.inited === true,
    ai,
    account: acct ? { id: acct.id, label: acct.label, kind: acct.kind } : null,
    fallback: ws.chat ? await fallbackOf(ws) : { auto: false, steps: [], custom: false },
    limit: ws.limit ?? null,
    rules,
    accessNote: ws.chat ? (identityOf(ws) === undefined ? `${name} runs commands on this server as the server's own account, without asking. Set KOHLAB_AGENT_USER to run it as a smaller account.` : `${name} runs commands without asking.`) : null,
  };
}
