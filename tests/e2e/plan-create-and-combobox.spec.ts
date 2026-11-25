import { expect, test } from "@playwright/test";
import type { BookingGroup } from "../../src/shared/api.generated";
import { makePlan, mockAuthenticatedApp } from "./fixtures";

test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, "方案创建与房间类型下拉回归仅在桌面视口运行");

test("creating a single plan after editing creates a new plan and hides empty combobox text when matched", async ({
  page,
}) => {
  await mockAuthenticatedApp(page, {
    plans: [makePlan("p-1", "101", false)],
  });

  const requests: { method: string; path: string }[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/plans")) {
      requests.push({ method: req.method(), path });
    }
  });

  await page.goto("/plans");
  const firstRow = page.locator("li").filter({ hasText: "自习室" }).first();
  await expect(firstRow).toBeVisible();

  // 先 hover 行并打开已有方案的编辑弹窗再取消，复现 selected 状态残留场景
  await firstRow.hover();
  await firstRow.getByRole("button", { name: "编辑方案" }).click();
  const editDialog = page.getByRole("dialog", { name: "编辑单条方案" });
  await expect(editDialog).toBeVisible();
  await expect(editDialog.locator("input[name='seatNum']")).toHaveValue("101");
  await editDialog.getByRole("button", { name: "取消" }).click();
  await expect(editDialog).toBeHidden();

  // 点击「创建方案」->「单条方案」，应为全新空白创建表单
  await page.getByRole("button", { name: "创建方案" }).first().click();
  await page.getByRole("button", { name: /单条方案/ }).click();

  const createDialog = page.getByRole("dialog", { name: "创建单条方案" });
  await expect(createDialog).toBeVisible();
  await expect(createDialog.locator("input[name='seatNum']")).toHaveValue("");

  // 展开房间类型下拉框：有选项时不应出现底部灰字「没有匹配项」
  const roomInput = createDialog.getByPlaceholder("选择房间类型");
  await roomInput.click();
  await expect(page.getByRole("option", { name: "阅览室" })).toBeVisible();
  await expect(page.getByText("没有匹配项")).toBeHidden();

  // 输入无匹配关键字时才显示「没有匹配项」
  await roomInput.fill("不存在的房间类型");
  await expect(page.getByText("没有匹配项")).toBeVisible();

  // 重新匹配「阅览室」后，「没有匹配项」消失并可选中
  await roomInput.fill("阅览");
  await expect(page.getByText("没有匹配项")).toBeHidden();
  await page.getByRole("option", { name: "阅览室" }).click();

  // 补齐其余字段并提交
  await createDialog.getByRole("combobox", { name: "楼层" }).click();
  await page.getByRole("option", { name: /三楼/ }).click();
  await createDialog.locator("input[name='seatNum']").fill("309");
  await createDialog.getByRole("combobox", { name: "开始时间" }).click();
  await page.getByRole("option", { name: "08:00" }).click();
  await createDialog.getByRole("combobox", { name: "时长" }).click();
  await page.getByRole("option", { name: "2 小时" }).click();
  await createDialog.getByRole("button", { name: "保存方案" }).click();

  await expect(page.getByText("方案已创建")).toBeVisible();
  const rows = page.getByRole("main").last().locator("li");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("座位 101");
  await expect(rows.nth(1)).toContainText("座位 309");

  // 必须调用 POST /api/plans，而不能误调 PATCH /api/plans/p-1
  expect(requests.some((r) => r.method === "POST" && r.path === "/api/plans")).toBe(true);
  expect(requests.some((r) => r.method === "PATCH" && r.path === "/api/plans/p-1")).toBe(false);
});

test("creating a group plan after editing an existing group creates a new group instead of updating", async ({
  page,
}) => {
  const existingGroup: BookingGroup = {
    id: "g-existing",
    kind: "group",
    name: "原有组合",
    memberPlanIds: ["p-1", "p-2"],
    weekdays: [1, 2, 3, 4, 5],
    enabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  await mockAuthenticatedApp(page, {
    plans: [
      makePlan("p-1", "101", false),
      makePlan("p-2", "102", false),
      makePlan("p-3", "103", false),
      makePlan("p-4", "104", false),
      existingGroup,
    ],
  });

  const groupRequests: { method: string; path: string }[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (path.startsWith("/api/groups")) {
      groupRequests.push({ method: req.method(), path });
    }
  });

  await page.goto("/plans");
  const groupRow = page.locator("li").filter({ hasText: "原有组合" });
  await expect(groupRow).toBeVisible();

  // 先 hover 行并打开已有组合的编辑抽屉再关闭
  await groupRow.hover();
  await groupRow.getByRole("button", { name: "编辑方案" }).click();
  const editDrawer = page.getByRole("dialog", { name: "编辑组合方案" });
  await expect(editDrawer).toBeVisible();
  await expect(editDrawer.locator("input[name='name']")).toHaveValue("原有组合");
  await editDrawer.getByRole("button", { name: "取消" }).click();
  await expect(editDrawer).toBeHidden();

  // 再创建新的组合方案
  await page.getByRole("button", { name: "创建方案" }).first().click();
  await page.getByRole("button", { name: /组合方案/ }).click();

  const createDrawer = page.getByRole("dialog", { name: "创建组合方案" });
  await expect(createDrawer).toBeVisible();
  await expect(createDrawer.locator("input[name='name']")).toHaveValue("");
  await createDrawer.locator("input[name='name']").fill("新建组合");
  const checkboxes = createDrawer.getByRole("checkbox");
  await checkboxes.nth(0).click();
  await checkboxes.nth(1).click();
  await createDrawer.getByRole("button", { name: "保存组合" }).click();

  await expect(page.getByText("组合方案已创建")).toBeVisible();
  await expect(page.getByText("原有组合")).toBeVisible();
  await expect(page.getByText("新建组合")).toBeVisible();

  expect(groupRequests.some((r) => r.method === "POST" && r.path === "/api/groups")).toBe(true);
  expect(groupRequests.some((r) => r.method === "PATCH" && r.path === "/api/groups/g-existing")).toBe(false);
});
