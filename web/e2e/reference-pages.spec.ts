import { expect, test, type Page } from "@playwright/test";
import { mockDashboard, mockSettings } from "./mock";
import { mockSession } from "./sso";

const pages = [
  ["", "运行概览", "AT A GLANCE"],
  ["credentials", "凭证管理", "ACCOUNT POOL"],
  ["models", "模型路由", "MODEL CATALOG"],
  ["media", "媒体生成", "MEDIA WORKSPACE"],
  ["keys", "密钥管理", "API ACCESS"],
  ["logs", "日志审计", "REQUESTS & AUDIT"],
  ["storage", "存储管理", "DATA & STORAGE"],
  ["settings", "系统设置", "GATEWAY SETTINGS"],
  ["updates", "版本更新", "RELEASES & UPDATES"],
] as const;

// Stable, synthetic read responses let screenshots cover populated business
// surfaces without using a production account or changing any gateway data.
async function fixture(page: Page) {
  await mockSession(page);
  const unexpected: string[] = [];
  const credential = {
    id: "reference-account",
    name: "reference-account.info",
    nickname: "隔离测试账号",
    enabled: true,
    profile: "cn-cli",
    health: "ready",
    catalog_ready: true,
    cooldowns: [],
    credits: { remaining: 250 },
  };
  const model = {
    id: "reference-model",
    public_id: "reference-model",
    enabled: true,
    keep_original: true,
    region: null,
    profile: null,
    credential_ids: [],
    credits: 0,
    credits_by_profile: { "cn-cli": 0 },
  };
  const bucket = Date.UTC(2026, 10, 1) / 1000;
  const summary = {
    requests: 126,
    success: 123,
    error: 3,
    success_rate: 123 / 126,
    total_tokens: 45678,
    input_tokens: 35678,
    output_tokens: 10000,
    cache_read_tokens: 8000,
    cache_write_tokens: 1000,
    credit: 1.5,
  };
  const responses: Record<string, unknown> = {
    "/admin/dashboard": {
      ...mockDashboard,
      summary,
      series: Array.from({ length: 7 }, (_, index) => ({
        bucket: bucket + index * 86400,
        date: `2026-11-0${index + 1}`,
        requests: 18,
        success: index < 3 ? 17 : 18,
        error: index < 3 ? 1 : 0,
        total_tokens: 6525,
        credit: 0.2,
      })),
      models: [{ model: model.id, ...summary }],
      profiles: [{ profile: "cn-cli", requests: 126 }],
      health: { credentials: [credential] },
      range: { days: 7, granularity: "day", timezone: "UTC", partial: false },
      generated_at: bucket + 6 * 86400,
    },
    "/admin/credentials": { credentials: [credential] },
    "/admin/growth-jobs": { jobs: [] },
    "/admin/models": { revision: 1, models: [model] },
    "/admin/models/output-probes": { probes: {} },
    "/admin/models/rate-probe": {
      key: "rate-probe",
      status: "idle",
      total: 0,
      completed: 0,
      current: [],
      results: [],
    },
    "/admin/models/scan": {
      status: "idle",
      total: 0,
      completed: 0,
      success: 0,
      failed: 0,
      differences: 0,
      profiles: {},
      accounts: [],
    },
    "/admin/keys": {
      external: null,
      items: [
        {
          id: "reference-key",
          name: "隔离测试密钥",
          type: "standard",
          version: 1,
          prefix: "sk-test",
          enabled: true,
          created_at: bucket,
        },
      ],
    },
    "/admin/logs": {
      items: [
        {
          id: "reference-request",
          started_at: bucket,
          model: model.id,
          profile: "cn-cli",
          outcome: "success",
          status_code: 200,
          duration_ms: 1520,
          total_tokens: 420,
          credit: 0,
        },
      ],
      has_more: false,
      next_cursor: null,
    },
    "/admin/auth/settings": {
      ssoEnabled: false,
      keyLoginEnabled: true,
      issuer: "",
      clientId: "",
      hasClientSecret: false,
      scope: "openid profile email",
      providerName: "",
      allowedSubjects: [],
      allowedEmails: [],
      callbackUrl: "https://console.example.com/sso/callback",
    },
    "/admin/settings": {
      ...mockSettings,
      items: [
        {
          key: "port",
          label: "监听端口",
          type: "integer",
          value: 8787,
          stored: null,
          source: "cli",
          mode: "restart",
          locked: true,
        },
      ],
    },
    "/admin/storage": {
      ...mockDashboard.storage,
      reclaimable_bytes: 0,
      request_count: 126,
      event_count: 5,
      retention_days: 30,
      pending_cleanup: false,
      freelist_pages: 0,
      page_count: 8,
      archives: [],
      backups: [],
    },
    "/admin/media": {
      configured: true,
      base_url: "https://media.example.invalid",
      available: true,
      locked: false,
      limit_bytes: 1073741824,
      ttl_hours: 72,
      usage: {
        total_bytes: 4096,
        images: { count: 0, bytes: 0 },
        videos: { count: 1, bytes: 4096 },
      },
      tasks: { active: 0, failed: 0 },
    },
    "/admin/media/assets": {
      items: [
        {
          id: "reference-video",
          kind: "video",
          mime: "video/mp4",
          size: 4096,
          model: "reference-video-model",
          created_at: bucket,
          expires_at: 4102444800,
        },
      ],
      has_more: false,
      next_cursor: null,
    },
    "/admin/media/tasks": { items: [], has_more: false, next_cursor: null },
    "/admin/update": {
      current: "1.5.4",
      repository: "https://github.com/azurekiln2333/codebuddy2api",
      deployment: "git",
      self_update: { available: false, reason: "隔离测试" },
      checked_at: bucket,
      latest: "1.5.4",
      update_available: false,
      releases: [
        {
          tag: "v1.5.4",
          version: "1.5.4",
          name: "v1.5.4",
          notes: "隔离测试版本说明。",
          published_at: "2026-11-01T00:00:00Z",
          installable: false,
        },
      ],
      job: { status: "idle" },
      mirrors: [],
    },
  };
  await page.route("**/admin/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path in responses)
      return route.fulfill({ json: responses[path] });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 500, json: { error: { message: "未模拟的测试请求" } } });
  });
  return unexpected;
}

