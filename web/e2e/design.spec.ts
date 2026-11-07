import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockSession } from "./sso";

// The console redesign must be verified by painted geometry and by the first
// frame the browser actually shows, not only by declared CSS values.
const DESKTOP = { width: 1440, height: 1050 } as const;
const MOBILE = { width: 375, height: 812 } as const;
const HEADER_HEIGHT = 52;
const SIDEBAR = 180;
const COLLAPSED_SIDEBAR = 64;

const dashboardPayload = {
  summary: { requests: 12, success_rate: 1, total_tokens: 3200, credit: 0 },
  series: [
    {
      bucket: 1790812800,
      date: "2026-10-01",
      requests: 12,
      success: 12,
      error: 0,
      total_tokens: 3200,
      credit: 0,
    },
  ],
  models: [],
  profiles: [],
  health: { credentials: [] },
  storage: { degraded: false },
  range: { days: 7, granularity: "day" },
  generated_at: 1790812800,
};

async function adminAPI(page: Page) {
  await page.route("**/admin/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname === "/admin/dashboard" ? dashboardPayload : {},
    }),
  );
}

// A control must be fully inside the viewport with an unclipped hit area. A
// partially off-screen position can still report a size, so assert the painted
// box against the viewport and verify the centre hits the element itself.
async function expectFullyVisible(page: Page, target: Locator, label: string) {
  const box = await target.boundingBox();
  expect(box, `${label}: painted box`).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.x, `${label}: left edge inside viewport`).toBeGreaterThanOrEqual(0);
  expect(box!.y, `${label}: top edge inside viewport`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label}: right edge inside viewport`).toBeLessThanOrEqual(
    viewport.width,
  );
  expect(box!.y + box!.height, `${label}: bottom edge inside viewport`).toBeLessThanOrEqual(
    viewport.height,
  );
  expect(box!.width, `${label}: usable hit width`).toBeGreaterThanOrEqual(28);
  expect(box!.height, `${label}: usable hit height`).toBeGreaterThanOrEqual(28);
  const centreHit = await target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit !== null && node.contains(hit);
  });
  expect(centreHit, `${label}: centre receives pointer events`).toBe(true);
}

test("first painted frame shows the branded connecting screen and the exact copy", async ({
  page,
}) => {
  await adminAPI(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/sso/session", async (route) => {
    await gate;
    await route.fulfill({
      json: {
        authenticated: true,
        csrf_token: "design-csrf",
        user: { sub: "design-admin", role: "admin" },
      },
    });
  });

  await page.setViewportSize(DESKTOP);
  await page.goto("/dashboard/");

  const boot = page.getByRole("status");
  await expect(boot).toBeVisible();
  await expect(boot).toHaveText("正在连接控制台");
  // Brand mark plus the animated loader, both painted on the first frame.
  await expect(boot.locator("svg")).toHaveCount(2);
  await expect(boot.locator("span").nth(1)).toHaveCSS("animation-name", /spin/);
  const bootBox = await boot.boundingBox();
  expect(bootBox!.width).toBe(DESKTOP.width);
  expect(bootBox!.height).toBeGreaterThanOrEqual(DESKTOP.height - 1);
  await page.screenshot({ path: "test-results/design-boot-light.png", animations: "disabled" });

  // The same first frame must also fill a phone viewport without clipping.
  await page.setViewportSize(MOBILE);
  await expect(boot).toBeVisible();
  const mobileBootBox = await boot.boundingBox();
  expect(mobileBootBox!.width).toBe(MOBILE.width);
  expect(mobileBootBox!.height).toBeGreaterThanOrEqual(MOBILE.height - 1);
  await page.screenshot({
    path: "test-results/design-boot-mobile-light.png",
    animations: "disabled",
  });

  release();
  await expect(page.getByRole("heading", { level: 1, name: "运行概览" })).toBeVisible();
  await expect(boot).toHaveCount(0);
});

test("desktop login keeps the reference two-column composition with a single SSO action", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockSession(page, false);
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/dashboard/login");
  await page.evaluate(() => document.fonts.ready);

  const story = page.locator("#root > div > section");
  const main = page.locator("#root > div > main");
  const storyBox = await story.boundingBox();
  const mainBox = await main.boundingBox();
  expect(storyBox).not.toBeNull();
  expect(mainBox).not.toBeNull();
  // Two columns, narrative on the left, form column on the right.
  expect(storyBox!.x).toBe(0);
  expect(storyBox!.width).toBeGreaterThan(mainBox!.width);
  expect(storyBox!.x + storyBox!.width).toBeCloseTo(mainBox!.x, 0);
  expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(DESKTOP.width + 1);

  // Brand, narrative headline and the restrained network diagram are painted.
  await expect(story.getByText("CodeBuddy2Api")).toBeVisible();
  await expect(story.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(story.locator("svg path")).not.toHaveCount(0);
  await expect(story.getByText("统一网关")).toBeVisible();
  await expect(story.getByText("账号池 1")).toBeVisible();

  // The sign-in column offers exactly one action: unified identity login.
  await expect(page.getByRole("heading", { name: "登录 CodeBuddy2Api" })).toBeVisible();
  const action = page.getByRole("link", { name: "使用统一身份登录" });
  await expect(action).toHaveAttribute("href", "/sso/login?return_to=/dashboard/");
  await expect(action).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#root input, #root form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "外观设置" })).toBeVisible();
  expect(errors).toEqual([]);

  // Composition metrics from the reference panel, measured on the painted page.
  const composition = await page.evaluate(() => {
    const story = document.querySelector("#root > div > section")!;
    const main = document.querySelector("#root > div > main")!;
    const pick = (scope: ParentNode, name: string) =>
      scope.querySelector(`[class*="${name}"]`) as HTMLElement;
    const storyStyle = getComputedStyle(story);
    const h1 = story.querySelector("h1")!;
    const h2 = main.querySelector("h2")!;
    const lock = pick(main, "loginLock");
    const eyebrow = pick(main, "eyebrow");
    const submit = pick(main, "loginSubmit");
    const themeControl = pick(main, "loginTheme");
    return {
      storyPadding: storyStyle.padding,
      storyBorderRight: storyStyle.borderRightWidth,
      h1FontSize: getComputedStyle(h1).fontSize,
      h1FontWeight: getComputedStyle(h1).fontWeight,
      artHeight: getComputedStyle(pick(story, "networkArt")).height,
      mainPadding: getComputedStyle(main).padding,
      themeTop: getComputedStyle(themeControl).top,
      themeRight: getComputedStyle(themeControl).right,
      lockSize: [getComputedStyle(lock).width, getComputedStyle(lock).height],
      lockRadius: getComputedStyle(lock).borderTopLeftRadius,
      eyebrowDisplay: getComputedStyle(eyebrow).display,
      eyebrowMarginBottom: getComputedStyle(eyebrow).marginBottom,
      h2FontSize: getComputedStyle(h2).fontSize,
      submitHeight: getComputedStyle(submit).height,
      submitWidth: getComputedStyle(submit).width,
      cardWidth: getComputedStyle(pick(main, "loginCard")).width,
    };
  });
  expect(composition.storyPadding).toBe("42px 50px 28px");
  expect(composition.storyBorderRight).toBe("1px");
  expect(composition.h1FontSize).toBe("38px");
  expect(composition.h1FontWeight).toBe("600");
  expect(composition.artHeight).toBe("240px");
  expect(composition.mainPadding).toBe("65px 30px");
  expect(composition.themeTop).toBe("35px");
  expect(composition.themeRight).toBe("32px");
  expect(composition.lockSize).toEqual(["48px", "48px"]);
  expect(composition.lockRadius).toBe("16px");
  // The eyebrow is a block so its 8px gap actually paints.
  expect(composition.eyebrowDisplay).toBe("block");
  expect(composition.eyebrowMarginBottom).toBe("8px");
  expect(composition.h2FontSize).toBe("25px");
  expect(composition.submitHeight).toBe("42px");
  expect(composition.submitWidth).toBe(composition.cardWidth);

  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      primary: style.getPropertyValue("--primary").trim(),
      radius: style.getPropertyValue("--radius").trim(),
      page: getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(tokens.primary).toBe("#3169df");
  expect(tokens.radius).toBe("12px");

  await page.screenshot({
    path: "test-results/design-login-desktop-light.png",
    fullPage: true,
    animations: "disabled",
  });

  // Dark mode must only swap semantic tokens, not the layout.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkStoryBox = await story.boundingBox();
  expect(darkStoryBox!.width).toBe(storyBox!.width);
  const darkPage = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(darkPage).not.toBe(tokens.page);
  await page.screenshot({
    path: "test-results/design-login-desktop-dark.png",
    fullPage: true,
    animations: "disabled",
  });
});

test("mobile login collapses to one column with the brand kept and no page overflow", async ({
  page,
}) => {
  await mockSession(page, false);
  await page.setViewportSize(MOBILE);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/dashboard/login");
  await page.evaluate(() => document.fonts.ready);

  const story = page.locator("#root > div > section");
  const main = page.locator("#root > div > main");
  const storyBox = await story.boundingBox();
  const mainBox = await main.boundingBox();
  // Stacked rows instead of side-by-side columns.
  expect(storyBox!.width).toBe(mainBox!.width);
  expect(storyBox!.y + storyBox!.height).toBeCloseTo(mainBox!.y, 0);
  // The narrative block is removed on small screens but the brand remains.
  expect(storyBox!.height).toBeLessThan(120);
  await expect(story.getByText("CodeBuddy2Api")).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录 CodeBuddy2Api" })).toBeVisible();
  await expect(page.getByRole("link", { name: "使用统一身份登录" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const card = page.locator('[class*="loginCard"]').first();
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x).toBe(30);
  expect(cardBox.width).toBe(315);
  expect(cardBox.y).toBeGreaterThan(230);
  expect(cardBox.y + cardBox.height).toBeLessThan(600);
  await expect(story.locator('[class*="brandText"]')).toHaveCSS("font-size", "23px");

  // Regression: the theme control was once absolutely positioned above the
  // login column and clipped at y=0 on phones. Assert it is fully on screen
  // with a full hit area, in both themes.
  const themeControl = page.getByRole("button", { name: "外观设置" });
  await expectFullyVisible(page, themeControl, "mobile theme control (light)");
  // It belongs to the brand row band, not to the sign-in card.
  const themeBox = (await themeControl.boundingBox())!;
  expect(themeBox.y + themeBox.height).toBeLessThanOrEqual(storyBox!.height);
  expect(themeBox.y + themeBox.height).toBeLessThan(cardBox.y);
  await page.screenshot({
    path: "test-results/design-login-mobile-light.png",
    fullPage: true,
    animations: "disabled",
  });

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expectFullyVisible(page, themeControl, "mobile theme control (dark)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: "test-results/design-login-mobile-dark.png",
    fullPage: true,
    animations: "disabled",
  });
});

for (const theme of ["light", "dark"] as const) {
  test(`console shell keeps the reference geometry (${theme})`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockSession(page);
    await adminAPI(page);
    await page.setViewportSize(DESKTOP);
    await page.emulateMedia({ colorScheme: theme });
    await page.goto("/dashboard/");
    await expect(page.getByRole("heading", { level: 1, name: "运行概览" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    const geometry = await page.evaluate(() => {
      const round = (value: number) => Math.round(value * 100) / 100;
      const box = (node: Element) => {
        const rect = node.getBoundingClientRect();
        return {
          x: round(rect.x),
          top: round(rect.top),
          right: round(rect.right),
          width: round(rect.width),
          height: round(rect.height),
        };
      };
      const workspace = document.querySelector("main")!.parentElement!;
      const active = document.querySelector('aside [aria-current="page"]')!;
      const aside = document.querySelector("aside")!;
      const navLink = document.querySelector('aside a[href="/dashboard/logs"]')!;
      const caption = document.querySelector("aside p")!;
      const navStyle = getComputedStyle(navLink);
      const workspaceStyle = getComputedStyle(workspace);
      return {
        workspace: box(workspace),
        workspaceOverflow: workspaceStyle.overflowY,
        font: getComputedStyle(document.body).fontFamily,
        fontLoaded: [...document.fonts].some(
          (face) => face.family.includes("DM Sans Variable") && face.status === "loaded",
        ),
        documentHeight: document.documentElement.scrollHeight,
        header: box(document.querySelector("header")!),
        sidebar: box(aside),
        main: box(document.querySelector("main")!),
        workspaceRadius: workspaceStyle.borderTopLeftRadius,
        workspaceBackground: workspaceStyle.backgroundColor,
        workspaceMargin: workspaceStyle.margin,
        workspaceBorder: workspaceStyle.borderTopWidth,
        headerPadding: getComputedStyle(document.querySelector("header")!).padding,
        headerBackground: getComputedStyle(document.querySelector("header")!).backgroundColor,
        sidebarBackground: getComputedStyle(aside).backgroundColor,
        sidebarPadding: getComputedStyle(aside).padding,
        mainPadding: getComputedStyle(document.querySelector("main")!).padding,
        footerFontSize: getComputedStyle(document.querySelector("footer")!).fontSize,
        navItem: {
          minHeight: navStyle.minHeight,
          radius: navStyle.borderTopLeftRadius,
          fontSize: navStyle.fontSize,
          fontWeight: navStyle.fontWeight,
          padding: navStyle.padding,
        },
        navCaption: {
          fontSize: getComputedStyle(caption).fontSize,
          letterSpacing: getComputedStyle(caption).letterSpacing,
        },
        activeBackground: getComputedStyle(active).backgroundColor,
        activeShadow: getComputedStyle(active).boxShadow,
        activeColor: getComputedStyle(active).color,
        // Exactly one element may claim to be the current page.
        currentPageMarkers: document.querySelectorAll('[aria-current="page"]').length,
        currentPageMarkerTag: document.querySelector('[aria-current="page"]')!.tagName,
        currentPageMarkerInAside: document.querySelectorAll('aside [aria-current="page"]').length,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
      };
    });

    // 52px full-width top bar flush with the viewport.
    expect(geometry.header.x).toBe(0);
    expect(geometry.header.top).toBe(0);
    expect(geometry.header.height).toBe(HEADER_HEIGHT);
    expect(geometry.header.width).toBe(DESKTOP.width);
    // 180px sidebar starting directly below the top bar.
    expect(geometry.sidebar.width).toBe(SIDEBAR);
    expect(geometry.sidebar.top).toBe(HEADER_HEIGHT);
    // Inset surface panel with the 16px workspace radius.
    expect(geometry.workspace.x).toBe(SIDEBAR);
    expect(geometry.workspace.top).toBe(HEADER_HEIGHT + 8);
    expect(geometry.workspace.top + geometry.workspace.height).toBe(DESKTOP.height - 8);
    expect(geometry.workspaceOverflow).toBe("auto");
    expect(geometry.documentHeight).toBe(DESKTOP.height);
    expect(geometry.font).toContain("DM Sans Variable");
    expect(geometry.fontLoaded).toBe(true);
    expect(geometry.workspaceRadius).toBe("16px");
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);

    // Reference-panel spacing, type scale and radius, not just the outer frame.
    expect(geometry.headerPadding).toBe("0px 16px");
    expect(geometry.headerBackground).toBe(geometry.sidebarBackground);
    expect(geometry.sidebarPadding).toBe("8px 12px 12px");
    expect(geometry.workspaceMargin).toBe(`8px 8px 8px ${SIDEBAR}px`);
    expect(geometry.workspaceBorder).toBe("1px");
    expect(geometry.mainPadding).toBe("20px 22px 18px");
    expect(geometry.footerFontSize).toBe("12px");
    expect(geometry.navItem).toEqual({
      minHeight: "36px",
      radius: "8px",
      fontSize: "14px",
      fontWeight: "500",
      padding: "7px 9px",
    });
    expect(geometry.navCaption).toEqual({ fontSize: "11px", letterSpacing: "0.5px" });
    // The active entry is an inset surface, not a solid fill.
    expect(geometry.activeShadow).toContain("inset");
    expect(geometry.activeBackground).toBe(
      theme === "light" ? "rgb(207, 221, 242)" : "rgb(184, 204, 235)",
    );
    expect(geometry.activeColor).toBe("rgb(0, 0, 0)");
    // Only the sidebar entry marks the current page; the brand shortcut must not.
    expect(geometry.currentPageMarkers).toBe(1);
    expect(geometry.currentPageMarkerTag).toBe("A");
    expect(geometry.currentPageMarkerInAside).toBe(1);

    // The packaged notices must have a reachable entry point in the console, and
    // they must be plain anchors so the browser loads the gateway's text/plain
    // document instead of the SPA router swallowing the click.
    const footer = page.locator("footer");
    const notices = footer.getByRole("link", { name: "开源声明" });
    const licenses = footer.getByRole("link", { name: "依赖许可" });
    await expect(notices).toHaveAttribute("href", "/dashboard/THIRD_PARTY_NOTICES.txt");
    await expect(licenses).toHaveAttribute("href", "/dashboard/THIRD_PARTY_LICENSES.txt");
    await expect(licenses).toHaveAttribute("rel", "license");
    await expect(notices).toBeVisible();
    await expect(licenses).toBeVisible();
    expect(await footer.locator("a").count()).toBe(2);
    expect(errors).toEqual([]);

    await testInfo.attach(`shell-${theme}.json`, {
      body: JSON.stringify(geometry, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({
      path: `test-results/design-console-${theme}.png`,
      fullPage: true,
      animations: "disabled",
    });

    // Clicking must be a real document navigation to the gateway route. If the SPA
    // router swallowed the click the URL would not change and nothing would load.
    await notices.click();
    await expect(page).toHaveURL(/THIRD_PARTY_NOTICES\.txt$/);
  });
}

test("collapsed sidebar narrows to 64px without shifting navigation icons", async ({ page }) => {
  await mockSession(page);
  await adminAPI(page);
  await page.setViewportSize(DESKTOP);
  await page.goto("/dashboard/");
  await expect(page.getByRole("heading", { level: 1, name: "运行概览" })).toBeVisible();
  const link = page.locator("aside a[href='/dashboard/logs']");
  const expandedIcon = await link.locator("svg").boundingBox();
  await page.getByRole("button", { name: "折叠侧栏" }).click();
  await expect(page.locator("aside")).toHaveCSS("width", `${COLLAPSED_SIDEBAR}px`);
  await page.waitForTimeout(250);
  const collapsedIcon = await link.locator("svg").boundingBox();
  expect(Math.abs(collapsedIcon!.x - expandedIcon!.x)).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: "test-results/design-console-collapsed.png",
    animations: "disabled",
  });
});
