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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import type { Workspace } from "./types";
import {
  WORKS_DIR,
  agentIdentity,
  chatBusy,
  chatKillers,
  getWorkspace,
  identityOf,
  loadState,
  markStarted,
  mutateState,
  notifyWorkspaceDone,
  syncAgentClaudeConfig,
  worktreeIsClean,
  worktreePath,
} from "./lib";

/** The only keys copied into the claude process, never the server's secrets (KOHLAB_KEY and friends).
 *  Same allowlist as the PTY daemon: see SAFE_ENV_KEYS in pty-daemon.cjs for why. */
const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SHELL", "USER", "LOGNAME"];
const MAX_TEXT = 20000;

type Body =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "ask"; requestId: string; text: string; detail?: string }
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

/** A plain-English one-liner of an action the agent took. */
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
      return `Used ${name}`;
  }
}

/** The permission question for a risky action: what it asks, and the detail to show under it. */
export function describeAsk(name: string, input: Record<string, any>, cwd: string): { text: string; detail?: string } {
  switch (name) {
    case "Write":
      return { text: `Create the file ${rel(input.file_path, cwd)}?` };
    case "Edit":
    case "MultiEdit":
      return { text: `Change the file ${rel(input.file_path, cwd)}?` };
    case "Bash":
      return {
        text: "Run a command?",
        detail: input.description ? `${input.description}\n${input.command ?? ""}` : String(input.command ?? ""),
      };
    case "WebFetch":
      return { text: `Open ${input.url ?? ""}?` };
    default:
      return { text: `Use ${name}?`, detail: JSON.stringify(input).slice(0, 300) };
  }
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
  if (live) {
    live.stopping = true;
    live.child.kill("SIGTERM");
  }
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
    if (typeof m.session_id === "string") persistSession(id, m.session_id);
    return;
  }
  if (m.type === "assistant") {
    if (m.parent_tool_use_id) return; // a helper agent's work, not the conversation
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
    live.asks.set(m.request_id, input);
    const { text, detail } = describeAsk(m.request.tool_name, input as Record<string, any>, live.cwd);
    emit(id, { kind: "ask", requestId: m.request_id, text, ...(detail !== undefined ? { detail } : {}) });
    return;
  }
  if (m.type === "result") {
    if (m.subtype !== "success") {
      emit(id, { kind: "error", text: `The AI hit a problem: ${String(m.result ?? m.subtype ?? "unknown").slice(0, 200)}` });
    }
    emit(id, { kind: "done" });
    chatBusy.delete(id);
    finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
  }
}

function onExit(id: string, live: Live) {
  if (live.closed) return;
  live.closed = true;
  if (procs.get(id) === live) procs.delete(id);
  live.asks.clear();
  if (live.stopping || !chatBusy.has(id)) return;
  chatBusy.delete(id);
  const last = live.stderr.trim().split("\n").pop()?.trim();
  emit(id, { kind: "error", text: `The AI stopped unexpectedly. Send a message to continue.${last ? ` (${last.slice(0, 200)})` : ""}` });
  finish(id).catch((e) => console.error("[chat] finish:", (e as Error).message));
}

async function start(ws: Workspace, id: string): Promise<Live> {
  const s = await loadState();
  const cmd = (s.agents?.claude || "claude").split(/\s+/)[0];
  const bin = Bun.which(cmd);
  if (!bin) throw new Error(`${cmd} is not installed on this server`);
  const who = identityOf(ws);
  // The shared agent account gets the operator's Claude config; a named member's home is never touched.
  const agent = who && !ws.ownerId ? agentIdentity() : null;
  if (who && agent) {
    try {
      syncAgentClaudeConfig(join(homedir(), ".claude"), who.home, agent);
    } catch (e) {
      console.warn(`agent claude config sync failed: ${(e as Error).message}`);
    }
  }
  // No --include-partial-messages and no --model: the account default model.
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "default", "--permission-prompt-tool", "stdio"];
  if (ws.chatSession) args.push("--resume", ws.chatSession);
  const env: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) if (process.env[k] !== undefined) env[k] = process.env[k]!;
  env.HOME = who?.home || homedir();
  const cwd = worktreePath(ws);
  const child = spawn(bin, args, { cwd, uid: who?.uid, gid: who?.gid, env, stdio: ["pipe", "pipe", "pipe"] });
  const live: Live = { child, cwd, asks: new Map(), stderr: "", stopping: false, closed: false };
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
  if (!ws.chat) throw new ChatError(400, "not a chat workspace");
  const events = load(id).events.filter((e) => e.n > after);
  const live = procs.get(id);
  return { events, busy: chatBusy.has(id), waiting: live?.asks.keys().next().value ?? null };
}

/** Send a user message. Starts the claude process if none is alive. */
export async function send(id: string, text: string): Promise<void> {
  const t = text.trim();
  if (!t) throw new ChatError(400, "message is empty");
  if (t.length > MAX_TEXT) throw new ChatError(400, `message is over ${MAX_TEXT} characters`);
  const ws = await getWorkspace(id);
  if (!ws.chat) throw new ChatError(400, "not a chat workspace");
  // check and claim in one synchronous step, so two posts cannot both start a turn
  if (chatBusy.has(id)) throw new ChatError(409, "still working");
  chatBusy.add(id);
  emit(id, { kind: "user", text: t });
  try {
    await markStarted(id);
    const live = procs.get(id) ?? (await start(ws, id));
    live.child.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: t }, parent_tool_use_id: null }) + "\n");
  } catch (e) {
    chatBusy.delete(id);
    emit(id, { kind: "error", text: `The AI could not start: ${(e as Error).message}` });
    await finish(id);
  }
}

/** Answer a pending permission question. */
export async function answer(id: string, requestId: string, allow: boolean): Promise<void> {
  const live = procs.get(id);
  if (!live || !live.asks.has(requestId)) throw new ChatError(404, "no such pending question");
  const input = live.asks.get(requestId)!;
  live.asks.delete(requestId);
  const response = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user said no." };
  live.child.stdin!.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } }) + "\n");
  emit(id, { kind: "answer", requestId, allow });
}