for (const size of ["desktop", "mobile"] as const) {
  for (const theme of ["light", "dark"] as const) {
    test(`all console pages retain the reference shell on ${size} in ${theme}`, async ({
      page,
    }) => {
      const viewport =
        size === "desktop" ? { width: 1440, height: 1050 } : { width: 375, height: 812 };
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const unexpected = await fixture(page);
      await page.goto("/dashboard/");
      const workspace = page.locator("main").locator("..");
      for (const [path, title, eyebrow] of pages) {
        if (path) {
          // Every transition starts from a scrolled page, so this catches a
          // shared scroll container retaining the previous page's position.
          await workspace.evaluate((node) => {
            node.scrollTop = node.scrollHeight;
          });
          if (path === "credentials")
            expect(await workspace.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
          if (size === "mobile")
            await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
          await page
            .getByRole("navigation", { name: "主导航", exact: true })
            .locator(`a[href='/dashboard/${path}']`)
            .click();
        }
        await expect(
          page.getByRole("heading", { name: title, level: 1, exact: true }),
        ).toBeVisible();
        await expect(page.getByText(eyebrow, { exact: true })).toBeVisible();
        await expect(page.getByRole("status").filter({ hasText: "加载中…" })).toHaveCount(0);
        await page.evaluate(() => document.fonts.ready);
        await expect.poll(() => workspace.evaluate((node) => node.scrollTop)).toBe(0);
        await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
        const geometry = await workspace.evaluate((node) => ({
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          contentWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          headerTop: document.querySelector("header")!.getBoundingClientRect().top,
          overflow: getComputedStyle(node).overflowY,
        }));
        expect(geometry.documentWidth, `${path}: no outer horizontal overflow`).toBe(
          viewport.width,
        );
        expect(geometry.documentHeight, `${path}: only the workspace scrolls`).toBe(
          viewport.height,
        );
        expect(
          geometry.contentWidth,
          `${path}: tables contain their own horizontal scroll`,
        ).toBeLessThanOrEqual(geometry.clientWidth);
        expect(geometry.headerTop).toBe(0);
        expect(geometry.overflow).toBe("auto");
        if (path === "media") {
          const retention = page.getByText("保留 72 小时", { exact: true });
          const box = await retention.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.width, "retention copy must not inherit the 24px icon slot").toBeGreaterThan(
            60,
          );
          expect(box!.height).toBeLessThan(35);
        }
        if (path === "keys") {
          const name = page.getByRole("cell", { name: "隔离测试密钥", exact: true });
          expect((await name.boundingBox())!.width).toBeGreaterThanOrEqual(120);
        }
        await page.screenshot({
          path: `test-results/reference-${path || "overview"}-${size}-${theme}.png`,
          animations: "disabled",
        });
      }
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}
