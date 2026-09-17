import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";

/**
 * xterm instances live outside React and outside their pane: remounting the
 * cockpit (tab switch, route change) re-attaches to the same buffer, so the
 * scrollback survives.
 *
 * This module is deliberately xterm-free at runtime — the imports above are
 * types and are erased — so the delete path can dispose cached buffers without
 * dragging the ~390 KB terminal bundle into the eager chunk that
 * `lazy(() => import("./TerminalView"))` keeps it out of.
 */
export interface CachedTerminal {
  term: Terminal;
  fit: FitAddon;
}

const MAX_CACHED_TERMINALS = 32;

/** Keyed `<workspaceId>:<terminalId>`. */
export const termCache = new Map<string, CachedTerminal>();

export function cacheTerminal(key: string, entry: CachedTerminal) {
  termCache.set(key, entry);
  // bound the cache: evict the oldest (Map iterates in insertion order)
  if (termCache.size <= MAX_CACHED_TERMINALS) return;
  const oldest = termCache.keys().next().value;
  if (oldest === undefined) return;
  termCache.get(oldest)?.term.dispose();
  termCache.delete(oldest);
}

/** Dispose + drop cached terminals for a workspace (call on workspace delete). */
export function disposeWorkspaceTerminals(workspaceId: string) {
  for (const [key, { term }] of termCache) {
    if (!key.startsWith(`${workspaceId}:`)) continue;
    term.dispose();
    termCache.delete(key);
  }
}
