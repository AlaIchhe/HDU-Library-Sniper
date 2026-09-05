import { expect, test } from "@playwright/test";

// 回归测试：楼层加载失败时（如部分房间类型暂未开放），
// 点击"保存方案"必须能看到楼层校验错误，而不是弹窗毫无反应。
test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "表单校验逻辑与视口无关，仅在桌面视口运行");

test("shows floor validation error when floors fail to load", async ({ page }) => {
  // 兜底 mock：其余只读接口一律返回空数据
  await page.route("**/api/**", async (route) => {
    if (route.request().method() === "GET") await route.fulfill({ json: {} });
    else await route.fulfill({ json: {} });
  });
  await page.route("**/api/session", async (route) =>
    route.fulfill({ json: { authenticated: true, uid: "304174", name: "23320116", refreshing: false } }));
  await page.route("**/api/plans", async (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { plans: [] } }) : route.fulfill({ json: {} }));
  await page.route("**/api/catalog/room-types", async (route) =>
    route.fulfill({ json: { options: [{ id: "q=76", name: "阅览室", query: "q=76" }] } }));
  await page.route("**/api/catalog/floors**", async (route) =>
    route.fulfill({ status: 502, json: { detail: "该房间类型当前没有可预约楼层" } }));

  await page.goto("/");
  const nav = page.getByText("预约方案", { exact: true }).first();
  if (!(await nav.isVisible())) await page.getByRole("button", { name: "Toggle Sidebar" }).click();
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
