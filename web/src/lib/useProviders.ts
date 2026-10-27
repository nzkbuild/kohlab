import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import type { ProviderCard } from "../types";

/** One shared reading of GET /api/providers for every picker, chip and the Settings pane. A reading is reused for 60 s. */
const FRESH_MS = 60_000;

interface Store {
  cards: ProviderCard[] | null;
  at: number;
  loading: boolean;
  failed: boolean;
}

let store: Store = { cards: null, at: 0, loading: false, failed: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<Store>) {
  store = { ...store, ...next };
  listeners.forEach((l) => l());
}

/** Reads the cards unless a reading under 60 s old is held (`force` skips that). One read at a time. */
export function loadProviders(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && store.cards && Date.now() - store.at < FRESH_MS) return Promise.resolve();
  set({ loading: store.cards === null, failed: false });
  inflight = api
    .providers()
    .then(
      (r) => set({ cards: r.providers, at: Date.now(), loading: false, failed: false }),
      () => set({ loading: false, failed: true }),
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Owner only: read the AIs again now. One AI when `id` is given. Resolves to false when the server refused or could not be reached. */
export async function refreshProviders(id?: string): Promise<boolean> {
  try {
    const r = await api.refreshProviders(id);
    // An answer for one AI replaces only that card.
    const cards = id && store.cards ? store.cards.map((c) => r.providers.find((p) => p.id === c.id) ?? c) : r.providers;
    set({ cards, at: Date.now(), loading: false, failed: false });
    return true;
  } catch {
    return false;
  }
}

/** For tests and sign-out: forget what was read. */
export function resetProviders() {
  store = { cards: null, at: 0, loading: false, failed: false };
  inflight = null;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const snapshot = () => store;

/** The AI cards: `cards` is null until the first answer. `reload` reads again whatever the age; `refresh` (owner) makes the server look again. */
export function useProviders() {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void loadProviders();
  }, []);
  const reload = useCallback(() => loadProviders(true), []);
  return { cards: s.cards, loading: s.loading, failed: s.failed && s.cards === null, at: s.at, reload, refresh: refreshProviders };
}

/** The reason an AI cannot be used yet, or undefined. Keep the wording: it is shown in menus. */
export const SIGN_IN_FIRST = "Sign in first in Settings";

export function reasonFor(card: ProviderCard | undefined): string | undefined {
  if (!card) return undefined;
  return card.state === "signed_out" || card.state === "error" || card.state === "not_installed" ? SIGN_IN_FIRST : undefined;
}
