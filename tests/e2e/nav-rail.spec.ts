import { expect, test } from "@playwright/test";

// 中等宽度（1024–1279）使用图标 rail：hover / 聚焦时以覆盖层展开，不推动内容，
// 展开层必须盖在顶栏之上，并能用 Esc 收起。
test.skip(({ isMobile }) => isMobile, "rail 只在桌面中等宽度出现");

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.route("**/api/**", async (route) => route.fulfill({ json: {} }));
  await page.route("**/api/session", async (route) =>
    route.fulfill({ json: { authenticated: true, uid: "304174", name: "23320116", refreshing: false } }),
  );
  await page.route("**/api/plans", async (route) => route.fulfill({ json: { plans: [] } }));
  await page.route("**/api/runtime", async (route) => route.fulfill({ json: { state: "idle" } }));
  await page.goto("/plans");
  // Playwright 的鼠标初始在 (0,0)，正好落在 rail 上
  await page.mouse.move(700, 400);
});

test("rail expands as an overlay above the header and collapses on Escape", async ({ page }) => {
  const rail = page.getByRole("complementary", { name: "侧栏" });
  await expect(rail).toBeVisible();
  const header = page.locator("header").first();
  const headerBox = await header.boundingBox();
  const collapsed = await rail.boundingBox();
  expect(collapsed?.width).toBe(64);
  expect(headerBox?.x).toBe(64);

  if (process.env.RAIL_SHOTS) await page.screenshot({ path: `${process.env.RAIL_SHOTS}/collapsed.png` });

  await rail.hover();
  await expect(rail).toHaveAttribute("data-expanded", "true");
  await expect.poll(async () => (await rail.boundingBox())?.width).toBe(240);
  // 内容不被推动
  expect((await header.boundingBox())?.x).toBe(64);
  // 展开层在顶栏之上：点 rail 顶部、顶栏覆盖范围内的点，命中的应是 rail
  const hit = await page.evaluate(() => {
    const el = document.elementFromPoint(180, 28);
    return Boolean(el?.closest("aside[aria-label='侧栏']"));
  });
  expect(hit).toBe(true);
  await expect(rail.getByText("HDU Sniper")).toBeVisible();

  if (process.env.RAIL_SHOTS) await page.screenshot({ path: `${process.env.RAIL_SHOTS}/expanded.png` });

  await page.keyboard.press("Escape");
  await expect(rail).toHaveAttribute("data-expanded", "false");
});

test("collapsed rail links expose accessible names", async ({ page }) => {
  const rail = page.getByRole("complementary", { name: "侧栏" });
  await expect(rail.getByRole("link", { name: "预约方案" })).toHaveAttribute("aria-current", "page");
  await expect(rail.getByRole("link", { name: "当前预约" })).toBeVisible();
});
