#!/usr/bin/env node
/**
 * The built web bundle must not hold a lowered `||=` that leaves an undeclared variable.
 *
 * esbuild lowers `x ||= y` when the target is below es2021, and in xterm's minified code that
 * came out as `(void 0||(i={}))` with `i` never declared. The first DECRQM query (Claude Code
 * sends ESC[?2026$p at start-up) threw ReferenceError, and the terminal stopped repainting.
 * web/vite.config.ts pins target es2021; this scan catches a build that loses it.
 *
 * Needs web/dist already built (cd web && bun run build).
 *
 *   node scripts/check-bundle.mjs
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const assets = join(ROOT, "web/dist/assets");
// Any lowered logical assignment (||=, &&=, ??=) leaves `(void 0||(x=...` style code with x undeclared.
const BROKEN = /\(void 0(?:\|\||&&|\?\?)\(?[A-Za-z_$][\w$]*=/;
// The target that keeps those operators unlowered. Pinned here, and the config must say the same.
const PINNED_TARGET = "es2021";

if (!existsSync(assets)) {
  console.log("FAIL  web/dist is missing: build the web first (cd web && bun run build)");
  process.exit(1);
}

const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
if (files.length === 0) {
  console.log("FAIL  web/dist/assets has no .js files: build the web first (cd web && bun run build)");
  process.exit(1);
}

let failures = 0;
const config = readFileSync(join(ROOT, "web/vite.config.ts"), "utf8");
const target = config.match(/build:\s*\{[\s\S]*?target:\s*"([^"]+)"/)?.[1];
if (target !== PINNED_TARGET) {
  failures++;
  console.log(`FAIL  web/vite.config.ts build.target is ${target ?? "missing"}, pinned to "${PINNED_TARGET}" (a lower target lowers ||=)`);
}

for (const file of files) {
  const m = readFileSync(join(assets, file), "utf8").match(BROKEN);
  if (m) {
    failures++;
    console.log(`FAIL  ${file} has a lowered ||= (${m[0]}): the target must stay es2021 (web/vite.config.ts)`);
  }
}

console.log(`${files.length} bundle files scanned`);
console.log(failures ? `\n${failures} failed` : "\nall bundle checks passed");
process.exit(failures ? 1 : 0);
