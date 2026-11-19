#!/usr/bin/env bun
/**
 * Web preview pages: a folder with no index.html lists the project's HTML pages, the JSON route the UI
 * reads lists the same pages, and a share link lists only what it could serve. Titles and names are file
 * content, so they must come out escaped. Unit part on a throwaway tree; HTTP part on a throwaway server
 * (own PORT, WORKS_DIR, PTY_SOCKET) with two sh projects. No AI, no live state.
 *
 *   bun scripts/check-preview-pages.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listPreviewPages, pagesHtml, PAGES_MAX } from "../preview.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7955;
const KEY = "preview-pages-key";
const VIEWER_KEY = "preview-pages-viewer-key";
const sha256 = (x) => createHash("sha256").update(x).digest("hex");
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : detail ? `  (${String(detail).slice(0, 300)})` : ""}`);
};

/** Write a file under `dir`, creating folders, and give it a modification time (seconds). */
function put(dir, rel, body, mtime) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (mtime !== undefined) utimesSync(abs, mtime, mtime);
}

// ---------- unit: listPreviewPages and pagesHtml on a throwaway tree ----------
{
  const tmp = mkdtempSync(join(tmpdir(), "kohlab-pages-unit-"));
  try {
    const tree = join(tmp, "tree");
    const outside = join(tmp, "outside");
    mkdirSync(tree);
    put(outside, "o.html", "<title>outside</title>", 9000);
    put(tree, "a.html", "<title>  Alpha  </title>", 1000);
    put(tree, "sub/b.htm", "<p>no title here</p>", 3000);
    put(tree, "amp.html", "<title>Tom &amp; Jerry &lt;3 &quot;q&quot; it&#39;s &amp;lt;</title>", 500);
    put(tree, "t.html", "<title><b>Bold</b> <script>x()</script>page</title>", 5000);
    put(tree, "<img src=x onerror=alert(1)>.html", "<p>x</p>", 4000);
    put(tree, "node_modules/x.html", "x", 9000);
    put(tree, "dist/y.html", "y", 9000);
    put(tree, "build/z.html", "z", 9000);
    put(tree, ".hidden/h.html", "h", 9000);
    put(tree, ".kohlab/k.html", "k", 9000);
    put(tree, "sub/.dot.html", "d", 9000);
    put(tree, "notes.txt", "not a page", 9000);
    symlinkSync(join(outside, "o.html"), join(tree, "link.html"));
    symlinkSync(outside, join(tree, "linkdir"));
    for (let i = 0; i < PAGES_MAX + 5; i++) put(tree, `many/p${i}.html`, "<p>m</p>", 100);

    const got = await listPreviewPages(tree);
    check("unit: title entities decoded once", got.pages.find((p) => p.path === "amp.html")?.title === `Tom & Jerry <3 "q" it's &lt;`, JSON.stringify(got.pages.find((p) => p.path === "amp.html")));
    const ampHtml = pagesHtml("/p/tok/", got.pages.filter((p) => p.path === "amp.html"), 0);
    check("unit: decoded title is escaped again", ampHtml.includes("Tom &#38; Jerry &#60;3 &#34;q&#34; it&#39;s &#38;lt;") && !ampHtml.includes("Jerry <3"), ampHtml.slice(-300));
    const first = got.pages.slice(0, 4).map((p) => p.path);
    check("unit: most recent first", JSON.stringify(first) === JSON.stringify(["t.html", "<img src=x onerror=alert(1)>.html", "sub/b.htm", "a.html"]), JSON.stringify(first));
    check("unit: title from <title>, tags stripped", got.pages.find((p) => p.path === "t.html")?.title === "Bold x() page", JSON.stringify(got.pages.find((p) => p.path === "t.html")));
    check("unit: title from file name when none", got.pages.find((p) => p.path === "sub/b.htm")?.title === "b.htm", JSON.stringify(got.pages.find((p) => p.path === "sub/b.htm")));
    check("unit: title trimmed", got.pages.find((p) => p.path === "a.html")?.title === "Alpha", JSON.stringify(got.pages.find((p) => p.path === "a.html")));
    check("unit: changed is ms", got.pages.find((p) => p.path === "a.html")?.changed === 1000000, JSON.stringify(got.pages.find((p) => p.path === "a.html")));
    const paths = got.pages.map((p) => p.path);
    for (const bad of ["link.html", "linkdir/o.html", "node_modules/x.html", "dist/y.html", "build/z.html", ".hidden/h.html", ".kohlab/k.html", "sub/.dot.html", "notes.txt"]) {
      check(`unit: skips ${bad}`, !paths.includes(bad), bad);
    }
    check("unit: capped at PAGES_MAX", got.pages.length === PAGES_MAX, got.pages.length);
    check("unit: more counts the rest", got.more === 5 + PAGES_MAX + 5 - PAGES_MAX, got.more);

    const html = pagesHtml("/p/tok/", got.pages.slice(0, 4), 7);
    check("unit: listing has the more line", html.includes("…and 7 more"));
    check("unit: no raw script or img in listing", !/<script|<img src=x|<b>Bold/.test(html), html.slice(0, 200));
    check("unit: name escaped as text and href", html.includes("&#60;img src=x onerror=alert(1)&#62;.html") && !html.includes('href="/p/tok/<img'), html.slice(0, 400));
    check("unit: link is under the token base", html.includes('href="/p/tok/sub/b.htm"'));

    const empty = join(tmp, "empty");
    mkdirSync(empty);
    check("unit: empty folder has no pages", JSON.stringify(await listPreviewPages(empty)) === JSON.stringify({ pages: [], more: 0 }));
    check("unit: missing folder has no pages", JSON.stringify(await listPreviewPages(join(tmp, "nope"))) === JSON.stringify({ pages: [], more: 0 }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- HTTP: a throwaway server with two sh projects ----------
const tmp = mkdtempSync(join(tmpdir(), "kohlab-pages-"));
const works = join(tmp, "works");
const projects = join(tmp, "projects");
const socket = join(tmp, "pty.sock");
mkdirSync(works, { recursive: true });
mkdirSync(projects, { recursive: true });

// Seeded before the server starts: users with hashed keys (no OS account is made) and three projects written straight
// into state.json: the viewer's own, an owner's, and a team agent's workspace. lib.ts reads WORKS_DIR when it loads.
writeFileSync(join(works, "users.json"), JSON.stringify({ users: [{ id: "pv-viewer", name: "Pages viewer", role: "viewer", key: sha256(VIEWER_KEY) }] }));
process.env.WORKS_DIR = works;
const lib = await import("../lib.ts");
const seedWs = (id, extra) => ({ id, repo: "", task: id, agent: "sh", created: Date.now(), started: null, stopped: null, ownerId: "", ...extra });
await lib.mutateState((st) => {
  st.workspaces.push(seedWs("pv-viewer-own", { ownerId: "pv-viewer" }), seedWs("pv-owner-own", {}), seedWs("pv-team", { team: { id: "pv-t", role: "dev" } }));
});
for (const id of ["pv-viewer-own", "pv-owner-own", "pv-team"]) put(join(works, id, "tree"), "a.html", "<title>seed</title>");

const proc = spawn("bun", ["run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket },
  stdio: "ignore",
});

const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
const api = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });

async function makeProject(name) {
  const res = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ newProject: name, task: name, location: projects, agent: "sh" }) });
  if (!res.ok) throw new Error(`create project ${name}: ${res.status} ${await res.text()}`);
  const ws = await res.json();
  const tree = join(ws.dir ?? join(works, ws.id), "tree");
  if (!tree.startsWith(tmp)) throw new Error(`tree outside the throwaway folder: ${tree}`);
  mkdirSync(tree, { recursive: true });
  return { ws, tree };
}

