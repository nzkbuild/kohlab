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
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { Workspace } from "./types";
import { notifyNeedsYou } from "./push";
import { browserToolPolicy, browserUrl, writeBrowserMcp, type OwnPages } from "./browser";
import { devServerOrigin } from "./devserver";
import { ACP_AGENTS, AcpClient, acpStartFailure, isAcpAgent, type AcpHost } from "./acp";
import {
  WORKS_DIR,
  chatBusy,
  resumeOpen,
  chatKillers,
  chatWaiting,
  closeMain,
  getWorkspace,
  identityOf,
  isAlive,
  loadState,
  markStarted,
  mutateState,
  notifyWorkspaceDone,
  ownBase,
  parseModel,
  worktreeIsClean,
  worktreePath,
} from "./lib";

/** The only keys copied into the claude process, never the server's secrets (KOHLAB_KEY and friends).
 *  Same allowlist as the PTY daemon: see SAFE_ENV_KEYS in pty-daemon.cjs for why. */
const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME"];
/** The environment a child agent gets: the allowlisted keys from the server's, and its own HOME. */
export function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.HOME = home;
  return env;
}
/** Appended to claude's system prompt: who it talks to, and the Preview / Keep / Undo buttons it can rely on. */
const CHAT_SYSTEM_PROMPT =
  "The person you are working with is not a programmer. Use plain, friendly language and avoid jargon. Write short plain sentences; avoid Markdown headings. " +
  "When a picture explains better than words (a chart, a diagram, a quick mockup), you may put a self-contained ```html block in your reply (inline CSS and JavaScript; libraries from a CDN are fine) or a ```mermaid diagram, and Kohlab draws it right in the chat; to show a picture from the project, use ![description](path/inside/project.png). " +
  "When they ask for something visual (a website, page, game or small tool), build it with plain HTML, CSS and JavaScript " +
  "and put an index.html at the project root, so it works by opening that file; use another technology only if they ask for it. " +
  "Kohlab shows them a Preview button that opens index.html, and Keep / Undo buttons to save or throw away your changes. " +
  "Files the person attaches are saved in the uploads folder of the project; open them with your Read tool, and use pictures from there directly in the page when they ask for that. " +
  "When you run a command, always give it a short plain-English description of what it does and why. " +
  "You have a real browser that the person watches live: after you change a page, open it there and check it, using the http://127.0.0.1 address of a dev server you started, or else the project's Preview.";
const MAX_TEXT = 20000;

/** One multiple-choice question from AskUserQuestion, cleaned by askForm. */
export type AskQuestion = { question: string; header?: string; multiSelect?: boolean; options: { label: string; description?: string }[] };

export type Body =
  /** uuid: the id Claude keeps for this message, which Undo names. Not set on lines imported from a terminal's transcript. */
  | { kind: "user"; text: string; uuid?: string }
  | { kind: "assistant"; text: string }
  /** toolId: the tool's id, which its result refers to. detail: what it did (the command, the change), for the expandable line. */
  | { kind: "tool"; text: string; toolId?: string; detail?: string }
  /** result: what a tool gave back, trimmed by resultText. failed: the tool errored. */
  | { kind: "result"; toolId: string; output: string; failed?: boolean }
  /** form: a question card ("question", with questions) or a plan card ("plan", with plan). Neither is set for a permission question. */
  | { kind: "ask"; requestId: string; text: string; detail?: string; why?: string; form?: "question" | "plan"; questions?: AskQuestion[]; plan?: string }
  /** reply: what the person answered or asked for, when a question or plan card was answered with text. */
  | { kind: "answer"; requestId: string; allow: boolean; reply?: string }
  | { kind: "done" }
  | { kind: "error"; text: string };

export type ChatEvent = { n: number; at: number } & Body;

export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A path inside the worktree is shown relative to it; anything else as given. */
function rel(p: unknown, cwd: string): string {
  const s = String(p ?? "");
  if (isAbsolute(s) && (s === cwd || s.startsWith(cwd + "/"))) return relative(cwd, s) || ".";
  return s;
}

/** A plain-English one-liner of an action the agent took.
 *  ChatView parses these prefixes to group the lines ("Read ", "Created ", "Edited ", "Ran: ",
 *  "Searched", "Opened ", "Asked a helper"): keep them in step with its classifier. */
export function describeTool(name: string, input: Record<string, any>, cwd: string): string {
  switch (name) {
    case "Write":
      return `Created ${rel(input.file_path, cwd)}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Edited ${rel(input.file_path ?? input.notebook_path, cwd)}`;
    case "Read":
      return `Read ${rel(input.file_path, cwd)}`;
    case "Bash":
      return `Ran: ${input.description || String(input.command ?? "").slice(0, 80)}`;
    case "Glob":
    case "Grep":
      return "Searched the files";
    case "WebFetch":
      return `Opened ${input.url ?? ""}`;
    case "WebSearch":
      return `Searched the web for ${input.query ?? ""}`;
    case "Agent":
    case "Task":
      return "Asked a helper to look into it";
    default:
      if (name === "mcp__browser__agent_browser_open") return `Opened ${input.url ?? "a page"} in the browser`;
      return name.startsWith("mcp__browser__") ? "Used the browser" : `Used ${name}`;
  }
}

