#!/usr/bin/env node
// Terminal touch scroll, in a real phone-sized Chromium.
//
// @xterm/xterm 6.0.0 had no touch scrolling, so a swipe in Claude's terminal
// did nothing on a phone. The fix landed in the 6.1 beta series; web/package.json
// pins 6.1.0-beta.304. Move to 6.1.0 stable when it is released, and keep this
// check so a future bump cannot quietly bring the bug back.
//
// No new dependency: it uses a playwright-core and a Chromium already on the
// machine (KOHLAB_PLAYWRIGHT / KOHLAB_CHROME to point at them). Without both it
// skips with a printed reason, like check-browser.mjs does.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

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
const { chromium } = createRequire(import.meta.url)(pwPath);

const xtermDir = join(ROOT, "web/node_modules/@xterm/xterm");
const html = `<!doctype html><html><head><meta name=viewport content="width=device-width"><style>${readFileSync(join(xtermDir, "css/xterm.css"), "utf8")} body{margin:0} #t{height:600px}</style></head><body><div id=t></div><script>${readFileSync(join(xtermDir, "lib/xterm.js"), "utf8")}</script><script>
const term = new Terminal({ scrollback: 1000 });
term.open(document.getElementById("t"));
let s = ""; for (let i = 1; i <= 400; i++) s += i + "\\r\\n";
term.write(s);
window.term = term;
</script></body></html>`;

const browser = await chromium.launch({ executablePath: chrome });
let failed = false;
try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.waitForTimeout(800);
  const before = await page.evaluate(() => term.buffer.active.viewportY);

  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Input.synthesizeScrollGesture", { x: 200, y: 200, yDistance: 400, gestureSourceType: "touch", speed: 800 });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => term.buffer.active.viewportY);

  const moved = before - after;
  const ok = moved >= 10;
  failed = !ok;
  console.log(`${ok ? "ok " : "FAIL"}  touch swipe scrolls the terminal back  ${before} -> ${after}`);
} finally {
  await browser.close();
}

process.exit(failed ? 1 : 0);
