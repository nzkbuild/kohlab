#!/usr/bin/env bun
/**
 * Web preview paths: the rules that keep /p/<token>/<path> inside the worktree.
 * The disk check runs against a throwaway tree with a symlink that escapes it.
 *
 * Run:  bun scripts/check-preview.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewRelPath, resolvePreviewFile } from "../preview.ts";

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)})`}`);
}

for (const bad of ["../x", ".git/config", ".env", "%2e%2e/x", "css/../../x", "a//b", "%2fetc", "%ZZ"]) {
  check(`refuses ${bad}`, previewRelPath(bad), null);
}
check("accepts index.html", previewRelPath("index.html"), "index.html");
check("accepts css/a.css", previewRelPath("css/a.css"), "css/a.css");
check('empty path is index.html', previewRelPath(""), "index.html");
check("trailing slash is index.html", previewRelPath("docs/"), "docs/index.html");

// disk: a real file, a symlink out of the tree, and a symlink into .git
const root = mkdtempSync(join(tmpdir(), "kohlab-prev-"));
try {
  const tree = join(root, "tree");
  mkdirSync(join(tree, "css"), { recursive: true });
  mkdirSync(join(tree, ".git"));
  writeFileSync(join(tree, "index.html"), "<p>hi</p>");
  writeFileSync(join(tree, "css/a.css"), "p{}");
  writeFileSync(join(tree, ".git/config"), "secret");
  writeFileSync(join(root, "outside.txt"), "outside");
  symlinkSync(join(root, "outside.txt"), join(tree, "out.txt"));
  symlinkSync(join(tree, ".git/config"), join(tree, "gitlink.txt"));
  check("disk: index.html resolves", (await resolvePreviewFile(tree, "")) === join(tree, "index.html"), true);
  check("disk: css resolves", (await resolvePreviewFile(tree, "css/a.css")) === join(tree, "css/a.css"), true);
  check("disk: symlink out of tree refused", await resolvePreviewFile(tree, "out.txt"), null);
  check("disk: symlink into .git refused", await resolvePreviewFile(tree, "gitlink.txt"), null);
  check("disk: missing file refused", await resolvePreviewFile(tree, "nope.html"), null);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall preview path checks passed");
