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
  | { kind: "tool"; text: string; toolId?: string; detail?: string }
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
  | { kind: "done" }
  | { kind: "error"; text: string }
  /** A quiet line in the chat: "Switched to X", "Went back to before: …", compaction or model-fallback notices, "Background task finished: …". */
  | { kind: "note"; text: string }
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
