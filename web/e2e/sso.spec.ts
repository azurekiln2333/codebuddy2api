import { expect, test } from "@playwright/test";
import { adminSession, GATEWAY_CSRF, mockSession } from "./sso";

const dashboardPayload = {
  summary: { requests: 3, success_rate: 1, total_tokens: 30, credit: 0 },
  series: [{ date: "2026-10-01", bucket: 1790812800, requests: 3, success: 3, error: 0 }],
  models: [],
  profiles: [],
  health: { credentials: [] },
  storage: { degraded: false },
  range: { days: 7, granularity: "day" },
  generated_at: 1790812800,
};

// Gateway contract only: the browser must never request `/admin/session` or
// handle the original administrative API key during sign-in or sign-out.
test("SSO session contract: GET /sso/session, gateway CSRF and POST /sso/logout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const adminCalls: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/admin/")) adminCalls.push(`${request.method()} ${path}`);
  });
  const session = await mockSession(page);
  await page.route("**/admin/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/admin/session")
      return route.fulfill({ status: 500, json: { error: { message: "legacy endpoint" } } });
    if (path === "/admin/dashboard") return route.fulfill({ json: dashboardPayload });
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method()))
      return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { error: { message: "unmocked" } } });
  });

  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();

  const sessionCall = session.calls.find((call) => call.path === "/sso/session");
  expect(sessionCall).toMatchObject({ method: "GET", csrf: undefined });
  expect(JSON.stringify(sessionCall)).not.toContain("api");
  expect(adminCalls).not.toContain("GET /admin/session");
  expect(adminCalls.some((call) => call.endsWith("/sso/session"))).toBe(false);

  // The rendered identity comes from the gateway session, not from local input.
  await expect(page.getByTitle(adminSession.user.sub)).toBeVisible();

  // Sign-out lives in the reference-style account panel.
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  const logout = session.calls.find((call) => call.path === "/sso/logout");
  expect(logout).toMatchObject({ method: "POST", csrf: GATEWAY_CSRF, body: null });
  await expect(page.getByRole("link", { name: /统一身份登录/ })).toHaveAttribute(
    "href",
    "/sso/login?return_to=/dashboard/",
  );
  expect(errors).toEqual([]);
});

test("logging out twice does not reuse the consumed session", async ({ page }) => {
  const session = await mockSession(page);
  await page.route("**/admin/dashboard", (route) => route.fulfill({ json: dashboardPayload }));
  await page.goto("/dashboard/");
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  // Exactly one POST with the live gateway CSRF: no replay, no stale token.
  expect(session.calls.filter((call) => call.path === "/sso/logout")).toEqual([
    { method: "POST", path: "/sso/logout", body: null, csrf: GATEWAY_CSRF },
  ]);
  // The signed-out shell no longer offers sign-out, so nothing can be replayed.
  await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /统一身份登录/ })).toBeVisible();
});

test("anonymous session shows the SSO gate without any API key entry", async ({ page }) => {
  const session = await mockSession(page, false);
  await page.goto("/dashboard/settings");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await expect(page.getByRole("heading", { name: /登录 CodeBuddy2Api/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /统一身份登录/ })).toBeVisible();
  // No browser-side secret form: the original administrative API key is gone.
  expect(await page.getByLabel("API key", { exact: true }).count()).toBe(0);
  expect(await page.locator('input[type="password"]').count()).toBe(0);
  expect(await page.getByRole("button", { name: /进入工作台/ }).count()).toBe(0);
  for (const call of session.calls) expect(call.path).toBe("/sso/session");
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
});

