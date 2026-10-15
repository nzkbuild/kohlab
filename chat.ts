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
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { Workspace } from "./types";
import { notifyNeedsYou } from "./push";
import { browserToolPolicy, browserUrl, writeBrowserMcp, type OwnPages } from "./browser";
import { devServerOrigin } from "./devserver";
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
  worktreeIsClean,
  worktreePath,
} from "./lib";

/** The only keys copied into the claude process, never the server's secrets (KOHLAB_KEY and friends).
 *  Same allowlist as the PTY daemon: see SAFE_ENV_KEYS in pty-daemon.cjs for why. */
const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME"];
/** Appended to claude's system prompt: who it talks to, and the Preview / Keep / Undo buttons it can rely on. */
const CHAT_SYSTEM_PROMPT =
  "The person you are working with is not a programmer. Use plain, friendly language and avoid jargon. Write short plain sentences; avoid Markdown headings and tables. " +
  "When they ask for something visual (a website, page, game or small tool), build it with plain HTML, CSS and JavaScript " +
  "and put an index.html at the project root, so it works by opening that file; use another technology only if they ask for it. " +
  "Kohlab shows them a Preview button that opens index.html, and Keep / Undo buttons to save or throw away your changes. " +
  "Files the person attaches are saved in the uploads folder of the project; open them with your Read tool, and use pictures from there directly in the page when they ask for that. " +
  "When you run a command, always give it a short plain-English description of what it does and why. " +
  "You have a real browser that the person watches live: after you change a page, open it there and check it, using the http://127.0.0.1 address of a dev server you started, or else the project's Preview.";
const MAX_TEXT = 20000;

type Body =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "ask"; requestId: string; text: string; detail?: string; why?: string }
  | { kind: "answer"; requestId: string; allow: boolean }
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
  /** unanswered permission asks: requestId -> the input to echo back on allow */
  asks: Map<string, Record<string, unknown>>;
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
}

interface Chat {
  events: ChatEvent[];
}

/** In-memory transcript per workspace id, loaded from the file on first access. */
const chats = new Map<string, Chat>();
/** Live claude processes per workspace id. */
const procs = new Map<string, Live>();

const chatsDir = () => join(WORKS_DIR, "chats");
const transcriptPath = (id: string) => join(chatsDir(), `${id}.jsonl`);
const cursorPath = (id: string) => join(chatsDir(), `${id}.cursor.json`);
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

/** Claude Code's transcript lines as chat events: what the person wrote and what Claude said and did. Pure. */
export function transcriptEvents(lines: string[], cwd: string): Body[] {
  const out: Body[] = [];
  for (const line of lines) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue; // a torn or foreign line: skip it
    }
    if (!m || typeof m !== "object" || m.isSidechain || m.isMeta) continue; // a helper agent's work, or a note for Claude itself
    if (m.type === "user") {
      const content = m.message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) text = content.map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      // a slash command's own bookkeeping, not a message
      if (!text || ["<command-name>", "<local-command", "<command-message>"].some((p) => text.startsWith(p))) continue;
      out.push({ kind: "user", text });
    } else if (m.type === "assistant") {
      for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) out.push({ kind: "assistant", text: b.text.trim() });
        else if (b?.type === "tool_use" && typeof b.name === "string" && b.name !== "TodoWrite") {
          out.push({ kind: "tool", text: describeTool(b.name, b.input ?? {}, cwd) });
        }
      }
    }
  }
  return out;
}

/** A terminal project: copy the lines the terminal's Claude wrote since the last look into the chat. Never throws. */
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

function onLine(id: string, live: Live, line: string) {
  if (live.stopping) return;
  let m: any;
  try {
    m = JSON.parse(line);
  } catch {
    return; // not JSON: ignore
  }
  if (m.type === "system" && m.subtype === "init") {
    live.resuming = undefined;
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
      else if (b?.type === "tool_use" && b.name !== "TodoWrite") {
        emit(id, { kind: "tool", text: describeTool(b.name, b.input ?? {}, live.cwd) });
      }
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
    if (m.subtype !== "success" && resumeFailed(id, live)) return;
    markSeen(id, live);
    if (m.subtype !== "success") {
      const raw = String(m.result ?? m.subtype ?? "unknown");
      console.warn("[chat] claude result error:", raw.slice(0, 200));
      emit(id, { kind: "error", text: friendlyError(raw) });
    }
    emit(id, { kind: "done" });
    chatBusy.delete(id);
    finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
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
  if (live.stopping || !chatBusy.has(id)) return;
  if (resumeFailed(id, live)) return;
  markSeen(id, live);
  const last = live.stderr.trim().split("\n").pop()?.trim() ?? "";
  console.warn("[chat] claude stopped unexpectedly:", last.slice(0, 200));
  emit(id, { kind: "error", text: friendlyError(last) });
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
  live.child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: msg }, parent_tool_use_id: null }) + "\n");
}

