export interface Workspace {
  id: string;
  repo: string;
  task: string;
  agent: string;
  created: number;
  started: number | null;
  stopped: number | null;
  /** json payload given to the agent CLI at launch (may be absent) */
  payload?: string;
  /** read-only share token; link is <host>/?share=<token> */
  share?: string;
  /** optional resource caps applied to the agent's PTY session */
  limits?: WorkspaceLimits;
}

export interface WorkspaceLimits {
  /** wall-clock timeout in seconds */
  timeoutSec?: number;
  /** max virtual memory in MB (ulimit -v) */
  maxMemoryMb?: number;
  /** max simultaneous processes (ulimit -u) */
  maxProcs?: number;
}

export type Role = "owner" | "member" | "viewer";

export interface User {
  id: string;
  name: string;
  /** SHA-256 hex of the user's key. Plaintext is never stored. */
  key: string;
  role: Role;
}
