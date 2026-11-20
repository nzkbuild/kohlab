#!/usr/bin/env node
// Recently deleted, in the browser: the project menus say "Move to Recently deleted" (sidebar and project header) with
// the 30-day words and an Undo toast; Settings → Recently deleted lists what the API returns, with Restore (no primary
// button) and a confirmed Delete forever (Cancel focused); the empty and failed states; a viewer sees the list without
// the buttons; a refused restore shows the server's words.
//
// No project is deleted and no GitHub is touched: page.route answers GET /api/trash, POST /api/trash/:id/restore,
// DELETE /api/trash/:id and DELETE /api/workspaces/:id from a small state object. A throwaway server (own PORT,
// WORKS_DIR, PTY_SOCKET) serves the built web/dist and two real chat projects. Skips with a printed reason when
// playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-trash-ui.mjs
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

const KEY = "trash-ui-check-key";
const DAY = 86_400_000;
const now = Date.now();

const item = (id, name, purgeInDays) => ({
  id,
  name,
  agent: "claude",
  trashedAt: now - 18 * DAY,
  trashedBy: "owner",
  purgeAt: purgeInDays === null ? null : now + purgeInDays * DAY,
  kind: "project",
});

/** What the mocked server holds. Reset between sections. */
const S = {};
function reset(over = {}) {
  Object.assign(
    S,
    { trash: [], days: 30, trashFail: false, restorePost: 200, softDeletes: [], restores: [], forever: [], role: null },
    over,
  );
}

const idFrom = (route, pattern) => decodeURIComponent(pattern.exec(route.request().url())[1]);

/** Answers the trash routes and the delete call from S. Anything else goes to the real throwaway server. */
async function mock(page) {
  await page.route(/\/api\/trash$/, (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    if (S.trashFail) return route.fulfill({ status: 500, json: { error: "the list is unavailable" } });
    return route.fulfill({ json: { items: S.trash, days: S.days } });
  });
  await page.route(/\/api\/trash\/[^/]+\/restore$/, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const pattern = /\/api\/trash\/([^/]+)\/restore$/;
    const id = idFrom(route, pattern);
    S.restores.push(id);
    if (S.restorePost !== 200) return route.fulfill({ status: S.restorePost, json: { error: "a project with that name is already here" } });
    S.trash = S.trash.filter((i) => i.id !== id);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/trash\/[^/]+$/, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    const id = idFrom(route, /\/api\/trash\/([^/]+)$/);
    S.forever.push(id);
    S.trash = S.trash.filter((i) => i.id !== id);
    return route.fulfill({ json: { ok: true } });
  });
  await page.route(/\/api\/workspaces\/[^/?]+$/, (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    S.softDeletes.push(idFrom(route, /\/api\/workspaces\/([^/?]+)$/));
    return route.fulfill({ json: { ok: true } });
  });
  if (S.role) {
    await page.route(/\/api\/account$/, (route) => route.fulfill({ json: { id: "vee", role: S.role, kind: "user" } }));
  }
}

