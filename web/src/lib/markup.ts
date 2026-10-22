/**
 * Pen marks on a picture of the page ("Add picture"). Pure maths: strokes are kept
 * in image pixels, so the picture is saved at its full size whatever the screen
 * shows. scripts/check-markup.mjs tests this file.
 */

/** The two pen colours. Their values are CSS tokens, read by the dialog. */
export type Ink = "ink-1" | "ink-2";

export interface Pt {
  x: number;
  y: number;
}

export interface Stroke {
  ink: Ink;
  points: Pt[];
}

export interface Size {
  width: number;
  height: number;
}

/** A box on the screen, in the same units as the pointer positions. */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A new stroke with its first point. The list passed in is not changed. */
export function startStroke(strokes: readonly Stroke[], ink: Ink, p: Pt): Stroke[] {
  return [...strokes, { ink, points: [p] }];
}

/** Adds a point to the stroke being drawn, the last one. Nothing changes when there is no stroke. */
export function extendStroke(strokes: readonly Stroke[], p: Pt): Stroke[] {
  const last = strokes[strokes.length - 1];
  if (!last) return [...strokes];
  return [...strokes.slice(0, -1), { ink: last.ink, points: [...last.points, p] }];
}

/** Removes the newest stroke only. */
export function undoStroke(strokes: readonly Stroke[]): Stroke[] {
  return strokes.slice(0, -1);
}

/** Removes every stroke. */
export function clearStrokes(): Stroke[] {
  return [];
}

/**
 * A pointer position (client pixels) as a point in the picture's own pixels. The
 * picture fills `rect` on screen; a point outside it is pinned to the nearest edge.
 */
export function toImagePoint(client: Pt, rect: Rect, image: Size): Pt {
  const fx = rect.width > 0 ? (client.x - rect.left) / rect.width : 0;
  const fy = rect.height > 0 ? (client.y - rect.top) / rect.height : 0;
  return {
    x: Math.min(Math.max(fx, 0), 1) * image.width,
    y: Math.min(Math.max(fy, 0), 1) * image.height,
  };
}

/** The pen's width in picture pixels: a fixed share of the picture's shorter side, never thinner than 3. */
export function strokeWidth(image: Size): number {
  return Math.max(3, Math.round(Math.min(image.width, image.height) / 100));
}
