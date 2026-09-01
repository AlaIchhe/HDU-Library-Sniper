import { expect, test } from "@playwright/test";

test("unauthenticated users see the login page", async ({ page }) => {
  await page.route("**/api/session", async (route) => route.fulfill({ json: { authenticated: false, refreshing: false } }));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "登录图书馆账户" })).toBeVisible();
  await expect(page.getByLabel("学号")).toBeVisible();
});
