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
          // xterm + Monaco are the heavy per-view deps; they are also lazy()
          // imports, so keeping them out of the entry lets the shell paint first.
          // (lucide-react was listed here but is absent from package.json and
          // imported nowhere — removed.)
          "monaco-editor": ["@monaco-editor/react", "monaco-editor"],
          terminal: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-image"],
          icons: ["@phosphor-icons/react"],
        },
      },
    },
  },
});
