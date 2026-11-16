import { expect, test } from "@playwright/test";
import { mockAuthenticatedApp } from "./fixtures";

// 回归测试：楼层加载失败时（如部分房间类型暂未开放），
// 点击"保存方案"必须能看到楼层校验错误，而不是弹窗毫无反应。
test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "表单校验逻辑与视口无关，仅在桌面视口运行");

test("shows floor validation error when floors fail to load", async ({ page }) => {
  await mockAuthenticatedApp(page, { failFloors: true });

  await page.goto("/");
  // 侧边栏折叠时其内部链接在视口外，isVisible 仍为 true；必须按几何位置判断并先展开
  const nav = page.getByText("预约方案", { exact: true }).first();
  const box = await nav.boundingBox();
  const viewportWidth = page.viewportSize()?.width ?? 1280;
  if (!box || box.x < 0 || box.x + box.width > viewportWidth) {
    await page.getByRole("button", { name: "切换侧栏" }).click();
    await expect(nav).toBeInViewport();
  }
  await nav.click();
  await page.getByRole("button", { name: "创建方案" }).first().click();
  await page.getByRole("button", { name: /单条方案/ }).click();

  await page.getByPlaceholder("选择房间类型").click();
  await page.getByPlaceholder("选择房间类型").fill("阅览室");
  await page.getByRole("option", { name: "阅览室" }).first().click();
  await expect(page.getByText("该房间类型当前没有可预约楼层")).toBeVisible();

  await page.getByRole("button", { name: "保存方案" }).click();
  await expect(page.getByText("请选择楼层")).toBeVisible();
});
