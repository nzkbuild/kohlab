import type { Effort, Mode } from "./types"; // web: "./types"
export type RoleKind = "lead" | "builder" | "reviewer" | "tester";
export type AgentState = "idle"|"queued"|"working"|"parked"|"needs_you"|"paused"|"budget"|"stopped"|"error";
export type TaskStatus = "todo"|"working"|"review"|"done"|"blocked";
export type TeamStatus = "running"|"paused"|"awaiting_approval"|"landing"|"done"|"stopped";
export interface Budget { tokens?: number; minutes?: number }
export interface Spent  { tokens: number; ms: number; turns: number }
export interface TeamRole {
  id: string;            // "lead" | "builder-1".."builder-4" | "reviewer" | "tester"
  kind: RoleKind; name: string;      // "Lead", "Builder 2"
  member: string;                    // hidden workspace id ("" until first use)
  account?: string; model?: string; effort?: Effort;
  mode: Mode;                        // never bypass; "full" only if the owner set it
  instructions: string;              // <=1500 chars
  budget: Budget; spent: Spent;
  state: AgentState; line: string;   // <=100 chars
  taskId?: string; since: number;
  inboxRead: number;
}
export interface TeamTask {
  id: string; title: string /*<=80*/; brief: string /*<=1200*/;
  area: string[]; deps: string[];
  status: TaskStatus; assignee?: string;
  branch?: string; base?: string; head?: string;
  summary?: string; files?: string[];
  review?: { verdict: "approve"|"changes"; notes: string; by: string; at: number };
  rounds: number; conflict?: string[]; merged?: string;
  spent: Spent; created: number; updated: number;
}
export interface TeamEvent { n: number; at: number;
  kind: "tool"|"message"|"task"|"state"|"budget"|"merge"|"note"|"you";
  from: string; to?: string; task?: string; text: string /*<=600*/ }
export interface NeedsYou { kind: "budget"|"conflict"|"approve"|"ask"|"permission"|"stalled"; text: string; role?: string; task?: string }
export interface Team {
  id: string; project: string; goal: string;
  status: TeamStatus; created: number; updated: number;
  base: string; int: string;         // int = "kohlab/team-<id>"
  maxAgents: number; gate: "final" | "each";
  budget: Budget; spent: Spent;
  roles: TeamRole[]; tasks: TeamTask[];
  needsYou: NeedsYou[]; seq: number; wakes: number;
}
// server-only: { team: Team; secrets: Record<roleId, token> }
