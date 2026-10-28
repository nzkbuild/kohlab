/**
 * Chat workspaces whose agent speaks the Agent Client Protocol (ACP): JSON-RPC 2.0, one
 * object per line on the agent's stdin and stdout. chat.ts routes a message, an answer or
 * an interrupt here instead of to the claude process.
 *
 * ponytail: an ACP agent cannot take a second message mid-turn, so one waits for the person
 * to send it again. Effort, Undo and file mentions are not offered yet.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { BgTask, Body, Caps, Todo } from "./chat";
import { resultText } from "./chat";
import { chatBusy, chatWaiting } from "./lib";
import { acpDecision, acpToolName, ruleFor } from "./policy";

/** The agents that speak ACP, and the command that starts each one's ACP server. */
export const ACP_AGENTS: Record<string, string[]> = {
  hermes: ["hermes", "acp"],
  omp: ["omp", "acp"],
  gemini: ["gemini", "--experimental-acp"],
  opencode: ["opencode", "acp"],
  codex: ["codex-acp"],
};

/** How each agent is named in the questions it asks. */
const ACP_NAMES: Record<string, string> = { hermes: "Hermes", omp: "Omp", gemini: "Gemini", opencode: "OpenCode", codex: "Codex" };

export const isAcpAgent = (agent: string): boolean => Object.prototype.hasOwnProperty.call(ACP_AGENTS, agent);

/** The ACP error code for "authentication required" (the protocol's -32000). */
const AUTH_REQUIRED = -32000;

/** The chat line for an agent that could not start. A sign-in refusal says so; anything else is the generic line. Pure. */
export function acpStartFailure(agent: string, err: unknown): string {
  if ((err as { code?: unknown } | null)?.code === AUTH_REQUIRED) {
    return agent === "codex" ? "Codex isn't signed in yet. Ask the owner to sign in from Settings → Agents." : "The agent isn't signed in yet. Ask the owner to sign it in.";
  }
  return "The agent could not start. Try again.";
}

/** The models an ACP agent offers, from its session/new or session/load reply. hermes lists them under models (availableModels, currentModelId) and takes a change with session/set_model; omp lists the "model" config option and takes one with session/set_config_option. Pure. */
export function acpModels(res: any): { models: Caps["models"]; current: string | null; how: "model" | "config" | null; configId: string } {
  const none = { models: [], current: null, how: null, configId: "" };
  if (Array.isArray(res?.models?.availableModels)) {
    const models = res.models.availableModels
      .filter((m: any) => typeof m?.modelId === "string")
      .map((m: any) => ({ value: m.modelId, displayName: String(m.name ?? m.modelId), description: String(m.description ?? ""), supportedEffortLevels: [] }));
    const current = typeof res.models.currentModelId === "string" ? res.models.currentModelId : null;
    return { models, current, how: "model", configId: "" };
  }
  const opt = Array.isArray(res?.configOptions) ? res.configOptions.find((o: any) => o?.id === "model") : undefined;
  if (!opt || !Array.isArray(opt.options)) return none;
  const models = opt.options
    .filter((o: any) => typeof o?.value === "string")
    .map((o: any) => ({ value: o.value, displayName: String(o.name ?? o.value), description: String(o.description ?? ""), supportedEffortLevels: [] }));
  const current = typeof opt.currentValue === "string" ? opt.currentValue : null;
  return { models, current, how: "config", configId: String(opt.id) };
}

/** What one session/update line does to the chat: text for the streamed draft, a flush of that draft, an event, or the checklist. */
export type AcpEffect = { kind: "text"; text: string } | { kind: "flush" } | { kind: "event"; body: Body } | { kind: "todos"; todos: Todo[] };

/** The command text or file path a tool was given, for its expandable line. Undefined when rawInput has neither. Pure. */
export function acpDetail(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const v = r.command ?? r.path ?? r.file_path ?? r.url ?? r.query ?? r.pattern;
  const s = Array.isArray(v) ? v.map(String).join(" ") : typeof v === "string" ? v : "";
  return s ? s.slice(0, 2000) : undefined;
}

