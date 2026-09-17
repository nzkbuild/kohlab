import { create } from "zustand";
import { api } from "./api";
import type { Workspace } from "./types";
import { parseRoute, routePath, type Route } from "./lib/route";

/** Explicit socket state — never inferred from navigator.onLine. */
export type Connection = "connecting" | "live" | "reconnecting" | "offline";

export interface AppState {
  authed: boolean;
  route: Route;
  workspaces: Workspace[];
  /** True only for the very first load, when a skeleton is warranted. */
  loading: boolean;
  error: string | null;
  lastUpdated: number | null;
  connection: Connection;

  setAuthed: (value: boolean) => void;
  setConnection: (value: Connection) => void;
  refresh: () => Promise<void>;
  /** Push a new route onto history. */
  navigate: (route: Route) => void;
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

  navigate: (route) => {
    // Preserve the query string: an access key or share token may live there.
    history.pushState(null, "", `${routePath(route)}${location.search}`);
    set({ route });
  },

  adoptRoute: (route) => set({ route }),
}));

/** Selector kept beside the store so consumers do not hand-roll the lookup. */
export function findWorkspace(workspaces: Workspace[], id: string | null): Workspace | null {
  if (!id) return null;
  return workspaces.find((w) => w.id === id) ?? null;
}
