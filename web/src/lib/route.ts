/**
 * Tiny path router.
 *
 * The URL is the source of truth for what is on screen, so refresh preserves
 * context, links are shareable, and Back/Forward work. Four routes do not
 * justify a router dependency.
 */
export type WorkspaceTab = "terminal" | "files" | "review" | "log";

export const WORKSPACE_TABS: readonly WorkspaceTab[] = ["terminal", "files", "review", "log"];

export type SettingsSection = "account" | "team" | "agents" | "notifications" | "server" | "updates";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["account", "team", "agents", "notifications", "server", "updates"];

export type Route =
  /** Home: the review queue, then every workspace. `create` opens the form. */
  | { kind: "workspaces"; create?: boolean }
  /** `tab` absent means "the right pane for this workspace's state". */
  | { kind: "workspace"; id: string; tab?: WorkspaceTab }
  /** `section` absent means the first section the viewer may see. */
  | { kind: "settings"; section?: SettingsSection }
  /** Redeeming an invitation. The token is in the fragment, so it never reaches
   *  the server. This is the one route rendered before the key gate. */
  | { kind: "join" };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "w" && parts[1]) {
    const tab = WORKSPACE_TABS.find((t) => t === parts[2]);
    return { kind: "workspace", id: decodeURIComponent(parts[1]), ...(tab ? { tab } : {}) };
  }
  if (parts[0] === "new") return { kind: "workspaces", create: true };
  if (parts[0] === "settings") {
    const section = SETTINGS_SECTIONS.find((s) => s === parts[1]);
    return { kind: "settings", ...(section ? { section } : {}) };
  }
  if (parts[0] === "join") return { kind: "join" };
  // `/` and the old `/workspaces` both land on home, so existing bookmarks work.
  return { kind: "workspaces" };
}

export function routePath(route: Route): string {
  switch (route.kind) {
    case "workspace":
      return `/w/${encodeURIComponent(route.id)}${route.tab ? `/${route.tab}` : ""}`;
    case "settings":
      return route.section ? `/settings/${route.section}` : "/settings";
    case "join":
      return "/join";
    default:
      return route.create ? "/new" : "/";
  }
}

/** Titles for the document title and the error boundary. */
export const ROUTE_LABEL: Record<Route["kind"], string> = {
  workspaces: "Workspaces",
  workspace: "Workspace",
  settings: "Settings",
  join: "Join",
};
