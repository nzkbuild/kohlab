#!/usr/bin/env node
// The version handshake (F1). An open page learns when the server it talks to runs a newer build: the bar appears
// with one Reload, a draft blocks any automatic reload, and a deleted lazy chunk ends in the bar, not a dead pane.
//
// Chromium against a throwaway server on its own PORT, WORKS_DIR and PTY_SOCKET. It serves copies of web/dist
// (KOHLAB_WEB_DIST), so the real build is never touched. Build B is a copy of build R with its id replaced, so the
// bundle and the server agree on B the way a real release does. Skips with a printed reason when Chromium is missing.
//
//   cd web && bun run build && node scripts/check-version-handshake.mjs
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser, openContext } from "./ui-fixture.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7969;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "handshake-check-key";
const BAR = "A new version of Kohlab is ready";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const found = findBrowser();
if (!found) {
  console.log("skip: needs playwright-core and Chromium");
  process.exit(0);
}
if (!existsSync(join(ROOT, "web/dist/build-id.txt"))) {
  console.log("FAIL  web/dist has no build-id.txt: rebuild first (cd web && bun run build)");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const tmp = mkdtempSync(join(tmpdir(), "kohlab-handshake-"));
const works = join(tmp, "works");
const socket = join(tmp, "pty.sock");
const distA = join(tmp, "dist-a");
const distB = join(tmp, "dist-b");
let server = null;
let serverLog = "";

/** Same rule as check-all: kill only the daemon this run spawned, matched by its own PTY_SOCKET. */
function killDaemon() {
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
      if (!readFileSync(`/proc/${pid}/environ`, "utf8").includes(`PTY_SOCKET=${socket}`)) continue;
      process.kill(Number(pid), "SIGKILL");
    } catch {
      /* gone, or not ours */
    }
  }
}

function start(dist, build) {
  const env = { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket, KOHLAB_WEB_DIST: dist };
  delete env.KOHLAB_BUILD;
  if (build) env.KOHLAB_BUILD = build;
  serverLog = "";
  server = spawn("bun", ["run", "server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => (serverLog += d));
  server.stderr.on("data", (d) => (serverLog += d));
}

async function up() {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) return true;
    await sleep(150);
  }
  return false;
}

function stop() {
  try {
    server?.kill("SIGKILL");
  } catch {
    /* gone */
  }
  server = null;
  killDaemon();
}

/** Every /api answer, signed in and not, and the unknown route: each must name the build. */
async function apiBuilds() {
  const probes = [
    ["/api/health", {}],
    ["/api/auth/required", {}],
    ["/api/workspaces", {}],
    ["/api/workspaces", { authorization: `Bearer ${KEY}` }],
    ["/api/account", { authorization: `Bearer ${KEY}` }],
    ["/api/no-such-route", {}],
  ];
  const out = [];
  for (const [path, headers] of probes) {
    const res = await fetch(BASE + path, { headers });
    out.push({ path, status: res.status, build: res.headers.get("x-kohlab-build") });
  }
  return out;
}

/** The first frame a dashboard socket gets. */
function hello() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, [`kohlab.key.${KEY}`]);
    const timer = setTimeout(() => {
      ws.close();
      resolve(null);
    }, 5000);
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      ws.close();
      try {
        resolve(JSON.parse(String(ev.data)));
      } catch {
        resolve(null);
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
  });
}

const barOn = (page) => page.getByRole("status").filter({ hasText: BAR });

