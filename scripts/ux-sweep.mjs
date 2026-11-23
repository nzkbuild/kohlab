#!/usr/bin/env node
// UX sweep: numbers, not screenshots, for what makes the UI feel flaky. Read scripts/ux-sweep.README.txt.
//
// A throwaway server on its own PORT (7971), WORKS_DIR, PTY_SOCKET and HOME serves a COPY of web/dist, so the
// build the other agent is making is never touched. Seeded over HTTP with agent "sh" only: no AI runs.
//
//   node scripts/ux-sweep.mjs          report to /tmp/ux-sweep/report.json and print a summary (exit 0)
//   node scripts/ux-sweep.mjs --gate   also exit 1 when any HIGH issue exists (not wired into check-all)
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBrowser, openContext } from "./ui-fixture.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = 7971;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "ux-sweep-key";
const OUT = "/tmp/ux-sweep";
const GATE = process.argv.includes("--gate");
const CONCURRENCY = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEWPORTS = [
  { name: "390x844", w: 390, h: 844, touch: true, min: 44 },
  { name: "820x1180", w: 820, h: 1180, touch: false, min: 24 },
  { name: "1440x900", w: 1440, h: 900, touch: false, min: 24 },
];
const SCHEMES = ["light", "dark"];
const SETTINGS = ["account", "appearance", "agents", "notifications", "updates", "backups", "trash"];
const WEIGHT = { high: 3, medium: 2, low: 1 };

// ---- in-page code. Each function is serialised by Playwright, so it must be self-contained. ----

