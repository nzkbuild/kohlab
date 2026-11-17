#!/usr/bin/env node
/**
 * The web entry points to the terminals, end to end in a browser:
 *   - the owner's sidebar "Terminal" row opens /terminal, where a typed echo prints 42 on the xterm screen;
 *   - a member (account mocked to role "member") does not see that row, nor the status bar's server terminal;
 *   - a shell project's header Terminal button opens and closes the bottom panel, and the panel's shell runs echo;
 *   - the status bar hint is a button: in a project it opens the panel, anywhere else it opens /terminal;
 *   - the command palette lists "Terminal on the server" for the owner.
 *
 * Throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) against the built web/dist. Skips with a printed reason
 * when playwright-core or Chromium is missing.
 *
 *   cd web && bun run build && node scripts/check-server-shell-ui.mjs
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser, openContext, startFixture } from "./ui-fixture.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7939;
const KEY = "server-shell-ui-key";

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
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? `  ${detail}` : ""}`);
};

// `scope` is "" for the whole page, or a selector followed by a space (e.g. the bottom panel).
const promptUp = (page, scope) =>
  page
    .waitForFunction((sel) => [...document.querySelectorAll(sel)].some((r) => (r.textContent ?? "").trim() !== ""), `${scope}.xterm-rows > div`, { timeout: 20000 })
    .then(() => true, () => false);

const echoSeven = async (page, scope) => {
  await page.locator(`${scope}.xterm`).first().click();
  await page.keyboard.type("echo $((6*7))");
  await page.keyboard.press("Enter");
  // The echo's own output is a line of exactly 42; the typed command line is not.
  return page
    .waitForFunction((sel) => [...document.querySelectorAll(sel)].some((r) => (r.textContent ?? "").trim() === "42"), `${scope}.xterm-rows > div`, { timeout: 15000 })
    .then(() => true, () => false);
};

const fx = await startFixture({ port: PORT, key: KEY });
const projects = mkdtempSync(join(tmpdir(), "kohlab-shell-ui-"));
let browser;
try {
  // A sh terminal project in a throwaway folder (not the user's projects folder).
  const headers = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
  const res = await fetch(`${fx.base}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ newProject: "shell", task: "shell", location: projects, agent: "sh" }),
  });
  if (!res.ok) throw new Error(`create project: ${res.status} ${await res.text()}`);
  const sh = await res.json();

  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  // Power tools on, so the status bar (and its terminal hint) is shown.
  const ownerContext = async () => {
    const ctx = await openContext(browser, { key: KEY });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem("kohlab.powerTools", "1");
      } catch {
        /* storage is off */
      }
    });
    return ctx;
  };

  // Owner: the sidebar row, the palette entry, the status bar hint and the server shell page.
  const ctx = await ownerContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.goto(`${fx.base}/`);
  const row = page.getByRole("button", { name: "Terminal on the server" });
  const rowShown = await row.waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
  check("owner sees the Terminal row in the sidebar", rowShown);

  if (rowShown) {
    await row.click();
    await page.waitForURL(/\/terminal$/, { timeout: 10000 }).catch(() => {});
    check("the row opens /terminal", new URL(page.url()).pathname === "/terminal", page.url());
    check("the server terminal page has its heading", await page.getByRole("heading", { name: "Terminal on the server" }).isVisible().catch(() => false));
    const up = await promptUp(page, "");
    check("the server shell shows a prompt", up);
    if (up) check("a typed echo prints 42 in the server shell", await echoSeven(page, ""));
  }

  // Palette: the owner gets the entry.
  await page.goto(`${fx.base}/`);
  // The shortcut is bound once the app is up, so wait for the sidebar row before pressing it.
  await row.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  await page.keyboard.type("server");
  const paletteOptions = await page.getByRole("option").allTextContents();
  check("the command palette lists Terminal on the server", await page.getByRole("option", { name: /Terminal on the server/ }).first().isVisible().catch(() => false), paletteOptions.slice(0, 6).join(" | "));
  await page.keyboard.press("Escape");

  // Status bar on Home: the hint is a button and opens the server terminal.
  const footerButton = page.locator("footer").getByRole("button", { name: /Terminal/ });
  check("the status bar hint is a button on Home", (await footerButton.count()) === 1);
  await footerButton.click();
  await page.waitForURL(/\/terminal$/, { timeout: 10000 }).catch(() => {});
  check("the status bar button on Home opens /terminal", new URL(page.url()).pathname === "/terminal", page.url());

  // A shell project: the header Terminal button toggles the bottom panel, and its shell runs.
  await page.goto(`${fx.base}/w/${sh.id}`);
  const headerButton = page.getByRole("button", { name: "Terminal", exact: true });
  // The project page is a lazy chunk: wait for its header before counting.
  await headerButton.waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  const termButtons = await page.getByRole("button", { name: /Terminal/ }).evaluateAll((els) => els.map((e) => `${e.getAttribute("aria-label") ?? e.textContent?.trim()} (${e.closest("header") ? "header" : e.closest("footer") ? "footer" : "other"})`));
  check("a shell project has one header Terminal button", (await headerButton.count()) === 1, termButtons.join(" | "));
  const panel = page.locator('[aria-label="Terminal panel"]');
  await headerButton.click();
  check("the header Terminal button opens the bottom panel", await panel.waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false));
  check("the header Terminal button is pressed while the panel is open", (await headerButton.getAttribute("aria-pressed")) === "true");
  const panelUp = await promptUp(page, '[aria-label="Terminal panel"] ');
  check("the panel's shell shows a prompt", panelUp);
  if (panelUp) check("a typed echo prints 42 in the panel", await echoSeven(page, '[aria-label="Terminal panel"] '));
  await headerButton.click();
  check("the header Terminal button closes the panel again", await panel.waitFor({ state: "hidden", timeout: 10000 }).then(() => true, () => false));

  // The status bar hint on a project opens the panel.
  await page.locator("footer").getByRole("button", { name: /Terminal/ }).click();
  check("the status bar button on a project opens its panel", await panel.waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false));

  // A never-started terminal project does not claim it has stopped while it starts.
  check("no 'has stopped' line on a shell project", (await page.getByText(/has stopped/).count()) === 0);
  check("the owner's pages had no page error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | ").slice(0, 300));
  await ctx.close();

  // Member: the account reads as a member, so the sidebar row and the status bar's server terminal are gone.
  const member = await ownerContext();
  await member.route("**/api/account", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, role: "member" } });
  });
  const mp = await member.newPage();
  const accountRead = mp.waitForResponse((r) => r.url().endsWith("/api/account"), { timeout: 15000 }).catch(() => null);
  await mp.goto(`${fx.base}/`);
  await accountRead;
  // The role is read into the store after the response; give the page a moment to render it.
  await mp.waitForTimeout(500);
  check("a member does not see the Terminal row", (await mp.getByRole("button", { name: "Terminal on the server" }).count()) === 0);
  check("a member's status bar has no server terminal button", (await mp.locator("footer").getByRole("button", { name: /Terminal/ }).count()) === 0);
  await member.close();
} finally {
  await browser?.close();
  fx.stop();
  rmSync(projects, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall server shell UI checks passed");
process.exit(failures ? 1 : 0);
