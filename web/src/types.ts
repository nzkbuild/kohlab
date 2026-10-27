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
  | { kind: "user"; text: string; uuid?: string; tree?: string }
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
      questions?: AskQuestion[];
      plan?: string;
    }
  | { kind: "answer"; requestId: string; allow: boolean; reply?: string }
  | { kind: "done"; worked?: number; planDelta?: number; model?: string; tokens?: { in: number; out: number } }
  /** the plan share of the turn that ended just before it; the chat view merges it into that turn's done line */
  | { kind: "plan"; planDelta: number }
  | { kind: "error"; text: string }
  /** A quiet line in the chat: "Switched to X", "Went back to before: …", compaction or model-fallback notices, "Background task finished: …". */
  | { kind: "note"; text: string }
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
}

export interface ProviderAction {
  kind: "install" | "sign_in" | "add_account" | "fix" | "refresh" | "sign_out" | "open_dashboard";
  label: string;
  via?: "device_code" | "terminal" | "api_key" | "url" | "server";
  accountId?: string;
  hint?: string;
}

/** What GET /api/workspaces/:id/chat/run reports: what the AI was told and what it can use. */
export interface RunInfo {
  agent: string;
  agentName: string;
  terminalProject: boolean;
  instructions: { system: string | null; notes: string; note: string | null };
  tools: { builtin: string[]; mcp: { name: string; status: string }[] } | null;
  ready: boolean;
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
