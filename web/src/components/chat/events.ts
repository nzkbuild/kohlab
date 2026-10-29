/** Pure helpers over the chat's event list: notes, tool lines, merging, row grouping. */
import { noteLine } from "../../lib/aiHub";
import { ChatEvent, ToolEvent } from "./types";

/** The text of a note: a "note" event, or an old saved tool line that says the same (from before notes existed). Null for every other event. */
export function noteOf(e: ChatEvent): string | null {
  if (e.kind === "note") return noteLine(e.text, e.until);
  if (e.kind === "tool" && (e.text.startsWith("Switched to ") || e.text.startsWith("Went back to before:"))) return e.text;
  return null;
}

/** A tool line that belongs to a run of tool lines (notes never do). */
export const isToolLine = (e: ChatEvent): e is ToolEvent => e.kind === "tool" && noteOf(e) === null;

/** Merge a fresh batch into the list by sequence number, so a repeated event never shows twice. */
export function mergeEvents(prev: ChatEvent[], next: ChatEvent[]): ChatEvent[] {
  const seen = new Set(prev.map((e) => e.n));
  const fresh = next.filter((e) => !seen.has(e.n));
  if (fresh.length === 0) return prev;
  return [...prev, ...fresh].sort((a, b) => a.n - b.n);
}

export function groupRows(events: ChatEvent[]): ChatEvent[][] {
  const rows: ChatEvent[][] = [];
  for (const e of events) {
    if (e.kind === "done" || e.kind === "plan" || e.kind === "answer" || e.kind === "result") continue;
    // A note is always a row of its own: it never joins a run of tool lines.
    const last = rows[rows.length - 1];
    if (isToolLine(e) && last && isToolLine(last[0])) last.push(e);
    else rows.push([e]);
  }
  return rows;
}
