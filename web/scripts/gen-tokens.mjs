#!/usr/bin/env node
// Kohlab colour roles: Material 3 roles in monochrome, generated. Node >= 18, ESM, no dependencies.
//   node web/scripts/gen-tokens.mjs           write web/src/styles/tokens.generated.css
//   node web/scripts/gen-tokens.mjs --check   verify every contrast pair and that the committed CSS is current;
//                                             exit 1 on any failing pair or stale file (writes nothing)
// Spec: docs/design/m3-mono.md (sections 2, 4, 7). Copied from docs/mockups/m3mono/gen-tokens.mjs and reduced to what
// the app ships: one finish (matte: standard tones, no shadows), contrast standard/medium/high, tint none or one hue.
//
// Colour model: a tone T is CIE L* = T. Chroma 0 is a grey with L* = T. A tint is an OKLCH hue with chroma reduced
// until the sRGB result fits the gamut, so a tint never changes contrast. Contrast is measured on the final 8-bit hex
// values with the WCAG 2.x relative-luminance formula.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "src", "styles", "tokens.generated.css");
const CHECK = process.argv.includes("--check");

/* ------------------------------------------------------------ colour math */
const enc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const dec = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lstarToY = (L) => (L > 8 ? Math.pow((L + 16) / 116, 3) : L / 903.2963);
const yOf = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function oklchToLinear(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (rgb) => rgb.every((v) => v >= -1e-5 && v <= 1 + 1e-5);
function clampChroma(L, C, h) {
  const rgb = oklchToLinear(L, C, h);
  if (inGamut(rgb)) return rgb;
  let lo = 0, hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid;
  }
  return oklchToLinear(L, lo, h).map(clamp01);
}
const toHex = (lin) => "#" + lin.map((v) => Math.round(clamp01(enc(clamp01(v))) * 255).toString(16).padStart(2, "0")).join("");

/** tone (CIE L*) + hue + OKLCH chroma -> "#rrggbb" */
function toneHex(T, hue, chroma) {
  if (T <= 0) return "#000000";
  if (T >= 100) return "#ffffff";
  const target = lstarToY(T);
  if (!chroma) { const g = enc(target); return toHex([g, g, g].map(dec)); }
  let lo = 0, hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (yOf(clampChroma(mid, chroma, hue)) < target) lo = mid; else hi = mid;
  }
  return toHex(clampChroma((lo + hi) / 2, chroma, hue));
}
const lin = (hex) => [1, 3, 5].map((i) => dec(parseInt(hex.slice(i, i + 2), 16) / 255));
const lum = (hex) => yOf(lin(hex));
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

/* ------------------------------------------------------------ axes */
const MODES = ["light", "dark"];
const LEVELS = ["standard", "medium", "high"]; // index 0,1,2 in the tone triples
// One hue per tint (OKLCH degrees). "none" is pure grey.
const TINTS = { none: null, rose: 8, peach: 52, mint: 165, sky: 235, lilac: 300 };
const CHROMA_UNIT = 0.0045; // one chroma unit (M3 chroma 4-12 range) in OKLCH chroma
const MATTE_UNITS = 4; // the one finish the app ships
// Palette multipliers: neutral surfaces stay nearly grey on purpose.
const PAL_MULT = { neutral: 0.3, nv: 0.5, primary: 1, secondary: 0.65, tertiary: 1.15, error: 0.9, none: 0 };

/* ------------------------------------------------------------ role -> [palette, light[std,med,high], dark[std,med,high]] */
const R = (pal, light, dark) => ({ pal, light, dark });
const ROLES = {
  "primary": R("primary", [40, 25, 10], [80, 85, 95]),
  "on-primary": R("primary", [100, 100, 100], [20, 15, 5]),
  "primary-container": R("primary", [90, 84, 76], [30, 32, 35]),
  "on-primary-container": R("primary", [30, 10, 0], [90, 96, 100]),
  "secondary": R("secondary", [42, 32, 12], [80, 85, 95]),
  "on-secondary": R("secondary", [100, 100, 100], [20, 15, 5]),
  "secondary-container": R("secondary", [90, 84, 76], [30, 32, 35]),
  "on-secondary-container": R("secondary", [30, 10, 0], [90, 96, 100]),
  "tertiary": R("tertiary", [25, 18, 5], [90, 94, 98]),
  "on-tertiary": R("tertiary", [100, 100, 100], [20, 10, 0]),
  "tertiary-container": R("tertiary", [80, 74, 68], [42, 40, 36]),
  "on-tertiary-container": R("tertiary", [10, 5, 0], [98, 100, 100]),
  // error: same hue family as everything else, the heaviest tones, always paired with an icon and words
  "error": R("error", [20, 15, 5], [88, 92, 96]),
  "on-error": R("error", [100, 100, 100], [20, 10, 0]),
  "error-container": R("error", [82, 76, 70], [44, 38, 34]),
  "on-error-container": R("error", [10, 5, 0], [98, 100, 100]),
  "background": R("neutral", [98, 98, 98], [6, 6, 6]),
  "on-background": R("neutral", [10, 5, 0], [90, 95, 100]),
  "surface": R("neutral", [98, 98, 98], [6, 6, 6]),
  "surface-dim": R("neutral", [87, 80, 75], [6, 6, 6]),
  "surface-bright": R("neutral", [98, 98, 98], [24, 29, 34]),
  "surface-container-lowest": R("neutral", [100, 100, 100], [4, 2, 0]),
  "surface-container-low": R("neutral", [96, 96, 95], [10, 11, 12]),
  "surface-container": R("neutral", [94, 92, 90], [12, 16, 20]),
  "surface-container-high": R("neutral", [92, 88, 85], [17, 21, 25]),
  "surface-container-highest": R("neutral", [90, 84, 80], [22, 26, 30]),
  "surface-variant": R("nv", [90, 84, 80], [30, 28, 26]),
  "surface-tint": R("primary", [40, 25, 10], [80, 85, 95]),
  "on-surface": R("neutral", [10, 5, 0], [90, 95, 100]),
  "on-surface-variant": R("nv", [30, 20, 10], [80, 88, 95]),
  "outline": R("nv", [50, 38, 30], [60, 70, 80]),
  "outline-variant": R("nv", [80, 70, 60], [30, 45, 55]), // decorative, used only for the faint divider
  "inverse-surface": R("neutral", [20, 15, 10], [90, 95, 98]),
  "inverse-on-surface": R("neutral", [95, 98, 100], [20, 10, 5]),
  "inverse-primary": R("primary", [80, 85, 90], [40, 30, 20]),
  "scrim": R("none", [0, 0, 0], [0, 0, 0]),
  "shadow": R("none", [0, 0, 0], [0, 0, 0]),
};

