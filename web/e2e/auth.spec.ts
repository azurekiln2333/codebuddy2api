import { expect, test, type Page } from "@playwright/test";
import { mockDashboard, mockSettings } from "./mock";
import { GATEWAY_CSRF, mockSession } from "./sso";

async function mockAuth(page: Page, authenticated = false) {
  const session = await mockSession(page, authenticated);
  await page.route("**/admin/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/admin/settings") return route.fulfill({ json: mockSettings });
    if (path === "/admin/dashboard") return route.fulfill({ json: mockDashboard });
    if (path === "/admin/update") return route.fulfill({ json: { update_available: false } });
    return route.fulfill({ status: 404, json: { error: { message: `Unexpected ${path}` } } });
  });
  return session;
}

test("SSO session survives reload and logout returns to the login page", async ({ page }) => {
  const session = await mockAuth(page, true);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  expect(session.calls.find((call) => call.path === "/sso/logout")).toMatchObject({
    method: "POST",
    csrf: GATEWAY_CSRF,
    body: null,
  });
});

test("session persistence belongs to SSO and the login page collects no credentials", async ({
  page,
}) => {
  await mockAuth(page);
  await page.goto("/dashboard/login");
  await expect(page.getByRole("link", { name: "使用统一身份登录" })).toHaveAttribute(
    "href",
    "/sso/login?return_to=/dashboard/",
  );
  await expect(page.locator("form, input")).toHaveCount(0);
  await expect(page.getByLabel("记住我", { exact: true })).toHaveCount(0);
});

test("SSO sessions never show local bootstrap-password settings", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (request) => calls.push(new URL(request.url()).pathname));
  await mockAuth(page, true);
  await page.goto("/dashboard/settings?tab=account");
  await expect(page.getByRole("heading", { name: "系统设置", exact: true })).toBeVisible();
  await expect(page.getByText("当前使用初始密码，请尽快修改。", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("当前管理密码", { exact: true })).toHaveCount(0);
  expect(calls).not.toContain("/admin/account");
  expect(calls).not.toContain("/admin/session");
});

test("SSO login renders in light, dark and a single-column mobile layout", async ({ page }) => {
  await mockAuth(page);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.goto("/dashboard/login");
  await expect(page.getByRole("link", { name: "使用统一身份登录" })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await page.screenshot({ path: "test-results/auth-login-light.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.screenshot({ path: "test-results/auth-login-dark.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/auth-login-mobile.png", fullPage: true });
});
