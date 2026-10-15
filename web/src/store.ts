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
  prefs?: { powerTools?: boolean };
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
  /** Files tab and status bar. Off until someone opens a terminal or asks for files. */
  powerTools: boolean;
  setPowerTools: (value: boolean) => void;
  /** A command-palette action for the open project, taken by WorkspaceDetail. */
  panelRequest: PanelRequest | null;
  requestPanel: (request: PanelRequest | null) => void;
  /** The New project sheet. Opens over whatever page is showing, so the page under it stays put. */
  newOpen: boolean;
  /** Phone and tablet drawer. Lives here so any page header can open it. */
  navOpen: boolean;
  /** The command palette (⌘K or the sidebar search button). */
  paletteOpen: boolean;
  setPaletteOpen: (value: boolean) => void;

  setNavOpen: (value: boolean) => void;
  setNewOpen: (value: boolean) => void;
  setAuthed: (value: boolean) => void;
  setConnection: (value: Connection) => void;
  refresh: () => Promise<void>;
  loadMe: () => Promise<void>;
  /** Push a new route onto history, or replace the current entry. */
  navigate: (route: Route, opts?: { replace?: boolean }) => void;
  /** Adopt the current URL without touching history (Back/Forward). */
  adoptRoute: (route: Route) => void;
  /** Position of this entry in the app's own history (0 = first entry the app saw). */
  navIndex: number;
  /** Highest position reached in this session: forward is possible below it. */
  navMax: number;
}

export type PanelAction = "terminal" | "continue" | "files" | "changes" | "preview";
export interface PanelRequest {
  workspaceId: string;
  action: PanelAction;
}

// Set once the user changes the setting this page load, so a slow account load cannot undo it.
let touchedPowerTools = false;

const POWER_KEY = "kohlab.powerTools";

// The account's copy is the truth (see loadMe). This local copy only paints the first frame right.
// localStorage can throw (private mode, storage disabled): the cache is then just missing.
function readPowerTools(): boolean {
  try {
    return localStorage.getItem(POWER_KEY) === "1";
  } catch {
    return false;
  }
}

function writePowerTools(value: boolean) {
  try {
    localStorage.setItem(POWER_KEY, value ? "1" : "0");
  } catch {
    /* not cached */
  }
}

/** Each in-app entry carries its position in history.state, which survives a reload. An entry without one (the page the app loaded on) is position 0. */
function historyIndex(): number {
  const i = (history.state as { i?: unknown } | null)?.i;
  return typeof i === "number" ? i : 0;
}

export const useApp = create<AppState>((set, get) => ({
  authed: false,
  route: parseRoute(location.pathname),
  navIndex: historyIndex(),
  navMax: historyIndex(),
  workspaces: [],
  loading: true,
  error: null,
  lastUpdated: null,
  connection: "connecting",
  me: null,
  powerTools: readPowerTools(),
  setPowerTools: (value) => {
    if (get().powerTools === value) return;
    touchedPowerTools = true;
    writePowerTools(value);
    set({ powerTools: value });
    void api.savePrefs({ powerTools: value }).catch(() => {});
  },
  panelRequest: null,
  requestPanel: (request) => set({ panelRequest: request }),
  newOpen: false,
  navOpen: false,
  paletteOpen: false,
  setPaletteOpen: (value) => set({ paletteOpen: value }),

  setNavOpen: (value) => set({ navOpen: value }),
  setNewOpen: (value) => set({ newOpen: value }),
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
      const me = await api.account();
      set({ me });
      const saved = me.prefs?.powerTools;
      if (touchedPowerTools) {
        /* the user clicked while this was loading: their choice wins and was already saved */
      } else if (typeof saved === "boolean") {
        writePowerTools(saved);
        set({ powerTools: saved });
      } else if (readPowerTools()) {
        // Turned on before accounts saved it: move that choice up once.
        void api.savePrefs({ powerTools: true }).catch(() => {});
      }
    } catch {
      /* stays null: permissive, and the server refuses what it must */
    }
  },

  navigate: (route, opts) => {
    // Preserve the query string: an access key or share token may live there.
    const url = `${routePath(route)}${location.search}`;
    if (opts?.replace) {
      const navIndex = get().navIndex;
      history.replaceState({ i: navIndex }, "", url);
      set({ route });
      return;
    }
    // A push discards any forward entries, so the new position is also the maximum.
    const navIndex = get().navIndex + 1;
    history.pushState({ i: navIndex }, "", url);
    set({ route, navIndex, navMax: navIndex });
  },

  adoptRoute: (route) => {
    const navIndex = historyIndex();
    set((s) => ({ route, navIndex, navMax: Math.max(s.navMax, navIndex) }));
  },
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
