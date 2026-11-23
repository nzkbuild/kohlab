import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "../api";
import type { ProviderCard } from "../types";

/** One shared reading of GET /api/providers for every picker, chip and the Settings pane. A reading is reused for 60 s. */
const FRESH_MS = 60_000;
/** A card the server still has as "checking" is asked for again after this, a few times at most. */
const RECHECK_MS = 1_500;
const RECHECK_MAX = 8;

interface Store {
  cards: ProviderCard[] | null;
  at: number;
  loading: boolean;
  failed: boolean;
}

let store: Store = { cards: null, at: 0, loading: false, failed: false };
let inflight: Promise<void> | null = null;
let rechecks = 0;
const listeners = new Set<() => void>();

function set(next: Partial<Store>) {
  store = { ...store, ...next };
  listeners.forEach((l) => l());
}

// The last reading, kept per key in sessionStorage: a visit shows it at once and the fresh reading replaces it in place.
// Keyed by a hash of the key so one account never sees another's cards.
const CACHE_PREFIX = "kohlab.providers:";
function cacheKey(): string {
  const k = localStorage.getItem("kohlab_key") ?? "";
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 16777619) >>> 0;
  return CACHE_PREFIX + h.toString(36);
}
function readCached(): { cards: ProviderCard[]; at: number } | null {
  try {
    const got = JSON.parse(sessionStorage.getItem(cacheKey()) ?? "null");
    return got && Array.isArray(got.cards) && typeof got.at === "number" ? got : null;
  } catch {
    return null;
  }
}
function writeCached(cards: ProviderCard[], at: number) {
  if (cards.some((c) => c.state === "checking")) return; // not a reading yet
  try {
    sessionStorage.setItem(cacheKey(), JSON.stringify({ cards, at }));
  } catch {
    /* storage off: no cache, nothing else changes */
  }
}

/** A card still "checking" keeps the last real card for its AI (marked stale) instead of blanking it. */
function keepLast(next: ProviderCard[], prev: ProviderCard[] | null): ProviderCard[] {
  if (!prev) return next;
  return next.map((c) => {
    if (c.state !== "checking") return c;
    const old = prev.find((p) => p.id === c.id && p.state !== "checking");
    return old ? { ...old, stale: true } : c;
  });
}

/** Reads the cards unless a reading under 60 s old is held (`force` skips that). One read at a time. */
export function loadProviders(force = false): Promise<void> {
  if (inflight) return inflight;
  if (store.cards === null) {
    const got = readCached();
    if (got) set({ cards: got.cards, at: got.at });
  }
  if (!force && store.cards && Date.now() - store.at < FRESH_MS) return Promise.resolve();
  set({ loading: store.cards === null, failed: false });
  inflight = api
    .providers()
    .then(
      (r) => {
        const at = Date.now();
        writeCached(r.providers, at);
        set({ cards: keepLast(r.providers, store.cards), at, loading: false, failed: false });
        if (r.providers.some((c) => c.state === "checking") && rechecks < RECHECK_MAX) {
          rechecks++;
          window.setTimeout(() => void loadProviders(true), RECHECK_MS);
        } else rechecks = 0;
      },
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
    const at = Date.now();
    writeCached(cards, at);
    set({ cards, at, loading: false, failed: false });
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