/** The text of an ACP tool content list (text blocks, possibly wrapped as {type:"content"}), trimmed as a result. Pure. */
function toolOutput(content: unknown): string {
  const blocks = Array.isArray(content) ? content.map((c: any) => (c?.type === "content" ? c.content : c)).filter((c: any) => c?.type === "text") : [];
  return resultText(blocks);
}

/** A tool's finished line: its output, or a failure with no output. Nothing when it finished quietly. Pure. */
function resultEffects(toolId: string, update: any): AcpEffect[] {
  const failed = update.status === "failed";
  const output = toolOutput(update.content);
  if (output === "" && !failed) return [];
  return [{ kind: "event", body: { kind: "result", toolId, output, ...(failed ? { failed: true } : {}) } }];
}

/** The checklist from an ACP plan: each entry's text and where it stands. Pure. */
export function planTodos(entries: unknown): Todo[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e: any) => typeof e?.content === "string")
    .slice(0, 50)
    .map((e: any) => ({ text: String(e.content).slice(0, 200), status: e.status === "in_progress" ? "active" : e.status === "completed" ? "done" : "pending" }) as Todo);
}

/** What a session/update notification does to the chat. Pure. Unknown kinds (thoughts, commands, modes, usage) do nothing. */
export function acpEffects(update: any): AcpEffect[] {
  switch (update?.sessionUpdate) {
    case "agent_message_chunk": {
      const text = update.content?.type === "text" ? update.content.text : "";
      return typeof text === "string" && text ? [{ kind: "text", text }] : [];
    }
    case "tool_call": {
      const toolId = String(update.toolCallId ?? "");
      const detail = acpDetail(update.rawInput);
      const shown: AcpEffect = { kind: "event", body: { kind: "tool", text: String(update.title || "Used a tool"), toolId, ...(detail !== undefined ? { detail } : {}) } };
      // a tool that comes back finished in its first message has its result here, not in an update
      const done = update.status === "completed" || update.status === "failed" ? resultEffects(toolId, update) : [];
      return [{ kind: "flush" }, shown, ...done];
    }
    case "tool_call_update":
      return update.status === "completed" || update.status === "failed" ? resultEffects(String(update.toolCallId ?? ""), update) : [];
    case "plan":
      return [{ kind: "todos", todos: planTodos(update.entries) }];
    default:
      return [];
  }
}

/** The option the person's answer picks. Allow: the first allow_once, else allow_always, else the first option. Refuse: reject_once, else reject_always, else null (cancelled). Pure. */
export function pickOption(options: { optionId: string; kind: string }[], allow: boolean): string | null {
  const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of kinds) {
    const o = options.find((x) => x.kind === kind);
    if (o) return o.optionId;
  }
  return allow ? (options[0]?.optionId ?? null) : null;
}

/** The question a permission request puts to the person. Pure. */
export function permissionText(agent: string, title: string): string {
  const name = ACP_NAMES[agent] ?? agent;
  const t = title.trim();
  return t ? `${name} wants to do this: ${t}` : `${name} wants to do something`;
}

export interface AcpHost {
  emit(body: Body): void;
  persistSession(sid: string): void;
  finish(): void;
  pingNeedsYou(text: string): void;
  /** the models the agent offers, and the one it is on: the chat's menu, saved for the next start */
  models(list: Caps["models"], current: string | null): void;
  /** the client has stopped: the host drops it if it is still the chat's current one */
  exited(client: AcpClient): void;
  /** the permission mode and the saved rules in force right now: read at every request, so a change needs no restart */
  policy?(): { mode: string; rules: string[] };
  /** a quiet line in the chat */
  note?(text: string): void;
  /** the model the person chose could not be used: forget it */
  modelRefused?(): void;
  /** a turn failed with this text: true when it is a usage limit and the host takes over (it moves the message to another account or model, or says why it cannot) */
  limited?(raw: string): boolean;
}

export interface AcpStart {
  bin: string;
  args: string[];
  cwd: string;
  uid?: number;
  gid?: number;
  env: Record<string, string>;
  /** a conversation to load, when the agent can load one */
  resumeSession?: string;
  /** the model the person chose for this chat; applied when the agent is on another */
  agentModel?: string;
}

