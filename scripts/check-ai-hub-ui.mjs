#!/usr/bin/env node
// The AI hub in the browser: Settings -> AI, the composer's grouped picker, the run strip, the Run panel with its
// helpers tree, the "Continue fresh" banner, and the member's redacted view. No real AI CLI runs: page.route answers
// /api/providers, /api/workspaces/*/chat/run and adds a helper tree and a finished reply to the chat snapshot.
//
// Throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) against the built web/dist. Skips with a printed reason when
// playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-ai-hub-ui.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

/* --------------------------------------------------------------- fixtures -- */
const EMAIL = "you@example.com";
const PLAN = "max";
const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const models = (n, prefix) => Array.from({ length: n }, (_, i) => ({ value: `${prefix}-${i}`, label: `${prefix} model ${i}`, group: i % 2 ? "Group B" : "Group A" }));
const account = (over) => ({ id: "default", label: EMAIL, email: EMAIL, plan: PLAN, auth: "oauth", state: "connected", isolation: {}, usage: null, models: [], modelsAt: 1, ...over });
const base = { kind: "cli", installed: true, version: "9.9.9", checkedAt: Date.now() - 120_000, stale: false, actions: [{ kind: "refresh", label: "Refresh" }] };
const OWNER_CARDS = [
  {
    ...base,
    id: "claude",
    name: "Claude",
    state: "connected",
    accounts: [
      account({
        usage: {
          readAt: Date.now(),
          windows: [
            { id: "five_hour", label: "Next few hours", percent: 34, resetsAt: inHours(2), windowMins: 300, severity: "normal" },
            { id: "weekly", label: "This week", percent: 61, resetsAt: inHours(70), windowMins: 10080, severity: "normal" },
          ],
        },
        models: [
          { value: "default", label: "Default" },
          { value: "claude-sonnet-5-5", label: "Sonnet 5.5" },
        ],
      }),
    ],
  },
  { ...base, id: "codex", name: "Codex", state: "signed_out", accounts: [], actions: [{ kind: "refresh", label: "Refresh" }, { kind: "sign_in", label: "Sign in", via: "device_code" }] },
  { ...base, id: "hermes", name: "Hermes", state: "connected", accounts: [account({ label: "openrouter", email: null, plan: null, models: models(14, "hermes") })] },
  { ...base, id: "omp", name: "omp", installed: false, version: null, state: "not_installed", accounts: [], actions: [{ kind: "fix", label: "Fix", hint: "Ask whoever installed Kohlab to set it up" }] },
];
// What a member gets: the server drops email, plan, usage, versions, actions and the account's own label.
const MEMBER_CARDS = OWNER_CARDS.map((c) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  installed: c.installed,
  version: null,
  state: c.state,
  checkedAt: c.checkedAt,
  stale: false,
  accounts: c.accounts.map((a) => ({ id: a.id, label: c.name, email: null, plan: null, auth: a.auth, state: a.state, isolation: {}, usage: null, models: a.models, modelsAt: a.modelsAt })),
  actions: [],
}));

const HELPERS = [
  { id: "h1", taskId: "t1", parentId: null, label: "Research the page", kind: "Explore", model: "claude-haiku-5-5", status: "running", background: true, startedAt: Date.now() - 30_000, endedAt: null, tools: 4, tokens: 1234, lastTool: "Read index.html", summary: "Looking at the styles", canStop: true },
  { id: "h2", taskId: "t2", parentId: "h1", label: "Read the styles", kind: null, model: null, status: "done", background: false, startedAt: Date.now() - 20_000, endedAt: Date.now() - 10_000, tools: 2, tokens: null, lastTool: null, summary: null, canStop: false },
  { id: "h3", taskId: null, parentId: null, label: "Check the links", kind: "General", model: null, status: "failed", background: false, startedAt: Date.now() - 50_000, endedAt: Date.now() - 40_000, tools: null, tokens: null, lastTool: null, summary: "A link was broken", canStop: false },
];
const RUN = {
  agent: "claude",
  agentName: "Claude",
  terminalProject: false,
  instructions: { system: "You help a person build a small website.", notes: "My shop is called Blue Door.", note: null },
  tools: { builtin: ["Read", "Edit", "Bash"], mcp: [{ name: "playwright", status: "connected" }] },
  ready: true,
};
const DONE = { n: 9000, at: Date.now(), kind: "done", worked: 72_000, model: "claude-sonnet-5-5", tokens: { in: 12000, out: 345 }, planDelta: 4.2 };
const HANDOFF = { n: 9001, at: Date.now(), kind: "handoff", text: "Goal\nBuild the shop page" };

