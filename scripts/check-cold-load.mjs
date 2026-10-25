#!/usr/bin/env node
// A hard load of a project must not crash the page. A hook placed after `if (!w) return` made
// "Workspace failed to render" (React error #310) appear when the project list arrived after the first
// render; it showed on reloads, not on clicks, so nothing else caught it.
//
// Runs 8 hard loads each of /w/<id> and /w/<id>/chat in ONE browser context (the crash was
// intermittent), on a throwaway server (own PORT, WORKS_DIR, PTY_SOCKET), against the built web/dist.
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-cold-load.mjs
import { existsSync } from "node:fs";
import { findBrowser, openContext, startFixture } from "./ui-fixture.mjs";

const found = findBrowser();
if (!found) {
  console.log("skip: needs playwright-core and Chromium");
  process.exit(0);
}
if (!existsSync("web/dist/index.html")) {
  console.log("FAIL  web/dist is not built (cd web && bun run build)");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

const KEY = "cold-load-key";
const fx = await startFixture({ port: 7871, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  for (const width of [1280, 390]) {
    const ctx = await openContext(browser, { width, height: 844, key: KEY, touch: width < 600 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    for (const path of [`/w/${fx.ready}`, `/w/${fx.ready}/chat`, `/w/${fx.fresh}/chat`]) {
      let crashed = 0;
      let blank = 0;
      for (let i = 0; i < 8; i++) {
        await page.goto(fx.base + path);
        await page.locator("h1").first().waitFor({ timeout: 15000 }).catch(() => blank++);
        // give the late list/poll replies time to land: that is when the crash happened
        await page.waitForTimeout(700);
        if (await page.getByText(/failed to render/i).count()) crashed++;
      }
      check(`@${width} ${path.replace(/^\/w\/[^/]+/, "/w/<id>")}: 8 hard loads, none crash`, crashed === 0 && blank === 0, `${crashed} crashed, ${blank} blank`);
    }
    check(`@${width}: no console error or page error`, errors.length === 0, errors.slice(0, 2).join(" | ").slice(0, 300));
    await ctx.close();
  }
} finally {
  await browser?.close();
  fx.stop();
}
console.log(failures ? `\n${failures} failed` : "\nall cold-load checks passed");
process.exit(failures ? 1 : 0);
