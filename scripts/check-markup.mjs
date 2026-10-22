#!/usr/bin/env bun
/**
 * Pen marks on a picture of the page: where a pointer lands in the picture, and
 * the stroke list (start, extend, undo, clear). Pure functions only.
 *
 * Run:  bun scripts/check-markup.mjs
 */
import { clearStrokes, extendStroke, startStroke, strokeWidth, toImagePoint, undoStroke } from "../web/src/lib/markup.ts";

let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

// mapping: the picture fills the rect on screen, so screen fractions become picture pixels
const rect = { left: 100, top: 50, width: 200, height: 100 };
const image = { width: 800, height: 400 };
check("top left corner", toImagePoint({ x: 100, y: 50 }, rect, image), { x: 0, y: 0 });
check("bottom right corner", toImagePoint({ x: 300, y: 150 }, rect, image), { x: 800, y: 400 });
check("centre", toImagePoint({ x: 200, y: 100 }, rect, image), { x: 400, y: 200 });
check("a quarter in", toImagePoint({ x: 150, y: 75 }, rect, image), { x: 200, y: 100 });
check("outside to the left is pinned to the edge", toImagePoint({ x: 0, y: 100 }, rect, image), { x: 0, y: 200 });
check("outside to the bottom right is pinned", toImagePoint({ x: 999, y: 999 }, rect, image), { x: 800, y: 400 });
check("empty rect gives the origin, not NaN", toImagePoint({ x: 5, y: 5 }, { left: 0, top: 0, width: 0, height: 0 }, image), { x: 0, y: 0 });
check("a picture shown smaller than its size scales up", toImagePoint({ x: 100, y: 50 }, { left: 100, top: 50, width: 400, height: 200 }, image), { x: 0, y: 0 });

// strokes
const a = { x: 1, y: 1 };
const b = { x: 2, y: 2 };
const c = { x: 3, y: 3 };
const one = startStroke([], "ink-1", a);
check("start adds a stroke with its point", one, [{ ink: "ink-1", points: [a] }]);

const grown = extendStroke(one, b);
check("extend adds to the newest stroke", grown, [{ ink: "ink-1", points: [a, b] }]);
check("start does not change the list it was given", one, [{ ink: "ink-1", points: [a] }]);
check("extend does not change the list it was given", grown.length === 1 && one[0].points.length === 1, true);

const two = startStroke(grown, "ink-2", c);
check("a second colour is its own stroke", two.map((s) => s.ink), ["ink-1", "ink-2"]);
check("extend with no stroke changes nothing", extendStroke([], b), []);

const extendedSecond = extendStroke(two, b);
check("extend touches only the newest stroke", extendedSecond[0].points.length, 2);
check("extend keeps the colour of the newest stroke", extendedSecond[1].ink, "ink-2");

// undo removes the newest stroke only, and does nothing on an empty list
check("undo removes the newest stroke", undoStroke(two), grown);
check("undo twice empties in order", undoStroke(undoStroke(two)), []);
check("undo on nothing is nothing", undoStroke([]), []);

// clear
check("clear empties every stroke", clearStrokes(), []);

// pen width
check("small picture gets the minimum", strokeWidth({ width: 200, height: 150 }), 3);
check("a 1280 by 800 picture", strokeWidth({ width: 1280, height: 800 }), 8);
check("width follows the shorter side", strokeWidth({ width: 4000, height: 2000 }), 20);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall markup checks passed");
