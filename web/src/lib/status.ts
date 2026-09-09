import type { Workspace } from "../types";

/**
 * Workspace lifecycle — the product model (docs/product-v1.10.0.md):
 * create → running → needs-review → committed   (or → stopped clean)
 *
 * Derivation is pure and cheap: running wins, then needs-review (agent
 * finished and the diff isn't committed yet), then committed, then stopped.
 * `lastCommitAt` is set by the server on commit; before any commit it's
 * undefined, so any stopped workspace is by definition needs-review.
 */
export type WorkspaceStatus = "running" | "needs-review" | "committed" | "stopped";

export function workspaceStatus(w: Workspace): WorkspaceStatus {
  if (w.running) return "running";
  if (w.stopped && (w.lastCommitAt === undefined || w.lastCommitAt < w.stopped)) return "needs-review";
  if (w.stopped) return "committed";
  return "stopped";
}

export const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  running: "running",
  "needs-review": "needs review",
  committed: "committed",
  stopped: "stopped",
};

/** Tailwind classes per status — the one visual language for the lifecycle. */
export const STATUS_BADGE: Record<WorkspaceStatus, string> = {
  running: "text-emerald-400 border-emerald-400/40 bg-emerald-400/10",
  "needs-review": "text-amber-400 border-amber-400/40 bg-amber-400/10",
  committed: "text-emerald-300 border-emerald-300/30 bg-emerald-300/5",
  stopped: "text-zinc-400 border-zinc-700 bg-transparent",
};

export const STATUS_DOT: Record<WorkspaceStatus, string> = {
  running: "bg-emerald-400 shadow-[0_0_6px_hsl(var(--chart-1))]",
  "needs-review": "bg-amber-400",
  committed: "bg-emerald-300/70",
  stopped: "bg-zinc-600",
};

/** Kind tag for the activity timeline (Chrono Board grammar). */
export type ActivityKind = "created" | "start" | "review" | "commit" | "stop";
export const ACTIVITY_DOT: Record<ActivityKind, string> = {
  created: "bg-emerald-300/70",
  start: "bg-emerald-400",
  review: "bg-amber-400",
  commit: "bg-emerald-300/70",
  stop: "bg-zinc-600",
};