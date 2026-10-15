import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { startUpstream } from "./fixtures/upstream.js";
import { GatewayProxy } from "../src/proxy.js";
import { HttpError } from "../src/http.js";
import { it } from "node:test";
import type { GatewayConfig } from "../src/config.js";
import type { GatewaySession } from "../src/sessions.js";
import { HttpClient } from "./helpers/http-client.js";

// Minimal harness: mount GatewayProxy directly behind a tiny HTTP server that
// hands it a fabricated GatewaySession, to exercise the bridge without auth.ts.

it("bridges an isolated upstream session and translates CSRF without forwarding browser secrets", { timeout: 5_000 }, async () => {
  const upstream = await startUpstream();

  const config: GatewayConfig = {
    publicOrigin: "http://127.0.0.1:0",
    oidcIssuer: "http://127.0.0.1:0",
    oidcClientId: "c",
    oidcClientSecret: "s",
    oidcRefresh: false,
    upstreamOrigin: upstream.origin,
    upstreamApiKey: upstream.apiKey,
    host: "127.0.0.1",
    port: 0,
    uiStaticDir: ".",
    allowInsecureLocalhost: true,
    sessionTtlMs: 3_600_000,
    sessionIdleMs: 600_000,
    transactionTtlMs: 60_000,
    maxSessions: 128,
    oauthTimeoutMs: 2_000,
    upstreamTimeoutMs: 2_000,
    streamTimeoutMs: 5_000,
    maxBodyBytes: 1_048_576,
  };

  const proxy = new GatewayProxy(config);
  const session: GatewaySession = {
    id: "g1", csrfToken: "GATEWAY-CSRF", sub: "u", accessToken: "t",
    user: { sub: "u", role: "admin" },
    accessTokenExpiresAt: Date.now() + 1e6, expiresAt: Date.now() + 1e6, lastSeenAt: Date.now(),
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname.startsWith("/admin/")) {
        await proxy.admin(req, res, url, session);
        return;
      }
      if (url.pathname.startsWith("/v1/")) { await proxy.inference(req, res, url); return; }
      res.statusCode = 404; res.end();
    })().catch((err: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = err instanceof HttpError ? err.status : 500;
      res.statusCode = status;
      res.end(JSON.stringify({ error: err instanceof HttpError ? err.code : "internal" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  // The helper consumes each response completely. Global fetch would leave
  // dispatcher-owned responses alive if the test only inspected their status.
  const client = new HttpClient({ host: "127.0.0.1", port });

  try {
    // 1. Bridge login happens lazily; upstream sees canonical Origin + server key.
    const dash = await client.get("/admin/dashboard");
    assert.equal(dash.status, 200, "admin dashboard via bridge");
    const loginBody = upstream.lastBodies["/admin/session"] as { api_key?: string };
    assert.equal(loginBody?.api_key, upstream.apiKey, "bridge sends server key");
    assert.equal(String(upstream.lastHeaders["/admin/session"]?.origin), upstream.origin, "bridge sends canonical origin");
    assert.equal(dash.headers["set-cookie"], undefined, "no upstream Set-Cookie leaks");
    const dashHeaders = upstream.lastHeaders["/admin/dashboard"] ?? {};
    assert.ok(String(dashHeaders.cookie).startsWith("cb_admin_session="), "upstream cookie injected");
    assert.notEqual(String(dashHeaders.cookie).includes("GATEWAY"), true);

    // 2. Mutation injects distinct upstream CSRF, not the browser's.
    const clear = await client.post("/admin/logs/clear", { scope: "details" }, {
      headers: { "x-csrf-token": "GATEWAY-CSRF" },
    });
    assert.equal(clear.status, 200);
    const upCsrf = String((upstream.lastHeaders["/admin/logs/clear"] ?? {})["x-csrf-token"]);
    assert.ok(upCsrf.length > 0 && upCsrf !== "GATEWAY-CSRF", "distinct upstream CSRF injected");

    // 3. Full clear: wrong confirmation rejected locally, upstream not reached.
    const before = upstream.counts["/admin/logs/clear"] ?? 0;
    const bad = await client.post("/admin/logs/clear", { scope: "all", confirmation: "wrong" }, {
      headers: { "x-csrf-token": "GATEWAY-CSRF" },
    });
    assert.equal(bad.status, 403);
    assert.equal(upstream.counts["/admin/logs/clear"] ?? 0, before, "upstream not called on bad confirmation");

    // 4. Full clear good: browser key replaced with server key.
    const good = await client.post("/admin/logs/clear", { scope: "all", confirmation: "清空全部日志与统计", api_key: "BROWSER-KEY" }, {
      headers: { "x-csrf-token": "GATEWAY-CSRF" },
    });
    assert.equal(good.status, 200);
    const clearBody = upstream.lastBodies["/admin/logs/clear"] as { api_key?: string };
    assert.equal(clearBody.api_key, upstream.apiKey, "server key injected, browser key replaced");

    // 5. Inference: caller key preserved, cookies/identity dropped, server key never injected.
    const inference = await client.post("/v1/echo", {}, {
      headers: { authorization: `Bearer ${upstream.callerKey}`, cookie: "cb_gateway_session=x; cb_admin_session=y", "x-admin-identity": "admin" },
    });
    assert.equal(inference.status, 200);
    const inf = upstream.lastHeaders["/v1/echo"] ?? {};
    assert.equal(String(inf.authorization), `Bearer ${upstream.callerKey}`, "caller cred preserved");
    assert.equal(String(inf.cookie ?? ""), "", "cookies dropped");
    assert.equal(inf["x-admin-identity"], undefined, "identity spoof stripped");
    assert.notEqual(String(inf["x-api-key"] ?? ""), upstream.apiKey);

    // 6. Wait for actual cancellation on both hops before closing the servers.
    const upstreamCancelled = new Promise<void>((resolve) => {
      upstream.server.once("request", (req, res) => {
        assert.equal(req.url, "/v1/stream");
        res.once("close", () => {
          assert.equal(res.writableFinished, false, "the upstream stream was cancelled before completion");
          resolve();
        });
      });
    });
    const first = await new Promise<string>((resolve, reject) => {
      let firstChunk = "";
      let responseClosed = false;
      let requestClosed = false;
      const finish = (): void => {
        if (responseClosed && requestClosed) resolve(firstChunk);
      };
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "GET", path: "/v1/stream", headers: { authorization: `Bearer ${upstream.callerKey}` } },
        (res) => {
          res.once("data", (chunk: Buffer) => {
            firstChunk = chunk.toString();
            res.destroy();
          });
          res.once("close", () => { responseClosed = true; finish(); });
          res.on("error", reject);
        },
      );
      req.once("close", () => { requestClosed = true; finish(); });
      req.on("error", reject);
      req.end();
    });
    assert.match(first, /data: first/, "SSE first chunk flush");
    await upstreamCancelled;

  } finally {
    await proxy.logout(session);
    proxy.close();
    await new Promise<void>((r) => server.close(() => r()));
    await upstream.close();
  }
});
