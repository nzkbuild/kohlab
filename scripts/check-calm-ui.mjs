#!/usr/bin/env node
// The calmer app in the browser (v2.11, stage 1): Settings -> AI in Soft and Plain colour, dark and light, at 1440 and
// 390; the Appearance colour choice, its save, and its persistence; the Claude model picker's outcome lines.
// /api/providers and /api/account/prefs are answered by page.route (no AI runs). Throwaway server on port 7959.
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-calm-ui.mjs
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

/* --------------------------------------------------------------- fixtures -- */
const EMAIL = "you@example.com";
const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();
const claudeModels = [
  { value: "default", label: "Default (recommended)", efforts: [] },
  { value: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "high", "max"] },
  { value: "claude-sonnet-5-5", label: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
  { value: "claude-haiku-5-5", label: "Haiku 5.5", efforts: [] },
];
const base = { kind: "cli", installed: true, version: "9.9.9", checkedAt: Date.now() - 120_000, stale: false, actions: [{ kind: "refresh", label: "Refresh" }] };
const account = (over) => ({ id: "default", label: EMAIL, email: EMAIL, plan: "max", auth: "oauth", state: "connected", isolation: {}, usage: null, models: [], modelsAt: 1, ...over });
const CARDS = [
  {
    ...base,
    id: "claude",
    name: "Claude",
    state: "connected",
    accounts: [
      account({
        models: claudeModels,
        usage: {
          readAt: Date.now(),
          windows: [
            { id: "five", label: "This session", percent: 34, resetsAt: inHours(2), windowMins: 300, severity: "normal" },
            { id: "week", label: "This week", percent: 61, resetsAt: inHours(40), windowMins: 10080, severity: "normal" },
          ],
        },
      }),
    ],
  },
  { ...base, id: "codex", name: "Codex", state: "signed_out", accounts: [account({ id: "default", label: "Codex", email: null, plan: null, state: "signed_out", kind: "default", models: [] })], actions: [{ kind: "sign_in", label: "Sign in to Codex", via: "device_code" }] },
  { ...base, id: "hermes", name: "Hermes", state: "connected", accounts: [account({ id: "default", label: "Hermes", email: null, plan: null, kind: "default", models: [{ value: "hermes-1", label: "Hermes 1" }] })] },
  { ...base, id: "omp", name: "omp", installed: false, version: null, state: "not_installed", accounts: [], actions: [{ kind: "fix", label: "Fix", hint: "Ask whoever installed Kohlab to set it up" }] },
];

/** Answers the providers route and the prefs route. Every prefs POST is recorded and echoed. */
async function mock(page, saved) {
  await page.route(/\/api\/providers$/, (route) => route.fulfill({ json: { providers: CARDS, at: Date.now() } }));
  await page.route(/\/api\/ai\/defaults$/, (route) => route.fulfill({ json: { defaults: {} } }));
  await page.route(/\/api\/ai\/rules$/, (route) => route.fulfill({ json: { projects: [] } }));
  // The chat's own model list (what the composer's picker shows for Claude).
  await page.route(/\/api\/workspaces\/[^/]+\/chat\?after=/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.models = claudeModels.map((m) => ({ value: m.value, displayName: m.label, description: "", supportedEffortLevels: m.efforts }));
    await route.fulfill({ response: res, json: body });
  });
  await page.route(/\/api\/account\/prefs$/, async (route) => {
    const body = route.request().postDataJSON();
    saved.push(body);
    await route.fulfill({ json: body });
  });
}

