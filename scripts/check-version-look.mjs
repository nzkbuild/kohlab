#!/usr/bin/env bun
// S4 (Bun 1.x): Bun.file("x.css").type is "text/css;charset=utf-8" for a path that does not exist, so the version view can take its MIME type from the name alone.
// S4: the same holds for .html, .js, .mjs, .json, .png, .svg, .woff2 and .wasm; no file has to be on disk.
/**
 * Earlier versions, as files: a version's page comes from git (cat-file blob), only
 * for regular files, and never through a symlink, a dotfile or a path that climbs out.
 *
 * Run: bun scripts/check-version-look.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionFile } from "../preview.ts";

const dir = mkdtempSync(join(tmpdir(), "kohlab-version-look-"));
const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
}

try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "check@kohlab.test");
  git("config", "user.name", "check");
  writeFileSync(join(dir, "index.html"), "old page");
  mkdirSync(join(dir, "a"));
  writeFileSync(join(dir, "a", "index.html"), "a old");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  symlinkSync("/etc/passwd", join(dir, "evil"));
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  const old = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "index.html"), "new page");
  git("add", "-A");
  git("commit", "-q", "-m", "second");
  const now = git("rev-parse", "HEAD");

  const text = async (sha, rest) => {
    const got = await versionFile(dir, sha, rest);
    return got && got !== "redirect" ? got.bytes.toString("utf8") : got;
  };

  check("old version: the root page as it was", (await text(old, "")) === "old page");
  check("latest version: the root page as it is now", (await text(now, "")) === "new page");
  check("a directory without a slash asks for one", (await versionFile(dir, old, "a")) === "redirect");
  check("a directory with a slash: its index", (await text(old, "a/")) === "a old");
  check("a symlink is refused", (await versionFile(dir, old, "evil")) === null);
  check("a dotfile is refused", (await versionFile(dir, old, ".env")) === null);
  check("a path that climbs out is refused", (await versionFile(dir, old, "../etc/passwd")) === null);
  check("an encoded climb is refused", (await versionFile(dir, old, "%2e%2e/etc/passwd")) === null);
  check("a missing file is refused", (await versionFile(dir, old, "nope.html")) === null);
  check("an unknown commit is refused", (await versionFile(dir, "0".repeat(40), "")) === null);

  for (const [name, type] of [["x.css", "text/css"], ["a.js", "text/javascript"], ["y.json", "application/json"], ["z.png", "image/png"]]) {
    check(`MIME from the name alone: ${name}`, Bun.file(name).type.startsWith(type), Bun.file(name).type);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall version look checks passed");
