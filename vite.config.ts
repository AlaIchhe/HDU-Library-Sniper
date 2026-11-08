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
      workbox: {
        // CJK 字体有 100 多个 unicode-range 分片，全部预缓存等于首次访问先下 4.6 MB；
        // 交给浏览器按 unicode-range 按需取，再用运行时缓存兜底。
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        globIgnores: ["**/noto-sans-sc-*.woff2"],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/noto-sans-sc-.*\.woff2$/,
            handler: "CacheFirst",
            options: {
              cacheName: "cjk-fonts",
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
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
