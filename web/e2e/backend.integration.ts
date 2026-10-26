import { test, expect, type Page } from "@playwright/test";

// The real gateway fixture owns identity, so this spec signs in through the SSO
// contract and then drives the preserved `/admin/*` workflow with the gateway
// CSRF token. The browser never holds the original administrative API key.
async function signIn(page: Page) {
  const response = await page.request.get("/sso/session");
  expect(response.status()).toBe(200);
  const session = await response.json();
  expect(session.authenticated).toBe(true);
  expect(typeof session.csrf_token).toBe("string");
  expect(session.user.role).toBe("admin");
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  return { csrf: session.csrf_token as string, sub: session.user.sub as string };
}

function writeHeaders(csrf: string) {
  return {
    Origin: new URL(process.env.AZUREKILN_INTEGRATION_URL!).origin,
    "X-CSRF-Token": csrf,
  };
}

test("real management API: session, model alias, audit, clear, and file credentials", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard\/$/);
  const { csrf } = await signIn(page);
  await expect(page.getByText("125", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "模型路由" }).click();
  await page.getByRole("button", { name: "编辑规则" }).click();
  await page.getByLabel("对外 ID").fill("garden-fixture");
  await page.getByRole("button", { name: "保存规则" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const denied = await page.request.post("/v1/chat/completions", {
    data: { model: "garden-fixture", messages: [{ role: "user", content: "synthetic" }] },
  });
  expect(denied.status()).toBe(401);
  const generated = await page.request.post("/v1/chat/completions", {
    headers: { Authorization: "Bearer synthetic-e2e-key" },
    data: {
      model: "garden-fixture",
      stream: false,
      messages: [{ role: "user", content: "synthetic" }],
    },
  });
  expect(generated.status()).toBe(200);
  expect((await generated.json()).model).toBe("garden-fixture");
  await page.getByRole("button", { name: "新增模型" }).click();
  await page.getByLabel("对外 ID").fill("mapped-fixture");
  await page.getByLabel("上游 ID").fill("fixture-model");
  await page.getByRole("radio", { name: /指定账号/ }).check();
  await page.getByRole("checkbox", { name: /fixture.info/ }).check();
  await page.getByRole("button", { name: "创建模型" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const mapped = await page.request.post("/v1/chat/completions", {
    headers: { Authorization: "Bearer synthetic-e2e-key" },
    data: {
      model: "mapped-fixture",
      stream: false,
      messages: [{ role: "user", content: "synthetic mapping" }],
    },
  });
  expect(mapped.status()).toBe(200);
  expect((await mapped.json()).model).toBe("mapped-fixture");
  const credentials = (await (await page.request.get("/admin/credentials")).json()).credentials;
  expect(credentials[0].bindings).toContain("mapped-fixture");
  await page.getByRole("link", { name: "日志审计" }).click();
  await expect(page.getByText("garden-fixture", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "test-results/backend-real-audit.png", fullPage: true });
  const summaryBefore = await (await page.request.get("/admin/dashboard?days=1")).json();
  const cleared = await page.request.post("/admin/logs/clear", {
    headers: writeHeaders(csrf),
    data: { scope: "details" },
  });
  expect(cleared.status()).toBe(200);
  const summaryAfter = await (await page.request.get("/admin/dashboard?days=1")).json();
  expect(summaryAfter.summary.requests).toBe(summaryBefore.summary.requests);
  expect(summaryAfter.summary.credit).toBe(0);
  expect((await (await page.request.get("/admin/credentials")).json()).credentials).toHaveLength(1);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeVisible();
  await expect(page.getByText("125", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/backend-real-dashboard.png", fullPage: true });
  await page.goto("/dashboard/credentials");
  await expect(page.getByText("fixture.info", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: /^125(?:\s|$)/ })).toBeVisible();
  await page.screenshot({ path: "test-results/backend-real-credentials.png", fullPage: true });
  expect((await page.request.get("/v1/missing")).status()).toBe(404);
  expect((await page.request.get("/admin/missing")).status()).toBe(404);
  expect(errors).toEqual([]);
});

test("manual trial uses the real admin API and persists success and failed-attempt backoff", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { csrf } = await signIn(page);
  const settings = await (await page.request.get("/admin/settings")).json();
  expect(settings.items.some((item: { key: string }) => item.key === "auto_trial")).toBe(false);
  for (const uid of ["trial-timeout", "trial-success"]) {
    const response = await page.request.post("/admin/credentials/upload", {
      headers: writeHeaders(csrf),
      data: {
        files: [
          {
            name: `${uid}.info`,
            content: JSON.stringify({
              account: { uid, nickname: uid },
              auth: {
                domain: "www.workbuddy.ai",
                accessToken: "synthetic-only-access",
                refreshToken: "synthetic-only-refresh",
                expiresAt: Date.now() + 86400000,
              },
            }),
          },
        ],
        replace: false,
      },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).results[0].ok).toBe(true);
  }
  await page.goto("/dashboard/credentials");
  await page.getByRole("button", { name: "更多 trial-timeout.info" }).click();
  await page.getByRole("button", { name: "领取体验积分 trial-timeout.info" }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("button", { name: "确认领取" })).toBeEnabled();
  await drawer.getByRole("button", { name: "确认领取" }).click();
  await expect(drawer.getByRole("alert")).toContainText("领取请求超时");
  await expect(drawer.getByRole("button", { name: "确认领取" })).toBeDisabled();
  await page.screenshot({ path: "test-results/manual-trial-timeout.png", fullPage: true });
  await drawer.getByRole("button", { name: "刷新领取状态" }).click();
  await expect(drawer.getByRole("button", { name: "确认领取" })).toBeDisabled();
  await drawer.getByRole("button", { name: "关闭抽屉" }).click();
  await expect(drawer).toHaveCount(0);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "更多 trial-success.info" }).click();
  await page.getByRole("button", { name: "领取体验积分 trial-success.info" }).click();
  await drawer.getByRole("button", { name: "确认领取" }).click();
  await expect(drawer.getByText("已领取", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "确认领取" })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/manual-trial-success-mobile.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "更多 trial-success.info" }).click();
  await page.getByRole("button", { name: "领取体验积分 trial-success.info" }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "确认领取" })).toBeDisabled();
  const rows = (await (await page.request.get("/admin/credentials")).json()).credentials;
  expect(rows.find((row: { name: string }) => row.name === "trial-success.info").trial.state).toBe(
    "claimed",
  );
  expect(
    rows.find((row: { name: string }) => row.name === "trial-timeout.info").trial.can_claim,
  ).toBe(false);
  expect(errors).toEqual([]);
});
