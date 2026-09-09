export interface Workspace {
  id: string;
  repo: string;
  task: string;
  agent: string;
  created: number;
  started: number | null;
  stopped: number | null;
  /** timestamp of the last commit (set on commit; undefined = never committed) */
  lastCommitAt?: number;
  /** json payload given to the agent CLI at launch (may be absent) */
  payload?: string;
  /** owner's workspace root under their home; legacy records omit it and live
   *  under the shared store */
  dir?: string;
  /** kohlab user id who created the workspace ("" = legacy/anonymous/root) */
  ownerId?: string;
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
  /** POSIX user this member maps to ("" when unprovisioned). */
  osUser?: string;
  uid?: number;
  gid?: number;
  /** /home/<osUser> — where worktrees and agent config live. */
  home?: string;
}
