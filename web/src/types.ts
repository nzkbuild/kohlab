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
