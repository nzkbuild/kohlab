import type { Workspace } from "../types";

/**
 * Workspace lifecycle: the product model:
 *   create → running → needs-review → committed   (or → stopped clean)
 *
 * Derivation is pure and cheap: a pending question (waiting) wins, then running,
 * then needs-review (the agent
 * finished with changes and nothing has been committed since), then committed,
 * then stopped. A run that finished clean is stopped: it has nothing to review.
 */
export type WorkspaceStatus = "needs-you" | "running" | "needs-review" | "committed" | "discarded" | "stopped";

/**
 * Two decisions end a run: accept (commit) and reject (discard). Whichever one
 * happened at or after the last stop is what the workspace now is, and a fresh
 * run puts it back in the queue either way, because both are compared against
 * `stopped` rather than against each other.
 *
 * Discard has to be derivable. Without it a discarded workspace has no commit,
 * so the needs-review branch claimed it still needed review: it kept its place in
 * the queue and in the review count with an empty diff and nothing left to
 * review. Setting lastCommitAt on discard would have been worse, because it would
 * report rejected work as accepted.
 */
export function workspaceStatus(w: Workspace): WorkspaceStatus {
  if (w.waiting) return "needs-you";
  if (w.running) return "running";
  if (!w.stopped) return "stopped";
  const committed = w.lastCommitAt ?? -Infinity;
  const discarded = w.discardedAt ?? -Infinity;
  if (committed < w.stopped && discarded < w.stopped) return w.stoppedClean ? "stopped" : "needs-review";
  return discarded > committed ? "discarded" : "committed";
}

export const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  "needs-you": "Needs you",
  running: "Working",
  "needs-review": "Ready to check",
  committed: "Kept",
  discarded: "Undone",
  stopped: "Paused",
};

export const STATUS_CHIP: Record<WorkspaceStatus, string> = {
  "needs-you": "chip-review",
  running: "chip-running",
  "needs-review": "chip-review",
  committed: "chip-committed",
  discarded: "chip-stopped",
  stopped: "chip-stopped",
};

/**
 * Text-colour class per status. Held as a static map on purpose: Tailwind
 * cannot see an interpolated class name, so building these by template string
 * silently produces no CSS at all.
 */
export const STATUS_TEXT: Record<WorkspaceStatus, string> = {
  "needs-you": "text-status-review",
  running: "text-status-running",
  "needs-review": "text-status-review",
  committed: "text-status-committed",
  discarded: "text-status-stopped",
  stopped: "text-status-stopped",
};

/** Sort weight for the workspace table: review first, then live, then rest. */
export const STATUS_ORDER: Record<WorkspaceStatus, number> = {
  "needs-you": 0,
  "needs-review": 1,
  running: 2,
  committed: 3,
  stopped: 4,
  discarded: 5,
};

export function byReviewFirst(a: Workspace, b: Workspace): number {
  const d = STATUS_ORDER[workspaceStatus(a)] - STATUS_ORDER[workspaceStatus(b)];
  if (d !== 0) return d;
  return (b.started ?? b.created) - (a.started ?? a.created);
}

function lastActivity(w: Workspace): number {
  return Math.max(w.created, w.started ?? 0, w.stopped ?? 0);
}

/** Newest activity first. */
export function bySidebarActivity(a: Workspace, b: Workspace): number {
  return lastActivity(b) - lastActivity(a);
}

/** Kind tag for the activity timeline. */
export type ActivityKind = "created" | "start" | "review" | "commit" | "stop";

export const ACTIVITY_CHIP: Record<ActivityKind, string> = {
  created: "chip-stopped",
  start: "chip-running",
  review: "chip-review",
  commit: "chip-committed",
  stop: "chip-stopped",
};
