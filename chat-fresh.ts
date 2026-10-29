/** Continue fresh: when to start a fresh session, what the handoff note asks for, and what the first message says. */
import type { Todo } from "./chat-text";

/** The context fullness (percent) from which the chat suggests a fresh start, and from which Kohlab does it by itself (when allowed). */
export const FRESH_BANNER_PERCENT = 70;
export const FRESH_AUTO_PERCENT = 85;

/** The one message the old session is sent. It is not shown as the person's message. */
export const HANDOFF_REQUEST =
  "Before we continue in a fresh session, write a handoff note so a new session can pick up exactly where we are. " +
  "Reply ONLY with a fenced block ```handoff containing these headings: Goal, Done, In progress, Next steps, Key decisions, Files that matter, Open questions. " +
  "Be specific and brief (under 600 words). Do not change any files.";

export const HANDOFF_CAP = 8000;

/** The handoff note in an AI's reply: the first closed ```handoff block, trimmed and cut to 8000 characters. Fences inside it (with a language) stay part of it; a block opened with four or more backticks holds plain three-backtick fences. Null when there is none. Pure. */
export function extractHandoff(reply: string): string | null {
  const lines = reply.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s{0,3}(`{3,})\s*handoff\s*$/i.exec(lines[i]);
    if (!open) continue;
    const ticks = open[1].length;
    let depth = 0;
    let closed = false;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const fence = /^\s{0,3}(`{3,})(.*)$/.exec(lines[j]);
      if (fence) {
        const n = fence[1].length;
        const info = fence[2].trim();
        if (n >= ticks && info === "" && depth === 0) {
          closed = true;
          break;
        }
        if (ticks === 3 && n === 3) {
          if (info !== "") depth++;
          else if (depth > 0) depth--;
        }
      }
      body.push(lines[j]);
    }
    const text = body.join("\n").trim();
    if (closed && text) return text.slice(0, HANDOFF_CAP);
  }
  return null;
}

const HANDOFF_HEADINGS = ["goal", "done", "in progress", "next steps", "key decisions", "files that matter", "open questions"];

/** Whether a handoff note has anything under "In progress" or "Next steps" (so the new session can be sent on at once). Pure. */
export function handoffHasWork(note: string): boolean {
  const lines = note.split("\n");
  const clean = (l: string) => l.replace(/^[\s#>*_-]+/, "").replace(/[\s*_]+$/, "");
  const empty = (t: string) => t.replace(/^[\s*_-]+/, "").trim() === "" || /^(none|n\/a|nothing|nil|-+)\.?$/i.test(t.replace(/^[\s*_-]+/, "").trim());
  let current: string | null = null;
  for (const l of lines) {
    const c = clean(l);
    const low = c.toLowerCase();
    const h = HANDOFF_HEADINGS.find((x) => low === x || low.startsWith(`${x}:`));
    if (h) {
      current = h;
      if ((h === "in progress" || h === "next steps") && low.startsWith(`${h}:`) && !empty(c.slice(h.length + 1))) return true;
      continue;
    }
    if ((current === "in progress" || current === "next steps") && !empty(c)) return true;
  }
  return false;
}

/** The first message of the fresh session: the handoff note, the project's notes and the open checklist. Pure. */
export function freshMessage(note: string, notes: string, todos: Pick<Todo, "text" | "status">[]): string {
  const open = todos.filter((t) => t.status !== "done");
  const parts = [`We are continuing in a fresh session. Here is the handoff note from the previous session:\n${note}`];
  if (notes) parts.push(`Project notes:\n${notes}`);
  if (open.length) parts.push(`Open checklist:\n${open.map((t) => `- [${t.status === "active" ? "~" : " "}] ${t.text}`).join("\n")}`);
  parts.push("Continue with the next step.");
  return parts.join("\n\n");
}

/** Whether Kohlab should continue fresh by itself now: "now", "pending" (wait for the turn or the background work to end) or "no". Pure. */
export function freshDecision(x: { percent: number | null; auto: boolean; busy: boolean; waiting: boolean; background: boolean; recent: boolean; running: boolean }): "now" | "pending" | "no" {
  if (x.running || x.recent || !x.auto || x.percent === null || x.percent < FRESH_AUTO_PERCENT) return "no";
  return x.busy || x.waiting || x.background ? "pending" : "now";
}
