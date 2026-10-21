import type { Workspace } from "../types";
import { bySidebarActivity, workspaceStatus } from "./status";

/**
 * The sidebar's one flat list: projects that need the owner first, then projects
 * ready to check, then the rest, each run by most recent change.
 */
export function sidebarOrder(workspaces: Workspace[]): Workspace[] {
  const rank = (w: Workspace) => {
    const status = workspaceStatus(w);
    return status === "needs-you" ? 0 : status === "needs-review" ? 1 : 2;
  };
  return [...workspaces].sort((a, b) => rank(a) - rank(b) || bySidebarActivity(a, b));
}
