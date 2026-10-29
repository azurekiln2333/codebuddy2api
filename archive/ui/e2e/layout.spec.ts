import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mockSession } from "./sso";

// Exercise the browser's painted layout, not only declared CSS dimensions.
// Previously a sidebar covered the page while its computed width looked valid.
const SIDEBAR = 208;
const COLLAPSED_SIDEBAR = 44;
const HEADER_HEIGHT = 48;
const PANEL_INSET = 8;
const MOBILE_WIDTH = 375;
const DESKTOP = { width: 1440, height: 1050 } as const;

type Rect = {
  x: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};
type Rects = {
  viewport: { width: number; height: number; clientWidth: number };
  theme: string;
  aside: Rect | null;
  main: Rect;
  header: Rect;
  heading: Rect;
  hit: { tag: string; className: string; insideHeading: boolean };
  document: { scrollWidth: number };
};

// Seven complete daily buckets match the requested seven-day range. Two
// timestamped rows are not a valid seven-day fixture for the trend's domain.
const dailySeries = [
  { requests: 10, success: 10, total_tokens: 3500 },
  { requests: 14, success: 14, total_tokens: 4700 },
  { requests: 16, success: 15, total_tokens: 5900 },
  { requests: 22, success: 22, total_tokens: 8000 },
  { requests: 18, success: 17, total_tokens: 6400 },
  { requests: 24, success: 24, total_tokens: 8700 },
  { requests: 22, success: 21, total_tokens: 8478 },
].map((row, index) => {
  const bucket = Date.UTC(2026, 9, index + 1) / 1000;
  return {
    ...row,
    bucket,
    date: new Date(bucket * 1000).toISOString().slice(0, 10),
    error: row.requests - row.success,
    credit: 0,
  };
});
const hourlySeries = dailySeries.flatMap((row) =>
  Array.from({ length: 24 }, (_, hour) => {
    const bucket = row.bucket + hour * 3600;
    return {
      bucket,
      date: new Date(bucket * 1000).toISOString().slice(0, 16).replace("T", " "),
      requests: hour === 9 ? row.requests : 0,
      success: hour === 9 ? row.success : 0,
      error: hour === 9 ? row.error : 0,
      total_tokens: hour === 9 ? row.total_tokens : 0,
      credit: 0,
    };
  }),
);
const dashboardPayload = {
  summary: { requests: 126, success_rate: 123 / 126, total_tokens: 45678, credit: 0 },
  series: dailySeries,
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
  range: { days: 7, granularity: "day", timezone: "UTC", partial: false },
  generated_at: Date.UTC(2026, 9, 7, 23) / 1000,
};

// Session and administration responses are browser fixtures only.
async function dashboardAPI(page: Page) {
  await mockSession(page);
  await page.route("**/admin/**", (route) => {
    const url = new URL(route.request().url());
    const hourly = url.searchParams.get("granularity") === "hour";
    if (url.pathname === "/admin/models")
      return route.fulfill({ json: { revision: 1, models: [] } });
    if (url.pathname === "/admin/credentials") return route.fulfill({ json: { credentials: [] } });
    if (url.pathname === "/admin/logs")
      return route.fulfill({ json: { items: [], has_more: false, next_cursor: null } });
    return route.fulfill({
      json:
        url.pathname === "/admin/dashboard"
          ? {
              ...dashboardPayload,
              series: hourly ? hourlySeries : dailySeries,
              range: { ...dashboardPayload.range, granularity: hourly ? "hour" : "day" },
            }
          : {},
    });
  });
}

