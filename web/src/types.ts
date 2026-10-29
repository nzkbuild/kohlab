export interface Workspace {
  id: string;
  repo: string;
  task: string;
  agent: string;
  created: number;
  started: number | null;
  stopped: number | null;
  running: boolean;
  path: string;
  share?: string;
  /** timestamp of the last commit (set on commit; undefined = never committed) */
  lastCommitAt?: number;
  /** timestamp of the last discard (set on discard; undefined = never discarded).
   *  Mirrors lastCommitAt: the two decisions that end a run, and which one came
   *  last is what the status is derived from. */
  discardedAt?: number;
  /** Mirrors the server's stoppedClean: a run that changed nothing is not queued. */
  stoppedClean?: boolean;
  /** A chat workspace: the AI is driven through a chat screen, not a terminal. */
  chat?: boolean;
  chatSession?: string;
  /** The conversation last moved on in the chat view, so the terminal's next Claude resumes it. */
  resumeInTerminal?: boolean;
  /** When the chat switched conversation: the web view remounts on change. */
  chatReset?: number;
  /** From the listing: a chat permission question is pending (unanswered). */
  waiting?: boolean;
  /** From the listing: the chat's Claude still runs background work after its turn ended. */
  backgroundWork?: boolean;
  /** Claude model for this project. Undefined = the account default. */
  model?: "opus" | "sonnet" | "haiku";
  /** Model an ACP agent (hermes, omp) runs its chat on: the agent's own model value. */
  agentModel?: string;
  /** The last session id per agent for this chat project. */
  agentSessions?: Record<string, string>;
  /** The last event number each agent had seen when the person switched away from it. */
  agentSeen?: Record<string, number>;
  /** After a switch of AI: the events after this number are what the new agent has not seen. */
  handoffAfter?: number;
  /** Standing notes for the AI on this project (business name, colours, tone). At most 4000 characters. */
  notes?: string;
  /** Continue fresh by itself when the chat is nearly full. Undefined = on. */
  autoFresh?: boolean;
}

/** One multiple-choice question Claude asks (AskUserQuestion). */
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/** One entry in a chat workspace's conversation. `n` is the sequence number used for polling. */
export type ChatEvent = { n: number; at: number } & (
  | { kind: "user"; text: string; uuid?: string; tree?: string; with?: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string; toolId?: string; detail?: string; file?: string }
  | { kind: "result"; toolId: string; output: string; failed?: boolean }
  | {
      kind: "ask";
      requestId: string;
      text: string;
      why?: string;
      detail?: string;
      form?: "question" | "plan";
      /** The "Always allow" offer: the rule it would save and its plain label. Absent when this step can't be saved as a rule. */
      always?: { rule: string; label: string };
      questions?: AskQuestion[];
      plan?: string;
    }
  | { kind: "answer"; requestId: string; allow: boolean; reply?: string }
  | { kind: "done"; worked?: number; planDelta?: number; model?: string; tokens?: { in: number; out: number }; recalled?: string[] }
  /** the plan share of the turn that ended just before it; the chat view merges it into that turn's done line */
  | { kind: "plan"; planDelta: number }
  | { kind: "error"; text: string }
  /** A quiet line in the chat: "Switched to X", "Went back to before: …", compaction or model-fallback notices, "Background task finished: …". */
  | { kind: "note"; text: string; until?: number }
  /** The handoff note a fresh session starts from: shown as a collapsed card. */
  | { kind: "handoff"; text: string }
);