try {
  cpSync(join(ROOT, "web/dist"), distA, { recursive: true });
  cpSync(join(ROOT, "web/dist"), distB, { recursive: true });
  const R = readFileSync(join(distA, "build-id.txt"), "utf8").trim();
  const B = `${R}-next`;

  // Build B: a new release. The bundle carries the new id, and every hashed asset gets a new name as a rebuild gives,
  // so the browser cannot serve B's URLs from its cache of A after Reload. The bundle must carry its id, or this proves nothing.
  const assetsB = join(distB, "assets");
  const renamed = readdirSync(assetsB)
    .filter((f) => /\.(js|css)$/.test(f))
    .map((f) => [f, f.replace(/\.(js|css)$/, (ext) => `-next${ext}`)]);
  let carried = 0;
  for (const path of [join(distB, "index.html"), ...renamed.map(([from]) => join(assetsB, from))]) {
    let text = readFileSync(path, "utf8");
    if (text.includes(R)) carried++;
    text = text.split(R).join(B);
    for (const [from, to] of renamed) text = text.split(from).join(to);
    writeFileSync(path, text);
  }
  for (const [from, to] of renamed) renameSync(join(assetsB, from), join(assetsB, to));
  writeFileSync(join(distB, "build-id.txt"), `${B}\n`);
  check("the bundle carries its build id", carried > 0, `${carried} file(s) hold ${R}`);

  const apiLevel = Number(readFileSync(join(ROOT, "web/src/lib/apiLevel.ts"), "utf8").match(/API_LEVEL = (\d+)/)?.[1]);

  start(distA);
  check("server on build R is up", await up(), serverLog.trim().slice(-300));
  const hA = await hello();
  check("hello carries build R and the shared API level", hA?.type === "hello" && hA.build === R && hA.apiLevel === apiLevel, JSON.stringify(hA));
  const probesA = await apiBuilds();
  const badA = probesA.filter((p) => p.build !== R);
  check("every /api answer names build R", badA.length === 0, badA.map((p) => `${p.path} ${p.status} ${p.build}`).join(", "));

  const browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  try {
    const ctx = await openContext(browser, { key: KEY, width: 1280, height: 900 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await page.locator("h1").first().waitFor({ timeout: 15000 }).catch(() => {});
    await sleep(2500);
    check("a page on build R shows no bar", !(await barOn(page).isVisible()));

    stop();
    start(distB, B);
    check("server on build B is up after a restart", await up(), serverLog.trim().slice(-300));
    const shown = await barOn(page).waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false);
    check("the open page shows the bar within 10 s of the restart", shown);

    const hB = await hello();
    check("hello carries build B", hB?.build === B && hB.apiLevel === apiLevel, JSON.stringify(hB));
    const probesB = await apiBuilds();
    const badB = probesB.filter((p) => p.build !== B);
    check("every /api answer names build B", badB.length === 0, badB.map((p) => `${p.path} ${p.status} ${p.build}`).join(", "));

    // A draft in the composer blocks the automatic reload (the chunk-failure path), but the bar still shows.
    const composer = page.locator("textarea").first();
    await composer.fill("an unsent sentence");
    await sleep(700);
    await page.evaluate(() => {
      window.__marker = "kept";
      window.dispatchEvent(new Event("vite:preloadError"));
    });
    await sleep(1500);
    const kept = await page.evaluate(() => window.__marker === "kept");
    check("a draft blocks the automatic reload, and the bar shows", kept && (await barOn(page).isVisible()));

    // Reload is the person's choice, and it lands on build B.
    await page.getByRole("button", { name: "Reload", exact: true }).click();
    await page.locator("h1").first().waitFor({ timeout: 15000 }).catch(() => {});
    await sleep(3000);
    check("Reload gives build B: the bar is gone", !(await barOn(page).isVisible()));

    // No draft: one automatic reload for a failed chunk, then the session flag stops a loop. The draft kept
    // above is in localStorage and survives the Reload, so it has to go first.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith("kohlab.draft.")) localStorage.removeItem(k);
    });
    await sleep(500);
    const reloaded = page.waitForEvent("load", { timeout: 8000 }).then(() => true, () => false);
    await page.evaluate(() => window.dispatchEvent(new Event("vite:preloadError")));
    check("with no draft, a failed chunk reloads the page once", await reloaded);
    await sleep(2000);
    await page.evaluate(() => {
      window.__marker = "kept";
      window.dispatchEvent(new Event("vite:preloadError"));
    });
    await sleep(1500);
    check("a second failed chunk in the same session does not reload again", (await page.evaluate(() => window.__marker)) === "kept");

    // A deleted lazy chunk: the server page for /terminal loads TerminalView on demand.
    // emptyOutDir is false, so older builds' copies sit beside the current one: delete every copy.
    const terminalChunks = readdirSync(join(distB, "assets")).filter((f) => f.startsWith("TerminalView-") && f.endsWith(".js"));
    check("the build has a lazy TerminalView chunk to delete", terminalChunks.length > 0);
    for (const f of terminalChunks) rmSync(join(distB, "assets", f));
    const page2 = await ctx.newPage();
    await page2.goto(`${BASE}/terminal`);
    const chunkBar = await barOn(page2).waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false);
    check("a deleted chunk ends in the bar", chunkBar);
    const reload = await page2.getByRole("button", { name: "Reload", exact: true }).count();
    const retry = await page2.getByRole("button", { name: "retry", exact: true }).count();
    check("the failed pane offers Reload, not retry", reload >= 1 && retry === 0, `Reload ${reload}, retry ${retry}`);
  } finally {
    await browser.close();
  }
} catch (e) {
  failures++;
  console.log(`FAIL  ${e.message}`);
} finally {
  stop();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall version handshake checks passed");
process.exit(failures ? 1 : 0);