/* ------------------------------------------------------------ contrast pairs */
const SURF = ["surface", "surface-dim", "surface-bright", "surface-container-lowest", "surface-container-low", "surface-container", "surface-container-high", "surface-container-highest"];
const TEXT_PAIRS = [
  ...SURF.map((s) => ["on-surface", s]),
  ...SURF.map((s) => ["on-surface-variant", s]),
  ...SURF.map((s) => ["primary", s]), // links and selected labels on any surface
  ...SURF.map((s) => ["error", s]), // inline problem text
  ["on-primary", "primary"], ["on-secondary", "secondary"], ["on-tertiary", "tertiary"], ["on-error", "error"],
  ["on-primary-container", "primary-container"], ["on-secondary-container", "secondary-container"],
  ["on-tertiary-container", "tertiary-container"], ["on-error-container", "error-container"],
  ["inverse-on-surface", "inverse-surface"], ["inverse-primary", "inverse-surface"],
  ["on-surface-variant", "surface-variant"], ["on-background", "background"],
];
// UI: the keyboard focus ring, the unchecked marks and the field indicator are `outline`; it must read on every surface.
const UI_PAIRS = SURF.map((s) => ["outline", s]);
const MIN = { standard: { text: 4.5, ui: 3 }, medium: { text: 6, ui: 3.5 }, high: { text: 7, ui: 4.5 } };

/* ------------------------------------------------------------ build all */
const color = {}; // color[mode][level][tint] = { role: hex }
const fails = [];
const rows = [];
for (const mode of MODES) for (const level of LEVELS) for (const tint of Object.keys(TINTS)) {
  const li = LEVELS.indexOf(level), hex = {};
  for (const role of Object.keys(ROLES)) {
    const { pal } = ROLES[role];
    const T = ROLES[role][mode][li];
    const hue = TINTS[tint];
    const chroma = hue == null ? 0 : MATTE_UNITS * CHROMA_UNIT * PAL_MULT[pal];
    hex[role] = toneHex(T, hue ?? 0, chroma);
  }
  ((color[mode] ??= {})[level] ??= {})[tint] = hex;
  const key = `${mode}/${level}/${tint}`;
  let minT = [99, ""], minU = [99, ""];
  for (const [fg, bg] of TEXT_PAIRS) {
    const c = ratio(hex[fg], hex[bg]);
    if (c < minT[0]) minT = [c, `${fg} on ${bg}`];
    if (c < MIN[level].text) fails.push(`${key} text ${fg} on ${bg} = ${c.toFixed(2)} (< ${MIN[level].text})`);
  }
  for (const [fg, bg] of UI_PAIRS) {
    const c = ratio(hex[fg], hex[bg]);
    if (c < minU[0]) minU = [c, `${fg} on ${bg}`];
    if (c < MIN[level].ui) fails.push(`${key} ui ${fg} on ${bg} = ${c.toFixed(2)} (< ${MIN[level].ui})`);
  }
  rows.push({ mode, level, tint, minT, minU });
}

