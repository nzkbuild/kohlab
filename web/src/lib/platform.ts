/** Mac shows ⌘ where other platforms say Ctrl. */
export const isApple = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Touch screens get no Ctrl-key hints: the shortcuts are for a keyboard. */
export function isTouchOnly(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/**
 * Focus is "busy typing" inside a form control or a live terminal: a bare key
 * (like "?") belongs to the field there, not to the app.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  // A key event can target the document itself; nothing is "typing" then.
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return true;
  return target.closest(".terminal-wrap, .xterm") !== null;
}
