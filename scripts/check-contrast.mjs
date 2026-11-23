#!/usr/bin/env node
/**
 * Token contrast audit: the runnable check behind the design system, every theme combination.
 *
 * The components use the alias names in web/src/index.css. Those aliases point at the Material 3 roles in
 * web/src/styles/tokens.generated.css. This script resolves each alias for every combination the app can show:
 * light and dark x standard, medium and high contrast x six tints, plus the dark pane (terminal and code) in a light
 * theme. It asserts the WCAG 2.2 minimums for the level: standard 4.5:1 text and 3:1 UI, medium 6 and 3.5, high 7 and
 * 4.5 (docs/design/m3-mono.md, 2.4). The generator checks the role pairs itself (web/scripts/gen-tokens.mjs);
 * this covers the aliases and the chip tints as the components draw them.
 *
 * Ratios are NOT rounded: 4.499:1 fails, per
 * https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
 *
 *   node scripts/check-contrast.mjs
 */
import { readFileSync } from "node:fs";

const INDEX_CSS = readFileSync(new URL("../web/src/index.css", import.meta.url), "utf8");
const GENERATED = readFileSync(new URL("../web/src/styles/tokens.generated.css", import.meta.url), "utf8");

/* ---------------------------------------------------------------- parsing -- */

/** Every `--name: value;` declared in a block of CSS text. */
function declarations(text) {
  const out = new Map();
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1], m[2].trim());
  return out;
}

/** The body of the first rule whose selector is exactly `selector` (the text before its `{`). */
function ruleBody(css, selector) {
  const marker = `${selector} {`;
  const start = css.indexOf(marker);
  if (start === -1) throw new Error(`no rule ${JSON.stringify(selector)}`);
  const open = start + marker.length;
  const close = css.indexOf("}", open);
  return css.slice(open, close);
}

const ALIASES = declarations(ruleBody(INDEX_CSS, ":root,\n.dark-pane"));
const ROOT = declarations(ruleBody(GENERATED, ":root"));
const combo = (mode, level, tint) => `html[data-theme="${mode}"][data-contrast="${level}"][data-tint="${tint}"]`;
const palette = (mode, level, tint, pane = false) => declarations(ruleBody(GENERATED, combo(mode, level, tint) + (pane ? " .dark-pane" : "")));

/* ------------------------------------------------------------------ colour -- */

/** OKLCH (L 0..1, C, H deg) -> linear sRGB. */
function oklchToLinearRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** linear -> gamma-encoded sRGB (0..1), clamped to the displayable gamut. */
function encode(lin) {
  const v = clamp01(lin);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Splits `a, b, c` at top-level commas (commas inside parentheses stay). */
function splitArgs(text) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

/**
 * Resolves a token expression to [r, g, b, a] (gamma-encoded sRGB, alpha 0..1) through var() aliases.
 * Supports: var(--x), #rrggbb, oklch(...), and color-mix(in srgb|oklch, A P%, B|transparent).
 */
function resolve(expr, tokens, depth = 0) {
  if (depth > 12) throw new Error(`alias cycle at ${expr}`);
  const value = expr.trim();

  // A bare token name (as written in CHECKS) is the same as var(name).
  if (/^--[a-z0-9-]+$/i.test(value)) return resolve(`var(${value})`, tokens, depth + 1);

  const v = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
  if (v) {
    const next = tokens.get(v[1]);
    if (next === undefined) throw new Error(`unknown token ${v[1]}`);
    return resolve(next, tokens, depth + 1);
  }

  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }

  const ok = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/i);
  if (ok) {
    const [r, g, b] = oklchToLinearRgb(Number(ok[1]), Number(ok[2]), Number(ok[3])).map(encode);
    return [r, g, b, ok[4] === undefined ? 1 : Number(ok[4])];
  }

  const mix = value.match(/^color-mix\((.*)\)$/i);
  if (mix) {
    const [, , first, second] = [null, ...splitArgs(mix[1])];
    const a = first.match(/^(.*\S)\s+([\d.]+)%$/);
    if (!a || second === undefined) throw new Error(`cannot parse mix: ${value}`);
    const weight = Number(a[2]) / 100;
    const c1 = resolve(a[1], tokens, depth + 1);
    if (second === "transparent") return [c1[0], c1[1], c1[2], c1[3] * weight];
    const b = second.match(/^(.*\S)\s+([\d.]+)%$/);
    const c2 = resolve(b ? b[1] : second, tokens, depth + 1);
    const w2 = b ? Number(b[2]) / 100 : 1 - weight;
    return [0, 1, 2].map((i) => c1[i] * weight + c2[i] * w2).concat([1]);
  }

  throw new Error(`cannot parse colour: ${value}`);
}

