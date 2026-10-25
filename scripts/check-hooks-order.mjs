#!/usr/bin/env node
/**
 * Hooks after an early return: the cause of the cold-load crash ("Workspace failed to render",
 * React error #310). A component that returns early (`if (!w) return ...`) and calls a hook below
 * it renders fewer hooks on one pass than on the next, so React throws when the data arrives.
 *
 * There is no ESLint in this project, so this is a small static scan instead of
 * react-hooks/rules-of-hooks: for each top-level component in web/src, it finds an early return at
 * the function's own indentation, then flags any `useXxx(` statement after it at that same level.
 * ponytail: line-based and indentation-based (it relies on the formatter's 2 spaces); it does not parse
 * code, so a hook in a nested helper or a one-line function is not seen. Move to eslint-plugin-react-hooks
 * if the project ever adopts ESLint.
 *
 *   node scripts/check-hooks-order.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Violations in one file's text: [{ line, fn, hook, returnLine }]. */
export function hooksAfterReturn(text) {
  const lines = text.split("\n");
  const found = [];
  let fn = null;
  let returnLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = line.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Z]\w*)\s*[(<]/);
    if (start) {
      fn = start[1];
      returnLine = 0;
      continue;
    }
    if (!fn) continue;
    if (line === "}") {
      fn = null;
      continue;
    }
    if (!returnLine && /^ {2}if \(/.test(line)) {
      // `if (x) return ...;` on one line, or a block `if (x) {` ... `}` holding a return of its own.
      if (/^ {2}if \(.*\)\s+return\b/.test(line)) returnLine = i + 1;
      else if (/\{\s*$/.test(line)) {
        for (let j = i + 1; j < lines.length && !/^ {2}\}/.test(lines[j]); j++) {
          if (/^ {4}return\b/.test(lines[j])) returnLine = i + 1;
        }
      }
      continue;
    }
    const hook = returnLine && line.match(/^ {2}(?:const|let)?[^=(]*=?\s*(use[A-Z]\w*)\(/);
    if (hook) found.push({ line: i + 1, fn, hook: hook[1], returnLine });
  }
  return found;
}

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  ${detail}` : ""}`);
};

// The scan must catch the bug it exists for, and leave the fixed shape alone.
const bad = `function A() {\n  const w = useApp();\n  if (!w) return null;\n  const r = useRef(0);\n  return r;\n}\n`;
const badBlock = `export default function B() {\n  if (!w) {\n    return <p />;\n  }\n  useEffect(() => {}, []);\n  return null;\n}\n`;
const good = `function C() {\n  const r = useRef(0);\n  useEffect(() => {\n    if (!r) return;\n    useless();\n  }, []);\n  if (!r) return null;\n  const x = compute();\n  return x;\n}\n`;
check("catches a hook after a one-line early return", hooksAfterReturn(bad).length === 1);
check("catches a hook after a block early return", hooksAfterReturn(badBlock).length === 1);
check("leaves hooks above the early return alone", hooksAfterReturn(good).length === 0);

const root = new URL("../web/src/", import.meta.url).pathname;
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name));
    else if (e.name.endsWith(".tsx")) files.push(join(dir, e.name));
  }
};
walk(root);
for (const file of files) {
  for (const v of hooksAfterReturn(readFileSync(file, "utf8"))) {
    check(`${file.slice(root.length)}:${v.line} ${v.fn}`, false, `${v.hook}() after the early return on line ${v.returnLine}`);
  }
}
check(`${files.length} components scanned, no hook after an early return`, failures === 0);

console.log(failures ? `\n${failures} failed` : "\nall hook-order checks passed");
process.exit(failures ? 1 : 0);
