import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mockSession } from "./sso";

// Layout acceptance for the AzureKiln shell at real browser sizes.
// Regression: the old screenshots (dashboard-desktop.png / appearance-dark.png)
// showed the 1048px sidebar overlapping the main column because the sidebar width
// and the workspace margin both animated. Root removed those transitions; the
// geometry below must hold with no transition in flight and no arbitrary waits.
const SIDEBAR = 208;
const MOBILE_WIDTH = 375;
const DESKTOP = { width: 1440, height: 1050 } as const;

type Rect = { x: number; right: number; width: number };
type Rects = {
  viewport: { width: number; height: number };
  theme: string;
  aside: Rect;
  workspace: Rect;
  main: Rect & { top: number; bottom: number };
  header: Rect & { top: number; bottom: number };
  title: Rect & { top: number; height: number };
  heading: Rect & { height: number };
  hit: { tag: string; className: string; insideTitle: boolean };
  document: { scrollWidth: number };
};

const dashboardPayload = {
  summary: { requests: 126, success_rate: 0.98, total_tokens: 45678, credit: 0 },
  series: [
    { date: "2026-10-01", bucket: 1790812800, requests: 126, success: 126, error: 0 },
    { date: "2026-10-02", bucket: 1790899200, requests: 96, success: 96, error: 0 },
  ],
  models: [{ model: "mock-model", requests: 126, total_tokens: 45678, credit: 0 }],
  profiles: [{ profile: "cn-cli", requests: 126 }],
  health: { credentials: [] },
  storage: {
    degraded: false,
    logical_bytes: 1024,
    max_bytes: 268435456,
    db_bytes: 32768,
    wal_bytes: 4096,
    shm_bytes: 32768,
  },
  range: { days: 7, granularity: "day" },
  generated_at: 1790812800,
};

// Mocked dashboard fixture; the session contract comes from the shared helper.
async function dashboardAPI(page: Page) {
  await mockSession(page);
  await page.route("**/admin/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("/admin/dashboard") ? dashboardPayload : {},
    }),
  );
}

// Measures the shell and, crucially, what the browser actually paints at the
// heading's centre. `h1` is a 1x1px screen-reader-only element, so the hit test
// target is its visible page-title container.
async function measure(page: Page): Promise<Rects> {
  return page.evaluate(() => {
    const round = (value: number) => Math.round(value * 100) / 100;
    const box = (node: Element) => {
      const r = node.getBoundingClientRect();
      return { x: round(r.x), right: round(r.right), width: round(r.width) };
    };
    const aside = document.querySelector("aside")!;
    const main = document.querySelector("main")!;
    const header = document.querySelector("header")!;
    const heading = document.querySelector("h1")!;
    const title = heading.parentElement!.closest("[class]")!;
    const mainRect = main.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const target = document.elementFromPoint(
      titleRect.x + titleRect.width / 2,
      titleRect.y + titleRect.height / 2,
    );
    return {
      viewport: { width: innerWidth, height: innerHeight },
      theme: document.documentElement.dataset.theme ?? "",
      aside: box(aside),
      workspace: box(main.parentElement!),
      main: { ...box(main), top: round(mainRect.top), bottom: round(mainRect.bottom) },
      header: {
        ...box(header),
        top: round(header.getBoundingClientRect().top),
        bottom: round(header.getBoundingClientRect().bottom),
      },
      title: { ...box(title), top: round(titleRect.top), height: round(titleRect.height) },
      heading: { ...box(heading), height: round(heading.getBoundingClientRect().height) },
      hit: {
        tag: target?.tagName ?? "",
        className: typeof target?.className === "string" ? target.className : "",
        insideTitle: !!target && title.contains(target),
      },
      document: { scrollWidth: document.documentElement.scrollWidth },
    };
  });
}

async function writeRects(testInfo: TestInfo, name: string, rects: Rects) {
  // Persist the measured geometry next to the screenshot and as a report attachment.
  const body = JSON.stringify(rects, null, 2);
  await writeFile(testInfo.outputPath(`${name}.rects.json`), body, "utf8");
  await testInfo.attach(`${name}.rects.json`, { body, contentType: "application/json" });
  console.log(`${name} rects: ${JSON.stringify(rects)}`);
}