async function measure(page: Page): Promise<Rects> {
  // The sidebar animates its width, so settle running transitions before
  // sampling painted geometry.
  await page
    .evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)))
    .catch(() => undefined);
  return page.evaluate(() => {
    const round = (value: number) => Math.round(value * 100) / 100;
    const box = (node: Element) => {
      const r = node.getBoundingClientRect();
      return {
        x: round(r.x),
        top: round(r.top),
        right: round(r.right),
        bottom: round(r.bottom),
        width: round(r.width),
        height: round(r.height),
      };
    };
    const aside = document.querySelector("aside");
    const heading = document.querySelector("main h1")!;
    const headingRect = heading.getBoundingClientRect();
    const target = document.elementFromPoint(
      headingRect.x + headingRect.width / 2,
      headingRect.y + headingRect.height / 2,
    );
    return {
      viewport: {
        width: innerWidth,
        height: innerHeight,
        clientWidth: document.documentElement.clientWidth,
      },
      theme: document.documentElement.dataset.theme ?? "",
      aside: aside ? box(aside) : null,
      main: box(document.querySelector("main")!),
      header: box(document.querySelector("header")!),
      heading: box(heading),
      hit: {
        tag: target?.tagName ?? "",
        className: typeof target?.className === "string" ? target.className : "",
        insideHeading: !!target && heading.contains(target),
      },
      document: { scrollWidth: document.documentElement.scrollWidth },
    };
  });
}

async function writeRects(testInfo: TestInfo, name: string, rects: Rects) {
  const body = JSON.stringify(rects, null, 2);
  await writeFile(testInfo.outputPath(`${name}.rects.json`), body, "utf8");
  await testInfo.attach(`${name}.rects.json`, { body, contentType: "application/json" });
  console.log(`${name} rects: ${JSON.stringify(rects)}`);
}

function expectVisibleContent(rects: Rects, label: string) {
  // A screen-reader-only 1px h1 would satisfy Playwright's visibility check.
  // The redesigned page title must also be visually readable and unobstructed.
  expect(rects.heading.height, `${label}: readable heading height`).toBeGreaterThan(20);
  expect(rects.heading.width, `${label}: readable heading width`).toBeGreaterThan(50);
  expect(
    rects.hit.insideHeading,
    `${label}: heading centre is unobstructed (hit ${rects.hit.tag}.${rects.hit.className})`,
  ).toBe(true);
  expect(rects.heading.top, `${label}: heading is within the content panel`).toBeGreaterThanOrEqual(
    rects.main.top,
  );
  expect(
    rects.document.scrollWidth,
    `${label}: no page-wide horizontal overflow`,
  ).toBeLessThanOrEqual(rects.viewport.width);
}

function expectFullWidthHeader(rects: Rects, label: string, minimumInset = PANEL_INSET) {
  expect(rects.header.x, `${label}: full-width header starts at viewport left`).toBe(0);
  expect(rects.header.top, `${label}: header sits at viewport top`).toBe(0);
  expect(rects.header.height, `${label}: compact header height`).toBe(HEADER_HEIGHT);
  // Accommodate a reserved browser scrollbar gutter without permitting the
  // previous header offset by the whole sidebar width.
  expect(rects.header.right, `${label}: header spans the usable viewport`).toBeGreaterThanOrEqual(
    rects.viewport.clientWidth,
  );
  expect(rects.header.right).toBeLessThanOrEqual(rects.viewport.width);
  expect(rects.main.top, `${label}: content panel clears the header`).toBeGreaterThanOrEqual(
    rects.header.bottom + minimumInset,
  );
}

function expectDesktop(rects: Rects, label: string, sidebarWidth = SIDEBAR) {
  expectFullWidthHeader(rects, label);
  expectVisibleContent(rects, label);
  expect(rects.aside, `${label}: desktop sidebar exists`).not.toBeNull();
  if (!rects.aside) throw new Error(`${label}: missing desktop sidebar`);
  expect(rects.aside.width, `${label}: sidebar width`).toBe(sidebarWidth);
  expect(rects.aside.x, `${label}: sidebar starts at viewport left`).toBe(0);
  expect(rects.aside.top, `${label}: sidebar starts below global header`).toBe(HEADER_HEIGHT);
  expect(rects.main.x, `${label}: content panel clears the sidebar`).toBeGreaterThanOrEqual(
    rects.aside.right + PANEL_INSET,
  );
  expect(rects.main.right, `${label}: panel keeps its right inset`).toBeLessThanOrEqual(
    rects.header.right - PANEL_INSET,
  );
  expect(rects.heading.x, `${label}: heading clears the sidebar`).toBeGreaterThan(
    rects.aside.right,
  );
}

