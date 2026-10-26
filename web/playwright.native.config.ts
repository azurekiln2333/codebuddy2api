import { defineConfig } from "@playwright/test";

// Real browser, real backend, synthetic identity provider.
//
// `tests/native_sso_fixture.py` starts a synthetic OIDC IdP on a TCP port and
// the actual `converter.py` process with native SSO enabled. Nothing is mocked
// or routed: the browser performs the full authorization-code redirect and the
// console talks to the shipped FastAPI application.
const backendPort = Number(process.env.NATIVE_SSO_BACKEND_PORT || 8791);
const baseURL = process.env.NATIVE_SSO_BASE_URL || `http://127.0.0.1:${backendPort}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "native-sso.integration.ts",
  timeout: 90000,
  globalTimeout: 300000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL,
    locale: "zh-CN",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath: process.env.WEBUI_CHROMIUM,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // A shell-free Node wrapper spawns the fixture, so an interpreter path with
    // spaces works. It prefers WEBUI_PYTHON (the CI convention), then
    // NATIVE_SSO_PYTHON, then `python` on PATH.
    command: "node scripts/start-native-fixture.mjs",
    url: `${baseURL}/health`,
    timeout: 180000,
    // Never adopt a foreign listener that happens to answer on the same port.
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
  },
});
