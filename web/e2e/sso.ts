import { expect, type Page, type Route } from "@playwright/test";

// Isolated browser fixture for the gateway SSO session contract. The gateway
// owns `/sso/*`; the browser probes `/admin/session` only to discover an existing
// panel-key session and never holds an administrative secret.
export const GATEWAY_CSRF = "mock-csrf";
export const sessionUser = { sub: "test-admin", role: "admin" as const };
export const adminSession = {
  authenticated: true,
  csrf_token: GATEWAY_CSRF,
  user: sessionUser,
};
// The public login-page contract (design D2.1). Both methods on by default so a
// test that only cares about the shell still gets a usable login page.
export type AuthConfig = {
  keyLoginEnabled: boolean;
  sso: { enabled: boolean; providerName: string; loginUrl: string };
};
export const defaultAuthConfig: AuthConfig = {
  keyLoginEnabled: true,
  sso: { enabled: true, providerName: "SSO", loginUrl: "/sso/login" },
};
export async function mockAuthConfig(
  page: Page,
  config: { keyLoginEnabled?: boolean; sso?: Partial<AuthConfig["sso"]> } = {},
) {
  const body = {
    keyLoginEnabled: config.keyLoginEnabled ?? defaultAuthConfig.keyLoginEnabled,
    sso: { ...defaultAuthConfig.sso, ...(config.sso ?? {}) },
  };
  await page.route("**/sso/config", (route: Route) => route.fulfill({ json: body }));
  return body;
}

export type MockSession = {
  authenticated: boolean;
  /** Session GET failures (transport error, 401, 403, malformed body). */
  failure?: number | "network";
  calls: { method: string; path: string; body: unknown; csrf: string | undefined }[];
  sets: (value: boolean) => void;
};

// Intercepts only the `/sso/session` and `/sso/logout` contract. Leaving the
// remaining `/sso/*` traffic (sign-in redirect, callback) to the page keeps the
// browser navigation assertions real.
export async function mockSession(page: Page, authenticated = true): Promise<MockSession> {
  const calls: MockSession["calls"] = [];
  let isAuthenticated = authenticated;
  // Registered first, so a later mockAuthConfig in the test wins (routes are LIFO).
  await mockAuthConfig(page);
  await page.route("**/sso/session", async (route: Route) => {
    const request = route.request();
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postData() ? request.postDataJSON() : null,
      csrf: request.headers()["x-csrf-token"],
    });
    if (mock.failure === "network") return route.abort("failed");
    if (typeof mock.failure === "number") return route.fulfill({ status: mock.failure, json: {} });
    return isAuthenticated
      ? route.fulfill({ json: adminSession })
      : route.fulfill({
          json: { authenticated: false, csrf_token: null, user: null },
        });
  });
  await page.route("**/sso/logout", async (route: Route) => {
    const request = route.request();
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postData() ? request.postDataJSON() : null,
      csrf: request.headers()["x-csrf-token"],
    });
    if (request.method() !== "POST")
      return route.fulfill({ status: 405, json: { error: { message: "仅支持 POST 退出" } } });
    if (request.headers()["x-csrf-token"] !== GATEWAY_CSRF)
      return route.fulfill({ status: 403, json: { error: { message: "CSRF 校验失败" } } });
    isAuthenticated = false;
    return route.fulfill({ json: { ok: true } });
  });
  const mock: MockSession = {
    get authenticated() {
      return isAuthenticated;
    },
    calls,
    sets: (value: boolean) => {
      isAuthenticated = value;
    },
  };
  return mock;
}

export function sessionCalls(mock: MockSession) {
  return mock.calls;
}

// Shared assertion for every write issued by the migrated browser clients: the
// gateway CSRF travels in X-CSRF-Token and the original admin API key never does.
export async function expectAdminWrite(
  route: Route,
  expected: string = GATEWAY_CSRF,
): Promise<void> {
  const headers = route.request().headers();
  expect(headers["x-csrf-token"]).toBe(expected);
  expect(JSON.stringify(headers)).not.toContain("api_key");
  expect(JSON.stringify(headers)).not.toContain("api-key");
  expect(route.request().postData() ?? "").not.toContain("api_key");
  await route.fallback();
}