/** Observes layout shifts from before the first paint; the sources name the element that moved. */
function CLS_INIT() {
  const cssPath = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join("")}`.slice(0, 80);
  const st = (window.__cls = { total: 0, bySel: {} });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        st.total += e.value;
        const n = e.sources?.find((s) => s.node && s.node.nodeType === 1)?.node;
        const key = n ? cssPath(n) : "(no element)";
        st.bySel[key] = (st.bySel[key] || 0) + e.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    /* no layout-shift support: CLS reads 0 */
  }
}

/** The text a person reads: no terminal output (xterm repaints its rows), no script or hidden text. */
function readableText() {
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const p = n.parentElement;
    if (!p || !n.textContent.trim() || p.closest(".xterm, script, style, [aria-hidden=true]") || !p.getClientRects().length) continue;
    out.push(n.textContent);
  }
  return out.join("\n");
}

/** Static checks on the settled page: overflow, covered controls, target size, text size and contrast. */
function auditPage({ min, scoped }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cs = (el) => getComputedStyle(el);
  const cssPath = (el) => {
    const tag = el.tagName.toLowerCase();
    const label = el.getAttribute("aria-label");
    const text = tag === "button" || tag === "a" ? (el.innerText || "").trim().replace(/\s+/g, " ").slice(0, 24) : "";
    return `${tag}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join("").slice(0, 60)}${label ? `[aria-label="${label.slice(0, 40)}"]` : ""}${text ? ` "${text}"` : ""}`;
  };
  const visible = (el) => {
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2; // a 1px box is a visually hidden helper (sr-only)
  };
  const inView = (r) => r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
  const all = [...document.querySelectorAll("*")];

  const controls = [
    ...document.querySelectorAll("button, a, input, select, [role=button], [role=tab], [role=menuitem], [role=switch], [role=checkbox]"),
  ].filter((el) => el.type !== "hidden" && visible(el) && !el.closest("[inert], [aria-hidden=true]"));
  // With a popup open, only its controls are judged: the page behind it is covered on purpose.
  const overlays = [...document.querySelectorAll("[role=dialog], [role=alertdialog], [role=menu], [role=listbox], aside[aria-label=Preview]")].filter(visible);
  const inScope = (el) => !scoped || overlays.length === 0 || overlays.some((o) => o.contains(el));
  const scopedControls = controls.filter(inScope);

  const covered = [];
  let offscreen = 0;
  for (const el of scopedControls) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= vw || y >= vh) {
      offscreen++;
      continue;
    }
    const top = document.elementFromPoint(x, y);
    if (top && (top === el || el.contains(top) || top.contains(el))) continue;
    covered.push({ sel: cssPath(el), toast: !!(top && top.closest("[data-sonner-toaster], [data-sonner-toast], .kohlab-toast")), by: top ? cssPath(top) : "(nothing: clipped out)", at: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  }

  const small = [];
  for (const el of scopedControls) {
    if (el.tagName === "A" && cs(el).display === "inline") continue; // a link inside prose
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2 || !inView(r)) continue; // visually hidden helpers
    // A checkbox, radio or switch is hit through its label: the larger of the two boxes is the target.
    const lab = el.matches("input[type=checkbox], input[type=radio], [role=switch]") ? el.closest("label") : null;
    const lr = lab ? lab.getBoundingClientRect() : null;
    const w = Math.max(r.width, lr?.width ?? 0);
    const h = Math.max(r.height, lr?.height ?? 0);
    if (w < min || h < min) small.push({ sel: cssPath(el), size: `${Math.round(w)}x${Math.round(h)}` });
  }

  const docW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const clipped = (el) => {
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (/hidden|clip|auto|scroll/.test(cs(a).overflowX) && a.getBoundingClientRect().right <= vw + 1) return true;
    }
    return false;
  };
  const wide = [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.right <= vw + 1 || !visible(el) || clipped(el)) continue;
    wide.push({ sel: cssPath(el), right: Math.round(r.right) });
  }

  const cutText = [];
  for (const el of all) {
    const s = cs(el);
    if (!/hidden|clip/.test(s.overflowX) || s.textOverflow === "ellipsis" || !ownText(el) || !visible(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1) cutText.push({ sel: cssPath(el), px: el.scrollWidth - el.clientWidth });
  }

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx2d = canvas.getContext("2d", { willReadFrequently: true });
  const toRGBA = (css) => {
    ctx2d.clearRect(0, 0, 1, 1);
    ctx2d.fillStyle = "#000";
    ctx2d.fillStyle = css; // oklch and colour-mix come back as sRGB through the canvas
    ctx2d.fillRect(0, 0, 1, 1);
    const d = ctx2d.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  // The first opaque background up the tree, composited; null when an image or gradient sits behind the text.
  const bgOf = (el) => {
    const stack = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const s = cs(n);
      if (s.backgroundImage && s.backgroundImage !== "none") return null;
      const c = toRGBA(s.backgroundColor);
      if (c.a > 0) stack.push(c);
      if (c.a >= 1) break;
    }
    let acc = { r: 255, g: 255, b: 255 };
    for (const c of stack.reverse()) acc = { r: c.r * c.a + acc.r * (1 - c.a), g: c.g * c.a + acc.g * (1 - c.a), b: c.b * c.a + acc.b * (1 - c.a) };
    return acc;
  };
  const lum = (c) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const rgb = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

  const textEls = all.filter((el) => ownText(el) && visible(el) && inView(el.getBoundingClientRect()) && inScope(el));
  const tiny = [];
  for (const el of textEls) {
    const px = parseFloat(cs(el).fontSize);
    if (px < 12) tiny.push({ sel: cssPath(el), px });
  }
  const lowContrast = [];
  let sampled = 0;
  for (const el of textEls.slice(0, 400)) {
    if (el.matches(":disabled") || el.closest("[aria-disabled=true]")) continue;
    const bg = bgOf(el);
    if (!bg) continue;
    sampled++;
    const fg0 = toRGBA(cs(el).color);
    const fg = { r: fg0.r * fg0.a + bg.r * (1 - fg0.a), g: fg0.g * fg0.a + bg.g * (1 - fg0.a), b: fg0.b * fg0.a + bg.b * (1 - fg0.a) };
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (ratio < 4.5) lowContrast.push({ sel: cssPath(el), ratio: Math.round(ratio * 100) / 100, fg: rgb(fg), bg: rgb(bg), text: (el.innerText || "").trim().slice(0, 30) });
  }

  return {
    docOverflowPx: Math.max(0, docW - vw),
    controls: controls.length,
    checked: scopedControls.length - offscreen,
    offscreen,
    popup: overlays.length,
    covered,
    small,
    wide: { count: wide.length, top: wide.slice(0, 10) },
    cutText: cutText.slice(0, 20),
    tiny,
    contrast: { sampled, low: lowContrast },
  };
}

/** One Tab press: the element that took focus, whether it is on screen, and whether its look changed from unfocused. */
function focusStep() {
  const cssPath = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join("")}`.slice(0, 80);
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { sel: "(body)", none: true };
  const r = el.getBoundingClientRect();
  const onScreen = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  const sig = (s) => [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderColor, s.backgroundColor].join("|");
  const focused = sig(getComputedStyle(el));
  el.blur();
  const unfocused = sig(getComputedStyle(el));
  el.focus({ preventScroll: true });
  return { sel: cssPath(el), onScreen, styled: focused !== unfocused };
}