/** The address of a project's owner preview: /p/<token>/. */
async function previewBase(id) {
  const res = await api(`/api/workspaces/${id}/preview`, { method: "POST", body: "{}" });
  const { url } = await res.json();
  return url;
}

try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const pages = await makeProject("pages");
  const empty = await makeProject("empty");
  const t = pages.tree;
  put(t, "a.html", "<title>Alpha</title>", 1000);
  put(t, "sub/b.htm", "<p>no title here</p>", 3000);
  put(t, "t.html", "<title><b>Bold</b> page</title><script>alert(9)</script>", 5000);
  put(t, "<img src=x onerror=alert(1)>.html", "<p>named</p>", 4000);
  put(t, "50% off.html", "<title>Sale</title>", 2000);
  put(t, "node_modules/x.html", "x", 9000);
  put(t, "dist/y.html", "y", 9000);
  put(t, ".hidden/h.html", "h", 9000);
  put(t, ".kohlab/k.html", "k", 9000);
  put(t, "sub/.dot.html", "d", 9000);
  const outside = join(tmp, "outside");
  put(outside, "o.html", "<title>outside</title>", 9000);
  symlinkSync(join(outside, "o.html"), join(t, "link.html"));
  symlinkSync(outside, join(t, "linkdir"));

  const url = await previewBase(pages.ws.id);
  const token = url.split("/")[2];
  check("owner preview address", /^\/p\/[A-Za-z0-9_-]+\/$/.test(url), url);

  // The folder with no index.html: the page list.
  const listRes = await fetch(`${base}${url}`);
  const body = await listRes.text();
  check("listing is 200", listRes.status === 200, listRes.status);
  check("listing is HTML", (listRes.headers.get("content-type") ?? "").startsWith("text/html"), listRes.headers.get("content-type"));
  check("listing is nosniff", listRes.headers.get("x-content-type-options") === "nosniff");
  check("listing keeps the sandbox CSP", (listRes.headers.get("content-security-policy") ?? "").startsWith("sandbox "), listRes.headers.get("content-security-policy"));
  check("listing has the heading", body.includes("Pages in this project"));
  const hrefs = [...body.matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]);
  check("listing has five pages (no node_modules, dot, dist, symlinks)", hrefs.length === 5, hrefs.length);
  const want = ["t.html", "%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.html", "sub/b.htm", "50%25%20off.html", "a.html"].map((p) => `${url}${p}`);
  check("most recent first", JSON.stringify(hrefs) === JSON.stringify(want), hrefs.join(" "));
  for (const h of hrefs) {
    const r = await fetch(`${base}${h}`);
    check(`link works: ${decodeURIComponent(h.slice(url.length))}`, r.status === 200, r.status);
  }
  check("no raw script or img from names", !/<script|<img src=x|<b>Bold/.test(body));
  check("title markup comes out as text", body.includes("Bold page") && !body.includes("<b>Bold"));
  check("name shown escaped", body.includes("&#60;img src=x onerror=alert(1)&#62;.html"));
  check("folder shown muted", body.includes('<span class="dir">sub/</span>'));
  const head = await fetch(`${base}${url}`, { method: "HEAD" });
  check("HEAD on the listing is 200", head.status === 200, head.status);
  // %2e%2e/ would be normalised by the URL parser before the server sees it, so the climbs use an encoded slash.
  const traversal = [`${url}%2e%2e%2fx.html`, `${url}%2e%2e%2f`, `${url}.hidden/h.html`, `${url}.kohlab/k.html`, `${url}linkdir/o.html`, `${url}link.html`];
  for (const p of traversal) {
    const r = await fetch(`${base}${p}`);
    check(`refused ${p.slice(url.length)}`, r.status === 404, r.status);
  }
  const badDir = await fetch(`${base}${url}%2e%2e%2fx/`);
  const badDirBody = await badDir.text();
  check("invalid folder keeps the friendly 404", badDir.status === 404 && badDirBody.includes("Nothing to preview yet"), badDir.status);
  const post = await fetch(`${base}${url}`, { method: "POST", body: "x" });
  check("POST to the listing is 405", post.status === 405, post.status);

  // The JSON route the UI reads.
  const j = await api(`/api/workspaces/${pages.ws.id}/pages`);
  const jb = await j.json();
  check("JSON pages is 200", j.status === 200, j.status);
  check("JSON pages has five entries in order", JSON.stringify(jb.pages?.map((p) => p.path)) === JSON.stringify(["t.html", "<img src=x onerror=alert(1)>.html", "sub/b.htm", "50% off.html", "a.html"]), JSON.stringify(jb.pages?.map((p) => p.path)));
  check("JSON entries have path, title, changed", (jb.pages ?? []).every((p) => Object.keys(p).sort().join() === "changed,path,title" && typeof p.changed === "number"));
  check("JSON title of t.html", jb.pages?.[0]?.title === "Bold page", JSON.stringify(jb.pages?.[0]));
  const noKey = await fetch(`${base}/api/workspaces/${pages.ws.id}/pages`);
  check("JSON without a key is 401", noKey.status === 401, noKey.status);
  const unknown = await api("/api/workspaces/no-such-id/pages");
  check("JSON unknown id is 404", unknown.status === 404, unknown.status);
  const shell = await api("/api/workspaces/server-shell/pages");
  check("JSON server shell id is 404", shell.status === 404, shell.status);
  const post2 = await api(`/api/workspaces/${pages.ws.id}/pages`, { method: "POST", body: "{}" });
  check("JSON POST is 405", post2.status === 405, post2.status);
  const shareParam = await api(`/api/workspaces/${pages.ws.id}/pages?share=${token}`);
  check("JSON with a share param is 403", shareParam.status === 403, shareParam.status);

  // Who may read the list: a viewer reads their own project, not the owner's; a team agent's workspace is 404 even for the owner.
  const asViewer = (id) => fetch(`${base}/api/workspaces/${id}/pages`, { headers: { authorization: `Bearer ${VIEWER_KEY}` } });
  const vOwn = await asViewer("pv-viewer-own");
  check("JSON viewer reads their own project", vOwn.status === 200 && (await vOwn.json()).pages?.[0]?.path === "a.html", vOwn.status);
  check("JSON viewer is refused the owner's project", (await asViewer("pv-owner-own")).status === 403);
  check("JSON owner reads any project", (await api("/api/workspaces/pv-viewer-own/pages")).status === 200);
  check("JSON team agent workspace is 404", (await api("/api/workspaces/pv-team/pages")).status === 404);
  check("JSON team agent workspace is 404 for a viewer", (await asViewer("pv-team")).status === 404);

  // The empty project: the friendly text, unchanged.
  const emptyUrl = await previewBase(empty.ws.id);
  const er = await fetch(`${base}${emptyUrl}`);
  const ebody = await er.text();
  check("empty project is 404", er.status === 404, er.status);
  check("empty project keeps the friendly text", ebody.includes("Nothing to preview yet. Ask Claude to build a web page, then press Preview again."), ebody.slice(0, 200));
  const emptyPages = await (await api(`/api/workspaces/${empty.ws.id}/pages`)).json();
  check("empty project JSON has no pages", Array.isArray(emptyPages.pages) && emptyPages.pages.length === 0, JSON.stringify(emptyPages));

  // A share link lists only what the file route would serve.
  const link = await api(`/api/workspaces/${pages.ws.id}/link`, { method: "POST", body: JSON.stringify({ expires: "never" }) });
  const shareUrl = (await link.json()).url;
  check("share link made", /^\/p\/[A-Za-z0-9_-]+\/$/.test(shareUrl ?? ""), shareUrl);
  const sr = await fetch(`${base}${shareUrl}`);
  const sbody = await sr.text();
  const shareHrefs = [...sbody.matchAll(/<li><a href="([^"]+)"/g)].map((m) => m[1]);
  check("share listing is 200", sr.status === 200, sr.status);
  check("share listing has the same five pages", shareHrefs.length === 5 && shareHrefs.every((h) => h.startsWith(shareUrl)), shareHrefs.join(" "));
  check("share listing keeps the sandbox CSP", (sr.headers.get("content-security-policy") ?? "").startsWith("sandbox "));
  const shareLink = shareHrefs[0];
  if (shareLink) check("share link opens a page", (await fetch(`${base}${shareLink}`)).status === 200);
  check("share traversal refused", (await fetch(`${base}${shareUrl}%2e%2e%2fx.html`)).status === 404);
  const emptyLink = await api(`/api/workspaces/${empty.ws.id}/link`, { method: "POST", body: JSON.stringify({ expires: "never" }) });
  const emptyShare = (await emptyLink.json()).url;
  const esr = await fetch(`${base}${emptyShare}`);
  check("share of an empty project stays 404 Not found", esr.status === 404 && (await esr.text()) === "Not found", esr.status);

  // index.html present: served as before, no list.
  put(t, "index.html", "<!doctype html><title>Home</title><p>home page</p>", 6000);
  const ir = await fetch(`${base}${url}`);
  const ibody = await ir.text();
  check("index.html is served", ir.status === 200 && ibody.includes("home page"), ir.status);
  check("index.html keeps the sandbox CSP", (ir.headers.get("content-security-policy") ?? "").startsWith("sandbox "));
  check("index.html is not replaced by the list", !ibody.includes("Pages in this project"));
  // An index.html in a subfolder only answers that folder; the rest of the project still lists.
  put(t, "sub/index.html", "<p>sub home</p>", 7000);
  const subHome = await (await fetch(`${base}${url}sub/`)).text();
  check("sub folder index.html is served at its folder", subHome.includes("sub home"));
  rmSync(join(t, "index.html"));
  const rootAgain = await (await fetch(`${base}${url}`)).text();
  check("without the root index.html the list is back", rootAgain.includes("Pages in this project"));
} finally {
  proc.kill("SIGKILL");
  // the PTY daemon the throwaway server started: match on our own socket only
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${socket}`)) continue;
      process.kill(Number(pid), "SIGTERM");
    } catch {
      /* gone, or not ours */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall preview page checks passed");
process.exit(failures ? 1 : 0);