/* ------------------------------------------------------------ static tokens */
const FONT_PLAIN = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const SHAPE = { none: "0px", "extra-small": "4px", small: "8px", medium: "12px", large: "16px", "extra-large": "28px", full: "9999px" };
const EASING = {
  linear: "cubic-bezier(0, 0, 1, 1)", standard: "cubic-bezier(0.2, 0, 0, 1)", "standard-decelerate": "cubic-bezier(0, 0, 0, 1)",
  "standard-accelerate": "cubic-bezier(0.3, 0, 1, 1)", emphasized: "cubic-bezier(0.2, 0, 0, 1)",
  "emphasized-decelerate": "cubic-bezier(0.05, 0.7, 0.1, 1)", "emphasized-accelerate": "cubic-bezier(0.3, 0, 0.8, 0.15)",
};
const DURATION = { short1: 50, short2: 100, short3: 150, short4: 200, medium1: 250, medium2: 300, medium3: 350, medium4: 400, long1: 450, long2: 500, long3: 550, long4: 600 };
const STATE = { hover: 0.08, focus: 0.1, pressed: 0.1, dragged: 0.16, disabledContent: 0.38, disabledContainer: 0.12 };
// The terminal keeps one fixed dark tone in both modes (M3 tone 10): it is a dev surface, not a theme colour.
const TERMINAL = toneHex(10, 0, 0);

/* ------------------------------------------------------------ CSS */
const vars = (hex) => Object.entries(hex).map(([r, v]) => `--md-sys-color-${r}:${v};`).join("");
const sel = (m, l, t) => `html[data-theme="${m}"][data-contrast="${l}"][data-tint="${t}"]`;
const DURATIONS_OFF = Object.keys(DURATION).map((n) => `--md-sys-motion-duration-${n}:1ms;`).join("");

let css = `/* Generated by web/scripts/gen-tokens.mjs from docs/design/m3-mono.md. Do not edit: run
   node web/scripts/gen-tokens.mjs
   The theme is four attributes on <html>, set by web/public/colour.js before first paint:
   data-theme=light|dark, data-contrast=standard|medium|high, data-tint=none|rose|peach|mint|sky|lilac.
   Names follow Material 3 (--md-sys-*); index.css aliases them to the names the components use. */
:root {
  color-scheme: dark;
  --md-ref-typeface-plain: ${FONT_PLAIN};
  --md-ref-typeface-mono: ${FONT_MONO};
${Object.entries(SHAPE).map(([n, v]) => `  --md-sys-shape-corner-${n}: ${v};`).join("\n")}
${Object.entries(EASING).map(([n, v]) => `  --md-sys-motion-easing-${n}: ${v};`).join("\n")}
${Object.entries(DURATION).map(([n, v]) => `  --md-sys-motion-duration-${n}: ${v}ms;`).join("\n")}
  --md-sys-state-hover-state-layer-opacity: ${STATE.hover};
  --md-sys-state-focus-state-layer-opacity: ${STATE.focus};
  --md-sys-state-pressed-state-layer-opacity: ${STATE.pressed};
  --md-sys-state-dragged-state-layer-opacity: ${STATE.dragged};
  --k-terminal: ${TERMINAL};
  ${vars(color.dark.standard.none)}
}
/* Fallback when the page has no data-theme yet (colour.js always sets one). */
@media (prefers-color-scheme: light) {
  :root:not([data-theme]) {
    color-scheme: light;
    ${vars(color.light.standard.none)}
  }
}
@media (prefers-reduced-motion: reduce) {
  :root {
    ${DURATIONS_OFF}
  }
}
`;
for (const m of MODES) for (const l of LEVELS) for (const t of Object.keys(TINTS)) {
  css += `${sel(m, l, t)} {\n  color-scheme: ${m};\n  ${vars(color[m][l][t])}\n}\n`;
}
// The terminal and code panes stay dark in light mode: they re-point the palette to the dark tones for their pane.
for (const l of LEVELS) for (const t of Object.keys(TINTS)) {
  css += `${sel("light", l, t)} .dark-pane {\n  color-scheme: dark;\n  ${vars(color.dark[l][t])}\n}\n`;
}

/* ------------------------------------------------------------ report */
const worst = (arr, key) => arr.reduce((a, b) => (b[key][0] < a[key][0] ? b : a));
console.log(`${rows.length} combinations (2 modes x 3 contrast levels x ${Object.keys(TINTS).length} tints), ${TEXT_PAIRS.length} text + ${UI_PAIRS.length} UI pairs each, ${fails.length} fail(s).`);
for (const m of MODES) for (const l of LEVELS) {
  const g = rows.filter((r) => r.mode === m && r.level === l);
  const wt = worst(g, "minT"), wu = worst(g, "minU");
  console.log(`  ${m.padEnd(5)} ${l.padEnd(8)} min text ${wt.minT[0].toFixed(2)} (${wt.minT[1]}, ${wt.tint})  min UI ${wu.minU[0].toFixed(2)} (${wu.minU[1]}, ${wu.tint})  need ${MIN[l].text} / ${MIN[l].ui}`);
}
if (fails.length) { console.error(fails.slice(0, 40).join("\n")); if (fails.length > 40) console.error(`... and ${fails.length - 40} more`); }

const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
const stale = current !== css;
if (CHECK) {
  if (stale) console.error(`${OUT} is out of date: run node web/scripts/gen-tokens.mjs`);
  console.log(stale ? "tokens.generated.css: STALE" : "tokens.generated.css: up to date");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, css);
  console.log(`wrote ${OUT}`);
}
process.exit(fails.length || (CHECK && stale) ? 1 : 0);