/** `fg` composited over an opaque `bg` (both gamma-encoded). */
function over(fg, bg) {
  return [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
}

/**
 * Read the chip's BACKGROUND tint percentage straight out of the `.chip-<name>` rule so this audit can never drift
 * from the stylesheet. Must anchor on `background:`: the same block may carry a border tint at another percentage.
 */
function chipTintPercent(chipName) {
  const start = INDEX_CSS.indexOf(`.chip-${chipName} {`);
  if (start === -1) throw new Error(`no .chip-${chipName} rule`);
  const block = INDEX_CSS.slice(start, INDEX_CSS.indexOf("}", start));
  const m = block.match(/background:\s*color-mix\(in oklch,\s*var\([^)]+\)\s+([\d.]+)%/);
  if (!m) throw new Error(`no background tint in .chip-${chipName}`);
  return Number(m[1]) / 100;
}

/* ------------------------------------------------------------------ maths -- */

/**
 * WCAG 2.2 relative luminance (normative): each channel linearised first, then
 * L = 0.2126R + 0.7152G + 0.0722B. Skipping the linearisation overstates contrast near black.
 */
const linearise = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]) => 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ checks -- */

const MIN = { standard: { text: 4.5, ui: 3 }, medium: { text: 6, ui: 3.5 }, high: { text: 7, ui: 4.5 } };

// [label, foreground, background, kind, why, chip?]. A background of "--a@--b" is --a composited over --b.
// kind "text" (SC 1.4.3) or "ui" (SC 1.4.11). A chip row names the chip rule; its tint is read from the stylesheet.
const CHECKS = [
  ["text primary / base", "--text-primary", "--surface-base", "text", "page body copy"],
  ["text primary / raised", "--text-primary", "--surface-raised", "text", "panel body copy"],
  ["text primary / sunken", "--text-primary", "--surface-sunken", "text", "code and log body"],
  ["text primary / overlay", "--text-primary", "--surface-overlay", "text", "dialog body"],
  ["text primary / field", "--text-primary", "--surface-field", "text", "typed text in a field"],
  ["text secondary / raised", "--text-secondary", "--surface-raised", "text", "labels, table cells"],
  ["text secondary / base", "--text-secondary", "--surface-base", "text", "topbar labels"],
  ["text muted / raised", "--text-muted", "--surface-raised", "text", "muted metadata, captions"],
  ["text muted / base", "--text-muted", "--surface-base", "text", "muted metadata on canvas"],
  ["text muted / hover", "--text-muted", "--surface-hover@--surface-base", "text", "muted text on a hovered row"],
  ["text faint / sunken", "--text-faint", "--surface-sunken", "text", "log timestamps"],
  ["text faint / raised", "--text-faint", "--surface-raised", "text", "placeholders, faint meta"],
  ["text primary / sidebar", "--text-primary", "--surface-sidebar", "text", "project rows"],
  ["text muted / sidebar", "--text-muted", "--surface-sidebar", "text", "account row, secondary labels"],
  ["text faint / sidebar", "--text-faint", "--surface-sidebar", "text", "Projects label"],
  ["text primary / selected row", "--text-primary", "--surface-active@--surface-sidebar", "text", "selected sidebar row"],
  ["text on tonal / tonal button", "--text-on-tonal", "--surface-tonal", "text", "secondary button label"],
  ["text on tonal / tonal hover", "--text-on-tonal", "--tonal-hover@--surface-tonal", "text", "secondary button hovered"],
  ["text on tonal / tonal pressed", "--text-on-tonal", "--tonal-pressed@--surface-tonal", "text", "secondary button pressed"],
  ["text primary / field hover", "--text-primary", "--surface-hover@--surface-field", "text", "raised button hovered"],
  ["text primary / bubble", "--text-primary", "--surface-bubble", "text", "user message"],
  ["text on accent / accent", "--text-on-accent", "--accent", "text", "primary button label"],
  ["text on accent / accent-hover", "--text-on-accent", "--accent-hover", "text", "primary button hovered"],
  ["text on accent / accent-press", "--text-on-accent", "--accent-press", "text", "primary button pressed"],
  ["on-accent-soft / accent-soft", "--on-accent-soft", "--accent-soft", "text", "selected option, capability tile label"],
  ["accent / base", "--accent", "--surface-base", "ui", "meter fill and selected mark on canvas"],
  ["accent / raised", "--accent", "--surface-raised", "ui", "focus and selection on a panel"],
  ["accent / sidebar", "--accent", "--surface-sidebar", "ui", "needs-you dot"],
  ["focus ring / base", "--focus-ring", "--surface-base", "ui", "focus ring on canvas"],
  ["focus ring / sidebar", "--focus-ring", "--surface-sidebar", "ui", "focus ring on sidebar rows"],
  ["focus ring / raised", "--focus-ring", "--surface-raised", "ui", "focus ring on panel and cards"],
  ["focus ring / field", "--focus-ring", "--surface-field", "ui", "focus ring on a text field"],
  ["line-strong / raised", "--line-strong", "--surface-raised", "ui", "unchecked control marks on a panel"],
  ["status running chip", "--status-running", null, "text", "chip label", "running"],
  ["status review chip", "--status-review", null, "text", "chip label", "review"],
  ["status committed chip", "--status-committed", null, "text", "chip label", "committed"],
  ["status danger chip", "--status-danger", null, "text", "chip label", "danger"],
];

