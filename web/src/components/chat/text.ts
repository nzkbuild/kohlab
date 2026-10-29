/** Pure text helpers for the chat view: error wording, tool summaries, the Worked for line. */

/** A failed request as a sentence a person can act on. */
export function friendly(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err)).trim();
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Can't reach Kohlab. Check your connection and try again.";
  if (m === "") return "Something went wrong.";
  return /[.!?]$/.test(m) ? m : `${m}.`;
}

/** A toast or inline error: "Couldn't undo. No file checkpoint found." */
export const failed = (what: string, err: unknown) => `Couldn't ${what}. ${friendly(err)}`;

/** What the tool lines of one kind start with. describeTool in chat.ts writes the first form; the older forms are still in saved conversations. */
export const WROTE_LINE = /^(Updated your page|Created |Edited )/;
const LOOKED_LINE = /^(Looked around|Read |Searched the files)/;

/** The tool lines of one run, as one plain sentence: "looked around, updated your page and checked it". Prefixes come from describeTool in chat.ts. */
export function summarizeTools(lines: string[]): string {
  let looked = false;
  let wrote = false;
  let ran = false;
  let pages = 0;
  let helped = 0;
  let other = 0;
  for (const t of lines) {
    if (WROTE_LINE.test(t)) wrote = true;
    else if (LOOKED_LINE.test(t)) looked = true;
    else if (t.startsWith("Ran: ")) ran = true;
    else if (t.startsWith("Searched the web") || t.startsWith("Opened ")) pages++;
    else if (t.startsWith("Asked a helper")) helped++;
    else other++;
  }
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts: string[] = [];
  if (looked) parts.push("looked around");
  if (wrote) parts.push("updated your page");
  if (ran) parts.push("checked it");
  if (pages) parts.push(`looked up ${n(pages, "page", "pages")}`);
  if (helped) parts.push(`asked ${n(helped, "helper", "helpers")}`);
  if (other) parts.push(`did ${n(other, "other thing", "other things")}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Present-tense version of a describeTool line for the working line: "Updated your page" -> "Updating your page". */
export function workingLine(t: string): string {
  if (WROTE_LINE.test(t)) return "Updating your page";
  if (LOOKED_LINE.test(t)) return "Looking around";
  if (t.startsWith("Ran: ")) return "Checking it";
  if (t.startsWith("Searched the web")) return "Searching the web";
  if (t.startsWith("Opened ")) return "Opening a page";
  if (t.startsWith("Asked a helper")) return "Asking a helper";
  return "Working";
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "12s" under a minute, then "1m 05s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The quiet line under a reply: "Worked for 1m 12s", with the plan share when the server has it and it rounds to more than 0%. Null for a turn of 5 s or less. Pure. */
export function workedLine(d: { worked?: number; planDelta?: number }): string | null {
  if (d.worked === undefined || d.worked <= 5000) return null;
  return `Worked for ${formatElapsed(d.worked)}${d.planDelta !== undefined && Math.round(d.planDelta) > 0 ? ` · ${Math.round(d.planDelta)}% of your plan` : ""}`;
}
