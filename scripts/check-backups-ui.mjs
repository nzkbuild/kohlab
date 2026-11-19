#!/usr/bin/env node
// Settings → Backups (Part 3): the owner's panel in words. The last good backup, a failed last run with its reason, the
// stale line after 3 days, daily on/off, the saved copies with Download and Delete (confirmed), Back up now as the one
// primary, a 409 while a run is going, the quiet off-computer disclosure, nothing on Home, and no Backups tab for members.
//
// No backup is made and no GitHub is touched: page.route answers /api/backups (list, run, download, delete) and
// /api/release (the server would run `git fetch` against the real origin). A throwaway server (own PORT, WORKS_DIR,
// PTY_SOCKET) only serves the built web/dist. Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-backups-ui.mjs
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

const KEY = "backups-ui-check-key";
const DAY = 86_400_000;
const MB = 1024 * 1024;

const archive = (daysAgo, bytes = 2 * MB) => {
  const at = Date.now() - daysAgo * DAY;
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  const name = `kohlab-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.tar.gz`;
  return { name, at, bytes };
};

/** The server's shape (Part 1's contract): the last run, the keep count, daily on or off, the archives on disk. */
const S = {
  last: null,
  keep: 7,
  daily: true,
  items: [],
  running: false,
  posts: [],
  downloads: [],
  deletes: [],
  backupsGets: 0,
  postStatus: 200,
};

function listing() {
  return { last: S.last, keep: S.keep, daily: S.daily, items: S.items, running: S.running };
}

/** Answers the backups routes from S, and /api/release with nothing to report (no GitHub). */
async function mock(page, { member = false } = {}) {
  await page.route(/\/api\/release(\?.*)?$/, (route) =>
    route.fulfill({
      json: { current: "2.11.0", latest: "2.11.0", available: false, commits: [], notes: "", upstream: null, head: "", checkedAt: Date.now(), error: null, running: false, startedAt: null, finishedAt: null, exit: null, unfinished: false, log: "", checks: null },
    }),
  );
  await page.route(/\/api\/backups$/, (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      S.posts.push("POST");
      if (S.postStatus === 409) return route.fulfill({ status: 409, json: { error: "a backup is already running" } });
      S.running = true;
      return route.fulfill({ json: listing() });
    }
    S.backupsGets++;
    return route.fulfill({ json: listing() });
  });
  await page.route(/\/api\/backups\/([^/]+)\/download$/, (route) => {
    S.downloads.push(decodeURIComponent(/\/api\/backups\/([^/]+)\/download$/.exec(route.request().url())[1]));
    return route.fulfill({ status: 200, contentType: "application/gzip", body: "x", headers: { "content-disposition": "attachment" } });
  });
  await page.route(/\/api\/backups\/([^/]+)$/, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const name = decodeURIComponent(/\/api\/backups\/([^/]+)$/.exec(route.request().url())[1]);
    S.deletes.push(name);
    S.items = S.items.filter((i) => i.name !== name);
    return route.fulfill({ json: listing() });
  });
  if (member) await page.route(/\/api\/account$/, (route) => route.fulfill({ json: { id: "sam", role: "member", kind: "user" } }));
}

function reset(over = {}) {
  Object.assign(S, { last: null, keep: 7, daily: true, items: [], running: false, posts: [], downloads: [], deletes: [], backupsGets: 0, postStatus: 200 }, over);
}

