// Turn checkpoints: a snapshot of the project's files taken just before each message,
// so a message can show what it changed and go back to before it. The git part only,
// with no workspace state, so scripts/check-checkpoints.mjs can run it on a throwaway repo.

import { execFile, spawn } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { restoreTree } from "./versions";

const exec = promisify(execFile);

/** Longest a snapshot may take. Sending never waits longer than this for one. */
const SNAPSHOT_MS = 10_000;
/** The patch of one message's changes stops here; the rest is not sent. */
export const PATCH_CAP = 500 * 1024;

export interface TurnFile {
  path: string;
  status: "added" | "modified" | "deleted";
}

/** git as the server runs it for a worktree. `index` points git at a scratch index instead of the real one. */
/** Only hashes we produced reach git as a revision. */
const HASH = /^[0-9a-f]{40,64}$/;
const mustBeHash = (...h: string[]) => {
  if (!h.every((x) => HASH.test(x))) throw new Error("not a tree hash");
};

function git(cwd: string, args: string[], index?: string): Promise<string> {
  const env = index ? { ...process.env, GIT_INDEX_FILE: index } : process.env;
  return exec("git", ["-c", "safe.directory=*", ...args], { cwd, env, timeout: SNAPSHOT_MS, maxBuffer: 16 * 1024 * 1024 }).then((r) => r.stdout);
}

/**
 * The files as they are now, as a git tree: HEAD plus every change in the worktree,
 * untracked files included, ignored files left out. Built with a scratch index, so the
 * real index and HEAD are never touched. Null when it cannot be taken in time or at all;
 * a null snapshot only costs the message its "What this changed" and "Go back".
 */
export async function snapshotTree(cwd: string): Promise<string | null> {
  let dir: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = async (): Promise<string> => {
    dir = mkdtempSync(join(tmpdir(), "kohlab-index-"));
    const index = join(dir, "index");
    const hasHead = await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(
      () => true,
      () => false, // no commit yet: start from an empty index
    );
    if (hasHead) await git(cwd, ["read-tree", "HEAD"], index);
    await git(cwd, ["add", "-A"], index);
    return (await git(cwd, ["write-tree"], index)).trim();
  };
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SNAPSHOT_MS);
  });
  try {
    return await Promise.race([work(), limit]);
  } catch (e) {
    console.warn(`[checkpoints] snapshot skipped: ${(e as Error).message.split("\n")[0]}`);
    return null;
  } finally {
    clearTimeout(timer);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Which files differ between two snapshots, and the patch of those differences (capped at PATCH_CAP). */
export async function turnChanges(cwd: string, from: string, to: string): Promise<{ files: TurnFile[]; diff: string }> {
  mustBeHash(from, to);
  // -z: names come back raw, NUL-separated, so no quoting to undo. No renames: a move is a delete and an add.
  const names = await git(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]);
  const parts = names.split("\0").filter(Boolean);
  const files: TurnFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i][0];
    files.push({ path: parts[i + 1], status: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
  }
  const patch = await patchOf(cwd, from, to);
  return { files, diff: patch.truncated ? `${patch.diff}\n\n… the rest of these changes is not shown (over 500 KB).\n` : patch.diff };
}

/** The unified patch between two trees, read until PATCH_CAP and then stopped. */
function patchOf(cwd: string, from: string, to: string): Promise<{ diff: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", ["-c", "safe.directory=*", "--no-pager", "diff", "--no-color", "--no-ext-diff", "--no-renames", from, to], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    p.stdout.on("data", (d: Buffer) => {
      if (truncated) return;
      const room = PATCH_CAP - size;
      if (d.length > room) {
        chunks.push(d.subarray(0, room));
        size = PATCH_CAP;
        truncated = true;
        p.kill();
      } else {
        chunks.push(d);
        size += d.length;
      }
    });
    p.stderr.resume();
    p.on("error", reject);
    p.on("close", (code) => {
      if (!truncated && code !== 0) return reject(new Error(`git diff exited ${code}`));
      resolve({ diff: Buffer.concat(chunks).toString("utf8"), truncated });
    });
  });
}

/**
 * Put the files back to `tree`. The files as they are now are saved first, as a commit
 * ("Before going back") when they differ from the last one, because restoreTree throws
 * uncommitted changes away. So the state before going back stays in Earlier versions.
 */
export async function goBackTo(cwd: string, tree: string, message: string): Promise<boolean> {
  mustBeHash(tree);
  await git(cwd, ["add", "-A"]);
  if ((await git(cwd, ["diff", "--cached", "--name-only"])).trim()) await git(cwd, ["commit", "-m", "Before going back"]);
  return restoreTree(cwd, tree, message);
}
