import { useApp } from "../store";

/**
 * New project means describing it: go to Home and put the cursor in its box.
 * The name is not asked for; Claude or the server names the project from the first message.
 */
export function startNewProject(): void {
  if (useApp.getState().route.kind !== "workspaces") useApp.getState().navigate({ kind: "workspaces" });
  // Home mounts (or re-renders) on the navigation; the box is there on the next tick.
  window.setTimeout(() => document.getElementById("home-idea")?.focus(), 0);
}
