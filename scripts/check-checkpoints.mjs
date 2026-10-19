#!/usr/bin/env bun
/**
 * Turn checkpoints (checkpoints.ts): the snapshot before each message, what a
 * message changed, and going back. On a throwaway repo; no server, no workspace.
 *
 * Run:  bun scripts/check-checkpoints.mjs
 */
import { execFileSync, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { snapshotTree, turnChanges, goBackTo } from "../checkpoints.ts";

let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`);
}

const dir = mkdtempSync(join(tmpdir(), "kohlab-checkpoints-"));
const git = (...args) => execFileSync("git", ["-c", "safe.directory=*", ...args], { cwd: dir, encoding: "utf8" }).trim();
const put = (name, text) => writeFileSync(join(dir, name), text);
/** What `git status` and the real index say, so a snapshot can be shown not to touch them. */
const realState = () => `${git("status", "--porcelain", "--untracked-files=all")}\n--\n${git("ls-files", "--stage")}\n--\n${git("rev-parse", "HEAD")}`;

try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "check@kohlab.test");
  git("config", "user.name", "check");

  put("a.txt", "one\n");
  put("c.txt", "gone soon\n");
  put(".gitignore", "*.log\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");

  // 1. A snapshot does not touch the real index, HEAD or the status.
  const stateBefore = realState();
  const before = await snapshotTree(dir);
  check("snapshot is a tree hash", typeof before === "string" && /^[0-9a-f]{40}$/.test(before), String(before));
  check("snapshot leaves status, index and HEAD unchanged", realState() === stateBefore);
  check("snapshot of an unchanged tree is stable", (await snapshotTree(dir)) === before);

  // 2. Edit a tracked file, add an untracked one, delete a tracked one, add an ignored one.
  put("a.txt", "two\n");
  put("b.txt", "new file\n");
  rmSync(join(dir, "c.txt"));
  put("debug.log", "ignored\n");
  const after = await snapshotTree(dir);
  check("snapshot changes after edits", after !== null && after !== before);

  const turn = await turnChanges(dir, before, after);
  const byPath = Object.fromEntries(turn.files.map((f) => [f.path, f.status]));
  check("modified file is listed as modified", byPath["a.txt"] === "modified", JSON.stringify(byPath));
  check("untracked file is listed as added", byPath["b.txt"] === "added", JSON.stringify(byPath));
  check("deleted file is listed as deleted", byPath["c.txt"] === "deleted", JSON.stringify(byPath));
  check("ignored file is not listed", byPath["debug.log"] === undefined);
  check("exactly three files changed", turn.files.length === 3, String(turn.files.length));
  check("patch shows the edit", turn.diff.includes("-one") && turn.diff.includes("+two"), turn.diff.slice(0, 200));
  check("no diff for identical trees", (await turnChanges(dir, after, after)).files.length === 0);

  // 3. Go back: the files return to the earlier state and the state before going back is kept as a version.
  const headBefore = git("rev-parse", "HEAD");
  await goBackTo(dir, before, "Went back to before: test");
  check("go back restores an edited file", readFileSync(join(dir, "a.txt"), "utf8") === "one\n");
  check("go back removes an added file", !existsSync(join(dir, "b.txt")));
  check("go back brings back a deleted file", readFileSync(join(dir, "c.txt"), "utf8") === "gone soon\n");
  check("go back leaves ignored files alone", existsSync(join(dir, "debug.log")));
  check("go back adds a commit on top", git("rev-parse", "HEAD") !== headBefore);
  check("the commit made by going back matches the earlier state", git("rev-parse", "HEAD^{tree}") === before, git("rev-parse", "HEAD^{tree}"));
  const saved = git("log", "--format=%s", "-n", "2").split("\n");
  check("the state before going back is a commit (Before going back)", saved[1] === "Before going back", saved.join(" | "));
  check("that saved commit holds the files as they were", git("rev-parse", "HEAD~1^{tree}") === after, git("rev-parse", "HEAD~1^{tree}"));

  // 4. The way back: going back to the saved state brings the edits back.
  await goBackTo(dir, after, "Went back to the version from before");
  check("the way back restores the edits", readFileSync(join(dir, "a.txt"), "utf8") === "two\n" && existsSync(join(dir, "b.txt")) && !existsSync(join(dir, "c.txt")));

  // 5. A repository with no commits yet: the snapshot still works, and does not commit.
  const empty = mkdtempSync(join(tmpdir(), "kohlab-checkpoints-empty-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: empty });
    writeFileSync(join(empty, "x.txt"), "x\n");
    const t = await snapshotTree(empty);
    check("snapshot works before the first commit", typeof t === "string" && /^[0-9a-f]{40}$/.test(t), String(t));
    // rev-parse exits 1 when there is no HEAD: that is the expected answer here.
    const headless = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: empty, encoding: "utf8" });
    check("snapshot makes no commit", headless.status === 1 && headless.stdout.trim() === "");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  // 6. Not a repository: null, never a throw.
  const plain = mkdtempSync(join(tmpdir(), "kohlab-checkpoints-plain-"));
  try {
    check("snapshot of a non-repository is null", (await snapshotTree(plain)) === null);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }

} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nall checkpoint checks passed" : `\n${failures} checkpoint check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