for (const theme of ["light", "dark"] as const) {
  test(`1440x1050 ${theme} has a full-width header and an unobstructed inset content panel`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: theme });
    await dashboardAPI(page);
    await page.goto("/dashboard/");
    await expect(page.getByRole("heading", { level: 1, name: "运行概览" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
    await expect(navigation.getByRole("link", { name: "概览", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);

    const rects = await measure(page);
    expectDesktop(rects, `${theme} 1440x1050`);
    expect(rects.viewport.width).toBe(DESKTOP.width);
    expect(rects.viewport.height).toBe(DESKTOP.height);
    expect(errors).toEqual([]);

    await writeRects(testInfo, `azurekiln-1440-${theme}`, rects);
    await page.screenshot({
      path: `test-results/azurekiln-1440-${theme}.png`,
      fullPage: true,
      animations: "disabled",
    });
  });
}

test("desktop sidebar collapse preserves the header, visible content and usable navigation", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(DESKTOP);
  await dashboardAPI(page);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { level: 1, name: "运行概览" })).toBeVisible();

  await page.getByRole("button", { name: "折叠侧栏", exact: true }).click();
  await expect(page.getByRole("button", { name: "展开侧栏", exact: true })).toBeVisible();
  const collapsed = await measure(page);
  expectDesktop(collapsed, "collapsed desktop", COLLAPSED_SIDEBAR);
  await writeRects(testInfo, "azurekiln-1440-collapsed", collapsed);

  // Icon-only links retain their accessible names and can still navigate.
  await page.getByRole("link", { name: "日志审计", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/logs$/);
  await expect(page.getByRole("heading", { level: 1, name: "日志审计" })).toBeVisible();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await expect(page.getByRole("button", { name: "折叠侧栏", exact: true })).toBeVisible();
  expectDesktop(await measure(page), "expanded desktop after navigation");
});

test("sidebar collapse animates width and fades copy without moving icons", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await dashboardAPI(page);
  await page.goto("/dashboard/");
  const aside = page.locator("aside");
  await expect(aside).toHaveCSS("transition-property", /width/);
  const label = aside.locator("a[href='/dashboard/logs'] span");
  const iconBox = async () => {
    const box = await aside.locator("a[href='/dashboard/logs'] svg").boundingBox();
    if (!box) throw new Error("missing navigation icon");
    return box;
  };
  const expandedIconX = (await iconBox()).x;
  await expect(label).toHaveCSS("opacity", "1");

  await page.getByRole("button", { name: "折叠侧栏", exact: true }).click();
  // The copy stays mounted and only fades, so the icon keeps its slot.
  await expect(label).toHaveCSS("opacity", "0");
  const collapsedIconX = (await iconBox()).x;
  expect(Math.abs(collapsedIconX - expandedIconX)).toBeLessThanOrEqual(1);
  await expect(aside).toHaveCSS("width", `${COLLAPSED_SIDEBAR}px`);
});

test("sidebar resizes without motion when reduced motion is requested", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await dashboardAPI(page);
  await page.goto("/dashboard/");
  const aside = page.locator("aside");
  await expect(aside).toHaveCSS("transition-duration", "0s");
  await page.getByRole("button", { name: "折叠侧栏", exact: true }).click();
  await expect(aside).toHaveCSS("width", `${COLLAPSED_SIDEBAR}px`);
});

test("375px mobile content remains readable with no horizontal navigation strip or page overflow", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 812 });
  await page.emulateMedia({ colorScheme: "light" });
  await dashboardAPI(page);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { level: 1, name: "运行概览" })).toBeVisible();

  const rects = await measure(page);
  expectFullWidthHeader(rects, "mobile", 1);
  expectVisibleContent(rects, "mobile");
  expect(rects.viewport.width).toBe(MOBILE_WIDTH);
  expect(rects.main.x, "mobile: panel keeps a visible left inset").toBeGreaterThan(0);
  expect(rects.main.right, "mobile: panel keeps a visible right inset").toBeLessThan(MOBILE_WIDTH);
  expect(rects.heading.right).toBeLessThanOrEqual(MOBILE_WIDTH);
  // Navigation belongs in the drawer on mobile, not in a scrolling row above
  // the title. Hidden/offscreen navigation must not receive focus or clicks.
  await expect(page.getByRole("navigation", { name: "主导航", exact: true })).not.toBeVisible();
  expect(errors).toEqual([]);

  await writeRects(testInfo, "azurekiln-375-light", rects);
  await page.screenshot({
    path: "test-results/azurekiln-375-light.png",
    fullPage: true,
    animations: "disabled",
  });
});