/** What a tool did, in full, for an expandable line: the command, the lines changed, the address or the search. Undefined when there is nothing to show. Pure. */
export function toolDetail(name: string, input: Record<string, any>, cwd: string): string | undefined {
  const cut = (s: string, cap: number) => (s.length > cap ? s.slice(0, cap - 2) + "\n…" : s);
  const diff = (oldText: unknown, newText: unknown) => [
    ...String(oldText ?? "").split("\n").map((l) => `- ${l}`),
    ...String(newText ?? "").split("\n").map((l) => `+ ${l}`),
  ];
  switch (name) {
    case "Bash":
      return String(input.command ?? "").slice(0, 2000) || undefined;
    case "Edit":
      return cut(diff(input.old_string, input.new_string).join("\n"), 4000);
    case "MultiEdit": {
      const edits: any[] = Array.isArray(input.edits) ? input.edits : [];
      return cut(edits.map((e) => diff(e?.old_string, e?.new_string).join("\n")).join("\n\n"), 4000) || undefined;
    }
    case "Write": {
      const text = String(input.content ?? "");
      return text ? cut(text.split("\n").slice(0, 40).map((l) => `+ ${l}`).join("\n"), 4000) : undefined;
    }
    case "WebFetch":
      return String(input.url ?? "") || undefined;
    case "WebSearch":
      return String(input.query ?? "") || undefined;
    case "Glob":
    case "Grep": {
      const pattern = String(input.pattern ?? "");
      if (!pattern) return undefined;
      return input.path ? `${pattern} in ${rel(input.path, cwd)}` : pattern;
    }
    default:
      return undefined;
  }
}

