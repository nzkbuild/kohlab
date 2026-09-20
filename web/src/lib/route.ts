/**
 * Tiny path router.
 *
 * The URL is the source of truth for what is on screen, so refresh preserves
 * context, links are shareable, and Back/Forward work. Three routes do not
 * justify a router dependency.
 */
export type Route =
  | { kind: "dashboard" }
  | { kind: "workspaces" }
  | { kind: "workspace"; id: string }
  | { kind: "settings" }
  /** Redeeming an invitation. The token is in the fragment, so it never reaches
   *  the server. This is the one route rendered before the key gate. */
  | { kind: "join" };

export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "w" && parts[1]) return { kind: "workspace", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "workspaces") return { kind: "workspaces" };
  if (parts[0] === "settings") return { kind: "settings" };
  if (parts[0] === "join") return { kind: "join" };
  return { kind: "dashboard" };
}

export function routePath(route: Route): string {
  switch (route.kind) {
    case "workspace":
      return `/w/${encodeURIComponent(route.id)}`;
    case "workspaces":
      return "/workspaces";
    case "settings":
      return "/settings";
    case "join":
      return "/join";
    default:
      return "/";
  }
}

/** Titles for the document title and the topbar breadcrumb. */
export const ROUTE_LABEL: Record<Route["kind"], string> = {
  dashboard: "Command center",
  workspaces: "Workspaces",
  workspace: "Workspace",
  settings: "Settings",
  join: "Join",
};