interface Rpc {
  resolve: (r: any) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Perm {
  rpcId: number | string;
  options: { optionId: string; kind: string }[];
}

/** One ACP agent process for one chat. Holds the same fields snapshot() reads from a Claude process. */
export class AcpClient {
  draft = "";
  todos: Todo[] = [];
  tasks: BgTask[] = [];
  helpers = new Map<string, string>();
  /** unanswered permission questions, by requestId */
  asks = new Map<string, { tool: string; input: Record<string, unknown>; always?: { rule: string; label: string } }>();
  readonly retry?: { attempt: number; max: number } = undefined;
  busySince?: number;
  model: string | null = null;
  mode: string | null = null;
  effort?: string = undefined;
  closed = false;
  stopping = false;
  /** the handshake and session are done: a model change can be sent */
  started = false;
  /** the session was opened new (not loaded), and no message has been sent in it yet: its first message carries the project's notes */
  freshSession = false;
  /** a message sent with another model: the model to go back to when its turn ends */
  restoreModel?: string;
  private cwd = "";
  /** models the agent turned down: not asked for again by this client */
  private refused = new Set<string>();
  stderr = "";
  sid?: string;
  /** how this agent takes a model change, and the config option's id when it is one */
  private modelHow: "model" | "config" | null = null;
  private configId = "";
  private child!: ChildProcess;
  private seq = 0;
  private rpc = new Map<number, Rpc>();
  private perms = new Map<string, Perm>();
  /** session/load replays the old conversation as updates: they are not new messages */
  private replaying = false;

  constructor(
    private readonly id: string,
    private readonly agent: string,
    private readonly host: AcpHost,
  ) {}

