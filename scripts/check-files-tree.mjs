#!/usr/bin/env bun
/**
 * Files view tree order: folders first, then files, each case-insensitive and
 * numeric-aware, at every level. Pure function only; nothing is read from disk.
 *
 * Run:  bun scripts/check-files-tree.mjs
 */
import { sortTree } from "../web/src/components/files/tree.ts";

let failures = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

const dir = (name, children = []) => ({ name, type: "dir", children });
const file = (name) => ({ name, type: "file" });
const names = (nodes) => nodes.map((n) => n.name);

// folders before files, even when a file sorts first
check("folders come before files", names(sortTree([file("a.ts"), dir("zeta")])), ["zeta", "a.ts"]);

// case-insensitive
check("case is ignored", names(sortTree([file("b.ts"), file("A.ts"), file("c.ts")])), ["A.ts", "b.ts", "c.ts"]);

// numeric-aware
check("numbers sort by value", names(sortTree([file("file10.ts"), file("file2.ts"), file("file1.ts")])), ["file1.ts", "file2.ts", "file10.ts"]);

// applies at every level, and nested folders stay ordered
const nested = sortTree([
  file("README.md"),
  dir("src", [file("main.ts"), dir("lib", [file("b.ts"), file("a.ts")]), file("App.tsx")]),
  dir("docs"),
]);
check(
  "every level is sorted",
  nested,
  [
    dir("docs"),
    dir("src", [dir("lib", [file("a.ts"), file("b.ts")]), file("App.tsx"), file("main.ts")]),
    file("README.md"),
  ],
);

// the input is not mutated
const input = [file("b"), file("a")];
sortTree(input);
check("input array is not mutated", names(input), ["b", "a"]);

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall files tree order checks passed");