/** What a tool result says, for its expandable line: the text of its text blocks, ANSI colour codes removed, and only the last 60 lines and 4000 characters. Pure. */
export function resultText(content: unknown): string {
  let text = typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((c: any) => (c?.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n") : "";
  text = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\n+$/, "");
  const lines = text.split("\n");
  let cut = lines.length > 60;
  if (cut) text = lines.slice(-60).join("\n");
  if (text.length > 4000) {
    text = text.slice(-4000);
    cut = true;
  }
  return cut ? `…\n${text}` : text;
}

/** The permission question for a browser tool, naming the site it acts on ("a website" when the page address is not known). */
function describeBrowserAsk(name: string, input: Record<string, any>, currentUrl: string | null): { text: string; detail?: string } {
  let site = "a website";
  try {
    site = (currentUrl && new URL(currentUrl).hostname) || site;
  } catch {
    /* not an address: say "a website" */
  }
  switch (name.replace("mcp__browser__agent_browser_", "")) {
    case "click":
    case "dblclick":
      return { text: `Claude wants to click on ${site}`, ...(input.selector ? { detail: String(input.selector) } : {}) };
    case "fill":
    case "type":
      return { text: `Claude wants to type into a form on ${site}`, detail: String(input.text ?? "").slice(0, 80) };
    case "press":
      return { text: `Claude wants to press a key on ${site}`, detail: String(input.key ?? "") };
    case "eval":
      return { text: `Claude wants to run a script on ${site}`, detail: String(input.script ?? "").slice(0, 300) };
    default:
      return { text: `Claude wants to use the browser on ${site}`, detail: JSON.stringify(input).slice(0, 300) };
  }
}

/** The permission question for a risky action: what it asks, the detail to show under it, and why (the model's own words, for a command). */
export function describeAsk(name: string, input: Record<string, any>, cwd: string, currentUrl: string | null = null): { text: string; detail?: string; why?: string } {
  if (name.startsWith("mcp__browser__")) return describeBrowserAsk(name, input, currentUrl);
  switch (name) {
    case "Write":
      return { text: `Claude wants to create the file ${rel(input.file_path, cwd)}` };
    case "Edit":
    case "MultiEdit":
      return { text: `Claude wants to change the file ${rel(input.file_path, cwd)}` };
    case "Bash":
      return {
        text: "Claude wants to run a command",
        detail: String(input.command ?? ""),
        ...(input.description ? { why: String(input.description) } : {}),
      };
    case "WebFetch":
      return { text: `Claude wants to open ${input.url ?? ""}` };
    default:
      return { text: `Claude wants to use ${name}`, detail: JSON.stringify(input).slice(0, 300) };
  }
}

/** A question card or plan card for AskUserQuestion / ExitPlanMode, or null for any other tool (and for an empty question or plan). Pure. */
export function askForm(tool: string, input: Record<string, any>): { text: string; form: "question"; questions: AskQuestion[] } | { text: string; form: "plan"; plan: string } | null {
  if (tool === "AskUserQuestion") {
    const questions: AskQuestion[] = [];
    for (const q of Array.isArray(input.questions) ? input.questions : []) {
      const question = typeof q?.question === "string" ? q.question.slice(0, 500) : "";
      if (!question.trim()) continue;
      const options: AskQuestion["options"] = [];
      for (const o of Array.isArray(q.options) ? q.options : []) {
        const label = typeof o?.label === "string" ? o.label.slice(0, 200) : "";
        if (!label.trim()) continue;
        options.push({ label, ...(typeof o.description === "string" ? { description: o.description.slice(0, 500) } : {}) });
        if (options.length === 8) break;
      }
      questions.push({
        question,
        ...(typeof q.header === "string" ? { header: q.header.slice(0, 40) } : {}),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
        options,
      });
      if (questions.length === 4) break;
    }
    if (questions.length === 0) return null;
    return { text: questions.length === 1 ? "Claude has a question" : `Claude has ${questions.length} questions`, form: "question", questions };
  }
  if (tool === "ExitPlanMode") {
    const plan = String(input.plan ?? "").slice(0, MAX_TEXT);
    if (!plan.trim()) return null;
    return { text: "Claude's plan is ready", form: "plan", plan };
  }
  return null;
}

/** The control_response body for a permission question, and the words the person gave (the reply, when there are any). Pure. */
export function answerResponse(
  tool: string,
  input: Record<string, unknown>,
  allow: boolean,
  extra: { answers?: Record<string, string>; message?: string },
): { response: Record<string, unknown>; reply?: string } {
  if (tool === "AskUserQuestion") {
    if (!allow) return { response: { behavior: "deny", message: "The user chose not to answer." } };
    // The card shows a question cut to 500 characters, so its answer may come back under the cut text: file it under the full one.
    const known = new Map<string, string>();
    for (const q of Array.isArray(input.questions) ? input.questions : []) {
      if (typeof q?.question !== "string") continue;
      known.set(q.question, q.question);
      known.set(q.question.slice(0, 500), q.question);
    }
    const answers: Record<string, string> = Object.create(null);
    for (const [question, value] of Object.entries(extra.answers ?? {})) {
      const full = known.get(question);
      if (full !== undefined && typeof value === "string" && value.trim()) answers[full] = value.slice(0, 2000);
    }
    return { response: { behavior: "allow", updatedInput: { ...input, answers } }, reply: Object.values(answers).join("; ") };
  }
  if (tool === "ExitPlanMode") {
    if (allow) return { response: { behavior: "allow", updatedInput: input } };
    const message = String(extra.message ?? "").trim().slice(0, 2000);
    if (!message) return { response: { behavior: "deny", message: "The user did not approve the plan." } };
    return { response: { behavior: "deny", message: `The user wants changes to the plan: ${message}` }, reply: message };
  }
  return allow ? { response: { behavior: "allow", updatedInput: input } } : { response: { behavior: "deny", message: "The user said no." } };
}

/** What the user reads when Claude fails. The raw CLI text goes to the server log, not the chat. */
export function friendlyError(raw: string): string {
  if (/usage limit|rate limit|limit reached|quota|overloaded|529/i.test(raw)) return "Claude has reached its usage limit for now. Try again in a little while.";
  if (/not logged in|log ?in|login|authenticat|401|invalid api key|credential/i.test(raw)) return "Claude is signed out on this server. Open Settings → Agents to check the connection.";
  if (/is not installed on this server/i.test(raw)) return "Claude is not set up on this server yet. Open Settings → Agents.";
  return "Something went wrong on Claude's side. Try again.";
}

interface Live {
  child: ChildProcess;
  cwd: string;
  /** unanswered permission asks: requestId -> the tool and its input (echoed back on allow) */
  asks: Map<string, { tool: string; input: Record<string, unknown> }>;
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
  /** background tasks still running (Bash or helper runs), from the CLI's own list */
  tasks: BgTask[];
  /** the checklist Claude's last TodoWrite sent (the full list) */
  todos: Todo[];
  /** TaskCreate calls waiting for their result (which carries the id), by tool_use id */
  newTasks: Map<string, { subject: string; form?: string }>;
  /** helper agents still running, by tool_use id, with a label for each */
  helpers: Map<string, string>;
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
const MODES = ["default", "acceptEdits", "plan", "auto", "dontAsk"];

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

const chatsDir = () => join(WORKS_DIR, "chats");
const transcriptPath = (id: string) => join(chatsDir(), `${id}.jsonl`);
const cursorPath = (id: string) => join(chatsDir(), `${id}.cursor.json`);
const capsPath = (id: string) => join(chatsDir(), `${id}.caps.json`);
/** A terminal project's first import reads at most this many bytes of Claude's transcript, and shows its last FIRST_IMPORT events. */
const TAIL_BYTES = 8 * 1024 * 1024;
const FIRST_IMPORT = 300;

/** Claude Code's transcript for a session: under the home, in a folder named after the worktree path. */
function transcriptFile(home: string, cwd: string, sid: string): string {
  return join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sid}.jsonl`);
}

/** How far into a terminal project's transcript the chat has read, for one session. */
function readCursor(id: string): { sid: string; offset: number } | null {
  try {
    const c = JSON.parse(readFileSync(cursorPath(id), "utf8"));
    return typeof c.sid === "string" && Number.isSafeInteger(c.offset) && c.offset >= 0 ? c : null;
  } catch {
    return null;
  }
}

function writeCursor(id: string, sid: string, offset: number) {
  mkdirSync(chatsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(cursorPath(id), JSON.stringify({ sid, offset }), { mode: 0o600 });
}

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

/** The one-line note for a finished background task, from its <task-notification> text. */
function taskFinishedLine(text: string): string {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1].trim().slice(0, 120);
  return summary ? `Background task finished: ${summary}` : "A background task finished";
}

/** The quiet line for a CLI system notice (a model switch, a compaction), or null for any other notice. Pure. */
export function noticeText(m: any): string | null {
  if (m?.subtype === "model_fallback") {
    const model = typeof m.fallback_model === "string" ? m.fallback_model : "another model";
    return `Switched to ${model} because the first choice was unavailable`;
  }
  if (m?.subtype === "compact_boundary") return "Conversation compacted to save space";
  return null;
}

/** The background tasks a background_tasks_changed line lists. Pure. */
function bgTasks(x: unknown): BgTask[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((t) => typeof t?.task_id === "string")
    .map((t) => ({ id: t.task_id, type: String(t.task_type ?? ""), description: String(t.description ?? "").slice(0, 200) }));
}

/** One item of Claude's checklist: its text and where it stands. */
export type Todo = { text: string; status: "pending" | "active" | "done"; id?: string; subject?: string; form?: string };

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

/** The label of a helper agent (a Task or Agent tool call): its description, else the start of its prompt. Pure. */
export function helperLabel(input: unknown): string {
  const i = (input ?? {}) as { description?: unknown; prompt?: unknown };
  const flat = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const d = flat(i.description);
  const p = flat(i.prompt).slice(0, 60).trim();
  return (d || p || "a helper").slice(0, 80).trim();
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

/** Bookkeeping tools whose calls are not shown as steps (the checklist already shows the tasks). */
const HIDDEN_TOOLS = new Set(["TodoWrite", "ToolSearch", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop"]);

/** Claude Code's transcript lines as chat events: what the person wrote and what Claude said and did. Pure. */
export function transcriptEvents(lines: string[], cwd: string): Body[] {
  const out: Body[] = [];
  const shown = new Set<string>(); // tool ids whose line this call emitted: their results follow in the same lines
  for (const line of lines) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // a torn or foreign line: skip it
    }
    if (!m || typeof m !== "object" || m.isSidechain || m.isMeta) continue; // a helper agent's work, or a note for Claude itself
    // a compaction note: one quiet line. Model switches are live-only, so they are not read from the transcript.
    if (m.type === "system" && m.subtype === "compact_boundary") out.push({ kind: "tool", text: noticeText(m) ?? "" });
    if (m.type === "user") {
      const content = m.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type !== "tool_result" || !shown.has(b.tool_use_id)) continue;
        shown.delete(b.tool_use_id);
        const output = resultText(b.content);
        if (output !== "" || b.is_error) out.push({ kind: "result", toolId: b.tool_use_id, output, ...(b.is_error ? { failed: true } : {}) });
      }
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) text = content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      // a slash command's own bookkeeping, not a message
      if (!text || ["<command-name>", "<local-command", "<command-message>"].some((p) => text.startsWith(p))) continue;
      // a background task's note to Claude: one quiet line; a helper's message to Claude: not the person's
      if (text.startsWith("<task-notification>")) {
        out.push({ kind: "tool", text: taskFinishedLine(text) });
        continue;
      }
      if (text.startsWith("<agent-message")) continue;
      out.push({ kind: "user", text });
    } else if (m.type === "assistant") {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "assistant", text: b.text.trim() });
        else if (b?.type === "tool_use" && typeof b.name === "string" && !HIDDEN_TOOLS.has(b.name)) {
          const detail = toolDetail(b.name, b.input ?? {}, cwd);
          shown.add(b.id);
          out.push({ kind: "tool", text: describeTool(b.name, b.input ?? {}, cwd), toolId: b.id, ...(detail !== undefined ? { detail } : {}) });
        }
      }
    }
  }
  return out;
}

/** A terminal project: copy the lines the terminal's Claude wrote since the last look into the chat. Also runs once for a chat project that switched to an earlier conversation. Never throws. */
async function syncFromTerminal(ws: Workspace): Promise<void> {
  const sid = ws.chatSession;
  if (chatBusy.has(ws.id) || !sid || !/^[\w-]+$/.test(sid)) return;
  try {
    const cwd = worktreePath(ws);
    const file = transcriptFile(identityOf(ws)?.home || homedir(), cwd, sid);
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

function emit(id: string, body: Body): ChatEvent {
  const c = load(id);
  const ev = { n: (c.events.at(-1)?.n ?? 0) + 1, at: Date.now(), ...body } as ChatEvent;
  c.events.push(ev);
  mkdirSync(chatsDir(), { recursive: true, mode: 0o700 });
  appendFileSync(transcriptPath(id), JSON.stringify(ev) + "\n", { mode: 0o600 });
  return ev;
}

/** Kill the claude process (stop or delete). The transcript cache is dropped and reloaded from file later. */
function stop(id: string) {
  const live = procs.get(id);
  procs.delete(id);
  chats.delete(id);
  chatBusy.delete(id);
  chatWaiting.delete(id);
  if (live && chatBusy.has(id)) markSeen(id, live); // the cut-off turn is already in the chat
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
/** The model an ACP project runs on: its own choice, else the one last chosen for that agent, else the agent's default (undefined). */
const wantedModel = (ws: Workspace): string | undefined => ws.agentModel ?? (isAcp(ws) ? (agentInfo(ws.agent).lastModel ?? undefined) : undefined);

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
  // Claude can start a turn by itself (a background task finished): show it as working, as a send does.
  if (isTurnStart(m) && !chatBusy.has(id)) {
    chatBusy.add(id);
    live.busySince = Date.now();
  }
  // A finished background task, live. A terminal project's importer reads the same line from the transcript, so it stays quiet there.
  if (m.type === "system" && m.subtype === "task_notification") {
    if (!live.transcriptHome) emit(id, { kind: "tool", text: taskFinishedLine(`<summary>${String(m.summary ?? "")}</summary>`) });
    return;
  }
  if (m.type === "system" && m.subtype === "background_tasks_changed") {
    live.tasks = bgTasks(m.tasks);
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
    if (text && (m.subtype === "model_fallback" || !live.transcriptHome)) emit(id, { kind: "tool", text });
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
        live.shownTools.add(b.id);
        emit(id, { kind: "tool", text: describeTool(b.name, b.input ?? {}, live.cwd), toolId: b.id, ...(detail !== undefined ? { detail } : {}) });
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
    if (m.subtype !== "success" && resumeFailed(id, live)) return;
    markSeen(id, live);
    if (m.subtype !== "success" && !byPerson) {
      const raw = String(m.result ?? m.subtype ?? "unknown");
      console.warn("[chat] claude result error:", raw.slice(0, 200));
      emit(id, { kind: "error", text: friendlyError(raw) });
    }
    emit(id, { kind: "done" });
    chatBusy.delete(id);
    live.busySince = undefined;
    live.helpers.clear();
    if (live.todos.every((t) => t.status === "done")) live.todos = [];
    finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
    void readUsage(id, live, true);
  }
}

function onExit(id: string, live: Live) {
  if (live.closed) return;
  live.closed = true;
  if (procs.get(id) === live) {
    procs.delete(id);
    chatWaiting.delete(id);
  }
  live.asks.clear();
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
  emit(id, { kind: "error", text: friendlyError(last) });
  emit(id, { kind: "done" });
  chatBusy.delete(id); // the turn died with the process: without this, send() answers 409 forever
  live.busySince = undefined;
  finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
}

/** The old session could not be resumed (e.g. it lived under another config dir): forget it and answer in a fresh one. Quiet for the user. */
function resumeFailed(id: string, live: Live): boolean {
  if (!live.resuming || live.msg === undefined) return false;
  live.stopping = true;
  live.child.kill("SIGTERM");
  if (procs.get(id) === live) procs.delete(id);
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
  live.busySince = Date.now();
  live.child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: msg }, parent_tool_use_id: null }) + "\n");
}

async function start(ws: Workspace, id: string): Promise<Live> {
  loadCaps(id); // before the new process can save over the file
  const s = await loadState();
  const cmd = (s.agents?.claude || "claude").split(/\s+/)[0];
  const bin = Bun.which(cmd);
  if (!bin) throw new Error(`${cmd} is not installed on this server`);
  const who = identityOf(ws);
  const home = who?.home || homedir();
  // A terminal project's chat continues the person's own Claude (their settings, skills and MCP servers), as their terminal does.
  const term = !ws.chat;
  // Chat users get a clean Claude with the same login: no user settings, skills, MCP servers or CLAUDE.md.
  // CLAUDE_CONFIG_DIR was rejected: token refresh would split the credentials into two copies.
  // --include-partial-messages streams Claude's reply as it is written (stream_event lines). --model only when the project chose one; otherwise the account default.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio"];
  // The mode the person picked in the chat. Otherwise a terminal project keeps its own settings, as its terminal does, and chat users get "default".
  const picked = MODES.includes(ws.permissionMode ?? "") ? ws.permissionMode : undefined;
  const mode = picked ?? (term ? undefined : "default");
  if (mode) args.push("--permission-mode", mode);
  if (!term) args.push("--setting-sources", "project,local", "--disable-slash-commands", "--strict-mcp-config");
  // strict: only our browser tools load, never the user's MCP servers
  const mcpFile = writeBrowserMcp(ws, who);
  if (mcpFile) args.push("--mcp-config", mcpFile);
  if (!term) args.push("--append-system-prompt", CHAT_SYSTEM_PROMPT);
  if (ws.chatSession) args.push("--resume", ws.chatSession);
  if (ws.model) args.push("--model", ws.model);
  const env = childEnv(home);
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
    shownTools: new Set(),
    model: null,
    mode: null,
    pending: new Map(),
    interrupted: false,
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
  const effort = ws.effort;
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
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "not a chat workspace");
  loadCaps(id);
  if (term) await syncFromTerminal(ws);
  const events = load(id).events.filter((e) => e.n > after);
  const live = procs.get(id);
  // the first read of usage comes with the first poll that finds none (a restart, or a chat not yet used)
  if (live && !usages.has(id)) void readUsage(id, live, false);
  // an ACP project with no model list yet: its agent starts quietly, once, so the list is there before the first message
  if (isAcp(ws) && !acps.has(id) && !caps.get(id)?.models.length && !agentInfo(ws.agent).models.length && !warmed.has(id)) {
    warmed.add(id);
    startAcp(ws, id).catch((e) => console.warn("[chat] warm-up:", (e as Error).message));
  }
  const cur = live ?? acps.get(id); // an ACP agent's chat keeps the same fields
  return {
    events,
    busy: chatBusy.has(id),
    busySince: chatBusy.has(id) ? (cur?.busySince ?? null) : null,
    now: Date.now(),
    background: cur?.tasks.length ?? 0,
    tasks: cur?.tasks ?? [],
    todos: cur?.todos ?? [],
    helpers: [...(cur?.helpers.values() ?? [])],
    retry: cur?.retry ?? null,
    usage: see.usage ? shownUsage(usages.get(id), see.owner) : null,
    // one rule: a live process, else the project's saved choice, else what was last seen
    model: cur?.model ?? wantedModel(ws) ?? ws.model ?? lastSeen.get(id)?.model ?? null,
    mode: cur?.mode ?? (MODES.includes(ws.permissionMode ?? "") ? ws.permissionMode : undefined) ?? lastSeen.get(id)?.mode ?? null,
    effort: cur?.effort ?? ws.effort ?? null,
    // clean chats run with --disable-slash-commands: they get no "/" menu
    commandsEnabled: term,
    commands: term ? (caps.get(id)?.commands ?? []).slice(0, 200) : [],
    models: caps.get(id)?.models.length ? caps.get(id)!.models : isAcp(ws) ? agentInfo(ws.agent).models : [],
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
  };
}

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
  const acp = new AcpClient(id, ws.agent, acpHost(id, ws.agent));
  acps.set(id, acp);
  try {
    await acp.start({ bin, args, cwd: worktreePath(ws), uid: who?.uid, gid: who?.gid, env: childEnv(who?.home || homedir()), resumeSession: ws.chatSession, agentModel: wantedModel(ws) });
    // a model chosen while the agent was starting
    await acp.applyModel(wantedModel(await getWorkspace(id)));
  } catch (e) {
    acp.stop();
    if (acps.get(id) === acp) acps.delete(id);
    throw e;
  }
  return acp;
}

/** A message to an ACP agent: one prompt turn. A message sent while a turn runs is refused: the agent cannot take it mid-turn. */
async function sendAcp(ws: Workspace, id: string, t: string): Promise<void> {
  if (chatBusy.has(id)) throw new ChatError(409, "still working");
  chatBusy.add(id);
  chatWaiting.delete(id); // a new message clears a stale "needs you" from before
  emit(id, { kind: "user", text: t });
  try {
    await markStarted(id);
    const cur = acps.get(id);
    const acp = cur && !cur.closed && !acpStarting.has(id) ? cur : await startAcp(ws, id);
    acp.prompt(t);
  } catch (e) {
    console.error("[chat] could not start:", (e as Error).message);
    emit(id, { kind: "error", text: acpStartFailure(ws.agent, e) });
    chatBusy.delete(id);
    await finish(id);
  }
}

/** The model an ACP chat runs on. With a live agent it is switched there; either way it is saved on the project for the next start. */
async function acpModel(id: string, value: unknown): Promise<void> {
  loadCaps(id);
  if (typeof value !== "string" || value.length === 0 || value.length > 200) throw new ChatError(400, "unknown model");
  // The agent's list is known once it has started; before that, the choice is saved and the agent checks it at its start.
  const ws = await getWorkspace(id);
  const offered = capsOf(id).models.length ? capsOf(id).models : agentInfo(ws.agent).models;
  if (offered.length > 0 && !offered.some((m) => m.value === value)) throw new ChatError(400, "unknown model");
  const acp = acps.get(id);
  if (acp && acp.started && !acp.closed) {
    await acp.setModel(value).catch((e) => {
      console.warn("[chat] could not switch the agent's model:", (e as Error).message);
      throw new ChatError(409, "The agent could not switch to that model. Try again.");
    });
  }
  await mutateState((s) => {
    const w = s.workspaces.find((x) => x.id === id);
    if (w) w.agentModel = value;
  });
  agentInfo(ws.agent).lastModel = value;
  saveAgentInfo(ws.agent);
}

/** Controls an ACP chat supports: the model, and stopping the turn. The rest wait for ACP support. */
async function acpControl(id: string, action: unknown, value: unknown): Promise<{ ok: true }> {
  if (action === "model") {
    await acpModel(id, value);
    return { ok: true };
  }
  if (action !== "interrupt") throw new ChatError(400, "Not available for this agent yet");
  const acp = acps.get(id);
  if (!acp || acp.closed) throw new ChatError(409, "The agent is not running");
  acp.cancel();
  return { ok: true };
}

/** Send a user message. Starts the claude process if none is alive. */
export async function send(id: string, text: string): Promise<void> {
  const t = text.trim();
  if (!t) throw new ChatError(400, "message is empty");
  if (t.length > MAX_TEXT) throw new ChatError(400, `message is over ${MAX_TEXT} characters`);
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "not a chat workspace");
  if (isAcp(ws)) return sendAcp(ws, id, t);
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
  if (queued && !procs.has(id)) throw new ChatError(409, "still working");
  if (!queued) chatBusy.add(id);
  if (!queued) chatWaiting.delete(id); // a new message clears a stale "needs you" from before
  // The id is ours, so the message can be named for Undo at once. The CLI keeps the id it is sent with.
  const uuid = randomUUID();
  emit(id, { kind: "user", text: t, uuid });
  try {
    if (!queued) await markStarted(id);
    const live = procs.get(id) ?? (await start(term ? await getWorkspace(id) : ws, id));
    if (!queued) {
      live.msg = t;
      live.busySince = Date.now();
    }
    live.child.stdin!.write(JSON.stringify({ type: "user", uuid, message: { role: "user", content: t }, parent_tool_use_id: null }) + "\n");
  } catch (e) {
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
  if (!ws.chat && !term) throw new ChatError(400, "not a chat workspace");
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

/** The files an @ mention can pick, from the CLI's own index. Empty when no process runs: a mention never starts one. */
async function fileMentions(id: string, query: unknown): Promise<string[]> {
  const live = procs.get(id);
  if (!live || typeof query !== "string" || query.length > 200) return [];
  try {
    const reply = await ask(live, { subtype: "file_suggestions", query });
    const paths: unknown[] = Array.isArray(reply?.suggestions) ? reply.suggestions.map((s: any) => s?.path) : [];
    return paths.filter((p): p is string => typeof p === "string" && p !== "" && !isAbsolute(p) && !p.split("/").some((d) => d === ".." || d === ".git")).slice(0, 20);
  } catch {
    return []; // the menu just shows nothing
  }
}

/** Stop one background task the CLI listed. The id must be in the current list. */
async function stopTask(id: string, value: unknown): Promise<{ ok: true }> {
  const live = procs.get(id);
  const task = live?.tasks.find((t) => t.id === value);
  if (!live || !task) throw new ChatError(400, "that task is not running");
  await ask(live, { subtype: "stop_task", task_id: task.id });
  return { ok: true };
}

/** Undo: the files Claude changed since a message. A dry run lists them; the real run puts them back. Only the last message can be undone. */
async function rewindFiles(id: string, value: unknown, dryRun: boolean): Promise<{ ok: true } & Record<string, unknown>> {
  if (typeof value !== "string") throw new ChatError(400, "message id is required");
  if (chatBusy.has(id)) throw new ChatError(409, "Claude is still working. Wait until it finishes, then undo.");
  let last: string | undefined; // the newest message's id; a message from before this feature, or a terminal's, has none
  for (const e of load(id).events) if (e.kind === "user") last = e.uuid;
  if (last === undefined || last !== value) throw new ChatError(400, "only the last message can be undone");
  const live = await liveFor(id);
  const r = await ask(live, { subtype: "rewind_files", user_message_id: value, ...(dryRun ? { dry_run: true } : {}) });
  if (r?.canRewind === false || r?.error) throw new ChatError(409, String(r.error ?? "Those changes can't be undone."));
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
  if (!ws.chat && !term) throw new ChatError(400, "not a chat workspace");
  loadCaps(id);
  const live = procs.get(id);
  if (live) await live.ready;
  switch (action) {
    case "model": {
      const models = capsOf(id).models;
      const picked = parseModel(value);
      if (live) {
        const known = value === "default" || models.some((m) => m.value === value);
        if (!known) throw new ChatError(400, "unknown model");
        await ask(live, { subtype: "set_model", model: value });
        // "default" shows as chosen until the next init reports the real model
        live.model = String(value);
        lastSeen.set(id, { model: live.model, mode: live.mode });
        const levels = models.find((m) => m.value === value)?.supportedEffortLevels ?? [];
        const dropEffort = !!live.effort && !levels.includes(live.effort);
        if (dropEffort) live.effort = undefined;
        // the three aliases are kept, so a restarted process uses the same model
        if (picked) {
          await mutateState((s) => {
            const w = s.workspaces.find((x) => x.id === id);
            if (!w) return;
            w.model = picked === "default" ? undefined : picked;
            if (dropEffort) w.effort = undefined;
          });
        }
      } else {
        // no process: only an alias is saved, and a listed model when the list is known
        const known = picked !== null && (picked === "default" || models.length === 0 || models.some((m) => m.value === value));
        if (!known) throw new ChatError(400, "unknown model");
        const levels = models.find((m) => m.value === value)?.supportedEffortLevels ?? [];
        await mutateState((s) => {
          const w = s.workspaces.find((x) => x.id === id);
          if (!w) return;
          w.model = picked === "default" ? undefined : picked;
          if (w.effort && !levels.includes(w.effort)) w.effort = undefined;
        });
      }
      break;
    }
    case "mode": {
      if (typeof value !== "string" || !MODES.includes(value)) throw new ChatError(400, "unknown mode");
      if (live) {
        const before = live.mode ?? (MODES.includes(ws.permissionMode ?? "") ? ws.permissionMode : undefined);
        await ask(live, { subtype: "set_permission_mode", mode: value });
        if (value === "plan" && before !== "plan") live.beforePlan = before;
        live.mode = value;
      }
      // saved on the project, so it survives a restart and applies when Claude next starts
      await mutateState((s) => {
        const w = s.workspaces.find((x) => x.id === id);
        if (w) w.permissionMode = value as Workspace["permissionMode"];
      });
      lastSeen.set(id, { model: live ? live.model : (lastSeen.get(id)?.model ?? null), mode: value });
      break;
    }
    case "effort": {
      if (typeof value !== "string" || !EFFORTS.includes(value)) throw new ChatError(400, "unknown effort level");
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

/** The chat's menu actions: stop the turn, or change the model, permission mode or effort (saved even with no process running).
 *  Also the reads and small actions the chat uses: "files" (@ mentions), "stop_task", "rewind_preview" and "rewind" (Undo). */
export async function chatControl(id: string, action: unknown, value: unknown): Promise<{ ok: true } & Record<string, unknown>> {
  if (isAcp(await getWorkspace(id))) return acpControl(id, action, value);
  if (action === "files") return { ok: true, files: await fileMentions(id, value) };
  if (action === "stop_task") return stopTask(id, value);
  if (action === "rewind_preview" || action === "rewind") return rewindFiles(id, value, action === "rewind_preview");
  if (action === "model" || action === "mode" || action === "effort") {
    await setting(id, action, value);
    return { ok: true };
  }
  if (action === "interrupt" && !procs.has(id)) throw new ChatError(409, "Claude is not running");
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
          emit(id, { kind: "done" });
          finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
        }, 5000);
      }
      break;
    }
    default:
      throw new ChatError(400, "unknown action");
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
  live.asks.set(requestId, { tool, input });
  const wasWaiting = chatWaiting.has(id);
  chatWaiting.add(id);
  const form = askForm(tool, input as Record<string, any>);
  if (form) {
    emit(id, { kind: "ask", requestId, ...form });
    if (!wasWaiting) pingNeedsYou(id, form.text);
    return;
  }
  const { text, detail, why } = describeAsk(tool, input as Record<string, any>, live.cwd, url);
  emit(id, { kind: "ask", requestId, text, ...(detail !== undefined ? { detail } : {}), ...(why !== undefined ? { why } : {}) });
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

/** Answer a pending permission question. */
export async function answer(id: string, requestId: string, allow: boolean, extra: { answers?: Record<string, string>; message?: string } = {}): Promise<void> {
  const acp = acps.get(id);
  if (acp) {
    if (!acp.asks.has(requestId)) throw new ChatError(404, "no such pending question");
    acp.answer(requestId, allow);
    return;
  }
  const live = procs.get(id);
  if (!live || !live.asks.has(requestId)) throw new ChatError(404, "no such pending question");
  const { tool, input } = live.asks.get(requestId)!;
  live.asks.delete(requestId);
  if (live.asks.size === 0) chatWaiting.delete(id);
  const { response, reply } = answerResponse(tool, input, allow, extra);
  writeAnswer(live, requestId, response);
  emit(id, { kind: "answer", requestId, allow, ...(reply ? { reply } : {}) });
  // an approved plan leaves plan mode for the mode it was entered from (default if unknown), through the mode menu's own path, without holding up the reply
  if (tool === "ExitPlanMode" && allow) {
    const back = live.beforePlan && live.beforePlan !== "plan" ? live.beforePlan : "default";
    live.beforePlan = undefined;
    setting(id, "mode", back).catch((e) => console.warn(`[chat] leave plan mode: ${(e as Error).message}`));
  }
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
  return dirname(transcriptFile(identityOf(ws)?.home || homedir(), worktreePath(ws), "x"));
}

/** A Claude project's earlier conversations, and which one is current (null for a new one). */
export async function sessions(id: string): Promise<{ current: string | null; sessions: { id: string; title: string; at: number }[] }> {
  const ws = await getWorkspace(id);
  if (!ws.chat && !(await viaTerminal(ws))) throw new ChatError(400, "not a Claude project");
  return { current: ws.chatSession ?? null, sessions: listSessions(sessionDir(ws), worktreePath(ws)) };
}

/** Start a new conversation (sid null), or switch to an earlier one. The chat's file is kept as one backup, and an earlier conversation's last messages are imported. */
export async function switchSession(id: string, sid: unknown): Promise<void> {
  if (sid !== null && typeof sid !== "string") throw new ChatError(400, "sid must be a conversation id or null");
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "not a Claude project");
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