/** Answers the AI hub's routes on a page. `role` makes the app think this person is an owner or a member. */
async function mock(page, { member = false, context = null } = {}) {
  await page.route(/\/api\/providers$/, (route) => route.fulfill({ json: { providers: member ? MEMBER_CARDS : OWNER_CARDS, at: Date.now() } }));
  await page.route(/\/api\/workspaces\/[^/]+\/chat\/run$/, (route) => route.fulfill({ json: RUN }));
  // The v2.6 routes: the defaults panel shows (the cards below it must not change), the rules list is empty.
  await page.route(/\/api\/ai\/defaults$/, (route) => route.fulfill({ json: { defaults: {} } }));
  await page.route(/\/api\/ai\/rules$/, (route) => route.fulfill({ json: { projects: [] } }));
  if (member) await page.route(/\/api\/account$/, (route) => route.fulfill({ json: { id: "sam", role: "member", kind: "user" } }));
  await page.route(/\/api\/workspaces\/[^/]+\/chat\?after=/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.helperTree = HELPERS;
    body.events = [...body.events, DONE, ...(context ? [HANDOFF] : [])];
    if (context !== null) body.usage = { context: { used: context * 10, limit: 1000, percent: context }, plan: null };
    await route.fulfill({ response: res, json: body });
  });
}

