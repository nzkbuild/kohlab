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
        // xterm + Monaco are the heavy per-view deps; they are also lazy()
        // imports, so keeping them out of the entry lets the shell paint first.
        // A function, not a package list: Monaco is imported by deep path
        // (lib/monaco.ts), which a package-name entry would not catch.
        manualChunks(id) {
          if (id.includes("/node_modules/monaco-editor/") || id.includes("/node_modules/@monaco-editor/")) return "monaco-editor";
          if (id.includes("/node_modules/@xterm/")) return "terminal";
          if (id.includes("/node_modules/@phosphor-icons/")) return "icons";
        },
      },
    },
  },
});
