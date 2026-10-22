// Earlier versions: the git part of "go back to this version". Kept out of lib.ts
// so scripts/check-versions.mjs can run it on a throwaway repo without workspace state.

import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export interface Version {
  /** Full commit sha. */
  id: string;
  /** Commit time, ms. */
  at: number;
  /** The commit subject. */
  label: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "safe.directory=*", ...args], { cwd });
  return stdout;
}

/**
 * Put the tree back to `sha` as a new commit. History is never rewritten: the
 * old commits stay, and going back adds one more on top.
 *
 * `git restore` alone would overlay: files added after `sha` would survive. The
 * index is emptied first so the restore gives back exactly `sha`'s files.
 * Returns false when `sha` matches the tree already, so there is nothing to commit.
 */
export async function restoreTree(tree: string, sha: string, message: string): Promise<boolean> {
  await git(tree, ["reset", "--hard", "HEAD"]);
  await git(tree, ["clean", "-fd"]);
  await git(tree, ["rm", "-r", "-q", "--ignore-unmatch", "--", "."]);
  await git(tree, ["restore", `--source=${sha}`, "--staged", "--worktree", "--", "."]);
  const staged = await git(tree, ["diff", "--cached", "--name-only"]);
  if (!staged.trim()) return false;
  await git(tree, ["commit", "-m", message]);
  return true;
}

/** The package.json at HEAD, parsed, or null. Read from git: a version is what HEAD's history says, not the worktree. */
export async function headPackage(tree: string): Promise<any | null> {
  try {
    return JSON.parse(await git(tree, ["show", "HEAD:package.json"]));
  } catch {
    return null;
  }
}

/** True when `sha`'s tree holds no files (the empty first commit): there is nothing to look at. */
export async function treeIsEmpty(tree: string, sha: string): Promise<boolean> {
  try {
    return !(await git(tree, ["ls-tree", sha])).trim();
  } catch {
    return false;
  }
}