const fx = await startFixture({ port: 7967, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  const dialogOf = (page) => page.getByRole("alertdialog");
  const toastWith = (page, words) => page.locator("[data-sonner-toast]").filter({ hasText: words });
  // The ⋯ on a sidebar row, and the project name that opens the header menu (Menu labels its trigger with the title).
  const rowMore = (page) => page.locator("button[aria-label^='More actions for']").first();
  // A real pointer: hover the row (the ⋯ appears), then click the ⋯ itself.
  const openRowMenu = async (page) => {
    await page.locator(".sidebar-item").first().hover();
    await rowMore(page).click({ timeout: 5000 });
  };
  const headerMenu = (page) =>
    page.locator("button[aria-haspopup='menu']:not([aria-label^='More actions']):not([aria-label^='Account'])").first();

  /* ------------------------------------------ the sidebar menu: soft delete and Undo -- */
  {
    reset();
    const ctx = await openContext(browser, { key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/`);
    await rowMore(page).waitFor({ timeout: 15000 }).catch(() => {});
    await openRowMenu(page);
    await page.getByRole("menuitem", { name: "Move to Recently deleted…" }).click();

    const dlg = dialogOf(page);
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    await dlg.getByText("You can bring it back for 30 days.", { exact: false }).waitFor({ timeout: 5000 }).catch(() => {});
    check("nothing on the page says Delete project", !(await page.locator("body").innerText()).includes("Delete project"));
    check("the confirm names the 30 days", (await dlg.getByText("You can bring it back for 30 days.", { exact: false }).count()) === 1);
    check("the confirm is titled as a move", (await dlg.getByText("Move this project to Recently deleted?", { exact: true }).count()) === 1);
    check("the soft path has no red danger button", (await dlg.locator(".btn-danger").count()) === 0);
    check("the confirm button is Move to Recently deleted", (await dlg.getByRole("button", { name: "Move to Recently deleted", exact: true }).count()) === 1);

    await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
    await dlg.waitFor({ state: "detached", timeout: 3000 }).catch(() => {});
    check("Cancel moves nothing", S.softDeletes.length === 0, S.softDeletes.join(","));

    await openRowMenu(page);
    await page.getByRole("menuitem", { name: "Move to Recently deleted…" }).click();
    await dlg.getByRole("button", { name: "Move to Recently deleted", exact: true }).click();
    await page.waitForTimeout(800);
    check("confirm sends one soft delete (DELETE /api/workspaces/:id)", S.softDeletes.length === 1, S.softDeletes.join(","));
    const movedId = S.softDeletes[0];
    const moved = toastWith(page, "moved to Recently deleted");
    check("a toast says it moved, with Undo", (await moved.count()) >= 1 && (await moved.getByRole("button", { name: "Undo" }).count()) === 1);

    await moved.getByRole("button", { name: "Undo" }).click();
    await page.waitForTimeout(800);
    check("Undo restores that project", S.restores.length === 1 && S.restores[0] === movedId, S.restores.join(","));
    await ctx.close();
  }

  /* ------------------------------------------------ the project header menu -- */
  {
    reset();
    const ctx = await openContext(browser, { key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/w/${encodeURIComponent(fx.ready)}`);
    await headerMenu(page).waitFor({ timeout: 15000 }).catch(() => {});
    await headerMenu(page).click();
    await page.getByRole("menuitem", { name: "Move to Recently deleted…" }).click();
    const dlg = dialogOf(page);
    await dlg.waitFor({ timeout: 5000 }).catch(() => {});
    check("the header menu item says Move to Recently deleted", (await dlg.count()) === 1);
    check("the header confirm uses the same words", (await dlg.getByText("moves to Recently deleted.", { exact: false }).count()) === 1);
    await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
    check("header Cancel moves nothing", S.softDeletes.length === 0, S.softDeletes.join(","));
    await ctx.close();
  }

  /* -------------------------------------------- Settings → Recently deleted (owner) -- */
  {
    reset({ trash: [item("quiet-notes", "Quiet notes", 12), item("blog", "Blog", null)] });
    const ctx = await openContext(browser, { key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/trash`);
    const list = page.locator("ul[aria-label='Recently deleted projects']");
    await list.waitFor({ timeout: 15000 }).catch(() => {});
    const main = page.locator("section[aria-labelledby='settings-section-title']");
    check("Settings has a Recently deleted tab", (await page.locator("nav[aria-label='Settings sections']").getByRole("button", { name: "Recently deleted", exact: true }).count()) === 1);
    check("both deleted projects are listed", (await list.getByRole("listitem").count()) === 2);
    check("a project with days left says so", (await main.innerText()).includes("· 12 days left"));
    check("a project kept until deleted says only the date", /^Deleted [^·\n]+$/m.test(await main.innerText()));
    check("the list has no primary button", (await page.locator(".btn-primary").count()) === 0);
    check("each row has Restore and a quiet Delete forever", (await main.getByRole("button", { name: "Restore", exact: false }).count()) === 2 && (await main.getByRole("button", { name: /Delete .* forever$/ }).count()) === 2);

    await main.getByRole("button", { name: "Restore Quiet notes" }).click();
    await page.waitForTimeout(800);
    check("Restore posts that project's id", S.restores.length === 1 && S.restores[0] === "quiet-notes", S.restores.join(","));
    const back = toastWith(page, "Quiet notes is back");
    check("a toast after Restore has an Open link", (await back.getByRole("button", { name: "Open" }).count()) === 1);
    check("the restored row leaves the list", (await list.getByRole("listitem").count()) === 1);

    await main.getByRole("button", { name: "Delete Blog forever" }).click();
    const dlg = dialogOf(page);
    await dlg.waitFor({ timeout: 3000 }).catch(() => {});
    check("Delete forever asks first", (await dlg.getByText("Delete this project for good?", { exact: true }).count()) === 1);
    check("Delete forever copy says it cannot be undone", (await dlg.getByText("This can't be undone.", { exact: false }).count()) === 1);
    check("Cancel has the focus", (await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "")) === "Cancel");
    await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(400);
    check("Cancel deletes nothing", S.forever.length === 0, S.forever.join(","));

    await main.getByRole("button", { name: "Delete Blog forever" }).click();
    await dlg.getByRole("button", { name: "Delete forever", exact: true }).click();
    await page.waitForTimeout(800);
    check("confirmed Delete forever calls DELETE /api/trash/:id", S.forever.length === 1 && S.forever[0] === "blog", S.forever.join(","));
    await ctx.close();
  }

  /* --------------------------------------------------------- empty and failed states -- */
  {
    reset({ trash: [] });
    const ctx = await openContext(browser, { key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/trash`);
    await page.getByText("Nothing here.", { exact: true }).waitFor({ timeout: 15000 }).catch(() => {});
    const text = await page.locator("section[aria-labelledby='settings-section-title']").innerText();
    check("empty state says it plainly", text.includes("Nothing here.") && text.includes("Deleted projects wait here for 30 days."), text.slice(0, 200));
    await ctx.close();
  }
  {
    reset({ trashFail: true });
    const ctx = await openContext(browser, { key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/trash`);
    await page.getByText("Couldn't load Recently deleted.", { exact: false }).waitFor({ timeout: 15000 }).catch(() => {});
    check("a failed read says so, with Try again", (await page.getByRole("button", { name: "Try again", exact: true }).count()) === 1);
    await ctx.close();
  }

  /* ------------------------------------------------------ a refused restore says why -- */
  {
    reset({ trash: [item("quiet-notes", "Quiet notes", 12)], restorePost: 409 });
    const ctx = await openContext(browser, { key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/trash`);
    const main = page.locator("section[aria-labelledby='settings-section-title']");
    await main.getByRole("button", { name: "Restore Quiet notes" }).waitFor({ timeout: 15000 }).catch(() => {});
    await main.getByRole("button", { name: "Restore Quiet notes" }).click();
    await page.waitForTimeout(800);
    const failed = toastWith(page, "Restore failed");
    check("a refused restore shows the server's words", (await failed.filter({ hasText: "already here" }).count()) >= 1);
    check("the row stays in the list", (await main.getByRole("listitem").count()) === 1);
    await ctx.close();
  }

  /* ------------------------------------------------- a viewer sees the list, no buttons -- */
  {
    reset({ trash: [item("quiet-notes", "Quiet notes", 12)], role: "viewer" });
    const ctx = await openContext(browser, { key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    const account = page.waitForResponse(/\/api\/account$/, { timeout: 15000 }).catch(() => null);
    await page.goto(`${fx.base}/settings/trash`);
    await account;
    const list = page.locator("ul[aria-label='Recently deleted projects']");
    await list.waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    check("a viewer sees the deleted project", (await list.getByRole("listitem").count()) === 1);
    check("a viewer has no Restore or Delete forever", (await page.getByRole("button", { name: /^Restore|Delete .* forever/ }).count()) === 0);
    await ctx.close();
  }
} finally {
  if (browser) await browser.close();
  fx.stop();
}

console.log(failures ? `\n${failures} check(s) failed` : "\ntrash UI: all checks passed");
process.exit(failures ? 1 : 0);
