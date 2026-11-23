#!/usr/bin/env node
// File cards in the chat: a page or picture the AI wrote shows inline under its tool line, and a path in a reply is a
// "View" chip that shows the same card. The newest card opens by itself; the others wait collapsed. The page is the real
// preview route (/p/<token>/, served by the throwaway server with its sandbox header), the chat events are appended to the
// real snapshot by page.route, and the picture bytes come from a mocked raw route. Skips with a printed reason when
// playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-file-cards-ui.mjs
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

const KEY = "file-cards-ui-check-key";
const PORT = 7973;
const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox";
// A valid 1x1 PNG, so the picture card has real bytes to draw.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

const now = Date.now();
// The chat's own events, appended after the real snapshot. index.html, pic.png and gone.html are written in that order,
// then about.html last: about.html is the newest card. gone.html is not in the project (the 404 line).
const EVENTS = [
  { n: 9000, at: now, kind: "user", text: "Make me some pages" },
  { n: 9001, at: now, kind: "tool", text: "Updated your page", toolId: "t1", file: "index.html" },
  { n: 9002, at: now, kind: "tool", text: "Updated your page", toolId: "t2", file: "pic.png" },
  { n: 9003, at: now, kind: "tool", text: "Updated your page", toolId: "t3", file: "gone.html" },
  { n: 9004, at: now, kind: "tool", text: "Updated your page", toolId: "t4", file: "about.html" },
  {
    n: 9005,
    at: now,
    kind: "assistant",
    text: "Done. The home page is `index.html`. Plain links such as https://example.com/x.html stay links.",
  },
];

/** Answers the chat snapshot with the real one plus EVENTS, and the picture and gone-file requests. */
async function mockRequests(page) {
  await page.route(/\/api\/workspaces\/[^/]+\/chat\?after=/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.events = [...body.events, ...EVENTS];
    await route.fulfill({ response: res, json: body });
  });
  await page.route(/\/api\/workspaces\/[^/]+\/raw\?path=pic\.png/, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
}

/** Runs in the page: the cumulative layout shift so far (counted from the first paint of the page). */
const INIT_CLS = () => {
  window.__cls = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* no layout-shift support: the check reports 0 */
  }
};

/** Runs in the page: the phone's width is the screen's, so nothing sticks out to the side. */
const overflowsX = () => document.documentElement.scrollWidth > window.innerWidth + 1;

