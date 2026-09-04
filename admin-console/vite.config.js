import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The Express backend runs separately in dev (npm run dev:server, in
    // the repo root). In production, vercel.json rewrites /api/* to the
    // same-origin serverless function instead — this proxy exists purely
    // so `fetch("/api/...")` works identically in both without the
    // frontend code needing to know which environment it's in.
    proxy: {
      "/api": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});