/** Every /api request starts counting from here: the number of requests in the first 3 s. */
const MUT_START = () => {
  window.__mut = 0;
  window.__mo = new MutationObserver((list) => {
    window.__mut += list.length;
  });
  window.__mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
};
const MUT_STOP = () => {
  window.__mo.disconnect();
  return window.__mut;
};

// ---- node side ----

const short = (u) => u.replace(BASE, "").split("?")[0];
const linesOf = (text) =>
  text
    .split("\n")
    .map((l) => l.replace(/\d+/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

function diffText(a, b) {
  const la = linesOf(a);
  const lb = linesOf(b);
  const sa = new Set(la);
  const sb = new Set(lb);
  const onlyA = la.filter((x) => !sb.has(x));
  const onlyB = lb.filter((x) => !sa.has(x));
  return {
    diffLines: onlyA.length + onlyB.length,
    diffChars: [...onlyA, ...onlyB].reduce((n, x) => n + x.length, 0),
    sample: [...onlyA.slice(0, 2).map((x) => `- ${x}`), ...onlyB.slice(0, 2).map((x) => `+ ${x}`)].map((x) => x.slice(0, 120)),
  };
}

async function openState(page, kind) {
  const count = () => page.evaluate(() => document.querySelectorAll("[role=dialog], [role=alertdialog], [role=menu], [role=listbox], aside[aria-label=Preview]").length);
  const before = await count();
  if (kind === "palette") await page.keyboard.press("Control+k");
  else if (kind === "dialog") {
    await page.keyboard.press("Control+k");
    await sleep(500);
    await page.keyboard.type("Keyboard shortcuts");
    await sleep(300);
    await page.keyboard.press("Enter");
    await sleep(900);
    return (await page.locator("[role=dialog]").filter({ hasText: "Show this list" }).count()) > 0;
  }
  else if (kind === "preview") {
    const b = page.getByRole("button", { name: "Preview", exact: true }).first();
    if (!(await b.count())) return false;
    await b.click({ timeout: 5000 }).catch(() => {});
  } else if (kind === "model") {
    // the composer's model chip: its label is "<agent> · <model>"
    const chip = page.locator("button:visible").filter({ hasText: "·" }).first();
    if (!(await chip.count())) return false;
    await chip.click({ timeout: 5000 }).catch(() => {});
  }
  await sleep(900);
  return (await count()) > before;
}

async function runCombo(browser, { route, vp, scheme }) {
  const rec = { route: route.id, viewport: vp.name, scheme, state: route.state ?? null, stateOpened: null, landed: null };
  const ctx = await openContext(browser, { key: KEY, width: vp.w, height: vp.h, touch: vp.touch, scheme });
  try {
    await ctx.addInitScript(CLS_INIT);
    const page = await ctx.newPage();
    page.setDefaultTimeout(8000);
    const net = { t0: 0, api3: 0, slow: [], failed: [], e401: 0 };
    rec.console = [];
    rec.consoleWarnings = [];
    rec.pageErrors = [];
    page.on("console", (m) => {
      const text = m.text().slice(0, 200);
      if (/Failed to load resource|status of 401/.test(text)) return; // counted under failed requests
      if (m.type() === "error") rec.console.push(text);
      else if (m.type() === "warning") rec.consoleWarnings.push(text);
    });
    page.on("pageerror", (e) => rec.pageErrors.push(String(e.message || e).slice(0, 200)));
    page.on("request", (r) => {
      if (net.t0 && r.url().includes("/api/") && Date.now() - net.t0 < 3000) net.api3++;
    });
    page.on("response", (r) => {
      const s = r.status();
      if (s === 401) net.e401++;
      else if (s >= 400) net.failed.push({ path: short(r.url()), status: s });
    });
    page.on("requestfailed", (r) => {
      const err = r.failure()?.errorText || "failed";
      if (!/ABORTED/.test(err)) net.failed.push({ path: short(r.url()), status: err });
    });
    page.on("requestfinished", (r) => {
      const t = r.timing();
      if (t.responseEnd > 1500) net.slow.push({ path: short(r.url()), ms: Math.round(t.responseEnd) });
    });
    const settle = () => page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});

    // History: a state route first visits Settings, so Back has somewhere sensible to go.
    if (route.state) await page.goto(`${BASE}/settings/account`, { waitUntil: "load" });
    net.t0 = Date.now();
    await page.goto(BASE + route.path, { waitUntil: "load" });
    await settle();
    await sleep(1500);
    rec.landed = new URL(page.url()).pathname;
    const clsOf = () =>
      page.evaluate(() => {
        const c = window.__cls;
        if (!c) return { total: 0, top: [] };
        const top = Object.entries(c.bySel)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([sel, v]) => ({ sel, value: Math.round(v * 1000) / 1000 }));
        return { total: Math.round(c.total * 1000) / 1000, top };
      });
    rec.clsLoad = (await clsOf()).total;

    if (route.state) {
      rec.stateOpened = await openState(page, route.state);
      await sleep(1500);
    }
    rec.cls = await clsOf();

    rec.audit = await page.evaluate(auditPage, { min: vp.min, scoped: !!route.state && rec.stateOpened === true });

    // Stability: reload, let it settle 3 s, then compare the text 2 s later and count DOM mutations in that window.
    await page.reload({ waitUntil: "load" });
    await settle();
    await sleep(3000);
    const textA = await page.evaluate(readableText);
    await page.evaluate(MUT_START);
    await sleep(2000);
    const mut = await page.evaluate(MUT_STOP);
    const textB = await page.evaluate(readableText);
    rec.stability = { ...diffText(textA, textB), mutPerSec: Math.round((mut / 2) * 10) / 10 };

    // Focus: twelve Tab presses from the top of the page.
    await page.evaluate(() => {
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      scrollTo(0, 0);
    });
    const steps = [];
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      steps.push(await page.evaluate(focusStep));
    }
    rec.focus = steps;

    // Back: from the open state, one browser Back must leave a page, not a blank one.
    if (route.state) {
      const reopened = await openState(page, route.state);
      const before = page.url();
      await page.goBack({ timeout: 5000 }).catch(() => {});
      await sleep(900);
      rec.back = {
        reopened,
        from: new URL(before).pathname,
        to: new URL(page.url()).pathname,
        overlayStillOpen: (await page.evaluate(() => document.querySelectorAll("[role=dialog], [role=alertdialog], [role=menu], [role=listbox], aside[aria-label=Preview]").length)) > 0,
        blank: await page.evaluate(() => document.body.innerText.trim().length < 2),
      };
    }

    rec.net = { apiFirst3s: net.api3, slow: net.slow, failed: net.failed, expected401: net.e401 };
    return rec;
  } finally {
    await ctx.close().catch(() => {});
  }
}

