import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "HDU Library Sniper",
        short_name: "HDU Sniper",
        description: "杭州电子科技大学图书馆预约工作台",
        theme_color: "#0f172a",
        background_color: "#f8fafc",
        display: "standalone",
        icons: [{ src: "favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
      },
      workbox: { globPatterns: ["**/*.{js,css,html,svg,woff2}"] },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(root, "src") },
  },
  build: { outDir: "dist/web" },
  preview: { port: 8000 },
  server: {
    port: 5173,
    strictPort: false,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
