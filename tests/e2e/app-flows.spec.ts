import { expect, test } from "@playwright/test";
import { makePlan, mockAuthenticatedApp } from "./fixtures";

test("plans toggle/undo, group creation drawer, bookings check-in, and command palette on desktop", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "桌面交互流程仅在 desktop 项目运行");
  await mockAuthenticatedApp(page, {
    plans: [makePlan("p-1", "101", true), makePlan("p-2", "102", false)],
    bookings: [
      {
        bookingId: "b-1",
        roomName: "三楼阅览室",
        seatNum: "308",
        startText: "08:00",
        durationText: "4 小时",
        status: "0",
        state: "check_in",
        statusLabel: "可签到",
        canCheckIn: true,
        canCancel: true,
        canLeave: false,
        canRenew: false,
        canSignOut: false,
      },
    ],
    disabledOnEnable: { "p-2": ["p-1"] },
  });

  await page.goto("/plans");
  await expect(page.getByText("101")).toBeVisible();

  // 表头与行内「重复日期」列左边缘必须对齐，避免操作列 auto 宽不一致导致整列左偏
  const weekdayHeader = await page.getByText("重复日期", { exact: true }).boundingBox();
  const weekdayCell = await page
    .locator("li")
    .filter({ hasText: "自习室" })
    .first()
    .getByText("工作日", { exact: true })
    .boundingBox();
  expect(weekdayHeader).not.toBeNull();
  expect(weekdayCell).not.toBeNull();
  expect(Math.abs((weekdayHeader?.x ?? 0) - (weekdayCell?.x ?? 0))).toBeLessThan(1);

  // 启用第二个方案应触发顶替撤销提示，点击「撤销」恢复原方案
  await page.getByRole("switch", { name: "启用方案" }).first().click();
  await expect(page.getByRole("button", { name: "撤销" })).toBeVisible();
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("已撤销")).toBeVisible();

  // 创建组合方案抽屉
  await page.getByRole("button", { name: "创建方案" }).first().click();
  await page.getByRole("button", { name: /组合方案/ }).click();
  const drawer = page.getByRole("dialog", { name: "创建组合方案" });
  await drawer.locator("input[name='name']").fill("早八顺位");
  const checkboxes = drawer.getByRole("checkbox");
  await checkboxes.nth(0).click();
  await checkboxes.nth(1).click();
  await drawer.getByRole("button", { name: "保存组合" }).click();
  await expect(page.getByText("早八顺位")).toBeVisible();

  // 使用 Ctrl+K 命令面板跳转到当前预约并执行签到
  await page.keyboard.press("Control+k");
  const search = page.getByRole("textbox", { name: "搜索命令" });
  await expect(search).toBeVisible();
  await search.fill("当前预约");
  await page.getByRole("listbox", { name: "命令" }).getByText("当前预约").click();
  await expect(page).toHaveURL(/\/bookings$/);
  await page.getByRole("button", { name: "签到", exact: true }).click();
  await expect(page.getByText("使用中")).toBeVisible();
});

test("floating dock navigates between plans and bookings on mobile viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "FloatingDock 仅在移动端窄视口显示");
  await mockAuthenticatedApp(page, {
    plans: [makePlan("p-1", "101", false)],
  });

  await page.goto("/plans");
  const dock = page.getByRole("navigation", { name: "主导航" });
  await expect(dock).toBeVisible();
  await dock.getByRole("link", { name: "当前预约" }).click();
  await expect(page).toHaveURL(/\/bookings$/);
});
