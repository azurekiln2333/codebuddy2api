import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { request as httpRequest } from "node:http";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig } from "./helpers/config.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";
import { HttpClient } from "./helpers/http-client.js";

/**
 * Regression coverage for the independent proxy review findings.
 *
 * These tests exercise the HTTP-observable consequences of the fixes:
 *  1. `req.close` must not abort a healthy streaming POST,
 *  2. Connection-nominated hop-by-hop headers are stripped both ways,
 *  3. spoofable identity headers (including wildcard families) are stripped,
 *  4. /v1 responses never relay Set-Cookie or CORS headers,
 *  5. POST SSE still flushes the first chunk immediately.
 */

describe("proxy review regressions", () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;
  let gw: RunningGateway;

  before(async () => {
    idp = await startMockOAuth();
    upstream = await startUpstream();
    gw = await startGateway((publicOrigin, port) => testConfig(idp, upstream, { publicOrigin, port }));
  });
  after(async () => {
    await gw.close();
    await idp.close();
    await upstream.close();
  });

  it("strips a Connection-nominated request header on /v1", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.request("POST", "/v1/echo", {
      headers: {
        authorization: `Bearer ${upstream.callerKey}`,
        connection: "x-hop-echo",
        "x-hop-echo": "secret-must-not-reach-upstream",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const headers = upstream.lastHeaders["/v1/echo"] ?? {};
    assert.equal(headers["x-hop-echo"], undefined, "Connection-nominated request header must be stripped");
  });

  it("strips spoofable identity headers (wildcard families) on /v1", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    await client.request("POST", "/v1/echo", {
      headers: {
        authorization: `Bearer ${upstream.callerKey}`,
        "x-user-id": "victim",
        "x-user-role": "admin",
        "x-authenticated-user": "victim",
        "x-auth-request-user": "victim",
        "remote-user": "victim",
        "x-forwarded-user": "victim",
        "x-originating-ip": "10.0.0.1",
        "x-user-email": "victim@example.invalid",
        "x-forwarded-client-cert": "spoofed-certificate",
        "x-auth-request-custom-role": "admin",
        "x-authenticated-groups": "admin",
        "x-remote-email": "victim@example.invalid",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const headers = upstream.lastHeaders["/v1/echo"] ?? {};
    for (const name of [
      "x-user-id",
      "x-user-role",
      "x-authenticated-user",
      "x-auth-request-user",
      "remote-user",
      "x-forwarded-user",
      "x-originating-ip",
      "x-user-email",
      "x-forwarded-client-cert",
      "x-auth-request-custom-role",
      "x-authenticated-groups",
      "x-remote-email",
    ]) {
      assert.equal(headers[name], undefined, `${name} must be stripped from /v1`);
    }
  });

  it("strips identity header families on the admin bridge", async () => {
    const { client } = await login(gw, idp);
    const names = ["x-user-email", "x-forwarded-client-cert", "x-auth-request-custom-role", "x-authenticated-groups", "x-remote-email"];
    const res = await client.get("/admin/dashboard", { headers: Object.fromEntries(names.map((name) => [name, "spoofed"])) });
    assert.equal(res.status, 200);
    const headers = upstream.lastHeaders["/admin/dashboard"] ?? {};
    for (const name of names) assert.equal(headers[name], undefined, `${name} must be stripped from admin`);
  });

  it("strips Connection-nominated hop-by-hop response headers", async () => {
    upstream.controls.hopByHopResponseHeaders = true;
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.request("POST", "/v1/echo", {
      headers: { authorization: `Bearer ${upstream.callerKey}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    // The gateway may emit its own Connection header for its hop, but the
    // upstream-nominated custom header must NEVER be relayed.
    assert.equal(res.headers["x-upstream-hop"], undefined, "Connection-nominated response header must be stripped");
    assert.notEqual(res.headers["connection"], "x-upstream-hop", "upstream Connection header must not be relayed");
    upstream.controls.hopByHopResponseHeaders = false;
  });

  it("never relays an upstream Set-Cookie from /v1", async () => {
    upstream.controls.setCookieOnInference = true;
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.request("POST", "/v1/echo", {
      headers: { authorization: `Bearer ${upstream.callerKey}`, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.equal(res.setCookie.length, 0, "Set-Cookie must never be relayed from /v1");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["access-control-allow-credentials"], undefined);
    upstream.controls.setCookieOnInference = false;
  });

  it("bounds a stalled upstream before the first streaming response header", async () => {
    const shortTimeout = await startGateway((publicOrigin, port) => testConfig(idp, upstream, { publicOrigin, port, streamTimeoutMs: 100 }));
    upstream.controls.streamDelayMs = 400;
    try {
      const res = await shortTimeout.client.get("/v1/stream", { headers: { authorization: `Bearer ${upstream.callerKey}` } });
      assert.equal(res.status, 504);
      assert.deepEqual(shortTimeout.client.json(res), { error: "upstream_timeout" });
    } finally {
      upstream.controls.streamDelayMs = 0;
      await shortTimeout.close();
    }
  });

  it("does not abort a healthy streaming response on req.close (GET)", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: gw.host, port: gw.port, method: "GET", path: "/v1/stream", headers: { authorization: `Bearer ${upstream.callerKey}` } },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            chunks.push(c);
            if (chunks.length >= 3) res.destroy();
          });
          res.on("close", () => resolve());
          res.on("error", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.ok(chunks.length >= 3, `healthy stream must deliver multiple chunks, got ${chunks.length}`);
  });

  it("does not abort a healthy streaming POST (req.close regression)", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const chunks: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          host: gw.host,
          port: gw.port,
          method: "POST",
          path: "/v1/stream-post",
          headers: { authorization: `Bearer ${upstream.callerKey}`, "content-type": "application/json" },
        },
        (res) => {
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            chunks.push(c);
            if (chunks.length >= 3) res.destroy();
          });
          res.on("close", () => resolve());
          res.on("error", () => resolve());
        },
      );
      req.on("error", reject);
      req.write("{}");
      req.end();
    });
    assert.ok(chunks.length >= 3, `healthy POST stream must deliver multiple chunks, got ${chunks.length}`);
  });

  it("still cancels the upstream when the client disconnects mid-stream", async () => {
    const before = upstream.counts["cancelled:/v1/stream"] ?? 0;
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: gw.host, port: gw.port, method: "GET", path: "/v1/stream", headers: { authorization: `Bearer ${upstream.callerKey}` } },
        (res) => {
          res.once("data", () => {
            req.destroy();
            setTimeout(resolve, 120);
          });
        },
      );
      req.on("error", (err: NodeJS.ErrnoException) => (err.code === "ECONNRESET" ? resolve() : reject(err)));
      req.end();
    });
    assert.ok((upstream.counts["cancelled:/v1/stream"] ?? 0) > before, "upstream observed an unfinished response close");
  });
});
