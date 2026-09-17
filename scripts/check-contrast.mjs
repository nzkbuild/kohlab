#!/usr/bin/env node
/**
 * Token contrast audit — the runnable check behind the design system.
 *
 * Parses the :root primitive + semantic tokens out of web/src/index.css,
 * resolves OKLCH -> sRGB, composites translucent chips over their surface, and
 * asserts the WCAG 2.2 minimum ratios (SC 1.4.3 text, SC 1.4.11 non-text).
 *
 * Ratios are NOT rounded: 4.499:1 fails, per
 * https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html
 *
 *   node scripts/check-contrast.mjs
 */
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../web/src/index.css", import.meta.url), "utf8");

/* ---------------------------------------------------------------- parsing -- */

/** Collect `--name: value;` declarations from the :root block only. */
function readRootTokens(css) {
  const start = css.indexOf(":root {");
  if (start === -1) throw new Error("no :root block found in index.css");
  const end = css.indexOf("\n}", start);
  const block = css.slice(start, end);
  const tokens = new Map();
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i);
    if (m) tokens.set(m[1], m[2].trim());
  }
  return tokens;
}

const TOKENS = readRootTokens(CSS);

/* ------------------------------------------------------------------ colour -- */

/** OKLCH (L 0..1, C, H deg) -> linear sRGB. */
function oklchToLinearRgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
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

/** Resolve a token expression to displayable sRGB (0..1), following var() aliases. */
function resolve(expr, depth = 0) {
  if (depth > 10) throw new Error(`alias cycle at ${expr}`);
  const value = expr.trim();

  const varMatch = value.match(/^var\(\s*(--[a-z0-9-]+)\s*\)$/i);
  if (varMatch) {
    const next = TOKENS.get(varMatch[1]);
    if (!next) throw new Error(`unknown token ${varMatch[1]}`);
    return resolve(next, depth + 1);
  }

  // Bare token name (as passed from the CHECKS table).
  if (/^--[a-z0-9-]+$/i.test(value)) {
    const next = TOKENS.get(value);
    if (!next) throw new Error(`unknown token ${value}`);
    return resolve(next, depth + 1);
  }

  const ok = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/i);
  if (ok) {
    const [r, g, b] = oklchToLinearRgb(Number(ok[1]), Number(ok[2]), Number(ok[3]));
    return [encode(r), encode(g), encode(b)];
  }

  const okAlpha = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\/\s*([\d.]+)\s*\)$/i);
  if (okAlpha) {
    const [r, g, b] = oklchToLinearRgb(Number(okAlpha[1]), Number(okAlpha[2]), Number(okAlpha[3]));
    return [...[encode(r), encode(g), encode(b)], Number(okAlpha[4])];
  }

  throw new Error(`cannot parse colour: ${value}`);
}

/** `color-mix(in oklch, X P%, transparent)` over a surface = alpha composite. */
function mixOver(expr, surface, ratioOverride) {
  const m = expr.match(/color-mix\(in oklch,\s*(--[a-z0-9-]+)\s+([\d.]+)%\s*,\s*transparent\s*\)/i);
  if (!m) throw new Error(`cannot parse mix: ${expr}`);
  const ratio = ratioOverride ?? Number(m[2]) / 100;
  const fg = resolve(m[1]);
  const bg = resolve(surface);
  return [0, 1, 2].map((i) => fg[i] * ratio + bg[i] * (1 - ratio));
}

/**
 * Read the chip's BACKGROUND tint percentage straight out of the
 * `.chip-<name>` rule so this audit can never drift from the stylesheet.
 * Must anchor on `background:` — the same block also carries a border tint at a
 * different percentage.
 */
function chipTintPercent(chipName) {
  const start = CSS.indexOf(`.chip-${chipName} {`);
  if (start === -1) throw new Error(`no .chip-${chipName} rule`);
  const block = CSS.slice(start, CSS.indexOf("}", start));
  const m = block.match(/background:\s*color-mix\(in oklch,\s*var\([^)]+\)\s+([\d.]+)%/);
  if (!m) throw new Error(`no background tint in .chip-${chipName}`);
  return Number(m[1]) / 100;
}

/* ------------------------------------------------------------------ maths -- */

