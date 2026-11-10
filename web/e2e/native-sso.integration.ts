import { expect, test, type Page, type Request } from "@playwright/test";

// Native SSO, end to end, in a real browser.
//
// The fixture behind `playwright.native.config.ts` runs the shipped backend with
// `CODEBUDDY2API_SSO_ENABLED=true` against a synthetic OIDC provider on real
// ports. This spec therefore proves the parts a unit test cannot: the browser
// follows the authorization-code redirect, the console renders data from the
// live admin API, a CSRF-guarded write is accepted while an unguarded one is
// refused, and logging out really revokes the session.

type SessionPayload = {
  authenticated: boolean;
  csrf_token: string | null;
  user: { sub: string; role?: string; username?: string; name?: string } | null;
};

async function session(page: Page): Promise<{ status: number; body: SessionPayload }> {
  const response = await page.request.get("/sso/session");
  // 200 when signed in, 401 for the documented anonymous shape.
  expect([200, 401]).toContain(response.status());
  return { status: response.status(), body: (await response.json()) as SessionPayload };
}

async function signInThroughTheUi(page: Page) {
  await page.goto("/dashboard/");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  // The login page follows the gateway's public config: the key form appears
  // only when a panel key is configured for this fixture.
  const config = (await (await page.request.get("/sso/config")).json()) as {
    keyLoginEnabled?: boolean;
  };
  await expect(page.getByRole("link", { name: "使用统一身份登录" })).toHaveAttribute(
    "href",
    "/sso/login?return_to=/dashboard/",
  );
  expect(await page.getByLabel("API key", { exact: true }).count()).toBe(0);
  if (config.keyLoginEnabled === true)
    await expect(page.getByLabel("面板密钥", { exact: true })).toBeVisible();
  else expect(await page.locator('input[type="password"]').count()).toBe(0);

  await page.getByRole("link", { name: "使用统一身份登录" }).click();
  // Real redirect chain: /sso/login -> provider /authorize -> /sso/callback -> console.
  await page.waitForURL(/\/dashboard\/(?:$|\?)/, { timeout: 30000 });
}

