import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { request as httpRequest, type Server } from "node:http";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig } from "./helpers/config.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";
import { HttpClient } from "./helpers/http-client.js";

/**
 * /v1/* inference proxy: caller credential handling and streaming.
 *
 * The gateway must keep caller Bearer/X-Api-Key enforcement, inject no server
 * secret or cookie, and stream SSE with immediate flush and cancellation.
 */

async function createGatewayForTest(idp: MockOAuthProvider, upstream: UpstreamServer): Promise<RunningGateway> {
  return startGateway((publicOrigin, port) => testConfig(idp, upstream, { publicOrigin, port }));
}

describe("inference /v1 credential handling and streaming", () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;
  let gw: RunningGateway;

  before(async () => {
    idp = await startMockOAuth();
    upstream = await startUpstream();
    gw = await createGatewayForTest(idp, upstream);
  });
  after(async () => {
    await gw.close();
    await idp.close();
    await upstream.close();
  });

  it("denies a /v1 request with no credential without injecting the server key", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.request("POST", "/v1/echo", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401, "no caller key must be denied");
    // The upstream was reached (it is the authority) but without the server key.
    const headers = upstream.lastHeaders["/v1/echo"] ?? {};
    const auth = String(headers.authorization ?? "");
    const apiKey = String(headers["x-api-key"] ?? "");
    assert.notEqual(auth, `Bearer ${upstream.apiKey}`, "server key must never be injected");
    assert.notEqual(apiKey, upstream.apiKey, "server key must never be injected");
  });

  it("denies a wrong caller key and never injects the server key", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.request("POST", "/v1/echo", {
      headers: { authorization: "Bearer wrong-key", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401);
    const headers = upstream.lastHeaders["/v1/echo"] ?? {};
    assert.notEqual(String(headers.authorization ?? ""), `Bearer ${upstream.apiKey}`);
  });

  it("denies a request that only carries an admin cookie (no caller credential)", async () => {
    const { client } = await login(gw, idp);
    const res = await client.request("POST", "/v1/echo", {
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401, "an admin cookie must not authorize inference");
    // No browser cookie may be forwarded to /v1.
    const headers = upstream.lastHeaders["/v1/echo"] ?? {};
    const cookie = String(headers.cookie ?? "");
    assert.equal(cookie, "", "no cookies may be forwarded to /v1");
  });

  it("accepts a correct caller key and drops server secrets and cookies", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.request("POST", "/v1/echo", {
      headers: {
        authorization: `Bearer ${upstream.callerKey}`,
        cookie: `cb_gateway_session=browser-secret; cb_admin_session=other`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hi: true }),
    });
    assert.equal(res.status, 200);
    const headers = upstream.lastHeaders["/v1/echo"] ?? {};
    assert.equal(String(headers.authorization ?? ""), `Bearer ${upstream.callerKey}`, "caller credential preserved");
    assert.equal(String(headers.cookie ?? ""), "", "browser cookies dropped");
    assert.notEqual(String(headers["x-api-key"] ?? ""), upstream.apiKey, "server key not injected");
  });

  it("accepts X-Api-Key caller credentials", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.request("POST", "/v1/echo", {
      headers: { "x-api-key": upstream.callerKey, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
  });

  it("strips spoofed identity and hop-by-hop headers from /v1", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    await client.request("POST", "/v1/echo", {
      headers: {
        authorization: `Bearer ${upstream.callerKey}`,
        "x-admin-identity": "admin",
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "5.6.7.8",
        "content-type": "application/json",
      },
      body: "{}",
    });
    const headers = upstream.lastHeaders["/v1/echo"] ?? {};
    assert.equal(headers["x-admin-identity"], undefined);
    assert.equal(headers["x-real-ip"], undefined);
  });

  describe("SSE streaming", () => {
    it("flushes the first chunk before the stream ends", async () => {
      const client = new HttpClient({ host: gw.host, port: gw.port });
      const completedBefore = upstream.counts["completed:/v1/stream-finite"] ?? 0;
      let firstChunk = "";
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: gw.host,
            port: gw.port,
            method: "GET",
            path: "/v1/stream-finite",
            headers: { authorization: `Bearer ${upstream.callerKey}` },
          },
          (res) => {
            res.once("data", (chunk: Buffer) => {
              firstChunk = chunk.toString("utf8");
              assert.equal(upstream.counts["completed:/v1/stream-finite"] ?? 0, completedBefore, "first chunk arrives while upstream is still producing events");
            });
            res.resume();
            res.on("end", resolve);
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.match(firstChunk, /data: first/, "first SSE chunk flushes immediately");
      assert.equal(upstream.counts["completed:/v1/stream-finite"], completedBefore + 1, "the stream then completes normally");
    });

    it("propagates client cancellation to the upstream", async () => {
      const before = upstream.counts["cancelled:/v1/stream"] ?? 0;
      await new Promise<void>((resolve, reject) => {
        const req = httpRequest(
          {
            host: gw.host,
            port: gw.port,
            method: "GET",
            path: "/v1/stream",
            headers: { authorization: `Bearer ${upstream.callerKey}` },
          },
          (res) => {
            res.once("data", () => {
              // Abort as soon as the stream opens.
              req.destroy();
              setTimeout(resolve, 100);
            });
          },
        );
        req.on("error", (err: NodeJS.ErrnoException) => (err.code === "ECONNRESET" ? resolve() : reject(err)));
        req.end();
      });
      assert.equal(upstream.counts["cancelled:/v1/stream"], before + 1, "upstream observed an unfinished response close");
    });
  });
});
