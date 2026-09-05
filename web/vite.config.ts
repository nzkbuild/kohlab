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
        manualChunks: {
          // xterm + icons are the heavy per-view deps; keep them out of the
          // entry so the workspace list + shell paint before they load.
          "monaco-editor": ["@monaco-editor/react", "monaco-editor"],
          "terminal": ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-image"],
          "icons": ["lucide-react", "@phosphor-icons/react"],
        },
      },
    },
  },
});
