#!/usr/bin/env bun
/**
 * GitHub's checks as the updater reads them (Part 2 of the update gate).
 *
 * Run:  bun scripts/check-release-checks.ts
 *
 * No network and no real gh: every GitHub answer is a fake runner. The parser is
 * checked state by state (mixed, empty, malformed), the origin must be GitHub
 * before gh is ever asked, a failed gh is "unknown" and not cached, and
 * checkRelease carries the result on an available update only.
 */
import { execFileSync } from "node:child_process";
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

const tmp = mkdtempSync(join(tmpdir(), "kohlab-release-checks-"));
process.env.WORKS_DIR = join(tmp, "state");
mkdirSync(join(tmp, "state"), { recursive: true });

try {
  const rc = await import("../release-checks.ts");
  const { parseCheckRuns, checksSentence, githubSlug, upstreamChecks } = rc;
  const { checkRelease } = await import("../lib.ts");

  console.log("\nkohlab, GitHub checks for an update\n");

  const run = (...runs: unknown[]) => JSON.stringify({ total_count: runs.length, check_runs: runs });
  const ok = { status: "completed", conclusion: "success", html_url: "https://github.com/o/n/runs/1" };

  // parser: every state, mixed, empty, malformed
  check("all success passes", parseCheckRuns(run(ok, { ...ok, conclusion: "neutral" }, { ...ok, conclusion: "skipped" })).state === "passed");
  check("in progress is pending", parseCheckRuns(run(ok, { status: "in_progress", conclusion: null })).state === "pending");
  check("queued is pending", parseCheckRuns(run({ status: "queued", conclusion: null })).state === "pending");
  check("an unknown conclusion is pending, never passed", parseCheckRuns(run({ status: "completed", conclusion: "weird" })).state === "pending");
  for (const c of ["failure", "cancelled", "timed_out", "action_required"]) {
    check(`${c} is failed`, parseCheckRuns(run({ ...ok, conclusion: c })).state === "failed", c);
  }
  const mixed = parseCheckRuns(run({ status: "in_progress", conclusion: null }, { ...ok, conclusion: "failure", html_url: "https://github.com/o/n/actions/runs/9" }));
  check("failed beats pending in a mix", mixed.state === "failed", JSON.stringify(mixed));
  check("a failed check links to its GitHub page", mixed.url === "https://github.com/o/n/actions/runs/9", String(mixed.url));
  const leaky = parseCheckRuns(run({ ...ok, conclusion: "failure", html_url: "https://tok@github.com/o/n/runs/2" }));
  check("userinfo is taken out of the link", leaky.url === "https://github.com/o/n/runs/2", String(leaky.url));
  const offsite = parseCheckRuns(run({ ...ok, conclusion: "failure", html_url: "https://evil.example/x" }));
  check("a link to another host is dropped", offsite.state === "failed" && offsite.url === undefined, JSON.stringify(offsite));
  check("no runs is unknown", parseCheckRuns(run()).state === "unknown");
  check("malformed JSON is unknown", parseCheckRuns("<html>rate limited</html>").state === "unknown");
  check("a body without check_runs is unknown", parseCheckRuns('{"message":"Not Found"}').state === "unknown");
  check("a null body is unknown", parseCheckRuns("null").state === "unknown");
  check("junk entries are ignored", parseCheckRuns(JSON.stringify({ check_runs: [null, 5, ok] })).state === "passed");
  check("only junk is unknown", parseCheckRuns(JSON.stringify({ check_runs: [null, "x"] })).state === "unknown");

  // wording
  check("passed wording", checksSentence({ state: "passed", sha: "x" }) === "GitHub's checks passed");
  check("pending wording", checksSentence({ state: "pending", sha: "x" }) === "GitHub is still checking this version");
  check("failed wording", checksSentence({ state: "failed", sha: "x" }) === "GitHub's checks failed for this version");
  check("unknown says nothing", checksSentence({ state: "unknown", sha: "x" }) === null && checksSentence(null) === null);

  // origin
  check("https github origin", githubSlug("https://github.com/acme/kohlab.git") === "acme/kohlab");
  check("ssh github origin", githubSlug("git@github.com:acme/kohlab.git") === "acme/kohlab");
  check("userinfo never reaches the slug", githubSlug("https://tok123@github.com/acme/kohlab") === "acme/kohlab");
  check("gitlab is not GitHub", githubSlug("https://gitlab.com/acme/kohlab.git") === null);
  check("a local path is not GitHub", githubSlug("/srv/origin.git") === null);

  // upstreamChecks with a fake gh
  const SHA = "a".repeat(40);
  const calls: string[][] = [];
  const fake = (out: string) => async (args: string[]) => {
    calls.push(args);
    return out;
  };
  const nonGithub = await upstreamChecks("/srv/origin.git", SHA, fake(run(ok)));
  check("a non-GitHub origin never asks gh", nonGithub.state === "unknown" && calls.length === 0);
  const badSha = await upstreamChecks("https://github.com/acme/kohlab.git", "main", fake(run(ok)));
  check("a non-sha is unknown without asking", badSha.state === "unknown" && calls.length === 0);

  const passedOut = await upstreamChecks("https://github.com/acme/kohlab.git", SHA, fake(run(ok)));
  check("gh answer is read", passedOut.state === "passed" && passedOut.sha === SHA, JSON.stringify(passedOut));
  check(
    "gh is called with a fixed argv for this commit",
    calls.length === 1 && calls[0].join(" ") === `api repos/acme/kohlab/commits/${SHA}/check-runs?per_page=100`,
    JSON.stringify(calls),
  );
  await upstreamChecks("https://github.com/acme/kohlab.git", SHA, fake(run(ok)));
  check("the answer is cached for a minute", calls.length === 1);

  const sha2 = "b".repeat(40);
  const thrown = await upstreamChecks("https://github.com/acme/kohlab.git", sha2, async () => {
    throw new Error("gh: not logged in, token ghp_secret");
  });
  check("gh missing or signed out is unknown, not an error", thrown.state === "unknown" && thrown.sha === sha2);
  const retry = await upstreamChecks("https://github.com/acme/kohlab.git", sha2, fake(run({ ...ok, conclusion: "failure" })));
  check("a failed gh is not cached: the next look asks again", retry.state === "failed", JSON.stringify(retry));

  // checkRelease: the checks ride on an available update only
  const GITENV = { ...process.env, GIT_AUTHOR_NAME: "k", GIT_AUTHOR_EMAIL: "k@k.test", GIT_COMMITTER_NAME: "k", GIT_COMMITTER_EMAIL: "k@k.test" };
  const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: GITENV });
  const origin = join(tmp, "origin.git");
  const work = join(tmp, "work");
  const rel = join(tmp, "rel");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "kohlab", version: "1.0.0" }) + "\n");
  git(["init", "-q", "-b", "main"], work);
  git(["add", "-A"], work);
  git(["commit", "-qm", "init"], work);
  git(["init", "-q", "--bare", "-b", "main", origin], tmp);
  git(["remote", "add", "origin", origin], work);
  git(["push", "-q", "-u", "origin", "main"], work);
  git(["clone", "-q", origin, rel], tmp);

  const idle = await checkRelease(work, { force: true, checksRunner: fake(run(ok)) });
  check("up to date carries no checks", idle.available === false && idle.checks === null, JSON.stringify(idle.checks));

  writeFileSync(join(rel, "package.json"), JSON.stringify({ name: "kohlab", version: "1.1.0" }) + "\n");
  git(["commit", "-qam", "feat: v1.1.0"], rel);
  git(["push", "-q", "origin", "main"], rel);
  const before = calls.length;
  const local = await checkRelease(work, { force: true, checksRunner: fake(run(ok)) });
  check("a local origin is unknown", local.available === true && local.checks?.state === "unknown", JSON.stringify(local.checks));
  check("a local origin never asks gh", calls.length === before);
  check("the checks name the upstream commit", local.checks?.sha.length === 40);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join("; ")}`);
  process.exit(1);
}
