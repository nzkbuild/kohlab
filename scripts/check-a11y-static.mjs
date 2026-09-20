#!/usr/bin/env node
// Static accessibility scan.
//
// WHAT THIS IS: a scan of the source and the page shell for accessibility
// mistakes that are visible in markup - a clickable div with no keyboard path, an
// input with no label, a positive tabindex, a removed focus ring, a page with no
// language. It reads whole JSX elements, not single lines, because props span
// lines and a line-based check reports correct code as broken.
//
// WHAT THIS IS NOT: an accessibility audit. It renders nothing, so it cannot see
// focus order, computed contrast, whether a live region actually announces, or
// whether a control is reachable by keyboard in practice. It will miss real
// problems. docs/accessibility.md records what has and has not been verified, and
// this file is one line in it.
//
// Errors fail the suite. Warnings are heuristics that need a human.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "web/src");
const errors = [];
const warnings = [];

const fail = (file, line, what) => errors.push(`${relative(ROOT, file)}:${line}  ${what}`);
const warn = (file, line, what) => warnings.push(`${relative(ROOT, file)}:${line}  ${what}`);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(entry)) out.push(p);
  }
  return out;
}

/**
 * The attributes of the JSX element starting at `from`.
 *
 * Walks to the closing `>` at brace depth zero, skipping quoted strings, so a
 * multi-line prop list is read as one element. Returns the text and the 1-based
 * line it started on.
 */
function elementAt(text, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth <= 0) return { text: text.slice(from, i + 1), end: i };
  }
  return { text: text.slice(from), end: text.length };
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Blank out comments, keeping every line number.
 *
 * Without this, prose is read as markup: a comment explaining that `option` has
 * no native element outside `<select>` was reported as an unlabelled `<select>`.
 */
function stripComments(text) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank) // {/* JSX comment */}
    .replace(/\/\*[\s\S]*?\*\//g, blank) // /* block */
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1) => p1 + blank(m.slice(p1.length))); // // line
}

/** `${u.id}` and other interpolations are not literals; compare their shape. */
const normalize = (s) => s.replace(/\$\{[^}]*\}/g, "\u00a7");

/**
 * Every value given to an attribute, in literal or brace form.
 *
 * A regex cannot do the brace form: `htmlFor={`role-${u.id}`}` contains a brace
 * of its own, so `[^}]*` stops inside the interpolation and the value never
 * matches. Balancing instead of regexing is what makes a template literal label
 * count as a label.
 */
