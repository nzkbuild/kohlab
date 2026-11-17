#!/usr/bin/env node
/**
 * The browser terminal must keep repainting after a DECRQM query (ESC[?2026$p), which Claude Code
 * sends at start-up. A broken xterm bundle threw ReferenceError on the query, stopped its write loop,
 * and the screen froze: typed output never reached the screen again.
 *
 * Throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) with one sh terminal project, against the built
 * web/dist. Types a DECRQM query and an echo into the shell, then waits for the echo's own line on the
 * xterm screen and for no page error. Skips with a printed reason when playwright-core or Chromium is missing.
 *
 *   cd web && bun run build && node scripts/check-terminal-decrqm.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser, openContext } from "./ui-fixture.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7935;
const KEY = "terminal-decrqm-key";
const base = `http://127.0.0.1:${PORT}`;

const found = findBrowser();
if (!found) {
  console.log("skip: needs playwright-core and Chromium");
  process.exit(0);
}
if (!existsSync(join(ROOT, "web/dist/index.html"))) {
  console.log("FAIL  web/dist is not built (cd web && bun run build)");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const tmp = mkdtempSync(join(tmpdir(), "kohlab-decrqm-"));
const works = join(tmp, "works");
const projects = join(tmp, "projects");
const socket = join(tmp, "pty.sock");
mkdirSync(works, { recursive: true });
mkdirSync(projects, { recursive: true });

const proc = spawn("bun", ["run", "server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket },
  stdio: "ignore",
});

let browser;
try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // A sh terminal project in a throwaway folder (not the user's projects folder).
  const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  const res = await fetch(`${base}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newProject: "decrqm", task: "decrqm", location: projects, agent: "sh" }),
  });
  if (!res.ok) throw new Error(`create project: ${res.status} ${await res.text()}`);
  const ws = await res.json();

  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  const ctx = await openContext(browser, { key: KEY });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${base}/w/${ws.id}`);
  const rows = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((r) => (r.textContent ?? "").trim()));
  // The shell prompt has arrived once the screen has any text on it.
  const up = await page
    .waitForFunction(() => [...document.querySelectorAll(".xterm-rows > div")].some((r) => (r.textContent ?? "").trim() !== ""), null, { timeout: 20000 })
    .then(() => true, () => false);
  check("terminal shows a shell prompt", up);

  if (up) {
    await page.locator(".xterm").first().click();
    await page.keyboard.type("printf '\\033[?2026$p'; echo AFTERDECRQM");
    await page.keyboard.press("Enter");
    // The echo's own output is a line of exactly AFTERDECRQM; the typed command line is not.
    const seen = await page
      .waitForFunction(() => [...document.querySelectorAll(".xterm-rows > div")].some((r) => (r.textContent ?? "").trim() === "AFTERDECRQM"), null, { timeout: 8000 })
      .then(() => true, () => false);
    check("after a DECRQM query the screen still shows AFTERDECRQM", seen, seen ? "" : (await rows()).filter(Boolean).slice(-3).join(" | "));
  }
  check("no page error (the terminal did not throw)", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ").slice(0, 300));

  await ctx.close();
} finally {
  await browser?.close();
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

console.log(failures ? `\n${failures} failed` : "\nall terminal DECRQM checks passed");
process.exit(failures ? 1 : 0);
