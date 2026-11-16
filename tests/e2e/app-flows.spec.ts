import { expect, type Page, test } from "@playwright/test";
import type { Booking, BookingGroup, BookingPlan } from "../../src/shared/types";

type MockState = {
  plans: Array<BookingPlan | BookingGroup>;
  bookings: Booking[];
  disabledOnEnable?: Record<string, string[]>;
};

function makePlan(id: string, seatNum: string, enabled: boolean): BookingPlan {
  return {
    id,
    kind: "single",
    roomType: "自习室",
    roomQuery: "q=76",
    floorId: 4,
    floorName: "四楼",
    seatNum,
    fallbackSeats: [],
    startHour: 8,
    durationHours: 4,
    weekdays: [1, 2, 3, 4, 5],
    enabled,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function mockAuthenticatedApp(page: Page, state: MockState) {
  await page.route("**/api/**", async (route) => route.fulfill({ json: {} }));
  await page.route("**/api/session", async (route) =>
    route.fulfill({ json: { authenticated: true, uid: "304174", name: "23320116", refreshing: false } }),
  );
  await page.route("**/api/runtime/status", async (route) => route.fulfill({ json: { state: "idle" } }));
  await page.route("**/api/checkin", async (route) =>
    route.fulfill({ json: { enabled: false, consentVersion: 1, acceptedAt: null } }),
  );
  await page.route("**/api/bookings/current", async (route) =>
    route.fulfill({ json: { bookings: state.bookings } }),
  );
  await page.route("**/api/bookings/*/*", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const id = parts[3];
    const action = parts[4];
    if (action === "check-in") {
      state.bookings = state.bookings.map((b) =>
        b.bookingId === id ? { ...b, state: "in_use", statusLabel: "使用中", canCheckIn: false } : b,
      );
    }
    await route.fulfill({ json: { success: true, message: "操作成功" } });
  });
  await page.route("**/api/plans", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { plans: state.plans } });
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    const created: BookingPlan = {
      ...makePlan("p-new", String(body.seatNum ?? "101"), false),
      roomType: String(body.roomType ?? "阅览室"),
      floorName: String(body.floorName ?? "三楼"),
    };
    state.plans = [...state.plans, created];
    return route.fulfill({ json: { plan: created } });
  });
  await page.route("**/api/plans/*/*", async (route) => {
    const parts = new URL(route.request().url()).pathname.split("/");
    const id = parts[3] ?? "";
    const enabled = parts[4] === "enable";
    const disabledPlanIds = enabled ? (state.disabledOnEnable?.[id] ?? []) : [];
    state.plans = state.plans.map((p) => {
      if (p.id === id) return { ...p, enabled };
      if (disabledPlanIds.includes(p.id)) return { ...p, enabled: false };
      return p;
    });
    const plan = state.plans.find((p) => p.id === id) ?? state.plans[0];
    return route.fulfill({ json: { plan, disabledPlanIds } });
  });
  await page.route("**/api/groups", async (route) => {
    const body = route.request().postDataJSON() as { name: string; memberPlanIds: string[] };
    const group: BookingGroup = {
      id: "g-1",
      kind: "group",
      name: body.name,
      memberPlanIds: body.memberPlanIds,
      weekdays: [1, 2, 3, 4, 5],
      enabled: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    state.plans = [...state.plans, group];
    return route.fulfill({ json: { plan: group } });
  });
}

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
        status: "RESERVED",
        state: "reserved",
        statusLabel: "待签到",
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
    bookings: [],
  });

  await page.goto("/plans");
  const dock = page.getByRole("navigation", { name: "主导航" });
  await expect(dock).toBeVisible();
  await dock.getByRole("link", { name: "当前预约" }).click();
  await expect(page).toHaveURL(/\/bookings$/);
});
