/**
 * Preview path resolution for `/p/<token>/<path>`: the AI's web page, served from
 * the workspace's own worktree. Pure string checks live in previewRelPath so the
 * rules can be tested without a filesystem; resolvePreviewFile adds the disk checks.
 */
import { realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

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