async function expectNavigationPanel(page: Page, drawer: Locator, label: string) {
  const panel = drawer.locator(":scope > section");
  const rect = await panel.boundingBox();
  expect(rect, `${label}: navigation panel is painted`).not.toBeNull();
  if (!rect) throw new Error(`${label}: missing navigation panel`);
  expect(rect.width, `${label}: usable drawer width`).toBeGreaterThanOrEqual(250);
  expect(rect.width, `${label}: drawer leaves some backdrop visible`).toBeLessThanOrEqual(320);
  expect(rect.x, `${label}: panel is inside viewport`).toBeGreaterThanOrEqual(0);
  expect(rect.x, `${label}: panel opens from the left`).toBeLessThanOrEqual(16);
  expect(rect.y, `${label}: panel is inside viewport`).toBeGreaterThanOrEqual(0);
  expect(rect.y, `${label}: panel starts near viewport top`).toBeLessThanOrEqual(16);
  expect(rect.x + rect.width).toBeLessThanOrEqual(MOBILE_WIDTH);
  await expect(panel).toHaveCSS("opacity", "1");
  const backgroundAlpha = await panel.evaluate((node) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = getComputedStyle(node).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  expect(backgroundAlpha, `${label}: panel background is opaque`).toBe(255);
  const overview = drawer.getByRole("link", { name: "概览", exact: true });
  const hitInsideLink = await overview.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit !== null && node.contains(hit);
  });
  expect(hitInsideLink, `${label}: navigation receives clicks above the page`).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    MOBILE_WIDTH,
  );
}

test("mobile navigation opens by keyboard, keeps background inert and restores focus on Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: MOBILE_WIDTH, height: 812 });
  await dashboardAPI(page);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { level: 1, name: "运行概览" })).toBeVisible();

  await page.emulateMedia({ colorScheme: "light" });
  const opener = page.getByRole("button", { name: "打开导航菜单", exact: true });
  const drawer = page.getByRole("dialog", { name: "主导航", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(drawer).toBeVisible();
  // Native showModal() supplies modal semantics without an aria-modal attribute.
  await expect
    .poll(() =>
      drawer.evaluate(
        (node) => node.matches("dialog:modal") || node.getAttribute("aria-modal") === "true",
      ),
    )
    .toBe(true);
  await expect
    .poll(() => drawer.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);

  // Finite entry animations are completed before checking the painted panel.
  await page.screenshot({
    path: "test-results/azurekiln-375-drawer-light.png",
    animations: "disabled",
  });
  await expectNavigationPanel(page, drawer, "light mobile drawer");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({
    path: "test-results/azurekiln-375-drawer-dark.png",
    animations: "disabled",
  });
  await expectNavigationPanel(page, drawer, "dark mobile drawer");

  // Native dialogs may let Tab reach browser chrome (activeElement=BODY),
  // but must never expose the background page's interactive controls.
  await drawer.getByRole("link").last().focus();
  await page.keyboard.press("Tab");
  const focusAfterTab = await drawer.evaluate((node) => ({
    withinDialog: node.contains(document.activeElement),
    browserChrome: document.activeElement === document.body,
    activeTag: document.activeElement?.tagName,
  }));
  expect(focusAfterTab.withinDialog || focusAfterTab.browserChrome).toBe(true);
  // Programmatic focus must also respect the native modal's inert background.
  await opener.evaluate((node) => node.focus());
  await expect(opener).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect
    .poll(() => drawer.evaluate((node) => node.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  await expect(opener).toBeFocused();

  await page.keyboard.press("Space");
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: "模型路由", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/models$/);
  await expect(drawer).not.toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "模型路由" })).toBeVisible();
  expectVisibleContent(await measure(page), "mobile after navigation");
});
