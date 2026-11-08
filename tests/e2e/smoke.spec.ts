import { expect, test } from "@playwright/test";

test("unauthenticated users see the login page", async ({ page }) => {
  await page.route("**/api/session", async (route) =>
    route.fulfill({ json: { authenticated: false, refreshing: false } }),
  );
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录图书馆账户" })).toBeVisible();
  await expect(page.getByLabel("学号")).toBeVisible();
});

test("openid login links to the guide", async ({ page }) => {
  await page.route("**/api/session", async (route) =>
    route.fulfill({ json: { authenticated: false, refreshing: false } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "OpenID 登录" }).click();
  await page.getByRole("button", { name: "点击获取" }).click();
  await expect(page.getByRole("heading", { name: "获取 openid" })).toBeVisible();
  await expect(page.getByText("微信扫一扫", { exact: true })).toBeVisible();
});
