#!/usr/bin/env node
// Delete web/dist/assets files older than N days (default 14) that the CURRENT build no longer reaches.
// Reachable = named in index.html, or in a reachable asset (lazy chunks and unchanged vendor chunks keep an old
// mtime but are still loaded). Regular files only (symlinks are never followed or removed), assets/ only.
//   node scripts/prune-assets.mjs <web/dist> [days]
import { lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2];
const days = Number(process.argv[3] ?? 14);
if (!dist || !Number.isFinite(days)) {
  console.error("usage: prune-assets.mjs <web/dist> [days]");
  process.exit(2);
}
const dir = join(dist, "assets");
let names;
try {
  names = readdirSync(dir);
} catch {
  process.exit(0); // no assets dir: nothing to prune
}
const files = new Set(names.filter((n) => lstatSync(join(dir, n)).isFile()));
const reached = new Set();
const visit = (text) => {
  for (const n of files) if (!reached.has(n) && text.includes(n)) { reached.add(n); visit(readFileSync(join(dir, n), "latin1")); }
};
visit(readFileSync(join(dist, "index.html"), "latin1")); // no index.html throws: nothing is deleted
const cutoff = Date.now() - days * 86400_000;
let removed = 0;
for (const n of files) {
  if (reached.has(n) || lstatSync(join(dir, n)).mtimeMs > cutoff) continue;
  unlinkSync(join(dir, n));
  removed++;
}
console.log(`pruned ${removed} unreferenced asset(s) older than ${days} days`);
