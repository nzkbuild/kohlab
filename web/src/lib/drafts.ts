/**
 * Unsent text that survives: each screen's draft, and the prompts saved for later.
 *
 * Every call is wrapped: a browser with storage turned off or full must still
 * let the person type, so a failed read is "nothing saved" and a failed write
 * is dropped.
 */
import { useEffect, useState } from "react";

/** Draft writes wait this long after the last key. */
export const DRAFT_SAVE_MS = 300;
export const SAVED_MAX = 20;
/** A paste of this many characters or more becomes a .txt file in the composer. */
export const BIG_PASTE = 32 * 1024;

const SAVED_KEY = "kohlab.saved";
const SAVED_CHANGED = "kohlab:saved-changed";

export interface SavedPrompt {
  text: string;
  at: number;
}

/** The draft key for a chat (its workspace id) or for Home ("home"). */
export function draftKey(scope: string): string {
  return `kohlab.draft.${scope}`;
}

export function readDraft(scope: string): string {
  try {
    return localStorage.getItem(draftKey(scope)) ?? "";
  } catch {
    return "";
  }
}

/** Empty text removes the draft, so a sent message leaves nothing behind. */
export function writeDraft(scope: string, text: string): void {
  try {
    if (text === "") localStorage.removeItem(draftKey(scope));
    else localStorage.setItem(draftKey(scope), text);
  } catch {
    /* storage full or off: the draft lives only in this tab */
  }
}

export function readSaved(): SavedPrompt[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((x): x is SavedPrompt => typeof x?.text === "string" && typeof x?.at === "number")
      .slice(0, SAVED_MAX);
  } catch {
    return [];
  }
}

function writeSaved(list: SavedPrompt[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch {
    /* storage full or off: nothing is kept */
  }
  window.dispatchEvent(new Event(SAVED_CHANGED));
}

/** Puts a prompt at the top of the saved list. The oldest drops off past the limit. */
export function addSaved(text: string): void {
  writeSaved([{ text, at: Date.now() }, ...readSaved()].slice(0, SAVED_MAX));
}

/** Takes a saved prompt out of the list and returns its text (or null if there is none at that index). */
export function takeSaved(index: number): string | null {
  const list = readSaved();
  const picked = list[index];
  if (!picked) return null;
  writeSaved(list.filter((_, i) => i !== index));
  return picked.text;
}

/** The first 60 characters of a saved prompt on one line, for its menu row. */
export function savedPreview(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
}

/** The saved list, kept current while any composer on screen saves or takes one. */
export function useSaved(): SavedPrompt[] {
  const [list, setList] = useState(readSaved);
  useEffect(() => {
    const sync = () => setList(readSaved());
    window.addEventListener(SAVED_CHANGED, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SAVED_CHANGED, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return list;
}
