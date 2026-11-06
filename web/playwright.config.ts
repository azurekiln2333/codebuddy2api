import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  // Real-service suites have their own configs and must not run in the mocked
  // default gate: `e2e/backend.integration.ts` (playwright.integration.config.ts)
  // and `e2e/native-sso.integration.ts` (playwright.native.config.ts).
  // `e2e/serve.mjs` is the dev server, not a spec.
  testIgnore: ["**/*.integration.ts", "serve.mjs"],
  timeout: 30000,
  // One worker runs every spec in turn; leave headroom as the suite grows.
  globalTimeout: 180000,
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:5174",
    // The UI follows the browser language by default; the specs are written in Chinese.
    locale: "zh-CN",
    viewport: { width: 1440, height: 1050 },
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.WEBUI_CHROMIUM,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/serve.mjs",
    stdout: "pipe",
    stderr: "pipe",
    wait: { stdout: /Isolated WebUI test server PID=/ },
    reuseExistingServer: false,
    timeout: 30000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