// Exact geometry assertions, run before any screenshot is taken.
async function expectNoOverlap(rects: Rects, label: string) {
  expect(rects.aside.width, `${label}: sidebar width`).toBe(SIDEBAR);
  expect(rects.aside.x, `${label}: sidebar left`).toBe(0);
  expect(rects.main.x, `${label}: main starts after the sidebar`).toBeGreaterThanOrEqual(SIDEBAR);
  expect(rects.workspace.x, `${label}: workspace clears the sidebar`).toBeGreaterThanOrEqual(
    SIDEBAR,
  );
  expect(rects.title.x, `${label}: page title starts right of the sidebar`).toBeGreaterThan(
    rects.aside.right,
  );
  expect(rects.heading.x, `${label}: heading starts right of the sidebar`).toBeGreaterThan(
    rects.aside.right,
  );
  // The painted element at the heading centre must be the title block or a
  // descendant: anything else means the sidebar (or a sibling) covers the page.
  expect(
    rects.hit.insideTitle,
    `${label}: heading centre is unobstructed (hit ${rects.hit.tag}.${rects.hit.className})`,
  ).toBe(true);
  expect(rects.title.top, `${label}: title sits below the header`).toBeGreaterThanOrEqual(
    rects.header.bottom,
  );
}

test("1440x1050 light layout keeps the 208px sidebar clear of the main column", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light" });
  await dashboardAPI(page);
  await page.goto("/dashboard/");
  const heading = page.getByRole("heading", { name: "运行概览" });
  await expect(heading).toBeAttached();
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const rects = await measure(page);
  await expectNoOverlap(rects, "light 1440x1050");
  expect(rects.viewport).toEqual({ width: 1440, height: 1050 });
  expect(rects.document.scrollWidth).toBeLessThanOrEqual(1440);
  expect(rects.header.x).toBeGreaterThanOrEqual(SIDEBAR);
  expect(errors).toEqual([]);

  await writeRects(testInfo, "azurekiln-1440-light", rects);
  await page.screenshot({ path: "test-results/azurekiln-1440-light.png", fullPage: true });
});

test("1440x1050 dark layout keeps the 208px sidebar clear of the main column", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "dark" });
  await dashboardAPI(page);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeAttached();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  const rects = await measure(page);
  await expectNoOverlap(rects, "dark 1440x1050");
  expect(rects.viewport).toEqual({ width: 1440, height: 1050 });
  expect(rects.document.scrollWidth).toBeLessThanOrEqual(1440);
  expect(errors).toEqual([]);

  await writeRects(testInfo, "azurekiln-1440-dark", rects);
  await page.screenshot({ path: "test-results/azurekiln-1440-dark.png", fullPage: true });
});

test("375px mobile layout stays contained with no horizontal overflow", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 812 });
  await page.emulateMedia({ colorScheme: "light" });
  await dashboardAPI(page);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { name: "运行概览" })).toBeAttached();

  const rects = await measure(page);
  // No fixed sidebar overlap on phones: the shell is a single column.
  expect(rects.viewport.width).toBe(MOBILE_WIDTH);
  expect(rects.document.scrollWidth, "mobile: no horizontal overflow").toBeLessThanOrEqual(
    MOBILE_WIDTH,
  );
  expect(rects.hit.insideTitle, "mobile: heading centre is unobstructed").toBe(true);
  expect(rects.main.width).toBeLessThanOrEqual(MOBILE_WIDTH);
  expect(rects.title.x).toBeGreaterThanOrEqual(0);
  expect(rects.title.right).toBeLessThanOrEqual(MOBILE_WIDTH);
  expect(errors).toEqual([]);

  await writeRects(testInfo, "azurekiln-375-light", rects);
  await page.screenshot({ path: "test-results/azurekiln-375-light.png", fullPage: true });
});
