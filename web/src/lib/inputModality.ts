/**
 * Which input the user used last. A menu that closes can then tell a pointer
 * close (focus returns silently) from a keyboard close (focus returns with the
 * ring). Listeners are module-level: installed once, on first import.
 */
let lastPointer = false;

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => (lastPointer = true), { capture: true, passive: true });
  window.addEventListener("keydown", () => (lastPointer = false), { capture: true });
}

/**
 * Radix onCloseAutoFocus helper. After a pointer close, return focus to the
 * trigger without the focus-visible ring. Keyboard closes are left to Radix, so
 * the ring still shows (WCAG 2.4.7).
 */
export function restoreFocusAfterClose(e: Event, trigger: HTMLElement | null | undefined) {
  if (!lastPointer || !trigger) return;
  e.preventDefault();
  // Chromium and Firefox honour focusVisible: false. Elsewhere the trigger still gets focus, and after a pointer the UA does not draw the ring.
  trigger.focus({ focusVisible: false } as FocusOptions);
}