/** Turns one screen's raw numbers into issues. The issue text carries no numbers, so it groups across screens. */
function issuesOf(c) {
  const out = [];
  const add = (kind, severity, sel, issue, detail) => out.push({ kind, severity, route: c.route, viewport: c.viewport, scheme: c.scheme, sel, issue, detail });
  const a = c.audit;
  if (!a) return out;
  for (const x of a.covered) add("covered", x.toast ? "low" : "high", x.sel, `covered by ${x.by}`, `covered by ${x.by} at ${x.at.join(",")}`);
  const cls = Math.max(c.cls?.total ?? 0, c.clsLoad ?? 0);
  if (cls > 0.1) {
    const top = c.cls.top.map((t) => `${t.sel} ${t.value}`).join("; ");
    add("layout-shift", "high", c.cls.top[0]?.sel ?? "(page)", "CLS over 0.1", `CLS ${cls.toFixed(3)}; top: ${top || "none"}`);
  }
  for (const e of c.pageErrors) add("page-error", "high", "(page)", e, e);
  if (a.docOverflowPx > 0) add("overflow-x", "medium", "document", "page scrolls sideways", `wider than the viewport by ${a.docOverflowPx}px`);
  for (const w of a.wide.top) add("overflow-x", "medium", w.sel, "element wider than the viewport", `right edge at ${w.right}px`);
  for (const t of a.cutText) add("clipped-text", "medium", t.sel, "text cut off by overflow hidden", `${t.px}px cut`);
  if (c.stability) {
    if (c.stability.diffLines > 0) add("unstable-idle", "medium", "document", "visible text changes while idle", `${c.stability.diffLines} line(s), ${c.stability.diffChars} chars: ${c.stability.sample.join(" | ")}`);
    if (c.stability.mutPerSec > 20) add("busy-churn", "medium", "document", "DOM churns while idle", `${c.stability.mutPerSec} mutations/s`);
  }
  for (const s of a.small) add("target", "medium", s.sel, "target smaller than its minimum", `${s.size}, minimum ${c.vpMin}px`);
  for (const t of a.tiny) add("text-size", "medium", t.sel, "text under 12px", `${t.px}px`);
  for (const l of a.contrast.low) add("contrast", "medium", l.sel, "contrast under 4.5:1", `${l.ratio}:1 ${l.fg} on ${l.bg} "${l.text}"`);
  for (const m of c.console) add("console-error", "medium", "(console)", m, m);
  for (const m of c.consoleWarnings) add("console-warning", "low", "(console)", m, m);
  for (const f of c.net.failed.filter((f) => !(f.status === 503 && /^\/api\/workspaces\/[^/]+\/browser/.test(f.path)))) add("failed-request", "medium", f.path, `status ${f.status}`, `${f.status} ${f.path}`);
  for (const s of c.net.slow) add("slow-request", "low", s.path, "request over 1.5 s", `${s.ms} ms ${s.path}`);
  if (c.net.apiFirst3s > 40) add("api-burst", "low", "(api)", "over 40 API requests in the first 3 s", `${c.net.apiFirst3s} requests`);
  const steps = c.focus ?? [];
  const real = steps.filter((s) => !s.none);
  for (const [i, s] of steps.entries()) {
    if (s.none) {
      if (i === 0) add("focus", "medium", "(body)", "Tab lands on nothing at the top of the page", "no focusable element first");
    } else if (!s.onScreen) add("focus", "medium", s.sel, "Tab focus is off screen", s.sel);
    else if (!s.styled) add("focus", "medium", s.sel, "focused element shows no focus style", s.sel);
  }
  if (real.length >= 3 && new Set(real.map((s) => s.sel)).size === 1) add("focus", "medium", real[0].sel, "focus stuck on one element", real[0].sel);
  if (c.back?.blank) add("back", "medium", "(page)", "Back leaves a blank page", `${c.back.from} -> ${c.back.to}`);
  else if (c.back?.reopened && c.back.from === c.back.to && c.back.overlayStillOpen) add("back", "low", "(overlay)", "Back leaves the overlay open", c.back.from);
  return out;
}

