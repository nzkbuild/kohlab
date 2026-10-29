// Git for teams: worktrees, commits, merges, and the landing into the project. Every call
// runs as the project owner (`who`), with hooks off and the same -c flags everywhere. Failures
// are plain Errors; the caller decides what they mean. Throwaway repos: scripts/check-team-core.mjs.

import { execFile, spawn } from "child_process";
import { promisify } from "util";

const runFile = promisify(execFile);

export type Who = { uid: number; gid: number };

const HARDENED = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=",
  "-c", "safe.directory=*",
  "-c", "user.name=Kohlab",
  "-c", "user.email=kohlab@localhost",
];
const TIMEOUT_MS = 60_000;

const firstLine = (s: string) => (s || "").trim().split("\n")[0] || "failed";

async function git(cwd: string, args: string[], who?: Who): Promise<string> {
  try {
    const r = await runFile("git", [...HARDENED, ...args], { cwd, uid: who?.uid, gid: who?.gid, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return r.stdout;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    throw new Error(`git ${args[0]}: ${firstLine(err.stderr || err.message || "")}`);
  }
}

/** Like git(), but stdout stops at `cap` bytes. `truncated` says the rest was not read. */
function gitCapped(cwd: string, args: string[], cap: number, who?: Who): Promise<{ out: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", [...HARDENED, ...args], { cwd, uid: who?.uid, gid: who?.gid, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let err = "";
    p.stdout.on("data", (d: Buffer) => {
      if (truncated) return;
      const room = cap - size;
      if (d.length > room) {
        chunks.push(d.subarray(0, room));
        size = cap;
        truncated = true;
        p.kill();
      } else {
        chunks.push(d);
        size += d.length;
      }
    });
    p.stderr.on("data", (d: Buffer) => {
      if (err.length < 2000) err += d.toString("utf8");
    });
    p.on("error", reject);
    p.on("close", (code) => {
      if (!truncated && code !== 0) return reject(new Error(`git ${args[0]}: ${firstLine(err)}`));
      resolve({ out: Buffer.concat(chunks).toString("utf8"), truncated });
    });
  });
}

const lines = (s: string) => s.split("\0").filter(Boolean);

async function unmerged(tree: string, who?: Who): Promise<string[]> {
  return lines(await git(tree, ["diff", "--name-only", "--diff-filter=U", "-z"], who));
}

/** A worktree of `parentTree` at `dest`: on a new branch, or detached when `branch` is null. */
export async function addTree(parentTree: string, dest: string, branch: string | null, startPoint: string, who?: Who): Promise<void> {
  await git(parentTree, branch ? ["worktree", "add", "-b", branch, "--", dest, startPoint] : ["worktree", "add", "--detach", "--", dest, startPoint], who);
}

/** Puts a worktree exactly at `startPoint` (moving `branch` there, if given) and removes untracked files. Local edits are discarded. */
export async function resetTree(tree: string, branch: string | null, startPoint: string, who?: Who): Promise<void> {
  await git(tree, branch ? ["checkout", "-q", "-f", "-B", branch, startPoint] : ["checkout", "-q", "-f", "--detach", startPoint], who);
  await git(tree, ["clean", "-fdq"], who);
}

export async function headOf(tree: string, who?: Who): Promise<string> {
  return (await git(tree, ["rev-parse", "HEAD"], who)).trim();
}

export async function isClean(tree: string, who?: Who): Promise<boolean> {
  return (await git(tree, ["status", "--porcelain"], who)).trim() === "";
}

/** Stages everything and commits it, unless there is nothing to commit. Hooks are off. */
export async function commitAll(tree: string, message: string, who?: Who): Promise<{ head: string; changed: boolean }> {
  await git(tree, ["add", "-A"], who);
  const changed = (await git(tree, ["diff", "--cached", "--name-only"], who)).trim() !== "";
  if (changed) await git(tree, ["commit", "-q", "--no-verify", "-m", message], who);
  return { head: await headOf(tree, who), changed };
}

