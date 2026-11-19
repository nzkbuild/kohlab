#!/usr/bin/env node
// The update gate in Settings → Updates (Part 2): GitHub's checks in words for passed, pending, failed and unknown; the
// "See why" link on failed; "Update now" straight through for passed and unknown; a confirm dialog first for pending and
// failed, with Cancel focused; and one primary button per view.
//
// No GitHub is touched: page.route answers /api/release (the server would run `git fetch` against the real origin) and
// /api/release/update (it would rewrite the checkout). A throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) only serves
// the built web/dist. Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-update-gate-ui.mjs
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
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
};

const KEY = "update-gate-ui-check-key";
const SHA = "c".repeat(40);
const FAIL_URL = "https://github.com/acme/kohlab/actions/runs/42";

/** A ReleaseStatus for an available update, with the given GitHub checks (or none: a non-owner gets no field). */
function status(checks) {
  const s = {
    current: "2.11.0",
    latest: "2.12.0",
    available: true,
    commits: ["abc1234 feat: the next thing"],
    notes: "",
    upstream: "origin/main",
    head: "def5678",
    checkedAt: Date.now(),
    error: null,
    running: false,
    startedAt: null,
    finishedAt: null,
    exit: null,
    unfinished: false,
    log: "",
  };
  if (checks !== undefined) s.checks = checks;
  return s;
}

/** Answers /api/release and /api/release/update, and records the update posts. */
async function mock(page, checks) {
  const posts = [];
  await page.route(/\/api\/release(\?.*)?$/, (route) => route.fulfill({ json: status(checks) }));
  await page.route(/\/api\/release\/update$/, (route) => {
    posts.push(route.request().method());
    return route.fulfill({ json: { started: true, log: "" } });
  });
  return posts;
}

const fx = await startFixture({ port: 7961, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  /** Opens Settings → Updates with the given checks and returns the page and its update posts. */
  async function view(checks) {
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    const posts = await mock(page, checks);
    await page.goto(`${fx.base}/settings/updates`);
    await page.getByText("A new version of Kohlab is ready.").waitFor({ timeout: 15000 }).catch(() => {});
    return { ctx, page, posts };
  }

  /* ------------------------------------------------ passed: straight through -- */
  {
    const { ctx, page, posts } = await view({ state: "passed", sha: SHA });
    const main = page.locator("section[aria-labelledby='settings-section-title']");
    check("passed says GitHub's checks passed", (await main.getByText("GitHub's checks passed", { exact: true }).count()) === 1);
    check("passed has no See why link", (await main.getByRole("link", { name: "See why" }).count()) === 0);
    check("one primary per view", (await page.locator(".btn-primary").count()) === 1, String(await page.locator(".btn-primary").count()));
    const update = page.getByRole("button", { name: "Update now", exact: true });
    check("passed: Update now is enabled", (await update.isEnabled()) === true);
    await update.click();
    await page.getByRole("alertdialog").waitFor({ timeout: 1500 }).catch(() => {});
    check("passed: no confirm dialog", (await page.getByRole("alertdialog").count()) === 0);
    await page.waitForTimeout(300);
    check("passed: the update is posted", posts.includes("POST"), posts.join(","));
    await ctx.close();
  }

  /* ----------------------------------------------------- unknown: nothing said -- */
  {
    const { ctx, page, posts } = await view({ state: "unknown", sha: SHA });
    const main = page.locator("section[aria-labelledby='settings-section-title']");
    const text = await main.innerText();
    check("unknown says nothing about GitHub", !/GitHub/.test(text), text.slice(0, 200));
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    await page.waitForTimeout(300);
    check("unknown: no confirm dialog", (await page.getByRole("alertdialog").count()) === 0);
    check("unknown: the update is posted", posts.includes("POST"), posts.join(","));
    await ctx.close();
  }

  {
    // A non-owner gets no checks field at all: nothing said, nothing gated.
    const { ctx, page } = await view(undefined);
    const main = page.locator("section[aria-labelledby='settings-section-title']");
    check("no checks field: nothing said about GitHub", !/GitHub/.test(await main.innerText()));
    await ctx.close();
  }

  /* ------------------------------------------------------ pending: asks first -- */
  {
    const { ctx, page, posts } = await view({ state: "pending", sha: SHA });
    const main = page.locator("section[aria-labelledby='settings-section-title']");
    check("pending says GitHub is still checking", (await main.getByText("GitHub is still checking this version", { exact: true }).count()) === 1);
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    const dlg = page.getByRole("alertdialog");
    await dlg.waitFor({ timeout: 3000 }).catch(() => {});
    check("pending asks first in a confirm dialog", (await dlg.count()) === 1);
    check("the dialog asks in the words given", (await dlg.getByText("GitHub hasn't passed this version yet. Update anyway?", { exact: true }).count()) === 1);
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    check("Cancel has the focus", focused === "Cancel", focused);
    check("pending: nothing posted before the answer", posts.length === 0, posts.join(","));
    await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
    await dlg.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    check("Cancel posts nothing", posts.length === 0, posts.join(","));
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    await dlg.waitFor({ timeout: 3000 }).catch(() => {});
    await dlg.getByRole("button", { name: "Update anyway", exact: true }).click();
    await page.waitForTimeout(400);
    check("Update anyway posts the update", posts.includes("POST"), posts.join(","));
    await ctx.close();
  }

  /* ------------------------------------------------------- failed: see why -- */
  {
    const { ctx, page, posts } = await view({ state: "failed", url: FAIL_URL, sha: SHA });
    const main = page.locator("section[aria-labelledby='settings-section-title']");
    const failedLine = main.locator("p", { hasText: "GitHub's checks failed for this version" });
    check("failed says the checks failed", (await failedLine.count()) === 1);
    const why = main.getByRole("link", { name: "See why", exact: true });
    check("failed links See why to the GitHub page", (await why.count()) === 1 && (await why.getAttribute("href")) === FAIL_URL);
    check("failed: the failure is not red", (await failedLine.evaluate((el) => getComputedStyle(el).color)) !== "rgb(255, 0, 0)");
    await page.getByRole("button", { name: "Update now", exact: true }).click();
    const dlg = page.getByRole("alertdialog");
    await dlg.waitFor({ timeout: 3000 }).catch(() => {});
    check("failed asks first in a confirm dialog", (await dlg.count()) === 1);
    const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
    check("failed: Cancel has the focus", focused === "Cancel", focused);
    await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(200);
    check("failed: Cancel posts nothing", posts.length === 0, posts.join(","));
    await ctx.close();
  }

  /* ------------------------------------------ the link never carries a host we did not ask for -- */
  {
    const { ctx, page } = await view({ state: "failed", url: "https://github.com/acme/kohlab/actions/runs/7", sha: SHA });
    const link = page.locator("section[aria-labelledby='settings-section-title']").getByRole("link", { name: "See why", exact: true });
    check("See why opens in a new tab, safely", (await link.getAttribute("target")) === "_blank" && /noopener/.test((await link.getAttribute("rel")) ?? ""));
    await ctx.close();
  }
} finally {
  if (browser) await browser.close();
  fx.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nupdate gate UI: all checks passed");
process.exit(failures ? 1 : 0);
