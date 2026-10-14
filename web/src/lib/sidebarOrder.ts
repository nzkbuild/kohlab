import type { Workspace } from "../types";
import { bySidebarActivity, workspaceStatus } from "./status";

/**
 * The sidebar's one flat list: projects that need the owner first, then the
 * rest, each run by most recent change. Only "needs you" jumps the queue; a
 * project ready to check sorts by activity like any other.
 */
export function sidebarOrder(workspaces: Workspace[]): Workspace[] {
  const rank = (w: Workspace) => (workspaceStatus(w) === "needs-you" ? 0 : 1);
  return [...workspaces].sort((a, b) => rank(a) - rank(b) || bySidebarActivity(a, b));
}
