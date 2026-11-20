#!/usr/bin/env node
// The browser checks test web/dist, so web/dist must be built from the web/src beside it. A dist older than
// any source file would make a green run describe an older UI (F4), so this fails by name until the web is rebuilt.
//
//   cd web && bun run build
//   node scripts/check-dist-fresh.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "web/src");
const INDEX = join(ROOT, "web/dist/index.html");
const BUILD_ID = join(ROOT, "web/dist/build-id.txt");

if (!existsSync(INDEX)) {
  console.log("FAIL  web/dist is not built (cd web && bun run build)");
  process.exit(1);
}

/** The newest file under a directory. */
function newest(dir) {
  let best = { mtime: 0, file: "" };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const found = entry.isDirectory() ? newest(path) : { mtime: statSync(path).mtimeMs, file: path };
    if (found.mtime > best.mtime) best = found;
  }
  return best;
}

const built = statSync(INDEX).mtimeMs;
const source = newest(SRC);
const id = existsSync(BUILD_ID) ? readFileSync(BUILD_ID, "utf8").trim() : "no build id (built before the handshake)";

if (source.mtime > built) {
  console.log(`FAIL  web/dist is older than ${source.file.slice(ROOT.length)}: the checks would test an old UI`);
  console.log("      rebuild first: cd web && bun run build");
  process.exit(1);
}

console.log(`ok    web/dist is not older than web/src  (build ${id})`);
process.exit(0);