/**
 * WCAG 2.2 relative luminance (normative):
 *   L = 0.2126R + 0.7152G + 0.0722B
 * where each channel is first linearised:
 *   c <= 0.04045 ? c/12.92 : ((c + 0.055)/1.055) ^ 2.4
 * `resolve()` returns GAMMA-ENCODED sRGB, so the transform below is required —
 * skipping it overstates contrast badly near black.
 */
const linearise = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

const luminance = ([r, g, b]) =>
  0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const hex = (rgb) =>
  "#" + rgb.slice(0, 3).map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");

/* ------------------------------------------------------------------ checks -- */

// [label, foreground, background, minimum, why]
const CHECKS = [
  // Body text on every surface it actually appears on (SC 1.4.3 -> 4.5:1)
  ["text primary / base", "--text-primary", "--surface-base", 4.5, "panel + page body copy"],
  ["text primary / raised", "--text-primary", "--surface-raised", 4.5, "panel body copy"],
  ["text primary / sunken", "--text-primary", "--surface-sunken", 4.5, "code + log body"],
  ["text primary / overlay", "--text-primary", "--surface-overlay", 4.5, "dialog body"],
  ["text secondary / raised", "--text-secondary", "--surface-raised", 4.5, "labels, table cells"],
  ["text secondary / base", "--text-secondary", "--surface-base", 4.5, "topbar labels"],
  ["text muted / raised", "--text-muted", "--surface-raised", 4.5, "muted metadata, captions"],
  ["text muted / base", "--text-muted", "--surface-base", 4.5, "muted metadata on canvas"],
  ["text muted / hover", "--text-muted", "--surface-hover", 4.5, "muted text on a hovered row"],
  ["text faint / sunken", "--text-faint", "--surface-sunken", 4.5, "log timestamps"],
  ["text faint / raised", "--text-faint", "--surface-raised", 4.5, "placeholders, faint meta"],

  // Accent surfaces (SC 1.4.3 — button label is normal-size text)
  ["on-accent / accent", "--text-on-accent", "--accent", 4.5, "primary button label"],

  // Focus ring against the surfaces it is drawn over (SC 1.4.11 -> 3:1)
  ["accent / base", "--accent", "--surface-base", 3, "focus ring on canvas"],
  ["accent / raised", "--accent", "--surface-raised", 3, "focus ring on panel"],
  ["accent / overlay", "--accent", "--surface-overlay", 3, "focus ring in dialog"],
  ["line-strong / raised", "--line-strong", "--surface-raised", 3, "input + control boundaries"],
  ["line-strong / sunken", "--line-strong", "--surface-sunken", 3, "control boundary on sunken"],

  // Status text on its own chip background (SC 1.4.3). The tint percentage is
  // read from the stylesheet, so these two cannot silently drift apart.
  ["status running chip", "--status-running", null, 4.5, "chip label", "running", "--status-running"],
  ["status review chip", "--status-review", null, 4.5, "chip label", "review", "--status-review"],
  ["status committed chip", "--status-committed", null, 4.5, "chip label", "committed", "--status-committed"],
  ["status danger chip", "--status-danger", null, 4.5, "chip label", "danger", "--status-danger"],
];

let failures = 0;
console.log("\nkohlab token contrast audit — WCAG 2.2 AA\n");

for (const [label, fgTok, bgTok, min, why, chipName, chipTint] of CHECKS) {
  const fg = resolve(fgTok);
  let bg;
  if (chipTint) {
    bg = mixOver(
      `color-mix(in oklch, ${chipTint} 12%, transparent)`,
      "--surface-raised",
      chipTintPercent(chipName),
    );
  } else {
    bg = resolve(bgTok);
  }
  const ratio = contrast(fg, bg);
  const ok = ratio >= min;
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${label.padEnd(26)} ${ratio.toFixed(2).padStart(6)}:1  (min ${min})  ${hex(fg)} on ${hex(bg)}  — ${why}`,
  );
}

console.log(
  failures
    ? `\n${failures} contrast failure(s). WCAG 2.2 AA is the conformance target — fix the token, not the check.\n`
    : `\nall ${CHECKS.length} pairs meet WCAG 2.2 AA\n`,
);
process.exit(failures ? 1 : 0);
