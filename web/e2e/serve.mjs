import { createServer } from "vite-plus";
// The isolated browser suite mocks `/admin/*` and `/sso/session` at the Playwright
// layer. Redirect navigations to the gateway sign-in URL still reach this dev
// server, so answer `/sso/*` with a placeholder page instead of the SPA shell.
const server = await createServer({
  plugins: [
    {
      name: "isolated-gateway-sso-fixture",
      configureServer(dev) {
        dev.middlewares.use((req, res, next) => {
          if (!req.url?.startsWith("/sso/")) return next();
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end("<!doctype html><title>Isolated gateway SSO fixture</title>");
        });
      },
    },
  ],
});
await server.listen();
console.log(
  `Isolated WebUI test server PID=${process.pid}; port=5174; owned and stopped by Playwright`,
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