  /** Starts the agent, shakes hands, and opens the session: loads the chat's conversation when the agent can, else starts a new one. */
  async start(opts: AcpStart): Promise<void> {
    this.cwd = opts.cwd;
    this.child = spawn(opts.bin, opts.args, { cwd: opts.cwd, uid: opts.uid, gid: opts.gid, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin!.on("error", () => {}); // a dead process: its exit event reports it
    this.child.stderr!.on("data", (d) => {
      this.stderr = (this.stderr + d).slice(-2000);
    });
    createInterface({ input: this.child.stdout! }).on("line", (l) => this.onLine(l));
    this.child.on("error", () => this.onExit());
    this.child.on("exit", () => this.onExit());
    const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, 60_000);
    const cwd = opts.cwd;
    let opened: any;
    if (opts.resumeSession && init?.agentCapabilities?.loadSession === true) {
      this.replaying = true;
      try {
        opened = await this.request("session/load", { sessionId: opts.resumeSession, cwd, mcpServers: [] }, 60_000);
        this.sid = opts.resumeSession;
      } catch (e) {
        // the old conversation is gone: a new one starts, quietly
        console.warn("[acp] could not load the conversation:", (e as Error).message);
      } finally {
        this.replaying = false;
      }
    }
    if (!this.sid) {
      opened = await this.request("session/new", { cwd, mcpServers: [] }, 60_000);
      this.sid = String(opened.sessionId);
      this.freshSession = true;
    }
    this.host.persistSession(this.sid);
    this.readModels(opened);
    await this.applyModel(opts.agentModel);
    this.started = true;
  }

  /** Switches the model: session/set_model, or the model config option, whichever the agent offered. For the config option, the agent's reply says which model it is on now; that is what is kept. */
  async setModel(value: string): Promise<void> {
    if (this.modelHow === "model") {
      await this.request("session/set_model", { sessionId: this.sid, modelId: value }, 60_000);
      this.model = value;
    } else if (this.modelHow === "config") {
      const res = await this.request("session/set_config_option", { sessionId: this.sid, configId: this.configId, value }, 60_000);
      const opt = Array.isArray(res?.configOptions) ? res.configOptions.find((o: any) => o?.id === this.configId) : undefined;
      this.model = typeof opt?.currentValue === "string" ? opt.currentValue : value;
    } else throw new Error("the agent offers no model choice");
  }

  /** Takes the models from a session reply, when it lists any. */
  private readModels(res: unknown): void {
    const got = acpModels(res);
    if (got.models.length === 0) return;
    this.modelHow = got.how;
    this.configId = got.configId;
    this.model = got.current;
    this.host.models(got.models, got.current);
  }

  /** Applies the model the person chose, when the agent is on another. When the agent refuses it, or says it is on another, the chat says so, the choice is forgotten and the model shown is the real one. */
  async applyModel(want: string | undefined): Promise<void> {
    if (!want || want === this.model || this.modelHow === null || this.refused.has(want)) return;
    let why = "";
    try {
      await this.setModel(want);
      if (this.model !== want) why = "stays";
    } catch (e) {
      console.warn("[acp] could not apply the chosen model:", (e as Error).message);
      why = "refused";
    }
    if (why) {
      this.refused.add(want);
      this.host.note?.(`${ACP_NAMES[this.agent] ?? this.agent} could not switch to ${want} and stays on ${this.model ?? "its own model"}.`);
      this.host.modelRefused?.();
    }
  }

  /** Sends one message as a prompt turn. The turn's end is handled here, when the agent answers. */
  prompt(text: string): void {
    const since = Date.now();
    this.busySince = since;
    this.draft = "";
    this.request("session/prompt", { sessionId: this.sid, prompt: [{ type: "text", text }] }).then(
      (r) => this.endTurn(since, String(r?.stopReason ?? "")),
      (e: Error) => this.endTurn(since, "error", e.message),
    );
  }

  /** Stops the turn. The agent ends it with a cancelled reply; if none comes, it is ended here. */
  cancel(): void {
    if (this.closed || this.busySince === undefined || !this.sid) return;
    this.notify("session/cancel", { sessionId: this.sid });
    // pending permission questions end as cancelled, as the protocol asks
    for (const [requestId, perm] of this.perms) this.write({ jsonrpc: "2.0", id: perm.rpcId, result: { outcome: { outcome: "cancelled" } } }), this.asks.delete(requestId);
    this.perms.clear();
    chatWaiting.delete(this.id);
    const since = this.busySince;
    setTimeout(() => this.endTurn(since, "cancelled"), 5000);
  }

  /** Answers a permission question: the option the answer picks (or cancelled when none fits). The host stores a rule the ask offered; this only answers. */
  answer(requestId: string, allow: boolean): void {
    const perm = this.perms.get(requestId);
    if (!perm) return;
    this.perms.delete(requestId);
    this.asks.delete(requestId);
    if (this.asks.size === 0) chatWaiting.delete(this.id);
    const optionId = pickOption(perm.options, allow);
    this.write({ jsonrpc: "2.0", id: perm.rpcId, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
    this.host.emit({ kind: "answer", requestId, allow });
  }

  /** Kills the agent (stop or delete). Its exit is not an error. */
  stop(): void {
    if (this.closed) return;
    this.stopping = true;
    this.child.kill("SIGTERM");
  }

  private endTurn(since: number, stop: string, err?: string): void {
    // a turn ends once; a late reply from an earlier turn, or one whose process already exited, changes nothing
    if (this.closed || this.busySince !== since) return;
    if (this.restoreModel !== undefined) {
      const back = this.restoreModel;
      this.restoreModel = undefined;
      this.setModel(back).catch((e) => console.warn("[acp] could not go back to the model:", (e as Error).message));
    }
    // a usage limit: the host moves the message on (or says why it cannot), and ends the turn itself
    if (err !== undefined && this.host.limited?.(err)) {
      this.busySince = undefined;
      this.draft = "";
      this.helpers.clear();
      return;
    }
    this.flush();
    if (stop === "refusal") this.host.emit({ kind: "error", text: "The agent refused to do that." });
    else if (stop === "max_tokens") this.host.emit({ kind: "error", text: "The reply got too long and was cut short. Ask for a smaller step." });
    else if (err !== undefined) {
      console.warn("[acp] prompt failed:", err.slice(0, 200));
      this.host.emit({ kind: "error", text: "The agent ran into a problem. Try again." });
    }
    this.host.emit({ kind: "done", worked: Date.now() - since, ...(this.model ? { model: this.model } : {}) });
    this.wrapUp();
  }

  /** The draft so far becomes one assistant line. */
  private flush(): void {
    if (this.draft.trim()) this.host.emit({ kind: "assistant", text: this.draft.trim() });
    this.draft = "";
  }

  private wrapUp(): void {
    chatBusy.delete(this.id);
    this.busySince = undefined;
    this.helpers.clear();
    if (this.todos.every((t) => t.status === "done")) this.todos = [];
    this.host.finish();
  }

  private onLine(line: string): void {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return; // not JSON: ignore
    }
    if (!m || typeof m !== "object") return;
    if (typeof m.method === "string") {
      if (m.id !== undefined) return this.onRequest(m);
      if (m.method === "session/update" && !this.replaying) for (const e of acpEffects(m.params?.update)) this.apply(e);
      return;
    }
    // a reply to one of our requests
    const p = this.rpc.get(m.id);
    if (!p) return;
    this.rpc.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(Object.assign(new Error(String(m.error.message ?? "agent error")), { code: m.error.code }));
    else p.resolve(m.result);
  }

  /** A request from the agent to us: a permission question, or anything else, which we do not support. The mode and the saved rules decide first: a yes is sent at once and the person is not asked. */
  private onRequest(m: any): void {
    if (m.method !== "session/request_permission") {
      this.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    const p = m.params ?? {};
    const title = String(p.toolCall?.title ?? "");
    const raw = p.toolCall?.rawInput;
    const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const kind = String(p.toolCall?.kind ?? "");
    const options = Array.isArray(p.options) ? p.options.filter((o: any) => typeof o?.optionId === "string").map((o: any) => ({ optionId: o.optionId, kind: String(o.kind ?? "") })) : [];
    const pol = this.host.policy?.() ?? { mode: "default", rules: [] };
    if (acpDecision(pol.mode, kind, input, pol.rules, this.cwd) === "allow") {
      const optionId = pickOption(options, true);
      this.write({ jsonrpc: "2.0", id: m.id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
      return;
    }
    const requestId = `acp-${m.id}`;
    const always = ruleFor(acpToolName(kind, input), input, this.cwd) ?? undefined;
    this.perms.set(requestId, { rpcId: m.id, options });
    this.asks.set(requestId, { tool: title, input, ...(always ? { always } : {}) });
    const wasWaiting = chatWaiting.has(this.id);
    chatWaiting.add(this.id);
    const text = permissionText(this.agent, title);
    const detail = raw !== undefined ? JSON.stringify(raw).slice(0, 300) : undefined;
    this.host.emit({ kind: "ask", requestId, text, ...(detail !== undefined ? { detail } : {}), ...(always ? { always } : {}) });
    if (!wasWaiting) this.host.pingNeedsYou(text);
  }

  private apply(e: AcpEffect): void {
    if (e.kind === "text") this.draft += e.text;
    else if (e.kind === "flush") this.flush();
    else if (e.kind === "event") this.host.emit(e.body);
    else this.todos = e.todos;
  }

  private onExit(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.rpc.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("agent stopped"));
    }
    this.rpc.clear();
    this.perms.clear();
    this.asks.clear();
    chatWaiting.delete(this.id);
    this.host.exited(this);
    if (this.stopping || !chatBusy.has(this.id) || !this.sid) return; // no session yet: the start that is waiting reports it
    const last = this.stderr.trim().split("\n").pop()?.trim() ?? "";
    console.warn("[acp] agent stopped unexpectedly:", last.slice(0, 200));
    this.host.emit({ kind: "error", text: "The agent stopped unexpectedly. Try again." });
    this.host.emit({ kind: "done" });
    this.busySince = undefined;
    this.draft = "";
    this.wrapUp();
  }

  private write(o: object): void {
    if (this.closed) return;
    this.child.stdin!.write(JSON.stringify(o) + "\n");
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("agent stopped"));
      const id = ++this.seq;
      const entry: Rpc = { resolve, reject };
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          this.rpc.delete(id);
          reject(new Error(`${method} did not answer in time`));
        }, timeoutMs);
      }
      this.rpc.set(id, entry);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
}