const fx = await startFixture({ port: PORT, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  // Desktop: the newest card opens, the older ones are collapsed; expand, collapse, Open in Preview, a picture, a 404 line, a chip.
  const ctx = await openContext(browser, { key: KEY, width: 1280, height: 900 });
  await ctx.addInitScript(INIT_CLS);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await mockRequests(page);
  await page.goto(`${fx.base}/w/${fx.ready}/chat`);

  const card = (name) => page.locator("div.rounded-card.bg-surface-raised").filter({ has: page.getByText(name, { exact: true }) }).first();
  const toggle = (name) => card(name).getByRole("button", { name: /^(Expand|Collapse)$/ });
  const aboutFrame = page.locator('iframe[title="Page about.html"]');
  await aboutFrame.waitFor({ timeout: 20000 }).catch(() => {});
  check("newest card (about.html) is expanded with its page", (await aboutFrame.count()) === 1);
  check("older page card (index.html) is collapsed", (await page.locator('iframe[title="Page index.html"]').count()) === 0);
  check("the newest card's toggle says Collapse", (await toggle("about.html").textContent())?.trim() === "Collapse");

  // The frame's sandbox is exact, with no same-origin.
  const sandbox = (await aboutFrame.getAttribute("sandbox")) ?? "";
  check("iframe has the exact sandbox attribute", sandbox === SANDBOX, sandbox);
  check("iframe sandbox has no allow-same-origin or top navigation", !/allow-same-origin|allow-top-navigation/.test(sandbox));
  check("iframe src is a same-origin /p/ preview address", ((await aboutFrame.getAttribute("src")) ?? "").startsWith("/p/"));

  // No layout shift when the frame loads: the box is reserved, so the shift between its placeholder and its loaded frame is 0.
  // The baseline is taken once the frame is in the page (the chat's own first-paint shifts are before it).
  await page.waitForFunction(() => document.querySelector('iframe[title="Page about.html"]'), { timeout: 20000 }).catch(() => {});
  const clsBefore = await page.evaluate(() => window.__cls);
  await page.waitForFunction(() => {
    const f = document.querySelector('iframe[title="Page about.html"]');
    return f && !f.classList.contains("invisible");
  }, { timeout: 20000 }).catch(() => {});
  const cls = (await page.evaluate(() => window.__cls)) - clsBefore;
  check("no layout shift as the page loads (CLS < 0.02)", cls < 0.02, `CLS ${cls.toFixed(3)}`);

  // Collapse and expand the newest card: the frame unmounts and mounts again.
  await toggle("about.html").click();
  check("collapse unmounts the frame", (await aboutFrame.count()) === 0);
  await toggle("about.html").click();
  await aboutFrame.waitFor({ timeout: 20000 }).catch(() => {});
  check("expand mounts the frame again", (await aboutFrame.count()) === 1);

  // Expanding an older card shows its page.
  await toggle("index.html").click();
  await page.locator('iframe[title="Page index.html"]').waitFor({ timeout: 20000 }).catch(() => {});
  check("expanding an older card shows its page", (await page.locator('iframe[title="Page index.html"]').count()) === 1);
  await toggle("index.html").click();

  // Open in Preview dispatches the open-preview event with that page.
  await page.evaluate(() => {
    window.__opened = null;
    window.addEventListener("kohlab:open-preview", (e) => (window.__opened = e.detail));
  });
  await card("about.html").getByRole("button", { name: "Open in Preview" }).click();
  const opened = await page.evaluate(() => window.__opened);
  check("Open in Preview dispatches the open-preview event for the page", opened?.page === "about.html" && opened?.id === fx.ready, JSON.stringify(opened));

  // A picture card draws the picture through the authenticated raw route.
  await toggle("pic.png").click();
  const img = page.locator('img[alt="pic.png"]');
  await img.waitFor({ timeout: 20000 }).catch(() => {});
  const drawn = await img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
  check("picture card shows the image", drawn);

  // A file that is not in the project says so in one line.
  await toggle("gone.html").click();
  await page.getByText("This file isn't in the project any more.").waitFor({ timeout: 20000 }).catch(() => {});
  check("a missing page says the file is gone", (await page.getByText("This file isn't in the project any more.").count()) === 1);

  // A path in the reply is a View chip; its click shows the card under the paragraph.
  const chip = page.getByRole("button", { name: "View index.html" });
  check("the path in the reply is a View chip", (await chip.count()) === 1);
  check("the chip starts collapsed", (await chip.getAttribute("aria-expanded")) === "false");
  await chip.click();
  check("the chip expands the file's card", (await chip.getAttribute("aria-expanded")) === "true");
  check("the chip's card shows the page", (await page.locator('iframe[title="Page index.html"]').count()) === 1);
  // A plain URL is not a chip.
  check("a plain URL stays a link", (await page.getByRole("link", { name: /example\.com/ }).count()) === 1);
  await ctx.close();

  // Keyboard: the toggle works with Enter.
  const kb = await openContext(browser, { key: KEY, width: 1280, height: 900 });
  const kbPage = await kb.newPage();
  await mockRequests(kbPage);
  await kbPage.goto(`${fx.base}/w/${fx.ready}/chat`);
  const kbToggle = kbPage.locator("div.rounded-card.bg-surface-raised").filter({ has: kbPage.getByText("index.html", { exact: true }) }).first().getByRole("button", { name: /^(Expand|Collapse)$/ });
  await kbToggle.waitFor({ timeout: 20000 });
  await kbToggle.focus();
  await kbPage.keyboard.press("Enter");
  await kbPage.locator('iframe[title="Page index.html"]').waitFor({ timeout: 20000 }).catch(() => {});
  check("keyboard: Enter expands a card", (await kbPage.locator('iframe[title="Page index.html"]').count()) === 1);
  await kb.close();

  // Phone: the cards fit at 390px, and the controls are 48px on a touch screen.
  const phone = await openContext(browser, { key: KEY, touch: true, width: 390, height: 844 });
  const phonePage = await phone.newPage();
  await mockRequests(phonePage);
  await phonePage.goto(`${fx.base}/w/${fx.ready}/chat`);
  await phonePage.locator('iframe[title="Page about.html"]').waitFor({ timeout: 20000 }).catch(() => {});
  check("390px: no horizontal overflow with the cards", !(await phonePage.evaluate(overflowsX)));
  const openBtn = phonePage.locator("div.rounded-card.bg-surface-raised").filter({ has: phonePage.getByText("about.html", { exact: true }) }).first().getByRole("button", { name: "Open in Preview" });
  const box = await openBtn.boundingBox();
  check("390px: Open in Preview is 48px tall on touch", !!box && box.height >= 47.5, box ? `${Math.round(box.height)}px` : "not shown");
  await phone.close();

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser?.close();
  fx.stop();
}

console.log(failures ? `\n${failures} failed` : "\nall file card UI checks passed");
process.exit(failures ? 1 : 0);
