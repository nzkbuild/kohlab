/** Formatting helpers shared by every surface. */

/** "3m", "2h", "4d" — compact, for dense rows. */
export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** "4m 12s" — for elapsed run time. */
export function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m ${rest}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Wall-clock time for log lines and activity rows. */
export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Count added/removed lines in a unified diff. Used for the per-file +/-
 * summary in review. Returns null when the payload is not a parseable diff
 * (binary files and over-size stubs come through as prose).
 */
export function diffStats(diff: string): { added: number; removed: number } | null {
  if (!/^@@|^\+\+\+ /m.test(diff)) return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Human label for a memory cap, e.g. 512 -> "512 MB". */
export function memoryLabel(mb?: number): string | null {
  if (!mb) return null;
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

export function timeoutLabel(sec?: number): string | null {
  if (!sec) return null;
  return sec >= 3600 ? `${Math.round(sec / 3600)}h` : sec >= 60 ? `${Math.round(sec / 60)}m` : `${sec}s`;
}