/** Files the branch changed since `base` (merge-base to HEAD). */
export async function changedFiles(tree: string, base: string, who?: Who): Promise<string[]> {
  return lines(await git(tree, ["diff", "--name-only", "-z", "--no-renames", `${base}...HEAD`], who));
}

/** Diffstat, and the patch read only up to `cap` bytes. */
export async function diffText(tree: string, base: string, head: string, cap: number, who?: Who): Promise<{ stat: string; diff: string; truncated: boolean }> {
  const range = `${base}...${head}`;
  const stat = await git(tree, ["diff", "--no-color", "--stat", range], who);
  const { out, truncated } = await gitCapped(tree, ["diff", "--no-color", "--no-ext-diff", "--no-renames", range], cap, who);
  return { stat: stat.trim(), diff: out, truncated };
}

/**
 * Merges a task branch into the integration tree, no fast-forward. On a conflict the merge is
 * aborted, so the integration tree is never left half-merged, and the conflicting files come back.
 */
export async function mergeInto(
  intTree: string,
  branch: string,
  message: string,
  who?: Who,
  prefer?: "ours" | "theirs",
): Promise<{ ok: true; head: string } | { ok: false; files: string[] }> {
  try {
    await git(intTree, ["merge", "--no-ff", "--no-edit", "-m", message, ...(prefer ? ["-X", prefer] : []), branch], who);
    return { ok: true, head: await headOf(intTree, who) };
  } catch (e) {
    const files = await unmerged(intTree, who).catch(() => [] as string[]);
    await git(intTree, ["merge", "--abort"], who).catch(() => {});
    if (!files.length) throw e;
    return { ok: false, files };
  }
}

/** Merges `rev` into a builder's tree and leaves the conflict markers in place for the builder to resolve. Returns the conflicting files ([] when it merged cleanly). */
export async function mergeKeepingConflicts(tree: string, rev: string, who?: Who): Promise<string[]> {
  try {
    await git(tree, ["merge", "--no-ff", "--no-edit", "-m", `Merge ${rev} into this branch`, rev], who);
    return [];
  } catch (e) {
    const files = await unmerged(tree, who).catch(() => [] as string[]);
    if (!files.length) throw e;
    return files;
  }
}

/**
 * Brings the team's branch into the project as uncommitted changes (never a commit): a squash merge,
 * then unstaged. Refused when the project tree has any change. On a conflict the tree is reset to HEAD.
 */
export async function landSquash(
  parentTree: string,
  branch: string,
  _base: string,
  who?: Who,
): Promise<{ ok: true; files: string[] } | { ok: false; reason: "dirty" | "conflict"; files?: string[] }> {
  if ((await git(parentTree, ["status", "--porcelain"], who)).trim() !== "") return { ok: false, reason: "dirty" };
  try {
    await git(parentTree, ["merge", "--squash", branch], who);
  } catch (e) {
    const files = await unmerged(parentTree, who).catch(() => [] as string[]);
    await git(parentTree, ["reset", "-q", "--hard", "HEAD"], who);
    if (!files.length) throw e;
    return { ok: false, reason: "conflict", files };
  }
  await git(parentTree, ["reset", "-q"], who);
  const tracked = lines(await git(parentTree, ["diff", "--name-only", "-z", "HEAD"], who));
  const untracked = lines(await git(parentTree, ["ls-files", "--others", "--exclude-standard", "-z"], who));
  return { ok: true, files: [...new Set([...tracked, ...untracked])] };
}

/** Removes a worktree and, when given, its branch. Teardown is idempotent: what is already gone is skipped. */
export async function removeTree(parentTree: string, tree: string, branch: string | null, who?: Who): Promise<void> {
  await git(parentTree, ["worktree", "remove", "--force", "--", tree], who).catch(() => {});
  await git(parentTree, ["worktree", "prune"], who).catch(() => {});
  if (branch) await git(parentTree, ["branch", "-D", branch], who).catch(() => {});
}
