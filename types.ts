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
  /** timestamp of the last discard (set on discard; undefined = never discarded).
   *  A decision field, like lastCommitAt: it is what lets a workspace leave the
   *  review queue without claiming its work was accepted. */
  discardedAt?: number;
  /** The worktree had no changes when the run stopped. A clean stop has nothing
   *  to review, so the status derivation files it as stopped. Undefined on runs
   *  stopped before this was recorded. */
  stoppedClean?: boolean;
  /** json payload given to the agent CLI at launch (may be absent) */
  payload?: string;
  /** Talks through the claude CLI's chat mode (chat.ts), not a main PTY. */
  chat?: boolean;
  /** claude session id: the chat's, or the terminal Claude's as reported by its hooks. For --resume. */
  chatSession?: string;
  /** the conversation last moved on in the chat view, so the terminal's next Claude resumes it. */
  resumeInTerminal?: boolean;
  /** When the chat switched conversation: the web view remounts on change. */
  chatReset?: number;
  /** terminal Claude: when its last prompt was submitted (UserPromptSubmit hook); cleared on start. Mid-turn when set and not stopped after it. */
  promptAt?: number;
  /** owner's workspace root under their home; legacy records omit it and live
   *  under the shared store */
  dir?: string;
  /** kohlab user id who created the workspace ("" = legacy/anonymous/root) */
  ownerId?: string;
  /** The agent runs as the dedicated KOHLAB_AGENT_USER account, not as the
   *  server (root). Set at creation, so turning the setting on never changes a
   *  workspace that already exists. */
  asAgent?: boolean;
  /** read-only share token; link is <host>/?share=<token> */
  share?: string;
  /** secret token for the web preview at /p/<token>/ (created on first Preview) */
  previewToken?: string;
  /** a share link to the app, served at /p/<token>/ to anyone with it. Expires unless `expires` is null. Never reaches the owner's browser or problem routes. */
  shareLink?: { token: string; expires: number | null };
  /** secret for the agent's hook callbacks (POST /api/hook/<id>), written into its Claude settings */
  hookToken?: string;
  /** optional resource caps applied to the agent's PTY session */
  limits?: WorkspaceLimits;
  /** Claude model for this project, as Claude takes it: an alias, a model's own id, a router's id, or "default" (an explicit choice of the account's own). Undefined = inherit the server default. */
  model?: string;
  /** Standing notes the person wrote for the AI about this project (<= 4000 chars). Always followed by a chat; a running Claude picks them up at its next message. */
  notes?: string;
  /** Claude effort level chosen in the chat; re-applied when its process restarts. */
  effort?: Effort;
/** Permission mode the person picked in the chat, passed to claude when it starts. Undefined = the server default for a chat, the project's own settings for a terminal. "full" is Kohlab answering every ask itself; Claude stays in "default". */
  permissionMode?: Mode | "dontAsk";
  /** The AI (and account) were chosen for this project: set by its first message or an explicit choice. Until then they follow the server defaults. */
  agentPinned?: boolean;
  /** The sign-in this project's AI uses: an account id (accounts.ts). Undefined = the AI's own login. */
  account?: string;
  /** What to do when the AI hits its usage limit. Undefined parts are the computed default. */
  fallback?: { auto?: boolean; steps?: FallbackStep[] };
  /** Set while a hop to another account or model is in force after a limit; cleared when the first one is usable again. */
  limit?: LimitState;
  /** Actions the person chose "Always allow" for (Claude permission rule syntax). */
  allowRules?: string[];
  /** Model an ACP agent (hermes, omp) runs its chat on, as the agent names it (its model value). Undefined = the agent's own default. */
  agentModel?: string;
  /** The last session id per agent for this chat project (Claude's or an ACP agent's), so switching back resumes it. */
  agentSessions?: Record<string, string>;
  /** The last event number each agent had seen when the person switched away from it. */
  agentSeen?: Record<string, number>;
  /** After a switch of AI: the events after this number are what the new agent has not seen. Cleared by its first message. */
  handoffAfter?: number;
  /** After "New chat from here": what the conversation it started from said, sent with the next message. Cleared by that message. */
  branchContext?: string;
  /** Continue fresh: do it by itself when the chat's memory is nearly full. On unless false. */
  autoFresh?: boolean;
  /** After "Continue fresh": the handoff note the new session starts from. Sent with its first message, then cleared. */
  freshNote?: string;
  /** After "Go back to here": the message the files were put back before (shortened). Sent as a note with the next message, then cleared. */
  restoredFrom?: string;
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
  /** SHA-256 hex of the user's key. Plaintext is never stored. Absent while an
   *  invitation is outstanding: they exist, but cannot sign in yet. */
  key?: string;
  role: Role;
  /** POSIX user this member maps to ("" when unprovisioned). */
  osUser?: string;
  uid?: number;
  gid?: number;
  /** /home/<osUser>, where worktrees and agent config live. */
  home?: string;
  /** Present while an invitation is outstanding; cleared when it is accepted. */
  invite?: Invite;
}

export interface Invite {
  /** SHA-256 hex of the invite token. The token itself is shown once, like a key. */
  token: string;
  /** epoch ms, after this the invitation is dead and must be re-sent. */
  expires: number;
  invitedBy?: string;
}

/** Something a person can ask the AI to fix: a browser error, a failed request, or a dev server that did not start. */
export interface Problem {
  kind: "console" | "page" | "request" | "devserver";
  /** One line, at most 300 characters. */
  text: string;
  /** More to read, at most 4000 characters. */
  detail?: string;
  /** When Kohlab noticed it (epoch ms). */
  at: number;
}

/** An element the person pointed at in the shared browser, as the chat is told about it. */
export interface Pick {
  tag: string;
  /** The element's visible text, one line, at most 80 characters. */
  text: string;
  id?: string;
  /** At most 5 class names, each at most 40 characters. */
  classes: string[];
  /** A CSS selector for the element, at most 300 characters. */
  selector: string;
  box: { x: number; y: number; width: number; height: number };
  /** The page's path only, at most 200 characters. */
  page: string;
  viewport: { width: number; height: number };
}

// ---- AI control (v2.6): the contract between server and web ----

export type Mode = "default" | "acceptEdits" | "auto" | "plan" | "full";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** What new projects start with. A key left out means "built in". */
export interface AiDefaults {
  agent?: string;
  account?: string;
  model?: string;
  effort?: Effort;
  mode?: Mode;
  autoFresh?: boolean;
}

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

/** One step of the usage-limit fallback list. An omitted account means the same account. */
export interface FallbackStep {
  account?: string | null;
  model?: string;
}
export interface Fallback {
  auto: boolean;
  steps: FallbackStep[];
  /** false = the computed default order */
  custom: boolean;
}
export interface LimitState {
  from: string;
  to: string;
  /** epoch ms the limit lifts */
  until: number | null;
  at: number;
  fromAccount: string | null;
  /** a hop to another model on the same account: the model to go back to */
  fromModel?: string | null;
}
export interface PermissionRule {
  rule: string;
  label: string;
  source: "kohlab" | "claude-settings" | "session";
  removable: boolean;
}