async function start(ws: Workspace, id: string): Promise<Live> {
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
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "default", "--permission-prompt-tool", "stdio"];
  if (!term) args.push("--setting-sources", "project,local", "--disable-slash-commands", "--strict-mcp-config");
  // strict: only our browser tools load, never the user's MCP servers
  const mcpFile = writeBrowserMcp(ws, who);
  if (mcpFile) args.push("--mcp-config", mcpFile);
  if (!term) args.push("--append-system-prompt", CHAT_SYSTEM_PROMPT);
  if (ws.chatSession) args.push("--resume", ws.chatSession);
  if (ws.model) args.push("--model", ws.model);
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.HOME = home;
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
  child.stdin!.write(JSON.stringify({ type: "control_request", request_id: "init-1", request: { subtype: "initialize" } }) + "\n");
  return live;
}

/** The chat transcript after event `after`, and whether a turn is in flight. */
export async function snapshot(id: string, after: number) {
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "not a chat workspace");
  if (term) await syncFromTerminal(ws);
  const events = load(id).events.filter((e) => e.n > after);
  const live = procs.get(id);
  return {
    events,
    busy: chatBusy.has(id),
    waiting: live?.asks.keys().next().value ?? null,
    draft: live?.draft ?? "",
    terminalOpen: term && (await isAlive(ws)),
  };
}

/** A terminal project whose agent is Claude: its conversation can be read and sent to from the chat view. */
async function viaTerminal(ws: Workspace): Promise<boolean> {
  if (ws.chat) return false;
  const cmd = ((await loadState()).agents?.[ws.agent] || "").split(/\s+/)[0];
  return basename(cmd) === "claude";
}

/** Send a user message. Starts the claude process if none is alive. */
export async function send(id: string, text: string): Promise<void> {
  const t = text.trim();
  if (!t) throw new ChatError(400, "message is empty");
  if (t.length > MAX_TEXT) throw new ChatError(400, `message is over ${MAX_TEXT} characters`);
  const ws = await getWorkspace(id);
  const term = await viaTerminal(ws);
  if (!ws.chat && !term) throw new ChatError(400, "not a chat workspace");
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
  // check and claim in one synchronous step, so two posts cannot both start a turn
  if (chatBusy.has(id)) throw new ChatError(409, "still working");
  chatBusy.add(id);
  chatWaiting.delete(id); // a new message clears a stale "needs you" from before
  emit(id, { kind: "user", text: t });
  try {
    await markStarted(id);
    const live = procs.get(id) ?? (await start(term ? await getWorkspace(id) : ws, id));
    live.msg = t;
    live.child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: t }, parent_tool_use_id: null }) + "\n");
  } catch (e) {
    chatBusy.delete(id);
    console.error("[chat] could not start:", (e as Error).message);
    emit(id, { kind: "error", text: friendlyError((e as Error).message) });
    await finish(id);
  }
}

/** Claude's answer to a permission question: allow echoes the input back. */
function writeAnswer(live: Live, requestId: string, allow: boolean, input: Record<string, unknown>) {
  const response = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user said no." };
  live.child.stdin!.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n");
}

/** Show a permission question to the person and ping them. `url` is the browser's page, when the tool acts on one. */
function askPerson(id: string, live: Live, requestId: string, tool: string, input: Record<string, unknown>, url: string | null) {
  live.asks.set(requestId, input);
  const { text, detail, why } = describeAsk(tool, input as Record<string, any>, live.cwd, url);
  const wasWaiting = chatWaiting.has(id);
  chatWaiting.add(id);
  emit(id, { kind: "ask", requestId, text, ...(detail !== undefined ? { detail } : {}), ...(why !== undefined ? { why } : {}) });
  if (!wasWaiting) pingNeedsYou(id, text);
}

/** A browser tool's permission question: read-only tools are allowed at once, interaction tools on the project's own page too, the rest are asked. */
async function browserAsk(id: string, live: Live, requestId: string, tool: string, input: Record<string, unknown>) {
  // only a tool that acts on the page needs its address and the workspace's own pages; a read does not touch the browser
  const ws = browserToolPolicy(tool, null, NO_OWN_PAGES) === "ask" ? await getWorkspace(id).catch(() => null) : null;
  const url = ws ? await browserUrl(ws).catch(() => null) : null;
  if (live.stopping || live.closed) return;
  if (browserToolPolicy(tool, url, ownPagesOf(ws)) === "allow") writeAnswer(live, requestId, true, input);
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
export async function answer(id: string, requestId: string, allow: boolean): Promise<void> {
  const live = procs.get(id);
  if (!live || !live.asks.has(requestId)) throw new ChatError(404, "no such pending question");
  const input = live.asks.get(requestId)!;
  live.asks.delete(requestId);
  if (live.asks.size === 0) chatWaiting.delete(id);
  writeAnswer(live, requestId, allow, input);
  emit(id, { kind: "answer", requestId, allow });
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
