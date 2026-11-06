import { expect, test, type Page } from "@playwright/test";
import { mockDashboard, mockSettings } from "./mock";
import { adminSession, GATEWAY_CSRF, mockSession } from "./sso";

async function mockAccount(page: Page) {
  await mockSession(page);
  await page.route("**/admin/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/settings") return route.fulfill({ json: mockSettings });
    if (path === "/admin/dashboard") return route.fulfill({ json: mockDashboard });
    if (path === "/admin/update") return route.fulfill({ json: { update_available: false } });
    return route.fulfill({ status: 404, json: { error: { message: `Unexpected ${path}` } } });
  });
}

test("account menu reflects SSO identity and dismisses with Escape", async ({ page }) => {
  await mockAccount(page);
  await page.goto("/dashboard/");
  const trigger = page.getByRole("button", { name: "账号菜单" });
  await expect(trigger).toHaveAttribute("title", adminSession.user.sub);
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByRole("group", { name: "账号菜单" });
  await expect(panel.getByText(adminSession.user.sub, { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "退出登录" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toHaveCount(0);
});

test("revoked SSO permission closes the account shell without a password fallback", async ({
  page,
}) => {
  await mockAccount(page);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  await page.route("**/admin/settings", (route) => {
    expect(route.request().headers()["x-csrf-token"]).toBe(GATEWAY_CSRF);
    return route.fulfill({ status: 403, json: { error: { message: "管理员权限已撤回" } } });
  });
  await page.getByRole("link", { name: "系统设置", exact: true }).click();
  await expect(page.getByRole("heading", { name: "无管理权限" })).toBeVisible();
  await expect(page.getByRole("link", { name: "使用其他账号登录" })).toHaveAttribute(
    "href",
    "/sso/login?return_to=/dashboard/",
  );
  await expect(page.getByRole("button", { name: "账号菜单" })).toHaveCount(0);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});