/** Runs in the page: the low-contrast text, the same rule as check-design (4.5:1, 3:1 for large text). */
function lowContrast() {
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
    if (!text || !el || el.closest("script, style, [disabled], [aria-disabled=true], .dark-pane, .sr-only")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const s = getComputedStyle(el);
    const fg = rgba(s.color);
    const bg = bgOf(el);
    const mix = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const [hi, lo] = [lum(mix), lum(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) low.push(`"${text.slice(0, 24)}" ${ratio.toFixed(2)}:1`);
  }
  return [...new Set(low)];
}

const DEV_WORDS = /\b(undefined|null|NaN|stdin|stdout|JSON|RPC|\[object)\b/;
const KEY = "calm-ui-key";
const fx = await startFixture({ port: 7959, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });

  /* ---------------------------------------- Settings -> AI, both colours -- */
  for (const [width, touch] of [[1440, false], [390, true]]) {
    for (const scheme of ["dark", "light"]) {
      for (const colour of ["soft", "plain"]) {
        const at = `Settings -> AI @${width} ${scheme} ${colour}`;
        const ctx = await openContext(browser, { width, height: 900, key: KEY, touch, scheme });
        await ctx.addInitScript((v) => localStorage.setItem("kohlab.softColour", v), colour === "soft" ? "1" : "0");
        const page = await ctx.newPage();
        const saved = [];
        await mock(page, saved);
        await page.goto(`${fx.base}/settings/agents`);
        const tiles = page.getByRole("group", { name: "Your AIs" }).getByRole("button");
        await tiles.first().waitFor({ timeout: 15000 }).catch(() => {});
        check(`${at}: a status tile per AI`, (await tiles.count()) === 4);
        const tileText = await tiles.allInnerTexts();
        check(`${at}: status tiles say the state in words`, tileText.some((t) => /Signed in/.test(t)) && tileText.some((t) => /Not signed in/.test(t)) && tileText.some((t) => /Not installed/.test(t)), tileText.join(" | ").replace(/\n/g, " "));
        check(`${at}: the chosen AI is Claude (the first, pressed)`, (await tiles.first().getAttribute("aria-pressed")) === "true");

        const claude = page.locator("section.panel:has(.chip)");
        const meters = await claude.getByRole("meter").evaluateAll((els) => els.map((e) => e.getAttribute("aria-valuenow")));
        check(`${at}: plan meters with their values`, JSON.stringify(meters) === JSON.stringify(["34", "61"]), meters.join(", "));
        const tilesOn = claude.getByRole("region", { name: "What it can do" }).getByRole("listitem");
        check(`${at}: eight capability tiles`, (await tilesOn.count()) === 8);
        const states = await tilesOn.evaluateAll((els) => els.map((e) => e.querySelectorAll("span")[1].textContent.trim()));
        check(`${at}: capability states are the honest words`, states.every((s) => ["Yes", "Depends", "Summary only", "No"].includes(s)), states.join(", "));

        await tiles.nth(1).click();
        const codex = page.locator("section.panel:has(.chip)");
        const codexStates = await codex.getByRole("region", { name: "What it can do" }).getByRole("listitem").evaluateAll((els) => els.map((e) => e.querySelectorAll("span")[1].textContent.trim()));
        check(`${at}: a signed-out AI shows its honest tiles (Codex: no team, no plan)`, codexStates.length === 8 && codexStates[6] === "No" && codexStates[7] === "No", codexStates.join(", "));
        await tiles.first().click();

        const primaries = await page.locator(".btn-primary:visible").count();
        check(`${at}: at most one primary`, primaries <= 1, `${primaries}`);
        const text = await page.locator("main, body").first().innerText();
        check(`${at}: no developer words`, !DEV_WORDS.test(text), (text.match(DEV_WORDS) ?? [])[0] ?? "");
        check(`${at}: no coming-soon words`, !/\b(coming soon|coming|roadmap)\b/i.test(text));
        const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
        check(`${at}: no horizontal overflow`, dims.sw <= dims.iw, `${dims.sw} > ${dims.iw}`);
        const low = await page.evaluate(lowContrast);
        check(`${at}: text contrast >= 4.5:1`, low.length === 0, low.slice(0, 4).join(", "));
        const attr = await page.evaluate(() => document.documentElement.getAttribute("data-colour"));
        check(`${at}: the colour attribute matches the choice`, colour === "soft" ? attr === "soft" : attr === null, `${attr}`);
        await ctx.close();
      }
    }
  }

  /* ------------------------------------------------- Appearance: Soft/Plain -- */
  {
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    const saved = [];
    await mock(page, saved);
    await page.goto(`${fx.base}/settings/appearance`);
    const soft = page.getByRole("tab", { name: "Soft" });
    const plain = page.getByRole("tab", { name: "Plain" });
    await plain.waitFor({ timeout: 15000 }).catch(() => {});
    check("Appearance: Soft is selected by default", (await soft.getAttribute("aria-selected")) === "true");
    check("Appearance: the page is in soft colour", (await page.evaluate(() => document.documentElement.getAttribute("data-colour"))) === "soft");
    await plain.click();
    await page.waitForTimeout(300);
    check("Appearance: Plain switches the page to plain colour", (await page.evaluate(() => document.documentElement.getAttribute("data-colour"))) === null);
    check("Appearance: Plain saves softColour false to the account", JSON.stringify(saved.at(-1)) === JSON.stringify({ softColour: false }), JSON.stringify(saved));
    await page.reload();
    await plain.waitFor({ timeout: 15000 }).catch(() => {});
    check("Appearance: Plain persists after a reload", (await page.evaluate(() => document.documentElement.getAttribute("data-colour"))) === null && (await plain.getAttribute("aria-selected")) === "true");
    await soft.click();
    await page.waitForTimeout(300);
    check("Appearance: Soft saves softColour true", JSON.stringify(saved.at(-1)) === JSON.stringify({ softColour: true }), JSON.stringify(saved));
    check("Appearance: Soft switches the page back", (await page.evaluate(() => document.documentElement.getAttribute("data-colour"))) === "soft");
    await ctx.close();
  }

  /* --------------------------------------------- the picker: outcome lines -- */
  {
    const ctx = await openContext(browser, { width: 1440, height: 900, key: KEY });
    const page = await ctx.newPage();
    await mock(page, []);
    await page.goto(`${fx.base}/w/${fx.ready}/chat`);
    const chip = page.locator('button[aria-label^="AI and model"]:visible').first();
    await chip.waitFor({ timeout: 15000 }).catch(() => {});
    await chip.click();
    const menu = page.getByRole("menu");
    await menu.waitFor({ timeout: 5000 }).catch(() => {});
    const menuText = await menu.innerText().catch(() => "");
    check("picker: Opus shows its outcome line", menuText.includes("Opus 5.5") && menuText.includes("Strongest · for big or tricky work"), menuText.slice(0, 160).replace(/\n/g, " | "));
    check("picker: Sonnet shows its outcome line", menuText.includes("Everyday · a good default for building"));
    check("picker: Haiku shows its outcome line", menuText.includes("Quickest · for small edits and questions"));
    check("picker: the model names stay as they were", menuText.includes("Opus 5.5") && !menuText.includes("Opus 5.5 —"));
    await ctx.close();
  }
} finally {
  await browser?.close();
  fx.stop();
}
console.log(failures ? `\n${failures} failed` : "\nall calm UI checks passed");
process.exit(failures ? 1 : 0);