test("real browser: click login, read live admin data, CSRF write, then logout", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const adminResponses: { url: string; status: number }[] = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/admin/")) adminResponses.push({ url: path, status: response.status() });
  });

  // ---- unauthenticated shell -------------------------------------------------
  await page.goto("/dashboard/");
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  const anonymousSession = await session(page);
  expect(anonymousSession.status).toBe(401);
  expect(anonymousSession.body.authenticated).toBe(false);
  expect(anonymousSession.body.csrf_token).toBeNull();
  expect(anonymousSession.body.user).toBeNull();
  expect((await page.request.get("/admin/session")).status()).toBe(401);

  // ---- click login, follow the real OIDC redirect ---------------------------
  await signInThroughTheUi(page);

  // ---- the console renders data from the live admin API ---------------------
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const signedIn = (await session(page)).body;
  expect(signedIn.authenticated).toBe(true);
  expect(signedIn.user?.role).toBe("admin");
  expect(signedIn.user?.sub).toBe("native-admin-1");
  expect(typeof signedIn.csrf_token).toBe("string");
  expect((signedIn.csrf_token as string).length).toBeGreaterThan(20);

  // The dashboard is fed by the real backend, not by a fixture payload.
  await expect
    .poll(() => adminResponses.filter((entry) => entry.url === "/admin/dashboard").length, {
      timeout: 20000,
    })
    .toBeGreaterThan(0);
  expect(adminResponses.every((entry) => entry.status < 500)).toBe(true);
  expect(adminResponses.find((entry) => entry.url === "/admin/dashboard")?.status).toBe(200);

  // Exercise the actual build documents through native static hosting. Backend
  // unit gates run before the web build in CI, so this verifies their combined
  // producer/route contract after the bundle exists.
  await expect(page.getByRole("link", { name: "开源声明" })).toHaveAttribute(
    "href",
    "/dashboard/THIRD_PARTY_NOTICES.txt",
  );
  await expect(page.getByRole("link", { name: "依赖许可" })).toHaveAttribute(
    "href",
    "/dashboard/THIRD_PARTY_LICENSES.txt",
  );
  for (const document of [
    "LICENSE.upstream.txt",
    "THIRD_PARTY_NOTICES.txt",
    "THIRD_PARTY_LICENSES.txt",
  ]) {
    const response = await page.request.get(`/dashboard/${document}`);
    expect(response.status(), document).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    expect((await response.text()).length).toBeGreaterThan(40);
  }

  // ---- a real management read through the browser ---------------------------
  const settings = await page.request.get("/admin/settings");
  expect(settings.status()).toBe(200);
  const revision = (await settings.json()).revision as number;

  // ---- CSRF-guarded write, issued by the page itself ------------------------
  // `page.evaluate` runs inside the console origin, so the browser attaches the
  // real `Origin`/`sec-fetch-site` headers this contract is built around.
  const write = await page.evaluate(
    async ({ csrf, revision }) => {
      const response = await fetch("/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify({ revision, values: { max_images: 16 } }),
      });
      return { status: response.status, body: await response.text() };
    },
    { csrf: signedIn.csrf_token as string, revision },
  );
  expect(write.status, write.body).toBe(200);

  const withoutCsrf = await page.evaluate(
    async ({ revision }) => {
      const response = await fetch("/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ revision, values: { max_images: 20 } }),
      });
      return { status: response.status, body: await response.text() };
    },
    { revision },
  );
  expect(withoutCsrf.status).toBe(403);
  // The browser *did* present the trusted Origin; only the CSRF token was absent,
  // so the write is refused for the precise reason.
  expect(withoutCsrf.body).toContain("csrf_denied");

  // ---- the CSRF-gated GET works from a real browser -------------------------
  // Browsers do not attach `Origin` to a same-origin GET; the contract accepts a
  // matching same-origin Referer, so this must not be a 403.
  let pollRequest: Request | undefined;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/admin/oauth/poll") pollRequest = request;
  });
  const poll = await page.evaluate(async (csrf) => {
    const response = await fetch("/admin/oauth/poll?login_id=not-a-task", {
      headers: { "X-CSRF-Token": csrf },
    });
    return { status: response.status, body: await response.text() };
  }, signedIn.csrf_token as string);
  expect(poll.status, poll.body).toBe(404); // CSRF accepted, task unknown
  if (pollRequest) {
    const headers = pollRequest.headers();
    // Documenting the real browser behaviour this contract has to tolerate.
    expect(headers["x-csrf-token"]).toBe(signedIn.csrf_token);
    expect(headers["sec-fetch-site"] ?? "same-origin").toBe("same-origin");
  }

  // ---- logout revokes the session ------------------------------------------
  await page.getByRole("button", { name: "账号菜单" }).click();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  expect((await page.request.get("/sso/session")).status()).toBe(401);
  expect((await page.request.get("/admin/settings")).status()).toBe(401);

  // Reloading the console cannot resurrect the session.
  await page.reload();
  await expect(page).toHaveURL(/\/dashboard\/login$/);
  expect(await page.getByRole("heading", { name: "运行概览" }).count()).toBe(0);
  expect(errors).toEqual([]);
});

test("real browser: an unauthenticated visitor never reaches an admin view", async ({ page }) => {
  for (const path of [
    "/dashboard/",
    "/dashboard/settings",
    "/dashboard/storage",
    "/dashboard/keys",
    "/dashboard/media",
    "/dashboard/updates",
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/dashboard\/login$/);
    await expect(page.getByRole("heading", { name: "运行概览" })).toHaveCount(0);
  }
  expect((await page.request.get("/admin/dashboard")).status()).toBe(401);
  expect((await page.request.get("/admin/models")).status()).toBe(401);
  for (const path of ["/admin/keys", "/admin/media", "/admin/update"])
    expect((await page.request.get(path)).status(), path).toBe(401);
  expect(
    (
      await page.request.post("/admin/session", { data: { api_key: "native-fixture-key" } })
    ).status(),
  ).toBe(405);
  expect((await page.request.get("/v1/models")).status()).toBe(401);
});
