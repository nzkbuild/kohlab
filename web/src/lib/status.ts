import type { Workspace } from "../types";

/**
 * Workspace lifecycle — the product model:
 *   create → running → needs-review → committed   (or → stopped clean)
 *
 * Derivation is pure and cheap: running wins, then needs-review (the agent
 * finished and nothing has been committed since), then committed, then stopped.
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

/**
 * Status is NEVER colour-only (SC 1.4.1): every status carries a label, and the
 * ones that appear without one in a dense row carry a glyph too. The chip class
 * supplies colour; the glyph is the non-colour cue that survives greyscale,
 * colour-blindness and forced-colors.
 */
export const STATUS_GLYPH: Record<WorkspaceStatus, string> = {
  running: "▶",
  "needs-review": "◆",
  committed: "✓",
  stopped: "■",
};

export const STATUS_CHIP: Record<WorkspaceStatus, string> = {
  running: "chip-running",
  "needs-review": "chip-review",
  committed: "chip-committed",
  stopped: "chip-stopped",
};

/**
 * Text-colour class per status. Held as a static map on purpose: Tailwind
 * cannot see an interpolated class name, so building these by template string
 * silently produces no CSS at all.
 */
export const STATUS_TEXT: Record<WorkspaceStatus, string> = {
  running: "text-status-running",
  "needs-review": "text-status-review",
  committed: "text-status-committed",
  stopped: "text-status-stopped",
};

/** Sort weight for the workspace table: review first, then live, then rest. */
export const STATUS_ORDER: Record<WorkspaceStatus, number> = {
  "needs-review": 0,
  running: 1,
  committed: 2,
  stopped: 3,
};

export function byReviewFirst(a: Workspace, b: Workspace): number {
  const d = STATUS_ORDER[workspaceStatus(a)] - STATUS_ORDER[workspaceStatus(b)];
  if (d !== 0) return d;
  return (b.started ?? b.created) - (a.started ?? a.created);
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
