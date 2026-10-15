import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Worker (wrangler dev, port 8787) owns /api and /d; Vite serves the UI with hot reload.
const worker = "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": worker,
      "/d": worker,
    },
  },
  build: {
    // Served as static assets by the same Worker (see wrangler.toml [assets]).
    outDir: "../worker/public",
    emptyOutDir: true,
  },
});