function groupIssues(issues) {
  const map = new Map();
  for (const i of issues) {
    const key = [i.kind, i.sel, i.issue].join("|");
    let g = map.get(key);
    if (!g) {
      g = { kind: i.kind, severity: i.severity, sel: i.sel, issue: i.issue, detail: i.detail, routes: new Set(), viewports: new Set(), schemes: new Set(), screens: new Set() };
      map.set(key, g);
    }
    g.routes.add(i.route);
    g.viewports.add(i.viewport);
    g.schemes.add(i.scheme);
    g.screens.add(`${i.route}|${i.viewport}|${i.scheme}`);
  }
  return [...map.values()]
    .map((g) => ({
      kind: g.kind,
      severity: g.severity,
      sel: g.sel,
      issue: g.issue,
      detail: g.detail,
      routes: [...g.routes],
      viewports: [...g.viewports],
      schemes: [...g.schemes],
      screens: g.screens.size,
      score: WEIGHT[g.severity] * g.screens.size,
    }))
    .sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
}

/** Kills only what this run started: the server it spawned, and daemons whose environ names this run's socket. */
function killOurs(socket, serverPid) {
  const pids = new Set(serverPid ? [serverPid] : []);
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      if (!readFileSync(`/proc/${p}/cmdline`, "utf8").includes("pty-daemon.cjs")) continue;
      if (!readFileSync(`/proc/${p}/environ`, "utf8").split("\0").includes(`PTY_SOCKET=${socket}`)) continue;
      pids.add(Number(p));
    } catch {
      /* gone, or not ours */
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function infra(msg) {
  console.log(`${msg}`);
  process.exit(GATE ? 1 : 0);
}

async function main() {
  const started = Date.now();
  const found = findBrowser();
  if (!found) infra("skip: needs playwright-core and Chromium");
  if (!existsSync(join(ROOT, "web/dist/build-id.txt"))) infra("skip: web/dist has no build-id.txt (cd web && bun run build)");
  if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) infra(`skip: port ${PORT} is already in use; not touching it`);

  const tmp = mkdtempSync(join(tmpdir(), "kohlab-ux-"));
  const dist = join(tmp, "dist");
  const works = join(tmp, "works");
  const home = join(tmp, "home");
  const socket = join(tmp, "pty.sock");
  mkdirSync(home);
  mkdirSync(works);
  cpSync(join(ROOT, "web/dist"), dist, { recursive: true });
  const build = readFileSync(join(dist, "build-id.txt"), "utf8").trim();

  let server = null;
  let browser = null;
  let serverLog = "";
  try {
    // KOHLAB_* from the caller's shell never reach the throwaway server; HOME is its own, so ~/.claude is never read.
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("KOHLAB_"))) };
    Object.assign(env, { HOME: home, PORT: String(PORT), HOST: "127.0.0.1", KOHLAB_KEY: KEY, WORKS_DIR: works, PTY_SOCKET: socket, KOHLAB_WEB_DIST: dist });
    server = spawn("bun", ["run", "server.ts"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (d) => (serverLog += d));
    server.stderr.on("data", (d) => (serverLog += d));
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
      if (!up) await sleep(250);
    }
    if (!up) throw new Error(`server did not start: ${serverLog.slice(-300)}`);

    const api = async (method, path, body) => {
      const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    };
    const chat = await api("POST", "/api/workspaces", { newProject: "ux chat one", chat: true, agent: "sh" });
    for (const [i, html] of ["<h1>One</h1>", "<h1>One</h1><p>Two</p>", "<h1>One</h1><p>Two</p><p>Three</p>"].entries()) {
      writeFileSync(join(chat.path, "index.html"), `${html}\n`);
      execFileSync("git", ["-c", "user.name=ux", "-c", "user.email=ux@local", "add", "-A"], { cwd: chat.path, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=ux", "-c", "user.email=ux@local", "commit", "-q", "-m", `Version ${i + 1}`], { cwd: chat.path, stdio: "ignore" });
    }
    // One unkept change, as the version fixture leaves: Changes and the header Preview exist only with work to show.
    writeFileSync(join(chat.path, "index.html"), "<h1>One</h1><p>Two</p><p>Three</p><p>Four</p>\n");
    writeFileSync(join(chat.path, "about.html"), "<p>About</p>\n");
    await api("POST", "/api/workspaces", { newProject: "ux chat two", chat: true, agent: "sh" });
    const term = await api("POST", "/api/workspaces", { newProject: "ux terminal", task: "ux terminal", agent: "sh" });
    const gone = await api("POST", "/api/workspaces", { newProject: "ux deleted", task: "ux deleted", agent: "sh" });
    await api("DELETE", `/api/workspaces/${gone.id}`);
    // Messages would come from the fixture helpers; none write chat messages, so both chat projects are empty.

    const routes = [
      { id: "home", path: "/" },
      { id: "chat", path: `/w/${chat.id}/chat` },
      { id: "term:terminal", path: `/w/${term.id}/terminal` },
      { id: "term:chat", path: `/w/${term.id}/chat` },
      { id: "term:changes", path: `/w/${term.id}/review` },
      { id: "term:files", path: `/w/${term.id}/files` },
      ...SETTINGS.map((s) => ({ id: `settings:${s}`, path: `/settings/${s}` })),
      { id: "brain", path: `/w/${chat.id}/brain` },
      { id: "team", path: `/w/${chat.id}/team` },
      { id: "server-terminal", path: "/terminal" },
      { id: "state:preview", path: `/w/${chat.id}/chat`, state: "preview" },
      { id: "state:palette", path: "/", state: "palette" },
      { id: "state:model", path: `/w/${chat.id}/chat`, state: "model" },
      { id: "state:dialog", path: "/", state: "dialog" },
    ];

    browser = await found.chromium.launch({ executablePath: found.chrome, args: ["--no-sandbox"] });
    const combos = [];
    for (const route of routes) for (const vp of VIEWPORTS) for (const scheme of SCHEMES) combos.push({ route, vp, scheme });
    const results = new Array(combos.length);
    let next = 0;
    const worker = async () => {
      while (next < combos.length) {
        const idx = next++;
        const { route, vp, scheme } = combos[idx];
        try {
          results[idx] = await runCombo(browser, combos[idx]);
          results[idx].vpMin = vp.min;
        } catch (e) {
          results[idx] = { route: route.id, viewport: vp.name, scheme, error: String(e.message || e).slice(0, 300) };
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const NOISY = new Set(["layout-shift", "covered"]);
    const flaggedAgain = results.flatMap((c, i) => (!c.error && issuesOf(c).some((x) => NOISY.has(x.kind)) ? [i] : []));
    const second = new Array(combos.length);
    let nextAgain = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (nextAgain < flaggedAgain.length) {
        const idx = flaggedAgain[nextAgain++];
        try {
          second[idx] = await runCombo(browser, combos[idx]);
          second[idx].vpMin = combos[idx].vp.min;
        } catch {
          second[idx] = null;
        }
      }
    }));
    const reproduced = (c, i) => {
      const again = second[i] && !second[i].error ? issuesOf(second[i]) : [];
      const keys = new Set(again.map((x) => `${x.kind}|${x.sel}`));
      return issuesOf(c).filter((x) => !NOISY.has(x.kind) || keys.has(`${x.kind}|${x.sel}`));
    };
    const issues = results.flatMap((c, i) => (c.error ? [] : reproduced(c, i)));
    const groups = groupIssues(issues);
    const byKind = {};
    const bySev = { high: 0, medium: 0, low: 0 };
    for (const i of issues) {
      byKind[i.kind] = (byKind[i.kind] || 0) + 1;
      bySev[i.severity]++;
    }
    const notReached = results.filter((c) => c.state && c.stateOpened === false).map((c) => `${c.route} ${c.viewport} ${c.scheme}`);
    const report = {
      generatedAt: new Date().toISOString(),
      build,
      runtimeSec: Math.round((Date.now() - started) / 100) / 10,
      routes: routes.map((r) => r.id),
      viewports: VIEWPORTS.map((v) => v.name),
      schemes: SCHEMES,
      counts: { screens: results.length, errors: results.filter((c) => c.error).length, rawIssues: issues.length, groups: groups.length, byKind, bySeverity: bySev },
      notes: { statesNotReached: notReached, touchTarget: "390x844 is the hasTouch viewport (44px); 820x1180 and 1440x900 use 24px" },
      groups,
      screens: results,
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));

    const lines = [];
    lines.push(`UX sweep: ${routes.length} routes x ${VIEWPORTS.length} viewports x ${SCHEMES.length} schemes = ${results.length} screens, ${report.runtimeSec} s, build ${build}`);
    lines.push(`screen errors: ${report.counts.errors}; issues: ${issues.length} raw, ${groups.length} grouped (high ${bySev.high}, medium ${bySev.medium}, low ${bySev.low})`);
    lines.push(`by category: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
    if (notReached.length) lines.push(`states not reached: ${notReached.length} (${[...new Set(notReached.map((s) => s.split(" ")[0]))].join(", ")})`);
    lines.push("");
    groups.slice(0, 40).forEach((g, i) => {
      const sev = g.severity.toUpperCase().padEnd(6);
      const routesStr = g.routes.length > 3 ? `${g.routes.slice(0, 3).join(", ")} +${g.routes.length - 3}` : g.routes.join(", ");
      const vps = g.viewports.map((v) => `${v}`).join(", ");
      lines.push(`${String(i + 1).padStart(2)}. ${sev} ${g.kind} ${g.sel} | ${g.issue} | ${routesStr} | ${vps} (${g.screens} screens)`);
    });
    lines.push("");
    lines.push(`report: ${join(OUT, "report.json")}`);
    console.log(lines.join("\n"));
    if (GATE && bySev.high > 0) {
      console.log(`gate: ${bySev.high} HIGH issue(s)`);
      process.exitCode = 1;
    }
  } finally {
    await browser?.close().catch(() => {});
    killOurs(socket, server?.pid);
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.log(`FAIL  ${e.message}`);
  process.exit(GATE ? 1 : 0);
});
