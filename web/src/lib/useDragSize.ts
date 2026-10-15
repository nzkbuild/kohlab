import { useEffect, useRef, useState, type HTMLAttributes, type KeyboardEvent, type PointerEvent } from "react";

/** One arrow-key press moves the edge this far. */
const STEP = 24;

// localStorage can throw (private mode, storage disabled): the size then lives for this page only.
function readSize(key: string, initial: number): number {
  try {
    const saved = Number(localStorage.getItem(key));
    return saved > 0 ? saved : initial;
  } catch {
    return initial;
  }
}

function writeSize(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* not persisted */
  }
}

/**
 * A size in px that the person drags from one edge. `edge` is the side the handle sits on:
 * "left" for a pane on the right, "top" for a panel at the bottom. Spread `handleProps` on the handle.
 */
export function useDragSize(key: string, initial: number, min: number, max: () => number, edge: "left" | "top") {
  const [stored, setStored] = useState(() => readSize(key, initial));
  const clamp = (n: number) => Math.min(Math.max(n, min), Math.max(min, max()));
  const size = clamp(stored);
  const [, relayout] = useState(0);
  const drag = useRef<{ pointer: number; origin: number; start: number; latest: number } | null>(null);

  // A smaller window re-clamps the stored size at render; an unmount mid-drag must not leave the body locked.
  useEffect(() => {
    const onResize = () => relayout((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (drag.current) {
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, []);

  const pos = (e: PointerEvent<HTMLDivElement>) => (edge === "left" ? e.clientX : e.clientY);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, origin: pos(e), start: size, latest: size };
    // Keep the canvas and the terminal from taking the drag while it runs.
    document.body.style.cursor = edge === "left" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    // Dragging toward the page's middle (left, or up) makes the pane or panel bigger.
    const delta = edge === "left" ? d.origin - e.clientX : d.origin - e.clientY;
    d.latest = clamp(d.start + delta);
    setStored(d.latest);
  };

  const onPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    drag.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    writeSize(key, d.latest);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = edge === "left" ? "ArrowLeft" : "ArrowUp";
    const shrink = edge === "left" ? "ArrowRight" : "ArrowDown";
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    const next = clamp(size + (e.key === grow ? STEP : -STEP));
    setStored(next);
    writeSize(key, next);
  };

  const onDoubleClick = () => {
    setStored(initial);
    writeSize(key, initial);
  };

  const handleProps: HTMLAttributes<HTMLDivElement> = {
    role: "separator",
    "aria-orientation": edge === "left" ? "vertical" : "horizontal",
    "aria-valuenow": size,
    "aria-valuemin": min,
    "aria-valuemax": Math.max(min, max()),
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onKeyDown,
    onDoubleClick,
  };

  return { size, handleProps };
}
