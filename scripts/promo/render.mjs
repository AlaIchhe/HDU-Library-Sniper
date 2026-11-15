#!/usr/bin/env node
// 逐帧渲染 promo.html 并编码为 MP4 / GIF。
//   node scripts/promo/render.mjs            # 完整渲染（60fps）
//   node scripts/promo/render.mjs --stills   # 只导出关键帧预览图到 .tmp-visual/promo
//   FPS=30 node scripts/promo/render.mjs     # 降帧快速预览
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
// 若浏览器装在其他 HOME 下：PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const FPS = Number(process.env.FPS ?? 60);
const OUT_MP4 = resolve(root, "docs/media/hdu-sniper-demo.mp4");
const OUT_GIF = resolve(root, "docs/media/hdu-sniper-demo.gif");
const stills = process.argv.includes("--stills");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto(`${pathToFileURL(resolve(here, "promo.html")).href}?render`);
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.__promo.DURATION);

const shoot = async (t, type = "jpeg") => {
  await page.evaluate((x) => window.__promo.seek(x), t);
  return page.screenshot(type === "jpeg" ? { type, quality: 95 } : { type });
};

if (stills) {
  const dir = resolve(root, ".tmp-visual/promo");
  mkdirSync(dir, { recursive: true });
  const times = (process.env.T ?? "1.5,2.7,4.9,6.0,8.6,11.5,15.0,17.0,21.4,22.8,25.8,29.5")
    .split(",")
    .map(Number);
  for (const t of times) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(resolve(dir, `t${t.toFixed(1)}.png`), await shoot(t, "png"));
  }
  console.log(`stills → ${dir}`);
  await browser.close();
  process.exit(0);
}

const ff = spawn(
  "ffmpeg",
  [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "image2pipe",
    "-framerate",
    String(FPS),
    "-i",
    "-",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    OUT_MP4,
  ],
  { stdio: ["pipe", "inherit", "inherit"] },
);

const total = Math.round(duration * FPS);
const started = Date.now();
for (let f = 0; f < total; f++) {
  const buf = await shoot(f / FPS);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % FPS === 0)
    process.stdout.write(`\r${f}/${total} frames · ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
ff.stdin.end();
await new Promise((r, j) => ff.on("close", (c) => (c === 0 ? r() : j(new Error(`ffmpeg exit ${c}`)))));
await browser.close();
console.log(`\nmp4 → ${OUT_MP4}`);

// README 预览 GIF：800 宽、15fps、调色板优化
await new Promise((r, j) => {
  const g = spawn(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      OUT_MP4,
      "-vf",
      // 先做时域降噪去掉胶片颗粒，否则 GIF 帧间差分失效、体积暴涨
      "fps=15,scale=800:-1:flags=lanczos,hqdn3d=6:6:20:20,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
      OUT_GIF,
    ],
    { stdio: "inherit" },
  );
  g.on("close", (c) => (c === 0 ? r() : j(new Error(`ffmpeg gif exit ${c}`))));
});
console.log(`gif → ${OUT_GIF}`);
