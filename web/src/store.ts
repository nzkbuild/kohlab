import { create } from "zustand";
import { api } from "./api";
import type { Workspace } from "./types";

interface AppState {
  authed: boolean;
  workspaces: Workspace[];
  selectedId: string | null;
  view: "workspaces" | "dashboard" | "settings";
  loading: boolean;
  error: string | null;

  setAuthed: (v: boolean) => void;
  refresh: () => Promise<void>;
  select: (id: string | null) => void;
  setView: (v: AppState["view"]) => void;
}
export const useApp = create<AppState>((set) => ({
  authed: false,
  workspaces: [],
  selectedId: null,
  view: "workspaces",
  loading: false,
  error: null,

  setAuthed: (v) => set({ authed: v }),

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const workspaces = await api.workspaces();
      set({ workspaces, loading: false });
    } catch (e) {
      set({ error: (e as Error).message, loading: false });
    }
  },

  select: (id) => set({ selectedId: id }),
  setView: (v) => set({ view: v, selectedId: null }),
}));

export const selectedWorkspace = (s: AppState): Workspace | null =>
  s.workspaces.find((w) => w.id === s.selectedId) ?? null;
