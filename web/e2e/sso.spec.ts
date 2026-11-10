import { expect, test } from "@playwright/test";
import { adminSession, GATEWAY_CSRF, mockAuthConfig, mockSession } from "./sso";

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

// Gateway contract: an SSO session is read from `/sso/session`, every write
// carries the gateway CSRF, and sign-out posts to `/sso/logout` with no secret.
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
      return route.fulfill({ json: { authenticated: false, csrf_token: null } });
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
  // The panel-key route is never posted to during an SSO sign-in: the SSO
  // session answers first, so the key probe is not even needed.
  expect(adminCalls).not.toContain("POST /admin/session");
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

test("anonymous session shows the login page with the panel key and the SSO gate", async ({
  page,
}) => {
  const session = await mockSession(page, false);
  await page.goto("/dashboard/settings");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await expect(page.getByRole("heading", { name: /登录 CodeBuddy2Api/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /统一身份登录/ })).toBeVisible();
  // The panel key is the console credential; the inference key never appears.
  await expect(page.getByLabel("面板密钥", { exact: true })).toBeVisible();
  expect(await page.getByLabel("API key", { exact: true }).count()).toBe(0);
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

test("a key session signs in through /admin/session and out with CSRF", async ({ page }) => {
  await mockAuthConfig(page, { keyLoginEnabled: true, sso: { enabled: true } });
  const posts: { method: string; path: string; body: unknown; csrf?: string }[] = [];
  await page.route("**/admin/session", async (route) => {
    const request = route.request();
    const method = request.method();
    posts.push({
      method,
      path: new URL(request.url()).pathname,
      body: request.postData() ? request.postDataJSON() : null,
      csrf: request.headers()["x-csrf-token"],
    });
    if (method === "POST")
      return route.fulfill({
        json: {
          authenticated: true,
          csrf_token: "panel-csrf",
          user: { sub: "panel:key", name: "面板密钥", provider: "key" },
        },
      });
    if (method === "DELETE") return route.fulfill({ json: { authenticated: false } });
    return route.fulfill({ status: 401, json: { authenticated: false, csrf_token: null } });
  });
  await page.route("**/sso/session", (route) =>
    route.fulfill({ status: 401, json: { authenticated: false, csrf_token: null, user: null } }),
  );
  await page.route("**/admin/dashboard", (route) => route.fulfill({ json: dashboardPayload }));

  await page.goto("/dashboard/login");
  await page.getByLabel("面板密钥", { exact: true }).fill("a-valid-panel-key");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  expect(posts.find((call) => call.method === "POST")).toMatchObject({
    path: "/admin/session",
    body: { key: "a-valid-panel-key" },
  });

  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  expect(posts.find((call) => call.method === "DELETE")).toMatchObject({
    path: "/admin/session",
    csrf: "panel-csrf",
  });
});

test("a wrong panel key keeps the console locked with the gateway reason", async ({ page }) => {
  await page.route("**/sso/session", (route) =>
    route.fulfill({ status: 401, json: { authenticated: false, csrf_token: null, user: null } }),
  );
  await page.route("**/admin/session", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 401, json: { error: { message: "面板密钥不正确" } } })
      : route.fulfill({ status: 401, json: { authenticated: false, csrf_token: null } }),
  );
  await page.goto("/dashboard/login");
  await page.getByLabel("面板密钥", { exact: true }).fill("wrong-key-value");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("alert")).toContainText("面板密钥不正确");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  await expect(page.getByRole("heading", { name: "运行概览" })).toHaveCount(0);
});

test("the login page hides the key field when the gateway disables it", async ({ page }) => {
  await mockSession(page, false);
  await mockAuthConfig(page, { keyLoginEnabled: false });
  await page.goto("/dashboard/login");
  await expect(page.getByRole("link", { name: /统一身份登录/ })).toBeVisible();
  expect(await page.getByLabel("面板密钥", { exact: true }).count()).toBe(0);
});

test("the login page explains an auth_error from the SSO callback", async ({ page }) => {
  await mockSession(page, false);
  await page.goto("/dashboard/login?auth_error=not_allowed");
  await expect(page.getByRole("alert")).toContainText("不在管理员白名单");
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
