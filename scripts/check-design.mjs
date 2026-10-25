#!/usr/bin/env node
// The design rules in DESIGN.md that a script can read off the rendered page, on Home, a ready chat, an empty
// chat, Changes and Settings, at 1280 (mouse) and 390 (touch):
//   - at most one primary button per view  (primary = a visible `.btn-primary`)
//   - main controls are big enough: >= 24px with a mouse (WCAG 2.5.8), >= 44px on touch
//   - no segmented switch with a single segment
//   - text contrast >= 4.5:1 against the nearest opaque background (the token pairs are in check-contrast)
//
// Throwaway server (own PORT, WORKS_DIR, PTY_SOCKET) with two chat projects, against the built web/dist.
// Skips with a printed reason when playwright-core or Chromium is missing.
//
//   cd web && bun run build && node scripts/check-design.mjs
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

/** Runs in the page. Returns what the four rules need, nothing else. */
function measure(touch) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden], [inert], .xterm");
  };
  const label = (el) => `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}]`;

  const primaries = [...document.querySelectorAll(".btn-primary")].filter(visible).map(label);

  // Main controls: buttons and tabs a person presses to do the work. Fields, links in prose and the
  // Monaco editor are out of scope (check-browser already holds every control to 24px).
  const min = touch ? 44 : 24;
  const small = [...document.querySelectorAll("button, [role=tab], [role=menuitem]")]
    .filter(visible)
    .filter((el) => !el.matches("[disabled], [aria-disabled=true]"))
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => Math.min(r.width, r.height) < min - 0.5)
    .map(({ el, r }) => `${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);

  const oneSegment = [...document.querySelectorAll("[role=tablist]")].filter(visible).filter((l) => [...l.querySelectorAll("[role=tab]")].filter(visible).length < 2).map(label);

  // Text contrast, WCAG relative luminance. The colour is read from the element, the background from the
  // nearest ancestor with an opaque fill. Disabled and dimmed text is exempt (SC 1.4.3).
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
    const ratio = (hi + 0.05) / (lo + 0.05);
    const large = parseFloat(s.fontSize) >= 24 || (parseFloat(s.fontSize) >= 18.66 && +s.fontWeight >= 700);
    if (ratio < (large ? 3 : 4.5)) low.push(`"${text.slice(0, 24)}" ${ratio.toFixed(2)}:1`);
  }
  return { primaries, small, oneSegment, low: [...new Set(low)] };
}

const KEY = "design-check-key";
const fx = await startFixture({ port: 7872, key: KEY });
let browser;
try {
  browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
  const views = [
    ["Home", "/"],
    ["ready chat", `/w/${fx.ready}/chat`],
    ["empty chat", `/w/${fx.fresh}/chat`],
    ["Changes", `/w/${fx.ready}/review`],
    ["Settings", "/settings"],
  ];
  for (const [width, touch] of [[1280, false], [390, true]]) {
    for (const scheme of ["dark", "light"]) {
      const ctx = await openContext(browser, { width, height: 844, key: KEY, touch, scheme });
      const page = await ctx.newPage();
      for (const [name, path] of views) {
        await page.goto(fx.base + path);
        await page.locator("h1").first().waitFor({ timeout: 15000 }).catch(() => {});
        if (name === "Changes") await page.getByRole("button", { name: "Keep this version" }).waitFor({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(500);
        const m = await page.evaluate(measure, touch);
        const at = `${name} @${width} ${scheme}`;
        check(`${at}: at most one primary button`, m.primaries.length <= 1, m.primaries.join(", "));
        // Guards the selector: Home always shows its one primary (Start building), so 0 means the class was renamed.
        if (name === "Home") check(`${at}: the primary is found by its class`, m.primaries.length === 1, m.primaries.join(", "));
        check(`${at}: main controls >= ${touch ? 44 : 24}px`, m.small.length === 0, m.small.slice(0, 4).join(", "));
        check(`${at}: no one-segment switch`, m.oneSegment.length === 0, m.oneSegment.join(", "));
        check(`${at}: text contrast >= 4.5:1`, m.low.length === 0, m.low.slice(0, 4).join(", "));
      }
      await ctx.close();
    }
  }
} finally {
  await browser?.close();
  fx.stop();
}
console.log(failures ? `\n${failures} failed` : "\nall design checks passed");
process.exit(failures ? 1 : 0);
