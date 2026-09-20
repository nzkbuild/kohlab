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
}

export interface TreeNode {
  name: string;
  type: "dir" | "file";
  children?: TreeNode[];
}

export interface DiffFile {
  name: string;
  diff: string;
}

export type AgentStatus = Record<string, boolean>;

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
