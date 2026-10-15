#!/usr/bin/env bun
/**
 * Earlier versions: restoreTree, the git part of "go back to this version", on a
 * throwaway repo with three commits. No server and no workspace state.
 *
 * Run:  bun scripts/check-versions.mjs
 */
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { restoreTree } from "../versions.ts";

let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

const dir = mkdtempSync(join(tmpdir(), "kohlab-versions-"));
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const log = () => git("log", "--format=%H").split("\n").filter(Boolean);

try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "check@kohlab.test");
  git("config", "user.name", "check");

  // Commit 1: a.txt v1. Commit 2: add b.txt. Commit 3: a.txt v3.
  writeFileSync(join(dir, "a.txt"), "v1\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "b.txt"), "b\n");
  git("add", "-A");
  git("commit", "-q", "-m", "added b");
  writeFileSync(join(dir, "a.txt"), "v3\n");
  git("add", "-A");
  git("commit", "-q", "-m", "edit a");
  const original = log();

  // Unkept work: a tracked edit and a new untracked file. Going back must drop both.
  writeFileSync(join(dir, "a.txt"), "unsaved\n");
  writeFileSync(join(dir, "scratch.txt"), "new, never kept\n");

  const committed = await restoreTree(dir, first, "Went back to the version from 1 Jan, 09:00");

  check("restoring an old version reports a commit", committed === true);
  check("b.txt (added after that version) is gone", !existsSync(join(dir, "b.txt")));
  check("a.txt is back to v1", readFileSync(join(dir, "a.txt"), "utf8") === "v1\n");
  check("the unkept untracked file is removed", !existsSync(join(dir, "scratch.txt")));
  check("the tree is clean afterwards", git("status", "--porcelain") === "");

  const after = log();
  check("a fourth commit exists", after.length === 4, `got ${after.length}`);
  check("the new commit has the going-back message", git("log", "-1", "--format=%s") === "Went back to the version from 1 Jan, 09:00");
  check("the three old commits are still there, unchanged", JSON.stringify(after.slice(1)) === JSON.stringify(original));

  const head = git("rev-parse", "HEAD");
  const again = await restoreTree(dir, head, "should not be written");
  check("restoring the current version is a no-op", again === false && log().length === 4 && git("rev-parse", "HEAD") === head);
} catch (e) {
  check("the version check ran without throwing", false, e.message);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall version checks passed");
