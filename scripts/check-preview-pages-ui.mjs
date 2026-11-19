#!/usr/bin/env node
// The page side of Preview in the browser: an HTML file opens as a page (Files: Page | Code), "View as page" on a changed
// HTML file (Changes), Look on the ready card opens the page that changed, Preview remembers the page it last showed (and
// falls back to home when the project no longer lists it), and the Pages menu jumps to a page. The pages list, the diff,
// the preview address and the shared browser are page.route mocks that record what the app asks for, so no AI runs and
// the shared browser is never touched. The throwaway server (its own PORT, WORKS_DIR and PTY_SOCKET) gives the projects.
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-preview-pages-ui.mjs
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

const KEY = "preview-pages-ui-check-key";
const PORT = 7957;
const TOKEN = "pagescheck";
const OPEN_ABOUT = `open /p/${TOKEN}/about.html`;
const ALL_PAGES = [
  { path: "index.html", title: "Home", changed: 1000 },
  { path: "about.html", title: "About us", changed: 2000 },
];

/** The app's requests for pages, Preview and the shared browser: answered here, and recorded in `state.calls`. */
async function mockRequests(page, base, state) {
  // The fixture's ready project has an unkept change but no run, so it is not "Ready to check" yet: the list says its run stopped.
  await page.route(/\/api\/workspaces$/, async (route) => {
    const list = await (await route.fetch()).json();
    const patched = list.map((w) => (w.id === state.ready ? { ...w, running: false, stopped: Date.now() + 60_000, stoppedClean: false } : w));
    return route.fulfill({ json: patched });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/pages$/, (route) => route.fulfill({ json: { pages: state.pages } }));
  await page.route(/\/api\/workspaces\/[^/]+\/diff$/, (route) =>
    route.fulfill({
      json: [
        { name: "index.html", diff: "" },
        { name: "about.html", diff: "" },
      ],
    }),
  );
  await page.route(/\/api\/workspaces\/[^/]+\/preview$/, (route) => {
    state.calls.push("preview");
    route.fulfill({ json: { url: `/p/${TOKEN}/` } });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/browser$/, (route) => {
    const req = route.request();
    if (req.method() === "GET") return route.fulfill({ json: { url: state.here } });
    const body = req.postDataJSON();
    if (body.action === "open") {
      state.calls.push(`open ${new URL(body.url).pathname}`);
      state.here = body.url;
    } else {
      state.calls.push(body.action);
      state.here = `${base}/p/${TOKEN}/`;
    }
    return route.fulfill({ json: { url: state.here } });
  });
}

/** Waits until the recorded calls contain `what`, or gives up after a few seconds. */
async function sawCall(state, what) {
  for (let i = 0; i < 40; i++) {
    if (state.calls.includes(what)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Runs in the page: the visible primary buttons in the main view. One primary per view. */
const primaries = () =>
  [...document.querySelectorAll(".btn-primary")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).length;

/** Runs in the page: text a person should never see on these views. */
const developerWords = () => /\b(iframe|sandbox|CSP|DOM|endpoint)\b/i.test(document.body.innerText);

const fx = await startFixture({ port: PORT, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  // Wide enough for the Files editor, the docked chat and the Preview pane to sit side by side (at 1280px they overlap).
  const ctx = await openContext(browser, { key: KEY, width: 1600 });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("kohlab.powerTools", "1");
    } catch {
      /* storage is off */
    }
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const state = { pages: ALL_PAGES, calls: [], here: null, ready: fx.ready };
  await mockRequests(page, fx.base, state);

  // 1. Files: an HTML file opens as a page by default, and Code shows its source.
  await page.goto(`${fx.base}/w/${fx.ready}/files`);
  // The left side of the row: the "Changed" mark sits over its right end.
  await page.getByRole("button", { name: /^about\.html/ }).click({ position: { x: 24, y: 8 } });
  const tabs = page.getByRole("tablist", { name: "Show the file as" });
  await tabs.waitFor({ timeout: 15000 });
  check("Files: an HTML file has a Page | Code switch", (await tabs.getByRole("tab").count()) === 2);
  check("Files: Page is the default", (await tabs.getByRole("tab", { name: "Page" }).getAttribute("aria-selected")) === "true");
  check("Files: Page opens the file in Preview", await sawCall(state, OPEN_ABOUT), state.calls.join(", "));
  check("Files: the page view shows no editor", (await page.locator(".monaco-editor").count()) === 0);
  check("Files (page view): at most one primary", (await page.evaluate(primaries)) <= 1);
  check("Files (page view): no developer words", !(await page.evaluate(developerWords)));

  await tabs.getByRole("tab", { name: "Code" }).click();
  check("Files: Code shows the source in the editor", (await page.locator(".monaco-editor").first().waitFor({ timeout: 20000 }).then(() => true, () => false)));
  check("Files: Code is selected", (await tabs.getByRole("tab", { name: "Code" }).getAttribute("aria-selected")) === "true");

  // 2. Changes: "View as page" on a changed HTML file opens that page.
  await page.goto(`${fx.base}/w/${fx.ready}/review`);
  const aboutRow = page.locator("li", { hasText: "about.html" });
  await aboutRow.getByRole("button", { name: "View as page" }).waitFor({ timeout: 15000 });
  check("Changes: a changed HTML file has View as page", (await page.getByRole("button", { name: "View as page" }).count()) === 2);
  state.calls.length = 0;
  await aboutRow.getByRole("button", { name: "View as page" }).click();
  check("Changes: View as page opens that page", await sawCall(state, OPEN_ABOUT), state.calls.join(", "));
  check("Changes: at most one primary", (await page.evaluate(primaries)) <= 1);

  // 3. Look on the ready card opens the page that changed (the newest of the changed pages).
  await page.goto(`${fx.base}/w/${fx.ready}/chat`);
  const ready = page.getByRole("region", { name: "Ready to check" });
  await ready.waitFor({ timeout: 15000 });
  state.calls.length = 0;
  await ready.getByRole("button", { name: "Preview", exact: true }).click();
  check("Look opens the changed page", await sawCall(state, OPEN_ABOUT), state.calls.join(", "));
  check("Look: no developer words on the chat", !(await page.evaluate(developerWords)));

  // With no page in the project, Look opens the home page.
  await page.getByRole("button", { name: "Close preview" }).click().catch(() => {});
  state.pages = [];
  state.calls.length = 0;
  await ready.getByRole("button", { name: "Preview", exact: true }).click();
  check("Look falls back to home when no page changed", await sawCall(state, "home"), state.calls.join(", "));
  state.pages = ALL_PAGES;

  // 4. Preview remembers the page; when the project no longer lists it, Preview goes home.
  await page.evaluate((id) => localStorage.setItem(`kohlab.previewPage.${id}`, "about.html"), fx.ready);
  await page.goto(`${fx.base}/w/${fx.ready}/chat`);
  const header = page.locator("header");
  await header.getByRole("button", { name: "Preview", exact: true }).waitFor({ timeout: 15000 });
  state.calls.length = 0;
  await header.getByRole("button", { name: "Preview", exact: true }).click();
  check("Preview opens the remembered page", await sawCall(state, OPEN_ABOUT), state.calls.join(", "));

  await page.getByRole("button", { name: "Close preview" }).click();
  state.pages = [ALL_PAGES[0]];
  state.calls.length = 0;
  await header.getByRole("button", { name: "Preview", exact: true }).click();
  check("Preview goes home when the remembered page is gone", await sawCall(state, "home"), state.calls.join(", "));
  check("Preview does not open the gone page", !state.calls.includes(OPEN_ABOUT), state.calls.join(", "));
  state.pages = ALL_PAGES;

  // 5. The Pages menu lists the pages and jumps to one.
  await page.getByRole("button", { name: "More preview actions" }).click();
  const pagesItem = page.getByRole("menuitem", { name: "Pages" });
  await pagesItem.waitFor({ timeout: 5000 });
  await pagesItem.focus();
  await page.keyboard.press("ArrowRight");
  const aboutItem = page.getByRole("menuitem", { name: /About us/ });
  await aboutItem.waitFor({ timeout: 10000 });
  state.calls.length = 0;
  await aboutItem.click();
  check("Pages menu opens the page it lists", await sawCall(state, OPEN_ABOUT), state.calls.join(", "));
  await page.keyboard.press("Escape").catch(() => {});

  // 5b. At 1280px the open Preview pane and the docked chat would cover the editor header: the dock waits for a wider screen.
  const narrow = await openContext(browser, { key: KEY, width: 1280, height: 900 });
  await narrow.addInitScript(() => {
    try {
      localStorage.setItem("kohlab.powerTools", "1");
    } catch {
      /* storage is off */
    }
  });
  const narrowPage = await narrow.newPage();
  await mockRequests(narrowPage, fx.base, { pages: ALL_PAGES, calls: [], here: null, ready: fx.ready });
  await narrowPage.goto(`${fx.base}/w/${fx.ready}/files`);
  await narrowPage.getByRole("button", { name: /^about\.html/ }).click({ position: { x: 24, y: 8 } });
  const narrowCode = narrowPage.getByRole("tablist", { name: "Show the file as" }).getByRole("tab", { name: "Code" });
  await narrowCode.waitFor({ timeout: 15000 });
  await narrowPage.getByRole("complementary", { name: "Preview" }).waitFor({ timeout: 15000 });
  const covered = await narrowCode.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !(top && el.contains(top));
  });
  check("1280px: the Code tab is not covered with Preview open", !covered);
  check("1280px: the docked chat steps aside while Preview is open", (await narrowPage.getByRole("complementary", { name: "Chat" }).count()) === 0);
  await narrow.close();

  // 6. Phone: the Page | Code switch targets are 44px.
  const phone = await openContext(browser, { key: KEY, touch: true, width: 390, height: 844 });
  await phone.addInitScript(() => {
    try {
      localStorage.setItem("kohlab.powerTools", "1");
    } catch {
      /* storage is off */
    }
  });
  const phonePage = await phone.newPage();
  await mockRequests(phonePage, fx.base, { pages: ALL_PAGES, calls: [], here: null, ready: fx.ready });
  await phonePage.goto(`${fx.base}/w/${fx.ready}/files`);
  await phonePage.getByRole("button", { name: /^about\.html/ }).click({ position: { x: 24, y: 8 } });
  const phoneTab = phonePage.getByRole("tablist", { name: "Show the file as" }).getByRole("tab", { name: "Page" });
  await phoneTab.waitFor({ timeout: 15000 });
  const box = await phoneTab.boundingBox();
  check("phone: the Page | Code switch targets are 44px", !!box && box.height >= 44, box ? `${Math.round(box.height)}px` : "not shown");
  await phone.close();

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await ctx.close();
} finally {
  await browser?.close();
  fx.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall preview page UI checks passed");
process.exit(failures ? 1 : 0);
