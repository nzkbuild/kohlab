/**
 * One coalesced announcement channel.
 *
 * A live terminal or log tail must never be an aria-live region — screen
 * readers would read every line. Instead the app emits discrete *state
 * transitions* here ("ws-3 finished — needs review") and a single permanently
 * present role="status" region renders the latest one.
 *
 * Announcements coalesce: bursts within COALESCE_MS collapse to the last
 * message, so a workspace flapping between states cannot flood the reader.
 */
const COALESCE_MS = 900;

type AnnouncementListener = (message: string) => void;

const listeners = new Set<AnnouncementListener>();
let paused = false;
let pending: string | null = null;
let timer: number | undefined;

export function subscribeAnnouncements(listener: AnnouncementListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function announce(message: string): void {
  if (paused) return;
  pending = message;
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const queued = pending;
    pending = null;
    timer = undefined;
    if (!queued) return;
    for (const listener of listeners) listener(queued);
  }, COALESCE_MS);
}

export function setAnnouncementsPaused(value: boolean): void {
  paused = value;
  if (!value) return;
  clearTimeout(timer);
  timer = undefined;
  pending = null;
}
