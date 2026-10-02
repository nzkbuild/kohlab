#!/usr/bin/env node
// Rendered-UI checks, in a real browser, against the built app (web/dist).
//
// The static scans read source; these read what a person gets. Each assertion
// is a claim the docs make about the UI that nothing else verifies:
//   - home is the review queue, and /new arrives with the create form open
//   - a workspace that needs review opens on Review, and the tab is in the URL
//   - no horizontal page scroll at 320, 390, 768, 1280
//   - exactly one <h1> per route
//   - every visible control is at least 24x24 (WCAG 2.5.8, contract rule 7)
//   - nothing is fetched from another origin (Monaco used to come from a CDN)
//   - the CSP is sent and the page raises no violation or error
//
// No new dependency: it uses a playwright-core and a Chromium already on the
// machine (KOHLAB_PLAYWRIGHT / KOHLAB_CHROME to point at them). Without both it
// skips with a printed reason, like the root-only checks do.
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 7841;
const KEY = "browser-check-key";
const base = `http://127.0.0.1:${PORT}`;

function find(candidates) {
  return candidates.find((p) => p && existsSync(p));
}
function globDirs(dir, prefix, suffix) {
  try {
    return readdirSync(dir).filter((d) => d.startsWith(prefix)).map((d) => join(dir, d, suffix));
  } catch {
    return [];
  }
}

const pwPath = find([
  process.env.KOHLAB_PLAYWRIGHT,
  ...globDirs(join(homedir(), ".npm/_npx"), "", "node_modules/playwright-core"),
]);
const chrome = find([
  process.env.KOHLAB_CHROME,
  ...globDirs(join(homedir(), ".cache/ms-playwright"), "chromium-", "chrome-linux64/chrome"),
  ...globDirs(join(homedir(), ".cache/ms-playwright"), "chromium-", "chrome-linux/chrome"),
]);
if (!pwPath || !chrome) {
  console.log(`skip: needs playwright-core and Chromium (found ${pwPath ? "playwright" : "no playwright"}, ${chrome ? "chrome" : "no chrome"})`);
  process.exit(0);
}
if (!existsSync("web/dist/index.html")) {
  console.log("FAIL  web/dist is not built (cd web && bun run build)");
  process.exit(1);
}
const { chromium } = createRequire(import.meta.url)(pwPath);

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
}

// One workspace waiting for review, one stopped clean.
const dir = mkdtempSync(join(tmpdir(), "kohlab-browser-"));
const SOCKET = join(tmpdir(), `kohlab-browser-${process.pid}.sock`);
const now = Date.now();
writeFileSync(
  join(dir, "state.json"),
  JSON.stringify({
    schemaVersion: 1,
    agents: { sh: "sh" },
    workspaces: [
      { id: "ws-review", repo: dir, task: "a finished task waiting for a decision", agent: "sh", created: now - 7_200_000, started: now - 7_000_000, stopped: now - 3_600_000 },
      { id: "ws-idle", repo: dir, task: "never started", agent: "sh", created: now - 86_400_000, started: null, stopped: null },
    ],
  }),
);

const proc = spawn("bun", ["run", "server.ts"], {
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: dir, PTY_SOCKET: SOCKET },
  stdio: "ignore",
});

let browser;
try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const head = await fetch(`${base}/`);
  check("CSP header is sent", !!head.headers.get("content-security-policy"));
  check("nosniff and no-referrer are sent", head.headers.get("x-content-type-options") === "nosniff" && head.headers.get("referrer-policy") === "no-referrer");

  browser = await chromium.launch({ executablePath: chrome });

  for (const width of [320, 390, 768, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await ctx.newPage();
    const external = [];
    const problems = [];
    page.on("request", (r) => {
      const u = r.url();
      if (!u.startsWith(base) && !/^(data|blob):/.test(u)) external.push(u);
    });
    page.on("pageerror", (e) => problems.push(e.message));
    page.on("console", (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text());
    });

    // The key arrives once in the URL, is adopted into storage and stripped.
    await page.goto(`${base}/?key=${KEY}`);
    await page.waitForSelector("h1");
    const routes = [
      ["/", "home"],
      ["/new", "new"],
      ["/w/ws-review", "workspace"],
      ["/settings", "settings"],
    ];
    for (const [path, name] of routes) {
      await page.goto(base + path);
      await page.waitForSelector("h1");
      await page.waitForTimeout(600);
      const m = await page.evaluate(() => {
        const visible = (el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !el.closest("[hidden], .xterm");
        };
        const small = [...document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=tab]")]
          .filter(visible)
          // A control inside its own <label> gets the label's hit area (checkboxes).
          .filter((el) => !(el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")))
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .filter(({ r }) => r.width < 23.5 || r.height < 23.5)
          .map(({ el, r }) => `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}[${el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 20)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
        return {
          path: location.pathname,
          h1: document.querySelectorAll("h1").length,
          overflow: document.scrollingElement.scrollWidth - innerWidth,
          surfaceOverflow: [...document.querySelectorAll(".surface")].reduce((n, s) => Math.max(n, s.scrollWidth - s.clientWidth), 0),
          small,
          form: !!document.querySelector("#launch-task"),
          queue: [...document.querySelectorAll("h2")].some((h) => /Waiting for you/.test(h.textContent)),
          // Radix generates the trigger id; the pane name is its suffix.
          tab: document.querySelector("[role=tab][aria-selected=true]")?.id.replace(/^.*-trigger-/, "tab-") ?? null,
        };
      });
      const at = `${name} @${width}`;
      check(`${at}: one h1`, m.h1 === 1, `${m.h1}`);
      check(`${at}: no horizontal scroll`, m.overflow <= 0 && m.surfaceOverflow <= 0, `page ${m.overflow}px, surface ${m.surfaceOverflow}px`);
      check(`${at}: controls at least 24px`, m.small.length === 0, m.small.slice(0, 4).join(", "));
      if (name === "home") check(`${at}: review queue leads`, m.queue);
      if (name === "new") check(`${at}: /new opens the form`, m.form);
      if (name === "workspace") {
        check(`${at}: needs-review opens on Review`, m.tab === "tab-review", `${m.tab}`);
        check(`${at}: the tab is in the URL`, m.path === "/w/ws-review/review", m.path);
      }
    }
    check(`@${width}: no request leaves this server`, external.length === 0, external.slice(0, 3).join(" "));
    check(`@${width}: no CSP violation or page error`, problems.length === 0, problems.slice(0, 2).join(" | "));
    await ctx.close();
  }
} finally {
  await browser?.close();
  proc.kill("SIGKILL");
  try {
    const pid = execSync(`ss -xlp 2>/dev/null | grep -F '${SOCKET}' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2`, { encoding: "utf8" }).trim();
    if (pid) process.kill(Number(pid), "SIGKILL");
  } catch {
    /* no daemon was started */
  }
  rmSync(SOCKET, { force: true });
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall browser checks passed");
process.exit(failures ? 1 : 0);
