import { create } from "zustand";
import { api } from "./api";
import type { Workspace } from "./types";
import { parseRoute, routePath, type Route } from "./lib/route";

/** Explicit socket state, never inferred from navigator.onLine. */
export type Connection = "connecting" | "live" | "reconnecting" | "offline";

/** Who this browser is. `role` drives which controls render; the server still gates every call. */
export interface Me {
  id: string;
  role: string;
  kind: string;
}

export interface AppState {
  authed: boolean;
  route: Route;
  workspaces: Workspace[];
  /** True only for the very first load, when a skeleton is warranted. */
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  connection: Connection;
  /** null until /api/account answers. Treated as permissive meanwhile: hiding
   *  controls for a beat on every load would flicker for the common case. */
  me: Me | null;
  /** Workspace that should open a fresh shell tab on arrival (Home's Open menu). */
  openShell: string | null;

  setOpenShell: (id: string | null) => void;
  setAuthed: (value: boolean) => void;
  setConnection: (value: Connection) => void;
  refresh: () => Promise<void>;
  loadMe: () => Promise<void>;
  /** Push a new route onto history, or replace the current entry. */
  navigate: (route: Route, opts?: { replace?: boolean }) => void;
  /** Adopt the current URL without touching history (Back/Forward). */
  adoptRoute: (route: Route) => void;
}

export const useApp = create<AppState>((set) => ({
  authed: false,
  route: parseRoute(location.pathname),
  workspaces: [],
  loading: true,
  error: null,
  lastUpdated: null,
  connection: "connecting",
  me: null,
  openShell: null,

  setOpenShell: (id) => set({ openShell: id }),
  setAuthed: (value) => set({ authed: value }),
  setConnection: (value) => set({ connection: value }),

  refresh: async () => {
    try {
      const workspaces = await api.workspaces();
      set({ workspaces, loading: false, error: null, lastUpdated: Date.now() });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  loadMe: async () => {
    try {
      set({ me: await api.account() });
    } catch {
      /* stays null: permissive, and the server refuses what it must */
    }
  },

  navigate: (route, opts) => {
    // Preserve the query string: an access key or share token may live there.
    const url = `${routePath(route)}${location.search}`;
    if (opts?.replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    set({ route });
  },

  adoptRoute: (route) => set({ route }),
}));

/** Selector kept beside the store so consumers do not hand-roll the lookup. */
export function findWorkspace(workspaces: Workspace[], id: string | null): Workspace | null {
  if (!id) return null;
  return workspaces.find((w) => w.id === id) ?? null;
}

/** What the current role may do, mirroring the server's canMutate / isOwner gates. */
export function useCan(): { mutate: boolean; own: boolean } {
  const role = useApp((s) => s.me?.role);
  if (!role) return { mutate: true, own: true };
  return { mutate: role === "owner" || role === "member", own: role === "owner" };
}
