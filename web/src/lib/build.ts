import { API_LEVEL } from "./apiLevel";
import { hasUnsent } from "./drafts";

declare const __KOHLAB_BUILD__: string;

/** The build this bundle was made from (vite.config.ts). */
export const BUILD: string = __KOHLAB_BUILD__;

/** Fired on window when the bar should show: a newer server, or a lazy chunk that is gone. */
export const UPDATE_READY = "kohlab:update-ready";

/** The server answered with a different build (or API level) than this bundle. Only the bar; never a reload. */
export function noteServerBuild(build: string | null | undefined, apiLevel?: number): void {
  // A vite dev session (port 5173) has its own id; the server's dist never matches it.
  if (import.meta.env.DEV || !build) return;
  if (build !== BUILD || (apiLevel !== undefined && apiLevel !== API_LEVEL)) {
    window.dispatchEvent(new Event(UPDATE_READY));
  }
}

const CHUNK_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i;

/** A lazy() import whose file the rebuild deleted: the old page cannot load its own code any more. */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return CHUNK_ERROR.test(message);
}

const RELOADED_FOR_CHUNK = "kohlab.reloadedForChunk";

/**
 * One automatic reload after a failed chunk, per tab session. Never while text is unsent or an upload runs:
 * then the bar's Reload is the only way, and the person chooses it.
 */
export function reloadOnceForChunk(): void {
  if (hasUnsent()) return;
  try {
    if (sessionStorage.getItem(RELOADED_FOR_CHUNK)) return;
    sessionStorage.setItem(RELOADED_FOR_CHUNK, "1");
  } catch {
    return; // no session storage: no automatic reload, the bar still shows
  }
  location.reload();
}
