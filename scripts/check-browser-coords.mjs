#!/usr/bin/env bun
/**
 * Shared browser coordinates: a click on the canvas maps to the right device pixel
 * of the remote page, letterboxed, and a click in the margin is not sent.
 *
 * Run:  bun scripts/check-browser-coords.mjs
 */
import { toDevicePoint } from "../web/src/lib/browserCoords.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

const device = { width: 800, height: 600 };

// Wide panel: 1000x400 box, the 4:3 page is letterboxed left and right (533.3 px wide, 233.3 px margin each side).
const wide = { left: 0, top: 0, width: 1000, height: 400 };
check("wide: centre maps to device centre", toDevicePoint(500, 200, wide, device), { x: 400, y: 300 });
check("wide: left letterbox margin is null", toDevicePoint(100, 200, wide, device), null);
check("wide: right letterbox margin is null", toDevicePoint(800, 200, wide, device), null);
check("wide: clamp pins a margin point to the edge", toDevicePoint(0, 0, wide, device, true), { x: 0, y: 0 });

// Tall panel: 300x600 box, the page is letterboxed top and bottom (225 px tall, 187.5 px margin each).
const tall = { left: 0, top: 0, width: 300, height: 600 };
check("tall: centre maps to device centre", toDevicePoint(150, 300, tall, device), { x: 400, y: 300 });
check("tall: top letterbox margin is null", toDevicePoint(150, 100, tall, device), null);

// Offset box: the canvas does not sit at the page origin.
const offset = { left: 50, top: 10, width: 1000, height: 400 };
check("offset box: centre maps to device centre", toDevicePoint(550, 210, offset, device), { x: 400, y: 300 });

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall browser coordinate checks passed");
