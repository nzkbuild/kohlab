import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
