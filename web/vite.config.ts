import { defineConfig } from "vite-plus";
import { prepareNotices } from "./scripts/prepare-notices.mjs";

const gateway = process.env.AZUREKILN_GATEWAY_URL;
const proxy = gateway
  ? {
      "/admin": { target: gateway, changeOrigin: false },
      "/sso": { target: gateway, changeOrigin: false },
    }
  : undefined;
export default defineConfig({
  base: "/dashboard/",
  // The container image runs `vp build` directly, so attribution and dependency
  // license texts are produced by the build itself, not only by the npm script.
  plugins: [
    {
      name: "codebuddy2api-prepare-notices",
      async buildStart() {
        await prepareNotices();
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy,
  },
  preview: { proxy },
  lint: { options: { typeCheck: true, typeAware: true } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
