/**
 * Preview path resolution for `/p/<token>/<path>`: the AI's web page, served from
 * the workspace's own worktree. Pure string checks live in previewRelPath so the
 * rules can be tested without a filesystem; resolvePreviewFile adds the disk checks.
 */
import { execFile } from "node:child_process";
import { open, readdir, realpath, stat } from "node:fs/promises";
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

/** One page a listing offers: a servable .html or .htm file. `changed` is its modification time in ms. */
export type PreviewPage = { path: string; title: string; changed: number };

/** Most pages a listing carries. The rest are counted ("…and N more"), not listed. */
export const PAGES_MAX = 200;
// ponytail: a walk ceiling, so a huge tree stops early and lists what it found; add an index when that is not enough.
const PAGES_SCAN_MAX = 5000;
const PAGES_DEPTH_MAX = 8;
/** Folders a page list never walks, beside the dot-prefixed ones (.git, .kohlab, .works). */
const PAGES_SKIP = new Set(["node_modules", "dist", "build", ".next"]);

/** Every segment percent-encoded, so previewRelPath decodes it back to the same name. */
const encodeRel = (rel: string) => rel.split("/").map(encodeURIComponent).join("/");

/** The entities a title usually carries, decoded in one pass (so "&amp;lt;" stays "&lt;"). pagesHtml escapes the result again. */
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

/** The title from the first 16 KB of the page, tags removed, or the file name when there is none. */
async function titleOf(abs: string, rel: string): Promise<string> {
  const fh = await open(abs, "r").catch(() => null);
  if (!fh) return basename(rel);
  try {
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(buf.toString("utf8", 0, bytesRead));
    const text = m ? m[1].replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e]).replace(/\s+/g, " ").trim() : "";
    return text ? text.slice(0, 120) : basename(rel);
  } finally {
    await fh.close();
  }
}

/**
 * The project's HTML pages, most recently changed first. Each candidate must pass
 * resolvePreviewFile, the same check the preview path makes, so a symlink, a dot-name
 * or anything outside the tree is never listed. `more` counts the pages past PAGES_MAX.
 */
export async function listPreviewPages(worktree: string): Promise<{ pages: PreviewPage[]; more: number }> {
  const found: { rel: string; abs: string; changed: number }[] = [];
  let scanned = 0;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    if (depth > PAGES_DEPTH_MAX) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++scanned > PAGES_SCAN_MAX) return;
      if (e.name.startsWith(".") || PAGES_SKIP.has(e.name)) continue;
      const rel = prefix + e.name;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), rel + "/", depth + 1);
      } else if (e.isFile() && /\.html?$/i.test(e.name)) {
        const st = await stat(join(dir, e.name)).catch(() => null);
        const abs = st ? await resolvePreviewFile(worktree, encodeRel(rel)) : null;
        if (st && abs) found.push({ rel, abs, changed: Math.round(st.mtimeMs) });
      }
    }
  };
  await walk(worktree, "", 0);
  found.sort((a, b) => b.changed - a.changed || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const top = found.slice(0, PAGES_MAX);
  const pages = await Promise.all(top.map(async (p) => ({ path: p.rel, title: await titleOf(p.abs, p.rel), changed: p.changed })));
  return { pages, more: found.length - top.length };
}

/** Escape for text and attribute values. Every name and title is file content, so nothing passes through raw. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PAGES_CSS = `:root{color-scheme:light dark;--bg:#ffffff;--fg:#0d0d0d;--muted:#5d5d5d}
@media (prefers-color-scheme:dark){:root{--bg:#212121;--fg:#ececec;--muted:#a3a3a3}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 20px}
h1{font-size:28px;font-weight:600;margin:0 0 16px}
ul{list-style:none;margin:0;padding:0}
a{display:inline-flex;align-items:center;min-height:44px;color:var(--fg);font-weight:500}
a:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.dir{color:var(--muted);font-size:14px;margin-left:8px}
.more{color:var(--muted);margin-top:16px}`;

/**
 * The listing page for a project with no index.html at its address. Links go to `base` (the
 * /p/<token>/ address) plus the page's path, so they work from any folder and stay under the
 * same sandboxed origin. No script; colours follow DESIGN.md, light and dark.
 */
export function pagesHtml(base: string, pages: PreviewPage[], more: number): string {
  const items = pages
    .map((p) => {
      const slash = p.path.lastIndexOf("/");
      const folder = slash < 0 ? "" : `<span class="dir">${esc(p.path.slice(0, slash + 1))}</span>`;
      return `<li><a href="${esc(base + encodeRel(p.path))}">${esc(p.title)}</a>${folder}</li>`;
    })
    .join("");
  const tail = more > 0 ? `<p class="more">…and ${more} more</p>` : "";
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages in this project</title><style>${PAGES_CSS}</style><main><h1>Pages in this project</h1><ul>${items}</ul>${tail}</main>`;
}
