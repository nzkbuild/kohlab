// The last mile: bringing an accepted workspace's branch into your own checkout.
//
// This command mutates a repository the operator cares about, so the checks are
// mostly about what it must NOT do: merge over uncommitted work, leave a
// repository mid-conflict, or touch anything when it refuses.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "kohlab-merge-"));
const repo = join(dir, "project");
const works = join(dir, "works");
const SOCKET = join(tmpdir(), `kohlab-merge-${process.pid}.sock`);
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const env = { ...process.env, WORKS_DIR: works, PTY_SOCKET: SOCKET, GIT_AUTHOR_NAME: "check", GIT_AUTHOR_EMAIL: "check@example.com", GIT_COMMITTER_NAME: "check", GIT_COMMITTER_EMAIL: "check@example.com" };
const kohlab = (...args) => spawnSync("bun", ["run", "cli.ts", ...args], { cwd: process.cwd(), env, encoding: "utf8" });
try {
  // ── a repository with one commit on main ───────────────────────────────────
  mkdirSync(repo, { recursive: true });
  mkdirSync(works, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "app.js"), "console.log('v1');\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "initial");
  const initial = git(repo, "rev-parse", "HEAD");

  const created = kohlab("create", repo, "add a feature", "sh");
  const id = created.stdout.match(/id:\s*(\S+)/)?.[1] ?? created.stdout.trim().split(/\s+/).pop();
  check("a workspace is created on the repository", created.status === 0, created.stderr.slice(0, 120));

  // The agent does some work, then the operator accepts it.
  // ── refusing before anything is committed ──────────────────────────────────
  const tooEarly = kohlab("merge", id);
  check("merging an uncommitted workspace is refused", tooEarly.status !== 0);
  check("and the message says to accept it first", /Accept the workspace first/.test(`${tooEarly.stdout}${tooEarly.stderr}`), JSON.stringify((tooEarly.stdout + tooEarly.stderr).trim().slice(-160)));

  // Commit inside the worktree, the way the agent's work is accepted.
  const wt = git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.replace("worktree ", ""))
    .find((p) => p !== repo);
  writeFileSync(join(wt, "feature.js"), "export const added = true;\n");
  const accepted = kohlab("commit", id, "add the feature");
  check("the workspace can be accepted", accepted.status === 0, accepted.stderr.slice(0, 160));
  check("the branch exists", git(repo, "rev-parse", "--verify", `kohlab/${id}`).length > 0);

  // ── the guard that matters most: never merge over work in progress ─────────
  writeFileSync(join(repo, "app.js"), "console.log('uncommitted edit');\n");
  const dirty = kohlab("merge", id);
  check("merging over uncommitted work is refused", dirty.status !== 0);
  check("and it says why", /uncommitted/.test(`${dirty.stdout}${dirty.stderr}`));
  check("nothing was merged", git(repo, "rev-parse", "HEAD") === initial);
  check("the edit is still there", readFileSync(join(repo, "app.js"), "utf8").includes("uncommitted edit"));
  git(repo, "checkout", "--", "app.js");

  // ── the merge itself ──────────────────────────────────────────────────────
  const merged = kohlab("merge", id);
  check("the merge succeeds", merged.status === 0, merged.stderr.slice(0, 200));
  check("the work is on main", git(repo, "show", "--stat", "HEAD").includes("feature.js"));
  check("it is a merge commit, not a fast-forward",
    git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/).length === 3);
  check("the tree is clean afterwards", git(repo, "status", "--porcelain") === "");
  check("and it prints how to undo it", /reset --hard/.test(merged.stdout));

  // ── a conflict leaves the repository exactly as it was ─────────────────────
  const created2 = kohlab("create", repo, "conflicting change", "sh");
  const id2 = created2.stdout.match(/id:\s*(\S+)/)?.[1] ?? created2.stdout.trim().split(/\s+/).pop();
  const wt2 = git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.replace("worktree ", ""))
    .find((p) => p !== repo && !p.includes(id));
  writeFileSync(join(wt2, "app.js"), "console.log('the agent\\'s version');\n");
  kohlab("commit", id2, "agent changes app.js");

  writeFileSync(join(repo, "app.js"), "console.log('my version');\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "my change to the same line");
  const beforeConflict = git(repo, "rev-parse", "HEAD");

  const conflicted = kohlab("merge", id2);
  check("a conflict is refused", conflicted.status !== 0);
  check("and reported as a conflict", /conflict/i.test(`${conflicted.stdout}${conflicted.stderr}`));
  check("no merge is left in progress", !existsSync(join(repo, ".git", "MERGE_HEAD")));
  check("the branch is unchanged", git(repo, "rev-parse", "HEAD") === beforeConflict);
  check("the working tree is untouched", git(repo, "status", "--porcelain") === "");
  check("and the message offers the manual path", /merge kohlab\//.test(`${conflicted.stdout}${conflicted.stderr}`));

  // ── merging into a bare clone is refused with somewhere to go ──────────────
  const bareInto = join(dir, "bare.git");
  git(dir, "init", "-q", "--bare", bareInto);
  const bare = kohlab("merge", id, "--into", bareInto);
  check("merging into a bare clone is refused", bare.status !== 0);
  check("with advice rather than a stack trace", /bare clone/.test(`${bare.stdout}${bare.stderr}`));
} finally {
  const pid = spawnSync("sh", ["-c", `ss -xlp 2>/dev/null | grep -F '${SOCKET}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`], { encoding: "utf8" }).stdout.trim();
  if (pid) spawnSync("kill", ["-9", pid], { encoding: "utf8" });
  rmSync(SOCKET, { force: true });
  rmSync(dir, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall merge checks passed");
