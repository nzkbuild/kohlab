/**
 * Hands a picture or a pointed-at element to the project's chat composer. With the
 * chat on screen the window event reaches it at once. Otherwise (Terminal or Files
 * tab) the item waits here, the project is asked to show its chat, and the chat
 * takes what waits as it opens: nothing is lost.
 */
const mounted = new Set<string>();
const waiting: { name: "kohlab:attach" | "kohlab:point"; detail: { id: string } }[] = [];

/** The chat of project `id` is on screen. Returns the undo for when it leaves. */
export function chatShown(id: string): () => void {
  mounted.add(id);
  return () => void mounted.delete(id);
}

export function toChat(name: "kohlab:attach" | "kohlab:point", detail: { id: string } & Record<string, unknown>) {
  if (mounted.has(detail.id)) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
    return;
  }
  waiting.push({ name, detail });
  window.dispatchEvent(new CustomEvent("kohlab:show-chat", { detail: { id: detail.id } }));
}

/** What waited for the chat of project `id`, oldest first. Emptied. */
export function takeWaiting(id: string) {
  const mine = waiting.filter((w) => w.detail.id === id);
  for (const w of mine) waiting.splice(waiting.indexOf(w), 1);
  return mine;
}
