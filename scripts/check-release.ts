#!/usr/bin/env bun
/**
 * Release checking — the data behind Settings → Updates.
 *
 * Run:  bun scripts/check-release.ts
 *
 * A release is published by pushing, and this is the logic that turns a push
 * into "v1.1.0 is available, here is what is in it". It checks that the pushed
 * commit is seen, that both versions are named, and that the notes are exactly
 * the changelog above the running version — not the old release's notes, which
 * are not news.
 *
 * It also covers `updateRunState`, which has to survive the one thing that makes
 * it hard: the reload kills the server that started the update, so the outcome
 * can only come from the log's marker lines.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name} ${detail}`);
}

const tmp = mkdtempSync(join(tmpdir(), "kohlab-release-"));

// lib.ts resolves WORKS_DIR when it is first imported, so point it at the
// fixture before importing — hence a dynamic import rather than a static one.
process.env.WORKS_DIR = join(tmp, "state");
mkdirSync(join(tmp, "state"), { recursive: true });

const { checkRelease, releaseNotes, updateRunState } = await import("../lib.ts");

const GITENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "kohlab check",
  GIT_AUTHOR_EMAIL: "check@kohlab.test",
  GIT_COMMITTER_NAME: "kohlab check",
  GIT_COMMITTER_EMAIL: "check@kohlab.test",
};
const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: GITENV });

const CHANGELOG_1_0 = `# Changelog

All notable changes are documented here. This preamble must never be shown as
release notes.

## [1.0.0] - 2026-09-19

### Added

- the first thing, which is old news
`;

const CHANGELOG_1_1 = `# Changelog

All notable changes are documented here. This preamble must never be shown as
release notes.

## [1.1.0] - 2026-09-20

### Added

- the new thing, which is the news

## [1.0.0] - 2026-09-19

### Added

- the first thing, which is old news
`;

try {
  const origin = join(tmp, "origin.git");
  const rel = join(tmp, "rel");
  const work = join(tmp, "work");

  mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main"], work);
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "kohlab", version: "1.0.0" }, null, 2) + "\n");
  writeFileSync(join(work, "CHANGELOG.md"), CHANGELOG_1_0);
  git(["add", "-A"], work);
  git(["commit", "-qm", "init"], work);
  git(["init", "-q", "--bare", "-b", "main", origin], tmp);
  git(["remote", "add", "origin", origin], work);
  git(["push", "-q", "-u", "origin", "main"], work);
  git(["clone", "-q", origin, rel], tmp);

  console.log("\nkohlab — release checking\n");

  const before = await checkRelease(work, { force: true });
  check("up to date reports current == latest", before.current === "1.0.0" && before.latest === "1.0.0", JSON.stringify(before));
  check("up to date reports nothing pending", before.available === false && before.commits.length === 0);
  check("up to date carries no notes", before.notes === "");
  check("up to date names the upstream branch", before.upstream === "origin/main", String(before.upstream));

  // publishing a release is the push, and nothing else
  writeFileSync(join(rel, "package.json"), JSON.stringify({ name: "kohlab", version: "1.1.0" }, null, 2) + "\n");
  writeFileSync(join(rel, "CHANGELOG.md"), CHANGELOG_1_1);
  git(["add", "-A"], rel);
  git(["commit", "-qm", "feat: v1.1.0"], rel);
  git(["push", "-q", "origin", "main"], rel);

  const after = await checkRelease(work, { force: true });
  check("a pushed release is seen", after.available === true);
  check("it names the published version", after.latest === "1.1.0", after.latest);
  check("it names the running version", after.current === "1.0.0", after.current);
  check("it lists the pending commit", after.commits.length === 1 && after.commits[0].includes("feat: v1.1.0"), after.commits.join(" | "));
  check("the notes are the new release", after.notes.includes("1.1.0") && after.notes.includes("which is the news"), after.notes);
  check("the notes exclude the running release", !after.notes.includes("which is old news"), after.notes);
  check("the notes exclude the changelog preamble", !after.notes.includes("This preamble must never be shown"), after.notes);
  check("the notes start at a heading", after.notes.startsWith("## ["), after.notes.slice(0, 40));

  // the pure part, on its own
  check(
    "releaseNotes cuts at the running version",
    releaseNotes(CHANGELOG_1_1, "1.0.0").trim().endsWith("which is the news"),
  );
  check("releaseNotes returns nothing when the version is absent", releaseNotes(CHANGELOG_1_1, "9.9.9") === "");
  check(
    "releaseNotes keeps an [Unreleased] section above the cut",
    releaseNotes(`# Changelog\n\n## [Unreleased]\n\n- pending\n\n## [1.0.0] - x\n\n- old\n`, "1.0.0").includes("pending"),
  );

  // --- how an update run is reported back -----------------------------------
  const logPath = join(tmp, "state", "update.log");
  const empty = await updateRunState();
  check(
    "no log yet -> nothing has run",
    empty.running === false && empty.exit === null && empty.finishedAt === null && empty.unfinished === false,
  );

  // started, with a pid that is gone: the server was killed mid-update
  const dead = spawnSync("true", [], {});
  writeFileSync(logPath, `# kohlab update started 1789000000000 pid ${dead.pid}\n1/5  save\n`);
  const orphaned = await updateRunState();
  check("a dead pid is not reported as running", orphaned.running === false, JSON.stringify(orphaned));
  check("an unfinished run reports no exit code", orphaned.exit === null && orphaned.finishedAt === null);
  check("an unfinished run is flagged, not silently ignored", orphaned.unfinished === true, JSON.stringify(orphaned));

  // the log exists but the script never even started (bash could not find it):
  // no started marker either, and this is what the panel used to show nothing for
  writeFileSync(logPath, `bash: /root/kohlab/scripts/update.sh: No such file or directory\n`);
  const neverRan = await updateRunState();
  check("a log with no markers at all is flagged", neverRan.unfinished === true && neverRan.running === false, JSON.stringify(neverRan));
  check("its log is still carried for the panel", neverRan.log.includes("No such file or directory"), neverRan.log);

  // started, with a live pid: the test process itself
  writeFileSync(logPath, `# kohlab update started ${Date.now()} pid ${process.pid}\n1/5  save\n`);
  const running = await updateRunState();
  check("a live pid is reported as running", running.running === true, JSON.stringify(running));
  check("a running update reports when it started", typeof running.startedAt === "number", String(running.startedAt));

  // finished: the marker the script writes on its way out
  writeFileSync(
    logPath,
    `# kohlab update started ${Date.now() - 4000} pid ${process.pid}\n2/5  check\n# kohlab update finished ${Date.now()} exit 7\n`,
  );
  const done = await updateRunState();
  check("a finished run is not running", done.running === false);
  check("a finished run reports its exit code", done.exit === 7, String(done.exit));
  check("a finished run reports when it ended", typeof done.finishedAt === "number", String(done.finishedAt));
  check("the log is carried for the panel", done.log.includes("2/5  check"), done.log);

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    throw new Error(`release checking regressed: ${failures.join("; ")}`);
  }
  console.log("release checking intact\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
