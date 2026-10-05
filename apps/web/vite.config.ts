import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Dual-loopback: Vite mặc định bind ::1 (IPv6) khiến http://127.0.0.1
    // không mở được. host:true nghe mọi interface loopback (v4+v6) để cả
    // localhost lẫn 127.0.0.1 đều vào được. Dev-only (không chứa secret).
    host: true,
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
