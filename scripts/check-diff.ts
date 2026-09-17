#!/usr/bin/env bun
/**
 * Run:  bun scripts/check-diff.ts
 *
 * The review surface is the product's headline feature and its diff splitter is
 * pure logic, so it gets a check. No framework: assertions and a non-zero exit.
 */
import { splitUnifiedDiff, languageForFile } from "../web/src/lib/diff.ts";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

console.log("\nkohlab diff splitter\n");

// --- a modified tracked file (the common case) -------------------------------
const modified = [
  "diff --git a/a.txt b/a.txt",
  "index 1234567..89abcde 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,3 +1,3 @@",
  " line1",
  "-old",
  "+new",
  " line3",
  "",
].join("\n");

const m = splitUnifiedDiff(modified);
check("modified: original keeps the removed line", m.original === "line1\nold\nline3", JSON.stringify(m.original));
check("modified: modified has the added line", m.modified === "line1\nnew\nline3", JSON.stringify(m.modified));
check("modified: the two sides actually differ", m.original !== m.modified);
check("modified: no patch metadata leaks in", !m.modified.includes("@@") && !m.modified.includes("diff --git"));
check("modified: no +/- markers leak in", !/^[+-]/m.test(m.modified));

// --- a brand-new untracked file ---------------------------------------------
const added = [
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "index 0000000..abc1234",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,2 @@",
  "+export const x = 1;",
  "+export const y = 2;",
  "",
].join("\n");

const a = splitUnifiedDiff(added);
check("new file: original is empty", a.original === "", JSON.stringify(a.original));
check("new file: modified is the file body", a.modified === "export const x = 1;\nexport const y = 2;", JSON.stringify(a.modified));

// --- a deleted file ----------------------------------------------------------
const deleted = ["--- a/gone.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-bye", "-gone", ""].join("\n");
const d = splitUnifiedDiff(deleted);
check("deleted: original is the body", d.original === "bye\ngone", JSON.stringify(d.original));
check("deleted: modified is empty", d.modified === "", JSON.stringify(d.modified));

// --- multiple hunks stay line-aligned ---------------------------------------
const twoHunks = [
  "diff --git a/b.txt b/b.txt",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -1,2 +1,2 @@",
  " keep1",
  "-old1",
  "+new1",
  "@@ -10,2 +10,2 @@",
  " keep2",
  "-old2",
  "+new2",
  "",
].join("\n");

const t = splitUnifiedDiff(twoHunks);
check("two hunks: original", t.original === "keep1\nold1\nkeep2\nold2", JSON.stringify(t.original));
check("two hunks: modified", t.modified === "keep1\nnew1\nkeep2\nnew2", JSON.stringify(t.modified));
check(
  "two hunks: line counts stay equal (so the diff aligns)",
  t.original.split("\n").length === t.modified.split("\n").length,
);

// --- "\ No newline at end of file" ------------------------------------------
const noNewline = ["--- a/c.txt", "+++ b/c.txt", "@@ -1 +1 @@", "-last", "+last", "\\ No newline at end of file", ""].join("\n");
const n = splitUnifiedDiff(noNewline);
check("no-newline marker is dropped", !n.modified.includes("\\") && !n.original.includes("\\"), JSON.stringify(n));

// --- payloads that are not a diff at all ------------------------------------
check("binary prose yields empty sides", splitUnifiedDiff("Binary files /dev/null and b/x differ").original === "");
check("oversize stub yields empty sides", splitUnifiedDiff("new file — 4194304 bytes, too large to preview").modified === "");
check("empty input is safe", splitUnifiedDiff("").original === "" && splitUnifiedDiff("").modified === "");

// --- language mapping --------------------------------------------------------
check("languageForFile tsx", languageForFile("src/App.tsx") === "typescript");
check("languageForFile nested deps", languageForFile("a/b/c.py") === "python");
check("languageForFile Dockerfile", languageForFile("deploy/Dockerfile") === "dockerfile");
check("languageForFile unknown", languageForFile("LICENSE") === "plaintext");
check("languageForFile dotfile", languageForFile(".gitignore") === "plaintext");
check("languageForFile yaml", languageForFile("k8s/deploy.yaml") === "yaml");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  // Throwing exits non-zero without depending on the `process` global, which
  // this file has no type definitions for.
  throw new Error(`diff splitter regressed: ${failures.join("; ")}`);
}
console.log("diff splitter intact\n");
