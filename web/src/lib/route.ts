/**
 * Tiny path router.
 *
 * The URL is the source of truth for what is on screen, so refresh preserves
 * context, links are shareable, and Back/Forward work. Four routes do not
 * justify a router dependency.
 */
/** "terminal" is the old name of the Claude view: it still opens the remembered Chat or Terminal view. */
export type WorkspaceTab = "chat" | "terminal" | "files" | "review" | "brain";

export const WORKSPACE_TABS: readonly WorkspaceTab[] = ["chat", "terminal", "files", "review", "brain"];

export type SettingsSection = "account" | "appearance" | "team" | "agents" | "notifications" | "server" | "updates";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = ["account", "appearance", "team", "agents", "notifications", "server", "updates"];

export type Route =
  /** Home: the review queue, then every workspace. `create` opens the form; `prompt` (from /new?prompt=) pre-fills the message box, never sends. */
  | { kind: "workspaces"; create?: boolean; prompt?: string }
  /** `tab` absent means "the right pane for this workspace's state". */
  | { kind: "workspace"; id: string; tab?: WorkspaceTab }
  /** `section` absent means the first section the viewer may see. */
  | { kind: "settings"; section?: SettingsSection }
  /** Redeeming an invitation. The token is in the fragment, so it never reaches
   *  the server. This is the one route rendered before the key gate. */
  | { kind: "join" };

/** Longest prompt a /new?prompt= link may pre-fill. */
export const PROMPT_MAX = 20_000;

export function parseRoute(pathname: string, search = ""): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "w" && parts[1]) {
    const tab = WORKSPACE_TABS.find((t) => t === parts[2]);
    return { kind: "workspace", id: decodeURIComponent(parts[1]), ...(tab ? { tab } : {}) };
  }
  if (parts[0] === "new") {
    const prompt = new URLSearchParams(search).get("prompt");
    if (prompt !== null) return { kind: "workspaces", prompt: prompt.slice(0, PROMPT_MAX) };
    return { kind: "workspaces", create: true };
  }
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