/** Runs in the page: the rules of check-design (one primary, big enough controls, contrast), and the signs of a spinner. */
function measure(touch) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden], [inert], .xterm");
  };
  const label = (el) => `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}]`;
  const primaries = [...document.querySelectorAll(".btn-primary")].filter(visible).map(label);
  const min = touch ? 44 : 24;
  const small = [...document.querySelectorAll("button, [role=tab], [role=menuitem]")]
    .filter(visible)
    .filter((el) => !el.matches("[disabled], [aria-disabled=true]"))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => Math.min(r.width, r.height) < min - 0.5)
    .map(({ el, r }) => `${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  const canvas = document.createElement("canvas").getContext("2d");
  const rgba = (c) => {
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = "#000";
    canvas.fillStyle = c;
    canvas.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
    return [r, g, b, a / 255];
  };
  const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const bgOf = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3] > 0.95) return c;
    }
    return [255, 255, 255, 1];
  };
  const low = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    const el = n.parentElement;
    if (!text || !el || !visible(el) || el.closest("script, style, [disabled], [aria-disabled=true], .dark-pane, .sr-only")) continue;
    let dimmed = false;
    for (let e = el; e; e = e.parentElement) if (+getComputedStyle(e).opacity < 1) dimmed = true;
    if (dimmed) continue;
    const s = getComputedStyle(el);
    const bg = bgOf(el);
    const fg = rgba(s.color);
    const mix = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const [hi, lo] = [lum(mix), lum(bg)].sort((a, b) => b - a);
    const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < (large ? 3 : 4.5)) low.push(`"${text.slice(0, 24)}" ${ratio.toFixed(2)}:1`);
  }
  const spinners = document.querySelectorAll('[aria-busy="true"], .animate-spin, [class*="spinner"]').length;
  return { primaries, small, low: [...new Set(low)], spinners };
}

async function design(page, at, touch) {
  const m = await page.evaluate(measure, touch);
  check(`${at}: at most one primary button`, m.primaries.length <= 1, m.primaries.join(", "));
  check(`${at}: controls >= ${touch ? 44 : 24}px`, m.small.length === 0, m.small.slice(0, 4).join(", "));
  check(`${at}: text contrast >= 4.5:1`, m.low.length === 0, m.low.slice(0, 4).join(", "));
  check(`${at}: no spinner and no aria-busy`, m.spinners === 0);
}

const KEY = "ai-hub-check-key";
const fx = await startFixture({ port: 7873, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  /* -------------------------------------------------------- Settings -> AI -- */
  {
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/agents`);
    await page.locator("section.panel h3").first().waitFor({ timeout: 15000 }).catch(() => {});
    // The AI cards are the panels with a state chip; the defaults and the always-allowed panels sit around them.
    const names = await page.locator("section.panel:has(.chip) h3").evaluateAll((els) => els.map((e) => e.childNodes[0].textContent.trim()));
    check("Settings -> AI: one card per AI, Claude first, then connected, signed out, not installed", JSON.stringify(names) === JSON.stringify(["Claude", "Hermes", "Codex", "omp"]), names.join(", "));
    const cards = page.locator("section.panel:has(.chip)");
    const words = await cards.evaluateAll((els) => els.map((e) => e.querySelector(".chip")?.textContent.trim() ?? ""));
    check("each card has a state word", JSON.stringify(words) === JSON.stringify(["Connected", "Connected", "Signed out", "Not installed"]), words.join(", "));
    const claudeCard = cards.nth(0);
    const meters = await claudeCard.getByRole("meter").evaluateAll((els) => els.map((e) => e.getAttribute("aria-valuenow")));
    check("Claude shows two meters with a value", JSON.stringify(meters) === JSON.stringify(["34", "61"]), meters.join(", "));
    check("the meters say when they reset", (await claudeCard.innerText()).match(/resets/gi)?.length === 2);
    check("the owner sees the email, the plan and the version", /you@example\.com/.test(await claudeCard.innerText()) && /Max/.test(await claudeCard.innerText()) && /9\.9\.9/.test(await claudeCard.innerText()));
    check("models disclosure counts", (await claudeCard.locator("summary").innerText()) === "2 models" && (await cards.nth(1).locator("summary").innerText()) === "14 models");
    await cards.nth(1).locator("summary").click();
    check("a long model list gets a search box", (await cards.nth(1).getByRole("searchbox", { name: "Search models" }).count()) === 1);
    check("the defaults panel comes first and is not an AI card", (await page.locator("section.panel h3").first().innerText()) === "Defaults for new projects" && !names.includes("Defaults for new projects"));
    check("the owner can Refresh", (await claudeCard.getByRole("button", { name: "Refresh" }).count()) === 1);
    check("signed-out Codex offers Sign in", (await cards.nth(2).getByRole("button", { name: "Sign in to Codex" }).count()) === 1);
    check("not-installed omp says what to do", /Ask whoever installed Kohlab/.test(await cards.nth(3).innerText()));
    await design(page, "Settings -> AI @1440", false);
    await ctx.close();
  }

  {
    const ctx = await openContext(browser, { width: 390, height: 844, key: KEY, touch: true });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/settings/agents`);
    await page.locator("section.panel h3").first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    await design(page, "Settings -> AI @390", true);
    await ctx.close();
  }

  /* -------------------------------------------- the project page, wide + phone -- */
  for (const [width, touch] of [[1440, false], [390, true]]) {
    const ctx = await openContext(browser, { width, height: 900, key: KEY, touch });
    const page = await ctx.newPage();
    await mock(page);
    await page.goto(`${fx.base}/w/${fx.ready}/chat`);
    const strip = page.locator('button[aria-label^="Run details"]');
    await strip.waitFor({ timeout: 15000 }).catch(() => {});
    const at = `chat @${width}`;
    check(`${at}: the run strip is in view without a click`, await strip.isVisible());
    const stripText = (await strip.innerText()).trim();
    const chip = page.locator('button[aria-label^="AI and model"]:visible').first();
    const chipText = (await chip.innerText()).trim();
    const modelPart = chipText.split("·").pop().trim();
    check(`${at}: the strip names the AI and the model`, stripText.startsWith("Claude") && stripText.includes(modelPart), `${stripText} | ${chipText}`);
    if (!touch) check(`${at}: the strip names the mode`, /Asks first/.test(stripText), stripText);
    check(`${at}: the strip is text only`, (await strip.locator("svg, img").count()) === 0);

    // the picker: a heading per connected AI, with the account for the owner; a signed-out AI is absent
    await chip.click();
    const menu = page.getByRole("menu");
    await menu.waitFor({ timeout: 5000 }).catch(() => {});
    const menuText = await menu.innerText().catch(() => "");
    check(`${at}: the picker groups by AI with the account line`, menuText.includes(`Claude · ${EMAIL}`) && menuText.includes("Hermes"), menuText.slice(0, 120).replace(/\n/g, " | "));
    check(`${at}: a signed-out AI is not in the picker`, !/Codex/.test(menuText));
    await page.keyboard.press("Escape");

    // the Run panel
    const aside = page.locator('aside[aria-label="Run"]');
    if (!touch) {
      await aside.waitFor({ timeout: 5000 }).catch(() => {});
      check(`${at}: the Run panel is docked and open with the Preview closed`, await aside.isVisible());
    } else {
      check(`${at}: on a phone the Run panel is not docked`, (await aside.count()) === 0);
      await strip.click();
      await page.getByRole("dialog", { name: "Run details" }).waitFor({ timeout: 5000 }).catch(() => {});
      check(`${at}: the strip opens the Run panel as a sheet`, await page.getByRole("dialog", { name: "Run details" }).isVisible());
    }
    const panel = touch ? page.getByRole("dialog", { name: "Run details" }) : aside;
    await panel.getByRole("heading", { name: "Helpers", level: 3 }).waitFor({ timeout: 5000 }).catch(() => {});
    const heads = await panel.getByRole("heading", { level: 3 }).allInnerTexts();
    check(`${at}: the sections are there`, ["Now", "Helpers", "Replies", "What it was told", "What it can use"].every((h) => heads.includes(h)), heads.join(", "));

    // helpers: nested rows, each with a status word; Stop only where it can work
    const roots = panel.locator('ul[aria-label="Helpers"] > li');
    check(`${at}: helper rows: two at the top`, (await roots.count()) === 2);
    check(`${at}: the second helper sits inside the first`, (await roots.nth(0).locator("ul > li").count()) === 1);
    const rowWords = await panel.locator('ul[aria-label="Helpers"] li > div > button[aria-expanded]').evaluateAll((els) => els.map((e) => e.querySelector("span > span:last-child")?.textContent.trim()));
    check(`${at}: each helper shows a status word`, JSON.stringify(rowWords) === JSON.stringify(["Working", "Done", "Failed"]), rowWords.join(", "));
    const rowText = await roots.nth(0).innerText();
    check(`${at}: a helper shows kind, model, steps and tokens`, /Explore/.test(rowText) && /Haiku 5\.5/.test(rowText) && /4 steps/.test(rowText) && /1\.2k tokens/.test(rowText), rowText.replace(/\n/g, " | "));
    const stops = await panel.getByRole("button", { name: /^Stop / }).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    check(`${at}: Stop only on the helper that can be stopped`, JSON.stringify(stops) === JSON.stringify(["Stop Research the page"]), stops.join(", "));
    await roots.nth(0).locator(":scope > div > button[aria-expanded]").click();
    check(`${at}: pressing a helper shows its last step`, /Last step: Read index\.html/.test(await roots.nth(0).innerText()));

    // replies, what it was told, what it can use
    const replies = await panel.locator('ul[aria-label="Replies"]').innerText();
    check(`${at}: Replies shows model, time, tokens and the plan share`, /Sonnet 5\.5 · 1m 12s · 12\.3k tokens · 4% of your plan/.test(replies), replies.replace(/\n/g, " | "));
    const told = panel.locator("section", { has: page.getByRole("heading", { name: "What it was told", level: 3 }) });
    await told.locator("pre").first().waitFor({ timeout: 5000 }).catch(() => {});
    check(`${at}: what it was told is shown`, /Blue Door/.test(await told.innerText()));
    check(`${at}: what it was told cannot be edited`, (await told.locator("textarea, input, [contenteditable]").count()) === 0);
    const tools = await panel.locator("section", { has: page.getByRole("heading", { name: "What it can use", level: 3 }) }).innerText();
    check(`${at}: tools and connected tool servers are listed`, /Read, Edit, Bash/.test(tools) && /playwright/.test(tools) && /Connected/.test(tools));
    const wording = await panel.innerText();
    check(`${at}: the panel never says sub-agent, MCP or system prompt`, !/sub-?agent|\bMCP\b|system prompt/i.test(wording));
    if (touch) await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.waitForTimeout(300);
    await design(page, at, touch);
    await ctx.close();
  }

  /* ------------------------------------------ banner and handoff card, wide -- */
  {
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, { context: 75 });
    await page.goto(`${fx.base}/w/${fx.ready}/chat`);
    const banner = page.getByText("This chat is getting long. Continue with a fresh memory? Nothing is lost.");
    await banner.waitFor({ timeout: 15000 }).catch(() => {});
    check("banner: shown at 75% full", await banner.isVisible());
    await design(page, "wide with the banner", false);
    check("banner: Continue fresh, Not now and Do it for me", (await page.getByRole("button", { name: "Continue fresh", exact: true }).count()) >= 1 && (await page.getByRole("button", { name: "Not now" }).count()) >= 1 && (await page.getByLabel("Do it for me").count()) === 1);
    const card = page.locator("details", { hasText: "Handoff note" }).first();
    check("handoff note: a collapsed card in the chat", (await card.count()) === 1 && !(await card.evaluate((e) => e.open)));
    await page.getByRole("button", { name: "Not now" }).first().click();
    check("banner: Not now hides it", !(await banner.isVisible()));
    await ctx.close();
  }

  /* -------------------------------------------------------- member's view -- */
  for (const path of ["/settings/agents", `/w/${fx.ready}/chat`]) {
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, { member: true });
    await page.goto(fx.base + path);
    await page.locator(path.startsWith("/settings") ? "section.panel h3" : 'button[aria-label^="Run details"]').first().waitFor({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    const body = await page.locator("body").innerText();
    check(`member ${path.split("/")[1]}: no email in the page`, !body.includes(EMAIL));
    check(`member ${path.split("/")[1]}: no plan, usage or version in the page`, !/\bMax\b/.test(body) && !/9\.9\.9/.test(body) && !/% used/.test(body) && (await page.getByRole("meter").count()) === 0);
    if (path.startsWith("/settings")) {
      check("member: states and models are shown, no Refresh", /Connected/.test(body) && /models/.test(body) && (await page.getByRole("button", { name: "Refresh" }).count()) === 0);
    } else {
      const aside = page.locator('aside[aria-label="Run"]');
      check("member: the strip and the panel are there", (await aside.count()) === 1 && /Claude/.test(await page.locator('button[aria-label^="Run details"]').innerText()));
      check("member: no plan share in Replies", !/of your plan/.test(await aside.innerText()));
    }
    await ctx.close();
  }
} finally {
  await browser?.close();
  fx.stop();
}

/* ------------------------------------------------------- the files themselves -- */
const root = new URL("../web/src/", import.meta.url).pathname;
const added = ["components/ProvidersPane.tsx", "components/ModelPicker.tsx", "components/RunStrip.tsx", "components/RunPanel.tsx", "components/AccountDialogs.tsx", "components/AiDefaultsPanel.tsx", "components/AiMenus.tsx", "components/RulesPanel.tsx", "lib/aiHub.ts", "lib/useProviders.ts"];
for (const f of added) {
  const text = readFileSync(join(root, f), "utf8");
  check(`${f}: no colour literal`, !/#[0-9a-fA-F]{3,8}\b|oklch\(|rgba?\(/.test(text));
  check(`${f}: no colour primitive`, !/(?:^|[^\w-])(?:text|bg|border|fill|stroke|ring|from|to|via)-(?:neutral|red|lime)-\d|--(?:neutral|red|lime)-\d/.test(text));
}
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const radix = walk(root).filter((f) => /\.tsx?$/.test(f) && !f.endsWith("components/ui.tsx") && /from ["']@radix-ui\//.test(readFileSync(f, "utf8")));
check("no @radix-ui import outside ui.tsx", radix.length === 0, radix.join(", "));

console.log(failures ? `\n${failures} failed` : "\nall AI hub UI checks passed");
process.exit(failures ? 1 : 0);
