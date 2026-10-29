/**
 * The project brain's graph, as pure functions: a deterministic layout, which shape each note type draws as,
 * the radius of a node, and the "Recalled 2 notes: …" line under a reply. Nothing here touches the DOM.
 */
import type { NoteType } from "../types";

/** Keeps nodes off the edge of the box. */
const MARGIN = 24;
/** Closest two nodes are treated as this far apart when forces are computed, so a force never blows up. */
const MIN_DIST = 1;

/**
 * Fruchterman-Reingold style layout. Starts on a circle (by index, so the same graph always lands the same way),
 * then `iterations` steps of repulsion between every pair, spring pull along edges and a gentle pull to the centre,
 * with a linear cooling so the last steps move little. Positions are clamped to the box with a 24px margin.
 * Edges to unknown ids and self-links are ignored.
 */
// ponytail: O(n²) per iteration, fine at 400 notes; a grid or Barnes-Hut pass is the upgrade if the cap ever grows.
export function layout(nodes: { id: string }[], edges: [string, string][], w: number, h: number, iterations = 150): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const n = nodes.length;
  if (n === 0) return out;

  const W = Number.isFinite(w) && w > 0 ? w : 1;
  const H = Number.isFinite(h) && h > 0 ? h : 1;
  const cx = W / 2;
  const cy = H / 2;
  const span = Math.min(W, H);
  const clamp = (v: number, size: number) => (size <= 2 * MARGIN ? size / 2 : Math.min(size - MARGIN, Math.max(MARGIN, v)));

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    x[i] = cx + Math.cos(a) * span * 0.35;
    y[i] = cy + Math.sin(a) * span * 0.35;
  }

  const index = new Map<string, number>();
  nodes.forEach((node, i) => index.set(node.id, i));
  const links: [number, number][] = [];
  for (const [a, b] of edges) {
    const i = index.get(a);
    const j = index.get(b);
    if (i !== undefined && j !== undefined && i !== j) links.push([i, j]);
  }

  // Ideal spacing between neighbours for an even spread of n nodes in the box.
  const k = Math.sqrt((W * H) / n);
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const temp = (span / 10) * (1 - it / iterations);
    dx.fill(0);
    dy.fill(0);

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ddx = x[i] - x[j];
        let ddy = y[i] - y[j];
        // Coincident nodes get a fixed direction so they still part, the same way every run.
        if (ddx === 0 && ddy === 0) ddx = 1;
        const d = Math.max(Math.sqrt(ddx * ddx + ddy * ddy), MIN_DIST);
        const f = (k * k) / d;
        const ux = ddx / d;
        const uy = ddy / d;
        dx[i] += ux * f;
        dy[i] += uy * f;
        dx[j] -= ux * f;
        dy[j] -= uy * f;
      }
    }

    for (const [i, j] of links) {
      const ddx = x[i] - x[j];
      const ddy = y[i] - y[j];
      const d = Math.max(Math.sqrt(ddx * ddx + ddy * ddy), MIN_DIST);
      const f = (d * d) / k;
      const ux = ddx / d;
      const uy = ddy / d;
      dx[i] -= ux * f;
      dy[i] -= uy * f;
      dx[j] += ux * f;
      dy[j] += uy * f;
    }

    for (let i = 0; i < n; i++) {
      dx[i] += (cx - x[i]) * 0.1;
      dy[i] += (cy - y[i]) * 0.1;
      const mag = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]);
      if (mag > 0) {
        const step = Math.min(mag, temp);
        x[i] += (dx[i] / mag) * step;
        y[i] += (dy[i] / mag) * step;
      }
      x[i] = clamp(x[i], W);
      y[i] = clamp(y[i], H);
    }
  }

  nodes.forEach((node, i) => out.set(node.id, { x: x[i], y: y[i] }));
  return out;
}

/** The shape each note type draws as. Types differ by shape and by their text label, never by hue alone. */
export type NodeShape = "circle" | "square" | "diamond" | "triangle" | "hexagon" | "ring" | "pill";
export const TYPE_SHAPE: Record<NoteType, NodeShape> = {
  Goal: "hexagon",
  Decision: "circle",
  Task: "diamond",
  Fact: "square",
  Handoff: "triangle",
  Version: "ring",
  File: "pill",
};

/** A node's radius from how many links it has: 5px for none, 12px at most. */
export function nodeRadius(degree: number): number {
  const d = Number.isFinite(degree) && degree > 0 ? degree : 0;
  return Math.min(12, Math.max(5, 5 + 1.5 * Math.sqrt(d)));
}

/**
 * A reply's recalled line, in two parts for the Run panel: the head ("Recalled 2 notes: ") and the titles it shows.
 * The count covers at most 8 titles. Titles are added while the list fits in 120 characters, and a title is never cut.
 * Empty for no titles.
 */
export function recalledParts(titles: string[]): { head: string; shown: string[] } {
  const count = Math.min(titles.length, 8);
  if (count === 0) return { head: "", shown: [] };
  const shown: string[] = [];
  let len = 0;
  for (const t of titles.slice(0, 8)) {
    const add = (shown.length > 0 ? 2 : 0) + [...t].length;
    if (shown.length > 0 && len + add > 120) break;
    shown.push(t);
    len += add;
  }
  return { head: `Recalled ${count} ${count === 1 ? "note" : "notes"}: `, shown };
}

/** "Recalled 2 notes: Goal, Use SQLite" for a reply. Empty for no titles. */
export function recalledText(titles: string[]): string {
  const { head, shown } = recalledParts(titles);
  return head + shown.join(", ");
}