test("denied session (403) and unauthenticated session (401) stay distinguishable", async ({
  page,
}) => {
  await page.route("**/sso/session", (route) =>
    route.fulfill({ status: 401, json: { error: { message: "未认证" } } }),
  );
  await page.goto("/dashboard/");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await expect(page.getByRole("heading", { name: /登录 CodeBuddy2Api/ })).toBeVisible();
  expect(await page.getByRole("heading", { name: "无管理权限" }).count()).toBe(0);

  const denied = await mockSession(page);
  await page.unroute("**/sso/session");
  await page.route("**/sso/session", (route) => route.fulfill({ status: 403, json: {} }));
  await page.goto("/dashboard/credentials");
  await expect(page.getByRole("heading", { name: "无管理权限" })).toBeVisible();
  await expect(page.getByText(/访问被拒绝/)).toBeVisible();
  await expect(page.getByRole("link", { name: /使用其他账号登录/ })).toBeVisible();
  // A denied session must not be treated as a usable session.
  expect(denied.calls).toEqual([]);
  await expect(page.getByRole("link", { name: /统一身份登录/ })).toHaveCount(0);
});

// The gateway owns identity, so any /sso/session state that is not a complete
// admin session must leave the console closed. Fixtures are served from a fresh
// context per attempt because Playwright route order is LIFO across registrations.
// Each case asserts the guard variant the app contract classifies it as.
test.describe("never unlocks on an incomplete session", () => {
  for (const [label, body, guard] of [
    [
      "blank CSRF",
      { authenticated: true, csrf_token: "   ", user: { sub: "test-admin", role: "admin" } },
      "返回登录",
    ],
    [
      "missing role",
      { authenticated: true, csrf_token: GATEWAY_CSRF, user: { sub: "test-admin" } },
      "使用其他账号登录",
    ],
    ["missing user", { authenticated: true, csrf_token: GATEWAY_CSRF }, "返回登录"],
    [
      "blank sub",
      { authenticated: true, csrf_token: GATEWAY_CSRF, user: { sub: "", role: "admin" } },
      "返回登录",
    ],
    [
      "non-boolean flag",
      { authenticated: "yes", csrf_token: GATEWAY_CSRF, user: { sub: "a", role: "admin" } },
      "返回登录",
    ],
    [
      "anonymous payload with identity",
      { authenticated: false, csrf_token: GATEWAY_CSRF, user: { sub: "a", role: "admin" } },
      "返回登录",
    ],
  ] as const) {
    test(`malformed session (${label}) keeps the guard and never renders the shell`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/sso/session", (route) => route.fulfill({ json: body }));
      await page.goto("/dashboard/");
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(page.getByRole("heading", { name: "运行概览" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: guard, exact: true })).toHaveAttribute(
        "href",
        "/sso/login?return_to=/dashboard/",
      );
      expect(errors).toEqual([]);
    });
  }
});

test("an unreachable session endpoint stays closed and retriable", async ({ page }) => {
  await page.route("**/sso/session", (route) => route.abort("failed"));
  await page.goto("/dashboard/");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "运行概览" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(0);
  // Recovery path is offered instead of a broken shell.
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(0);
});

test("non-admin role in a valid session is denied, not authenticated", async ({ page }) => {
  await page.route("**/sso/session", (route) =>
    route.fulfill({
      json: {
        authenticated: true,
        csrf_token: GATEWAY_CSRF,
        user: { sub: "test-user", role: "user" },
      },
    }),
  );
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "无管理权限" })).toBeVisible();
  await expect(page.getByRole("link", { name: /使用其他账号登录/ })).toBeVisible();
  expect(await page.getByRole("heading", { name: "运行概览" }).count()).toBe(0);
  await page.unroute("**/sso/session");
});

test("authenticated session is reused without a login redirect and survives reload", async ({
  page,
}) => {
  const session = await mockSession(page);
  await page.route("**/admin/dashboard", (route) => route.fulfill({ json: dashboardPayload }));
  await page.goto("/dashboard/logs");
  await expect(page).toHaveURL(/\/dashboard\/logs$/);
  await expect(page.getByRole("heading", { name: "日志审计" })).toBeVisible();
  expect(session.calls.filter((call) => call.path === "/sso/session").length).toBeGreaterThan(0);
  const before = session.calls.length;
  await page.reload();
  await expect(page.getByRole("heading", { name: "日志审计" })).toBeVisible();
  expect(session.calls.length).toBeGreaterThan(before);
  expect(session.calls.every((call) => call.path === "/sso/session" && call.method === "GET")).toBe(
    true,
  );
});