export interface TreeNode {
  name: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

export interface DiffFile {
  name: string;
  diff: string;
}

/** One kept version of a project: the commit's full sha, its time in ms, and its subject. */
export interface Version {
  id: string;
  at: number;
  label: string;
  /** No dev command at the newest version: it can be looked at as a plain page. */
  look?: boolean;
}

/** Something that went wrong with the project's page or app, as the server reports it. */
export interface Problem {
  kind: "console" | "page" | "request" | "devserver";
  text: string;
  detail?: string;
  at: number;
}

/** The element the person pointed at in the preview. Page CSS pixels. */
export interface Pick {
  tag: string;
  text: string;
  id?: string;
  classes: string[];
  selector: string;
  box: { x: number; y: number; width: number; height: number };
  page: string;
  viewport: { width: number; height: number };
}

/** A project's share link: its address (null when off), when it stops (null for never), and whether it can be shared. */
export interface LinkInfo {
  url: string | null;
  expires: number | null;
  kind: "static" | "app" | "unsupported";
}

export type AgentStatus = Record<string, boolean> & { claudeSignedIn?: boolean | null; codexSignedIn?: boolean | null };

/** Codex's sign-in as the server reports it: idle, waiting on the owner's approval (with the link and code), done, or failed. */
export interface CodexLogin {
  state: "idle" | "waiting" | "done" | "failed";
  url?: string;
  code?: string;
  error?: string;
}

/** What `/api/release` reports: the published version, and any update in flight. */
export interface ReleaseStatus {
  current: string;
  latest: string;
  available: boolean;
  commits: string[];
  notes: string;
  upstream: string | null;
  head: string;
  checkedAt: number;
  error: string | null;
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  exit: number | null;
  /** stopped without writing its finish marker: killed, or it never started */
  unfinished: boolean;
  log: string;
}

/* ------------------------------------------------------------- AI hub -- */

/** One AI on this computer, as GET /api/providers reports it. Owner-only fields are absent for everyone else. */
export interface ProviderCard {
  id: string;
  name: string;
  kind: "cli" | "router";
  installed: boolean;
  version: string | null;
  state: "connected" | "signed_out" | "not_installed" | "limited" | "error" | "checking";
  checkedAt: number;
  stale: boolean;
  error?: { code: "timeout" | "spawn" | "protocol" | "network" | "auth"; message: string };
  accounts: ProviderAccount[];
  actions: ProviderAction[];
}

export interface ProviderWindow {
  id: string;
  label: string;
  percent: number;
  resetsAt: string | null;
  windowMins: number | null;
  severity: "normal" | "warn" | "limit";
}

export interface ProviderModel {
  value: string;
  label: string;
  description?: string;
  efforts?: string[];
  isDefault?: boolean;
  group?: string;
  /** Added by the owner, not listed by the AI. */
  custom?: boolean;
}

export interface ProviderAccount {
  id: string;
  label: string;
  email: string | null;
  plan: string | null;
  auth: "oauth" | "api_key" | "router" | "config" | "none";
  state: "connected" | "signed_out" | "limited" | "error";
  isolation: Record<string, string>;
  usage: null | {
    readAt: number;
    windows: ProviderWindow[];
    credits?: { balance: string | null; unlimited: boolean } | null;
    reachedType?: string | null;
    note?: string;
  };
  models: ProviderModel[];
  modelsAt: number | null;
  /** Owner only. "default" is the AI's own login; "login" another sign-in; "router" an address with a key. */
  kind?: "default" | "login" | "router";
  /** Owner only: when this account's limit lifts (ms), if it is at its limit. */
  limitedUntil?: number | null;
  hasKey?: boolean;
  /** Owner only: "127.0.0.1:20128". Never the full address. */
  baseUrlHost?: string;
}

export interface ProviderAction {
  kind: "install" | "sign_in" | "add_account" | "fix" | "refresh" | "sign_out" | "open_dashboard";
  label: string;
  via?: "device_code" | "terminal" | "api_key" | "url" | "server";
  accountId?: string;
  hint?: string;
}

export type Mode = "default" | "acceptEdits" | "auto" | "plan" | "full";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** What new projects start with (Settings -> AI). A missing key means the built-in choice. */
export interface AiDefaults {
  agent?: string;
  account?: string;
  model?: string;
  effort?: Effort;
  mode?: Mode;
  autoFresh?: boolean;
}

/** Where a value comes from: this project, the Settings defaults, or Kohlab's built-in choice. */
export type Src = "project" | "default" | "builtin";
export interface AiSetting<T> {
  value: T | null;
  source: Src;
}
export interface AiResolved {
  agent: AiSetting<string>;
  account: AiSetting<string>;
  model: AiSetting<string>;
  effort: AiSetting<Effort>;
  mode: AiSetting<Mode>;
  autoFresh: AiSetting<boolean>;
}

/** One step of "If the limit is reached". Account omitted: the same account. */
export interface FallbackStep {
  account?: string | null;
  model?: string;
}
export interface Fallback {
  auto: boolean;
  steps: FallbackStep[];
  /** false: the suggested order, worked out by Kohlab. */
  custom: boolean;
}
/** The project moved off an AI that hit its limit. `until` is when it lifts (ms), or null if unknown. */
export interface LimitState {
  from: string;
  to: string;
  until: number | null;
  at: number;
  fromAccount: string | null;
}
export interface PermissionRule {
  rule: string;
  label: string;
  source: "kohlab" | "claude-settings" | "session";
  removable: boolean;
}

/** An account as GET /api/ai/accounts and the add form report it. Never a key, a folder or a full address. */
export interface AccountView {
  id: string;
  provider: "claude" | "codex";
  kind: "login" | "router";
  label: string;
  baseUrlHost?: string;
  hasKey?: boolean;
  signedIn?: boolean;
  createdAt: number;
}
export type RouterCheck = "ok" | "key_rejected" | "unreachable";

/** Another login's sign-in: waiting for the browser (url, and a code to type in or one to paste back), done, failed, or "manual" (run a command yourself). */
export interface AccountSignIn {
  state: "idle" | "waiting" | "done" | "failed" | "manual";
  url?: string;
  code?: string;
  needsCode?: boolean;
  command?: string;
  error?: string;
}

/** What GET /api/workspaces/:id/chat/run reports: what the AI was told and what it can use. */
export interface RunInfo {
  agent: string;
  agentName: string;
  terminalProject: boolean;
  instructions: { system: string | null; notes: string; note: string | null; brain?: { notes: number; tokens: number } | null };
  tools: { builtin: string[]; mcp: { name: string; status: string }[] } | null;
  ready: boolean;
  /** What each setting is for this project and where it comes from. An older server sends none. */
  ai?: AiResolved;
  /** The account the project runs on now (null: the AI's own login). */
  account?: { id: string; label: string; kind: string } | null;
  fallback?: Fallback;
  limit?: LimitState | null;
  rules?: PermissionRule[];
  /** Plain words about what Full access means here. */
  accessNote?: string | null;
}

/** One helper the AI started, as the chat snapshot's helperTree lists it (parents before children). */
export interface HelperNode {
  id: string;
  taskId: string | null;
  parentId: string | null;
  label: string;
  kind: string | null;
  model: string | null;
  status: "running" | "done" | "failed" | "stopped";
  background: boolean;
  startedAt: number;
  endedAt: number | null;
  tools: number | null;
  tokens: number | null;
  lastTool: string | null;
  summary: string | null;
  canStop: boolean;
}

export interface AgentInfo {
  name: string;
  installed?: boolean;
  installCmd?: string;
  setupCmd?: string;
  setupHint?: string;
}


export const AGENT_CATALOG: AgentInfo[] = [
  {
    name: "omp",
    installCmd: "npm i -g @moonbit/omp",
    setupCmd: "omp",
    setupHint: "Run `omp` once to complete setup.",
  },
  {
    name: "claude",
    installCmd: "npm i -g @anthropic-ai/claude-code",
    setupCmd: "claude setup",
    setupHint: "Run `claude setup` to log in with your Anthropic account or API key.",
  },
  {
    name: "codex",
    installCmd: "npm i -g @openai/codex",
    setupCmd: "codex",
    setupHint: "Run `codex` and follow the login flow with your OpenAI account or API key.",
  },
  {
    name: "opencode",
    installCmd: "npm i -g opencode-ai",
    setupCmd: "opencode",
    setupHint: "Run `opencode` to configure providers.",
  },
  {
    name: "pi",
    installCmd: "npm i -g @badlogic/pi",
    setupCmd: "pi",
    setupHint: "Run `pi` to configure.",
  },
  {
    name: "gemini",
    installCmd: "npm i -g @google/gemini-cli",
    setupCmd: "gemini",
    setupHint: "Run `gemini` and follow the Google sign-in flow.",
  },
];

/** One file a message changed: "What this changed". */
export interface TurnFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

/* ------------------------------------------------------- project brain -- */

export type NoteType = "Goal" | "Decision" | "Handoff" | "Task" | "Fact" | "Version" | "File";
export type NoteSource = "seed" | "person" | "ai" | "keep" | "plan" | "handoff" | "notes";
export type TaskStatus = "open" | "doing" | "done";

export interface BrainNodeInfo {
  name: string;
  type: NoteType;
  source: NoteSource;
  status?: TaskStatus;
  /** ms */
  updated: number;
  degree: number;
}

export interface BrainGraph {
  nodes: BrainNodeInfo[];
  /** [from, to] by name, deduped, resolved only, no self-links */
  edges: [string, string][];
  count: number;
  cap: 400;
  summary: { notes: number; tokens: number };
}

export interface BrainNote {
  name: string;
  type: NoteType;
  source: NoteSource;
  status?: TaskStatus;
  created: number;
  updated: number;
  body: string;
  outlinks: string[];
  unresolved: string[];
  backlinks: { name: string; type: NoteType }[];
  path?: string;
}

export interface BrainHit {
  name: string;
  type: NoteType;
  /** at most 160 characters */
  snippet: string;
  score: number;
}
