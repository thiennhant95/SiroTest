import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VV_API_PROXY ?? "http://localhost:3001",
        changeOrigin: true,
      },
      // Run live events (useRunChannel → ws://<vite>/ws?runId=&token=).
      // Without this the browser WS handshake 404s and the run page sits
      // in "reconnecting…" with no live step progress.
      "/ws": {
        target: (process.env.VV_API_PROXY ?? "http://localhost:3001").replace(/^http/, "ws"),
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