const fx = await startFixture({ port: 7963, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  const section = (page) => page.locator("section[aria-labelledby='settings-section-title']");

  /* ---------------------------------------------- a good backup, daily on -- */
  {
    const newest = archive(0, 2 * MB);
    const older = archive(1, 1 * MB);
    reset({ last: { at: newest.at, name: newest.name, bytes: newest.bytes, ok: true, verified: true, counts: { projects: 2, chats: 1, brains: 0 } }, items: [newest, older] });
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/backups`);
    const main = section(page);
    await main.getByRole("list", { name: "Saved backups" }).waitFor({ timeout: 15000 }).catch(() => {});
    const text = await main.innerText();
    check("headline names the last good backup in words", /Today at \d{1,2}:\d{2}/.test(text), text.slice(0, 200));
    check("headline gives the size and that it was checked", /· [\d.]+ MB · checked/.test(text), text.slice(0, 200));
    check("daily backups line says on and the keep count", text.includes("Daily backups: on, keeps the last 7."));
    check("one primary per view: Back up now", (await page.locator(".btn-primary").count()) === 1 && (await main.getByRole("button", { name: "Back up now", exact: true }).count()) === 1);
    const rows = main.getByRole("listitem");
    check("both archives are listed", (await rows.count()) === 2, String(await rows.count()));
    check("archive names are shown", (await main.getByText(newest.name, { exact: true }).count()) === 1);
    check("off-computer disclosure is quiet and plain", (await main.getByText("Keep a copy off this computer", { exact: true }).count()) === 1);
    check("no failure line when the last run worked", !/did not work/.test(text));
    check("no stale line for a fresh backup", !/It has been/.test(text));

    // Download: the archive's own name, through the authenticated request.
    const dl = main.getByRole("button", { name: /^Download the backup from/ }).first();
    await dl.click();
    await page.waitForTimeout(300);
    check("Download asks for the archive by its name", S.downloads.includes(newest.name), S.downloads.join(","));

    // Delete: confirmed, then gone from the list.
    await main.getByRole("button", { name: /^Delete the backup from/ }).nth(1).click();
    const dlg = page.getByRole("alertdialog");
    await dlg.waitFor({ timeout: 3000 }).catch(() => {});
    check("Delete asks first", (await dlg.getByText("Delete this backup?", { exact: true }).count()) === 1);
    check("Delete is not the default", (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "")) === "Cancel");
    await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(200);
    check("Cancel deletes nothing", S.deletes.length === 0, S.deletes.join(","));
    await main.getByRole("button", { name: /^Delete the backup from/ }).nth(1).click();
    await dlg.waitFor({ timeout: 3000 }).catch(() => {});
    await dlg.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForTimeout(500);
    check("Delete removes the chosen archive", S.deletes.length === 1 && S.deletes[0] === older.name, S.deletes.join(","));
    check("the list is one row after the delete", (await main.getByRole("listitem").count()) === 1);

    // Back up now: one request, and the panel says it is going.
    await main.getByRole("button", { name: "Back up now", exact: true }).click();
    await page.waitForTimeout(300);
    check("Back up now posts one run", S.posts.length === 1, S.posts.join(","));
    check("while it runs the panel says so in words", (await main.innerText()).includes("Backing up now…"));
    check("Back up now is off while a run goes", await main.getByRole("button", { name: "Back up now", exact: true }).isDisabled());
    await ctx.close();
  }

  /* ----------------------------------------------- 409: a run already going -- */
  {
    reset({ postStatus: 409 });
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/backups`);
    const main = section(page);
    await main.getByRole("button", { name: "Back up now", exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    await main.getByRole("button", { name: "Back up now", exact: true }).click();
    await page.waitForTimeout(300);
    check("a 409 shows the server's words, not a crash", (await main.innerText()).includes("a backup is already running"));
    await ctx.close();
  }

  /* ---------------------------------------------------- nothing ever backed up -- */
  {
    reset();
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/backups`);
    const main = section(page);
    await main.getByText("No backup yet.", { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    check("no backup says so plainly", (await main.getByText("No backup yet.", { exact: true }).count()) === 1);
    check("and Back up now is the one primary", (await page.locator(".btn-primary").count()) === 1 && (await main.getByRole("button", { name: "Back up now", exact: true }).count()) === 1);
    check("daily on line still shows", (await main.innerText()).includes("Daily backups: on, keeps the last 7."));
    await ctx.close();
  }

  /* ------------------------------------- the last run failed: the reason, and the older good one -- */
  {
    const good = archive(1, 3 * MB);
    const failed = archive(0, 0);
    reset({
      last: { at: Date.now(), name: failed.name, bytes: 0, ok: false, verified: false, counts: { projects: 0, chats: 0, brains: 0 }, error: "not enough free disk space" },
      items: [good],
    });
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/backups`);
    const main = section(page);
    await main.getByText("The last backup did not work.", { exact: false }).waitFor({ timeout: 15000 }).catch(() => {});
    const text = await main.innerText();
    check("a failed last run says it did not work, with the reason", text.includes("The last backup did not work. not enough free disk space"), text.slice(0, 300));
    check("the headline still names the last good backup", /Yesterday at|On /.test(text) && /· 3\.0 MB/.test(text), text.slice(0, 300));
    check("a failure is not shown in red", (await main.getByText("The last backup did not work.", { exact: false }).evaluate((el) => getComputedStyle(el).color)) !== "rgb(255, 0, 0)");
    await ctx.close();
  }

  /* ------------------------------------------------ gentle line after 3 days -- */
  {
    const old = archive(5, 2 * MB);
    reset({ last: { at: old.at, name: old.name, bytes: old.bytes, ok: true, verified: true, counts: { projects: 1, chats: 0, brains: 0 } }, items: [old] });
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/backups`);
    const main = section(page);
    await main.getByText("It has been", { exact: false }).waitFor({ timeout: 15000 }).catch(() => {});
    check("after 3 days a gentle line says how long", (await main.innerText()).includes("It has been 5 days since the last backup."));
    await ctx.close();
  }

  /* ----------------------------------------------------------- daily switched off -- */
  {
    reset({ daily: false, keep: 7 });
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/backups`);
    const main = section(page);
    await main.getByText("Daily backups: off.", { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    check("daily off says so", (await main.innerText()).includes("Daily backups: off."));
    await ctx.close();
  }

  /* -------------------------------------------- Home never asks about backups -- */
  {
    reset();
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/`);
    await page.getByText("What should we build?").waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    check("Home does not read backups", S.backupsGets === 0, String(S.backupsGets));
    check("Home says nothing about backups", !/No backup yet|Backed up|Back up now/.test(await page.locator("body").innerText()));
    await ctx.close();
  }

  /* ------------------------------------------------------------- members get no tab -- */
  {
    reset();
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, { member: true });
    const account = page.waitForResponse(/\/api\/account$/, { timeout: 15000 }).catch(() => null);
    await page.goto(`${fx.base}/settings/updates`);
    await account;
    const nav = page.locator("nav[aria-label='Settings sections']");
    await nav.waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    check("a member has no Backups tab", (await nav.getByRole("button", { name: "Backups", exact: true }).count()) === 0);
    await page.goto(`${fx.base}/settings/backups`);
    await page.waitForTimeout(1500);
    const firstCurrent = await nav.locator("[aria-current='page']").innerText().catch(() => "");
    check("a member opening /settings/backups is sent to the first section", firstCurrent.trim() === "Account", firstCurrent);
    check("and a member never reads backups", S.backupsGets === 0, String(S.backupsGets));
    await ctx.close();
  }

  /* -------------------------------------------------------- the owner sees the tab -- */
  {
    reset();
    const ctx = await openContext(browser, { width: 1280, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/updates`);
    const nav = page.locator("nav[aria-label='Settings sections']");
    await nav.waitFor({ timeout: 15000 }).catch(() => {});
    check("the owner has a Backups tab next to Updates", (await nav.getByRole("button", { name: "Backups", exact: true }).count()) === 1);
    await ctx.close();
  }
} finally {
  if (browser) await browser.close();
  fx.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nbackups UI: all checks passed");
process.exit(failures ? 1 : 0);