// Every combination the app can show. The dark pane is checked in a light theme (it is dark there).
const CONTEXTS = [];
for (const mode of ["dark", "light"]) for (const level of ["standard", "medium", "high"]) for (const tint of ["none", "rose", "peach", "mint", "sky", "lilac"]) {
  CONTEXTS.push({ name: `${mode} ${level} ${tint}`, level, mode, tokens: null, decls: palette(mode, level, tint) });
  if (mode === "light") CONTEXTS.push({ name: `dark pane in light ${level} ${tint}`, level, mode: "pane", decls: palette("light", level, tint, true) });
}

let failures = 0;
let checked = 0;
const worstByLevel = {};
console.log("\nkohlab token contrast audit, every theme combination\n");
for (const ctx of CONTEXTS) {
  const tokens = new Map([...ROOT, ...ALIASES, ...ctx.decls]);
  const failed = [];
  for (const [label, fgTok, bgTok, kind, why, chipName] of CHECKS) {
    const min = MIN[ctx.level][kind];
    const fg = resolve(fgTok, tokens);
    let bg;
    if (chipName) {
      const pct = chipTintPercent(chipName);
      bg = over(resolve(`color-mix(in oklch, var(${fgTok}) ${pct * 100}%, transparent)`, tokens), resolve("--surface-raised", tokens));
    } else if (bgTok.includes("@")) {
      const [over1, under] = bgTok.split("@");
      bg = over(resolve(over1, tokens), resolve(under, tokens));
    } else {
      bg = resolve(bgTok, tokens);
    }
    const ratio = contrast(fg, bg);
    checked++;
    const key = `${ctx.level}/${ctx.mode}`;
    worstByLevel[key] = Math.min(worstByLevel[key] ?? 99, ratio);
    if (ratio < min) {
      failures++;
      failed.push(`    FAIL ${label.padEnd(28)} ${ratio.toFixed(2)}:1 (min ${min}) ${why}`);
    }
  }
  if (failed.length) console.log(`${ctx.name}\n${failed.join("\n")}`);
}

console.log("lowest ratio per contrast level and mode (text and UI pairs):");
for (const key of Object.keys(worstByLevel)) console.log(`  ${key.padEnd(16)} ${worstByLevel[key].toFixed(2)}:1`);
console.log(
  failures
    ? `\n${failures} contrast failure(s) in ${checked} checks. WCAG 2.2 AA is the target: fix the token, not the check.\n`
    : `\nall ${checked} checks pass in ${CONTEXTS.length} contexts (2 modes x 3 contrast levels x 6 tints, plus the dark pane)\n`,
);
process.exit(failures ? 1 : 0);
