import { useEffect } from "react";

/** The sidebar is a drawer below 1024px (phones and tablets). */
const DRAWER_QUERY = "(max-width: 63.9375rem)";
/** In a browser tab the left edge belongs to the browser's back-swipe (iOS Safari); only the installed app may claim it. */
const installed = () =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** A swipe from the left screen edge opens the drawer; a leftward swipe closes it. */
const EDGE_PX = 20;
/** Horizontal travel before a gesture counts. Shorter is a tap or a wobble. */
const COMMIT_PX = 40;

/**
 * Touch only, below the desktop breakpoint; edge-open only when installed. A gesture decides once it has travelled COMMIT_PX
 * horizontally and further than it has travelled vertically, so a vertical
 * scroll never opens or closes anything.
 */
export function useDrawerSwipe(open: boolean, setOpen: (value: boolean) => void) {
  useEffect(() => {
    let start: { x: number; y: number } | null = null;

    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || !window.matchMedia(DRAWER_QUERY).matches) return;
      if (open || (e.clientX <= EDGE_PX && installed())) start = { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (Math.abs(dy) > Math.abs(dx)) {
        start = null;
        return;
      }
      if (Math.abs(dx) < COMMIT_PX) return;
      if (!open && dx > 0 && start.x <= EDGE_PX) setOpen(true);
      else if (open && dx < 0) setOpen(false);
      start = null;
    };
    const end = () => {
      start = null;
    };

    window.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, [open, setOpen]);
}
