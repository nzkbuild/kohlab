/**
 * Preview path resolution for `/p/<token>/<path>`: the AI's web page, served from
 * the workspace's own worktree. Pure string checks live in previewRelPath so the
 * rules can be tested without a filesystem; resolvePreviewFile adds the disk checks.
 */
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** A version's page is read whole, so it has a cap of its own. */
const VERSION_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Turn the part after `/p/<token>/` into a relative file path, or null to refuse.
 * "" and trailing slashes mean index.html. Each segment is percent-decoded first,
 * so "%2e%2e" cannot slip past the dot checks. Refused: "..", any dot-prefixed
 * segment (.git, .env), empty middle segments, and decoded slashes or NULs.
 */
export function previewRelPath(rest: string): string | null {
  const wantsDir = rest === "" || rest.endsWith("/");
  const parts = rest.split("/");
  if (wantsDir) parts.pop(); // the trailing slash leaves an empty last segment
  const segs: string[] = [];
  for (const raw of parts) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "" || seg === ".." || seg.startsWith(".")) return null;
    if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return null;
    segs.push(seg);
  }
  if (wantsDir) segs.push("index.html");
  return segs.join("/");
}

/**
 * Map a request path to a real file inside `worktree`, or null. Symlinks are
 * followed and the real location must still sit inside the real worktree and
 * avoid dot-prefixed names, so a link cannot reach .git or outside the tree.
 * A directory resolves to its index.html.
 */
export async function resolvePreviewFile(worktree: string, rest: string): Promise<string | null> {
  const rel = previewRelPath(rest);
  if (rel === null) return null;
  let root: string;
  try {
    root = await realpath(worktree);
  } catch {
    return null;
  }
  const candidate = resolve(root, rel);
  let real: string;
  try {
    real = await realpath(candidate);
    if ((await stat(real)).isDirectory()) real = await realpath(join(real, "index.html"));
    if (!(await stat(real)).isFile()) return null; // a FIFO or device would hang the response
  } catch {
    return null;
  }
  if (!real.startsWith(root + sep)) return null;
  const inside = real.slice(root.length + 1).split(sep);
  if (inside.some((s) => s.startsWith("."))) return null;
  return real;
}

/** One entry of a version's tree, from `git ls-tree -l`: the exact path, or null. */
async function treeEntry(tree: string, sha: string, rel: string): Promise<{ mode: string; type: string; size: number } | null> {
  const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", "ls-tree", "-l", "-z", sha, "--", rel], { cwd: tree, maxBuffer: 1 << 20 });
  for (const rec of stdout.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0 || rec.slice(tab + 1) !== rel) continue;
    const [mode, type, , size] = rec.slice(0, tab).trim().split(/\s+/);
    return { mode, type, size: size === "-" ? 0 : Number(size) };
  }
  return null;
}

/**
 * A file as it was at `sha`, for "look at an earlier version". Same path rules as
 * the live preview (previewRelPath). Only regular files: a symlink, a submodule or
 * a dotfile is refused. A directory without a trailing slash is "redirect" (the
 * browser then needs the slash for relative links). The bytes come from
 * `git cat-file blob`, so nothing is ever checked out or run through a shell.
 */
export async function versionFile(tree: string, sha: string, rest: string): Promise<{ bytes: Buffer; name: string } | "redirect" | null> {
  const rel = previewRelPath(rest);
  if (rel === null) return null;
  try {
    const entry = await treeEntry(tree, sha, rel);
    if (!entry) return null;
    if (entry.type === "tree") return rest.endsWith("/") ? null : "redirect";
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) return null;
    if (entry.size > VERSION_MAX_BYTES) return null;
    const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", "cat-file", "blob", `${sha}:${rel}`], {
      cwd: tree,
      encoding: "buffer",
      maxBuffer: VERSION_MAX_BYTES + 1,
    });
    return { bytes: stdout, name: basename(rel) };
  } catch {
    return null;
  }
}
