import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// One build id: <root package.json version>+<git short sha, else build timestamp>.
// Baked into the bundle as __KOHLAB_BUILD__ and written to dist/build-id.txt, which the server reads.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
let sha = "";
try {
  sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
} catch {
  /* no git: the timestamp below stands in */
}
const BUILD_ID = `${version}+${sha || new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "kohlab-build-id",
      closeBundle() {
        writeFileSync(join(ROOT, "web", "dist", "build-id.txt"), `${BUILD_ID}\n`);
      },
    },
  ],
  define: {
    __KOHLAB_BUILD__: JSON.stringify(BUILD_ID),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:7676",
      "/": {
        target: "http://localhost:7676",
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    // Old hashed assets stay until scripts/update.sh prunes them after a healthy restart, so an open tab's lazy chunks still resolve.
    emptyOutDir: false,
    // A lowered `||=` in xterm's minified code leaves an undeclared variable and freezes the terminal; do not lower the target.
    target: "es2021",
    rollupOptions: {
      output: {
        // xterm is a heavy per-view dep; it is also a lazy() import. Monaco is
        // deliberately NOT grouped here: a manual chunk made Rollup hoist the
        // shared Vite preload helper into it, so the entry statically imported
        // the whole Monaco chunk and modulepreloaded it on first paint.
        // A function, not a package list: xterm is imported by deep path.
        manualChunks(id) {
          if (id.includes("/node_modules/@xterm/")) return "terminal";
          if (id.includes("/node_modules/@phosphor-icons/")) return "icons";
        },
      },
    },
  },
});