function attrValues(text, name) {
  const out = [];
  const re = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|\{)`, "g");
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) { out.push(m[1]); continue; }
    if (m[2] !== undefined) { out.push(m[2]); continue; }
    const start = re.lastIndex - 1;
    let depth = 0;
    let quote = null;
    let i = start;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote && text[i - 1] !== "\\") quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(start + 1, i));
    re.lastIndex = i + 1;
  }
  return out;
}

/** Is this control's id labelled anywhere in the file? `<Field htmlFor>` counts. */
function hasLabelFor(text, id) {
  const wanted = normalize(id);
  return [...attrValues(text, "htmlFor"), ...attrValues(text, "aria-labelledby")].some(
    (v) => normalize(v) === wanted,
  );
}

/**
 * An explicit, in-code acknowledgement: the two lines before the element, or the
 * element itself, may carry `a11y-ok: <reason>`. A warning that is known-correct
 * is noise, and noise trains people to ignore the check.
 */
function acknowledged(text, index, element) {
  const before = text.slice(Math.max(0, index - 200), index);
  return /a11y-ok:/.test(element) || /a11y-ok:/.test(before.slice(-200));
}

const files = walk(SRC);

function scan(text, file) {

  // ── clickable non-interactive elements ─────────────────────────────────────
  const clickRe = /<(div|span|li|td|tr|section|article)\b/g;
  let m;
  while ((m = clickRe.exec(text))) {
    const el = elementAt(text, m.index).text;
    if (!/\bonClick=/.test(el)) continue;
    const keyboard = /role=|tabIndex=|onKeyDown=|onKeyUp=|onKeyPress=/.test(el);
    const n = lineOf(text, m.index);
    if (acknowledged(text, m.index, el)) continue;

    // The ARIA combobox/listbox pattern with `aria-activedescendant`: focus stays
    // on the input and the active option is reported, so the options are
    // *supposed* to be non-focusable. Giving them a tabIndex would add a stop per
    // result and break the pattern. Warn-free on that basis, not on trust.
    const managedFocus = /aria-activedescendant/.test(text) && /role="(option|listitem|row|gridcell)"/.test(el);
    if (managedFocus) continue;

    if (!keyboard) fail(file, n, `onClick on <${m[1]}> with no role/tabIndex/onKeyDown — use <button>`);
    else warn(file, n, `onClick on <${m[1]}> — confirm the keyboard path is complete`);
  }

  // ── images ─────────────────────────────────────────────────────────────────
  const imgRe = /<img\b/g;
  while ((m = imgRe.exec(text))) {
    const el = elementAt(text, m.index).text;
    // alt="" is the correct way to mark something decorative; a missing alt is
    // indistinguishable from an oversight, which is why this is an error.
    if (!/\balt=/.test(el)) fail(file, lineOf(text, m.index), "<img> with no alt (use alt=\"\" if decorative)");
  }

  // ── focus order ────────────────────────────────────────────────────────────
  const tabRe = /tabIndex=\{?["']?(\d+)/g;
  while ((m = tabRe.exec(text))) {
    if (Number(m[1]) > 0) {
      fail(file, lineOf(text, m.index), `positive tabIndex=${m[1]} — it reorders focus for the whole page; use 0 or -1`);
    }
  }

  // ── controls need a name ───────────────────────────────────────────────────
  const ctrlRe = /<(input|select|textarea)\b/g;
  while ((m = ctrlRe.exec(text))) {
    const el = elementAt(text, m.index).text;
    const n = lineOf(text, m.index);
    if (/type=["'](hidden|submit|button|checkbox|radio)["']/.test(el)) continue; // labelled by its own text/wrapper
    if (/aria-label=|aria-labelledby=|title=/.test(el)) continue;
    const id = el.match(/\bid=["']([^"']+)["']/)?.[1];
    if (id && hasLabelFor(text, id)) continue;
    const idRef = el.match(/\bid=\{([A-Za-z_$][\w$]*)\}/)?.[1];
    if (idRef && hasLabelFor(text, idRef)) continue;
    const idTemplate = el.match(/\bid=\{\s*(`[^`]*`)\s*\}/)?.[1];
    if (idTemplate && hasLabelFor(text, idTemplate)) continue;
    if (acknowledged(text, m.index, el)) continue;
    warn(file, n, `<${m[1]}> with no label, aria-label or associated htmlFor`);
  }

  // ── anchors ────────────────────────────────────────────────────────────────
  const aRe = /<a\b/g;
  while ((m = aRe.exec(text))) {
    const el = elementAt(text, m.index).text;
    if (!/href=/.test(el)) warn(file, lineOf(text, m.index), "<a> with no href — not focusable; use <button> if it is an action");
  }

  // ── hidden but focusable ───────────────────────────────────────────────────
  const hiddenRe = /aria-hidden=["']true["']/g;
  while ((m = hiddenRe.exec(text))) {
    const el = elementAt(text, m.index).text;
    if (/tabIndex=\{?["']?0/.test(el)) {
      fail(file, lineOf(text, m.index), "aria-hidden with tabIndex=0 — focusable but invisible to screen readers");
    }
  }
}

for (const f of files) scan(stripComments(readFileSync(f, "utf8")), f);

// ── does the scanner actually detect anything? ───────────────────────────────
// A check that cannot fail is decoration, and a scanner silently broken by a
// regex change would report a clean codebase forever. This runs the same rules
// over code that is wrong on purpose and requires each planted problem to be
// found. It is the only reason to believe the zero above means something.
const FIXTURE = `
const bad = () => (
  <div onClick={() => go()}>
    <img src="/logo.png" />
    <input type="text" />
    <select><option>a</option></select>
    <a>no href</a>
    <span tabIndex={3} onClick={() => go()} role="button">x</span>
    <div aria-hidden="true" tabIndex={0}>hidden but reachable</div>
  </div>
);
`;
const before = errors.length;
const warnedBefore = warnings.length;
scan(FIXTURE, "<self-test fixture>");
const planted = {
  "onClick on <div> with no keyboard path": errors.slice(before).some((e) => /onClick on <div>/.test(e)),
  "<img> with no alt": errors.slice(before).some((e) => /<img> with no alt/.test(e)),
  "positive tabIndex": errors.slice(before).some((e) => /positive tabIndex=3/.test(e)),
  "aria-hidden on a focusable element": errors.slice(before).some((e) => /aria-hidden with tabIndex=0/.test(e)),
  "an unlabelled <input>": warnings.slice(warnedBefore).some((w) => /<input> with no label/.test(w)),
  "an unlabelled <select>": warnings.slice(warnedBefore).some((w) => /<select> with no label/.test(w)),
  "an <a> with no href": warnings.slice(warnedBefore).some((w) => /<a> with no href/.test(w)),
};

// Drop the fixture's findings: they are not findings about this codebase.
const fixtureFailures = errors.slice(before);
errors.length = before;
warnings.length = warnedBefore;

console.log("\nscanner self-test (7 deliberately broken constructs):");
let selfTestFailed = false;
for (const [what, found] of Object.entries(planted)) {
  console.log(`  ${found ? "ok  " : "FAIL"}  detects ${what}`);
  if (!found) selfTestFailed = true;
}
if (fixtureFailures.length !== 4) {
  console.log(`  FAIL  expected exactly 4 errors from the fixture, got ${fixtureFailures.length}`);
  for (const f of fixtureFailures) console.log(`        ${f}`);
  selfTestFailed = true;
}
if (selfTestFailed) {
  console.log("\nthe scanner is not detecting what it claims — treat the clean result above as meaningless");
  process.exit(1);
}

// ── the page shell ───────────────────────────────────────────────────────────
const html = readFileSync(join(ROOT, "web/index.html"), "utf8");
if (!/<html[^>]+lang=/.test(html)) fail(join(ROOT, "web/index.html"), 1, "<html> has no lang attribute");
if (!/<title>[^<]+<\/title>/.test(html)) fail(join(ROOT, "web/index.html"), 1, "no <title>");
if (!/name=["']viewport["']/.test(html)) warn(join(ROOT, "web/index.html"), 1, "no viewport meta");

// ── a live region must exist, or state changes are silent ────────────────────
if (!files.some((f) => /aria-live|role=["'](status|alert)["']/.test(readFileSync(f, "utf8")))) {
  fail(SRC, 0, "no aria-live region anywhere — state changes are never announced");
}

// ── the focus indicator must not have been removed ───────────────────────────
const css = readFileSync(join(SRC, "index.css"), "utf8");
const outlineNone = css.match(/outline:\s*none/g)?.length ?? 0;
const focusVisible = (css.match(/:focus-visible/g)?.length ?? 0) > 0;
if (outlineNone > 0 && !focusVisible) {
  fail(join(SRC, "index.css"), 0, `${outlineNone} "outline: none" with no :focus-visible replacement — the focus indicator is gone`);
}
if (!focusVisible) warn(join(SRC, "index.css"), 0, "no :focus-visible rule found");

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nstatic accessibility scan — ${files.length} source files\n`);
for (const w of warnings) console.log(`  warn  ${w}`);
for (const e of errors) console.log(`  FAIL  ${e}`);
console.log(
  `\n${errors.length} error(s), ${warnings.length} warning(s). A source scan, not an audit: ` +
    `docs/accessibility.md says what is verified and what is not.`,
);

if (errors.length) process.exit(1);
console.log("\nno static accessibility errors");
