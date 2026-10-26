import { defineConfig } from "@playwright/test";

// This suite mutates a dedicated synthetic gateway/backend fixture. Never point
// it at a production administration service.
const integrationURL = process.env.AZUREKILN_INTEGRATION_URL;
if (!integrationURL)
  throw new Error("Set AZUREKILN_INTEGRATION_URL to a dedicated synthetic gateway fixture.");
export default defineConfig({
  testDir: "./e2e",
  testMatch: "backend.integration.ts",
  timeout: 30000,
  globalTimeout: 90000,
  workers: 1,
  use: {
    baseURL: integrationURL,
    storageState: process.env.AZUREKILN_INTEGRATION_STORAGE_STATE,
    locale: "zh-CN",
    viewport: { width: 1440, height: 1050 },
    launchOptions: {
      executablePath: process.env.WEBUI_CHROMIUM,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    },
    trace: "retain-on-failure",
  },
});
