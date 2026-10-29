#!/usr/bin/env bun
/**
 * The project brain's graph and its reply lines: the layout (deterministic, inside its box, clustered notes sit
 * closer), the shapes and node radius, the "Recalled N notes" line, and the reply rows that carry recalled titles.
 * Pure functions only; nothing is fetched and nothing is drawn.
 *
 * Run:  bun scripts/check-brain-graph.mjs
 */
import { layout, nodeRadius, recalledParts, recalledText, TYPE_SHAPE } from "../web/src/lib/brainGraph.ts";
import { replyLine, replyRows } from "../web/src/lib/aiHub.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}
function checkTrue(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${cond || !detail ? "" : `  (${detail})`}`);
}

const W = 720;
const H = 520;
const MARGIN = 24;
const ids = (n, prefix = "n") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/* ----------------------------------------------------------- layout -- */

// Two cliques of six notes with no link between them.
const clusterNodes = [...ids(6, "a"), ...ids(6, "b")];
const clusterEdges = [];
for (const prefix of ["a", "b"]) {
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) clusterEdges.push([`${prefix}${i}`, `${prefix}${j}`]);
}
const first = layout(clusterNodes, clusterEdges, W, H);
const second = layout(clusterNodes, clusterEdges, W, H);
check("same graph lays out the same way twice", [...first.entries()], [...second.entries()]);

const finite = [...first.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
checkTrue("no NaN or infinite positions", finite && first.size === clusterNodes.length);

const inBox = [...first.values()].every((p) => p.x >= MARGIN && p.x <= W - MARGIN && p.y >= MARGIN && p.y <= H - MARGIN);
checkTrue("every node inside the box with a 24px margin", inBox);

const linked = clusterEdges.map(([a, b]) => dist(first.get(a), first.get(b)));
const unlinked = [];
for (const a of clusterNodes) for (const b of clusterNodes) {
  if (a.id >= b.id) continue;
  if (clusterEdges.some(([x, y]) => (x === a.id && y === b.id) || (x === b.id && y === a.id))) continue;
  unlinked.push(dist(first.get(a.id), first.get(b.id)));
}
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
checkTrue("linked notes sit closer than unlinked ones", mean(linked) < mean(unlinked), `linked ${mean(linked).toFixed(1)}, unlinked ${mean(unlinked).toFixed(1)}`);

check("empty graph gives no positions", layout([], [], W, H).size, 0);

const one = layout([{ id: "solo" }], [], W, H);
checkTrue("one note is placed and inside the box", one.size === 1 && [...one.values()].every((p) => Number.isFinite(p.x) && p.x >= MARGIN && p.x <= W - MARGIN && p.y >= MARGIN && p.y <= H - MARGIN));

const disconnected = layout([...ids(3, "x"), ...ids(3, "y")], [["x0", "missing"], ["y1", "y1"]], W, H);
checkTrue("disconnected notes and dangling or self links are handled", disconnected.size === 6 && [...disconnected.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

// 400 notes and 600 links: the cap in the server's graph, and the budget for drawing it on a laptop.
const big = ids(400, "n");
let seed = 7;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const bigEdges = [];
while (bigEdges.length < 600) {
  const a = Math.floor(rand() * 400);
  const b = Math.floor(rand() * 400);
  if (a !== b) bigEdges.push([`n${a}`, `n${b}`]);
}
const started = performance.now();
const bigLayout = layout(big, bigEdges, W, H);
const took = performance.now() - started;
checkTrue("400 notes and 600 links lay out under 400 ms", took < 400, `took ${took.toFixed(0)} ms`);
checkTrue("400-note layout has no NaN and stays in the box", bigLayout.size === 400 && [...bigLayout.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= MARGIN && p.x <= W - MARGIN && p.y >= MARGIN && p.y <= H - MARGIN));

/* ------------------------------------------------- shapes and radius -- */

const types = ["Goal", "Decision", "Handoff", "Task", "Fact", "Version", "File"];
check("every note type has a shape", types.map((t) => typeof TYPE_SHAPE[t]), types.map(() => "string"));
check("types have different shapes", new Set(types.map((t) => TYPE_SHAPE[t])).size, types.length);
check("no degree is 5px or less at zero links", nodeRadius(0), 5);
check("radius is clamped to 12px", nodeRadius(400), 12);
checkTrue("radius grows with links", nodeRadius(4) > nodeRadius(1) && nodeRadius(1) > nodeRadius(0));
check("bad degree falls back to 5px", nodeRadius(Number.NaN), 5);

/* ------------------------------------------------- recalled line -- */

check("no titles gives an empty line", recalledText([]), "");
check("no titles gives empty parts", recalledParts([]), { head: "", shown: [] });
check("two titles", recalledText(["Goal", "Use SQLite"]), "Recalled 2 notes: Goal, Use SQLite");
check("one title is singular", recalledText(["Goal"]), "Recalled 1 note: Goal");
const long = Array.from({ length: 8 }, (_, i) => `${"Decision number ".repeat(4)}${i}`);
const longLine = recalledText(long);
checkTrue("long title lists stay within 120 characters of titles", recalledParts(long).shown.join(", ").length <= 120, `${recalledParts(long).shown.join(", ").length} chars`);
checkTrue("long lines keep the count and the first title", longLine.startsWith("Recalled 8 notes: ") && longLine.includes(long[0]));
check("more than 8 titles counts 8", recalledText(Array.from({ length: 10 }, (_, i) => `T${i}`)), "Recalled 8 notes: T0, T1, T2, T3, T4, T5, T6, T7");
check("parts join to the text", recalledParts(["Goal"]).head + recalledParts(["Goal"]).shown.join(", "), recalledText(["Goal"]));

/* --------------------------------------------------- reply rows -- */

const done = (n, extra = {}) => ({ n, at: 1_700_000_000_000 + n, kind: "done", worked: 72_000, model: "claude-sonnet-5-5", tokens: { in: 12000, out: 345 }, ...extra });
const rows = replyRows([done(1, { recalled: ["Goal", "Use SQLite"] }), done(2)], false, 20, (m) => (m === "claude-sonnet-5-5" ? "Sonnet 5.5" : m));
check("reply rows carry recalled titles", rows.map((r) => r.recalled), [[], ["Goal", "Use SQLite"]]);
check("reply without recall has an empty list", replyRows([done(3)])[0].recalled, []);
check("replyLine is unchanged by recalled titles", replyLine(rows[1]), replyLine({ ...rows[1], recalled: [] }));
check("replyLine text", replyLine(rows[1]), "Sonnet 5.5 · 1m 12s · 12.3k tokens");

console.log(failures ? `\n${failures} failed` : "\nall brain graph checks passed");
process.exit(failures ? 1 : 0);
