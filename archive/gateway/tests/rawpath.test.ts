import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig } from "./helpers/config.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";
import { HttpClient } from "./helpers/http-client.js";
import { validateRequestTarget } from "../src/server.js";

/**
 * CRITICAL: raw request-target traversal and classification confusion.
 *
 * These tests send literal request targets (the equivalent of
 * `curl --path-as-is`) so Node's WHATWG URL parser cannot pre-normalise the
 * dot segments. If the gateway parsed or classified by URL first, a request
 * such as `/v1/../admin/session` would land in the admin trusted scope. The
 * gateway must reject the raw target before URL parsing and the private
 * upstream must never be reached.
 *
 * Every case asserts the upstream call counter remains zero for admin paths.
 */

const TRAVERSAL_TARGETS = [
  "/v1/../admin/session",
  "/v1/../../admin/session",
  "/v1/./../admin/session",
  "/v1/..%2fadmin/session",
  "/v1/%2e%2e/admin/session",
  "/v1/%2e%2e%2fadmin/session",
  "/v1/%252e%252e/admin/session",
  "/v1/%2E%2E/admin/session",
  "/v1/..%5cadmin/session",
  "/v1/%2e%2e%5cadmin/session",
  "/v1\\..\\admin/session",
  "/v1/%2fadmin/session",
  "/v1/%5cadmin%5csession",
  "/v1/../admin/logs/clear",
  "/v1/%2e%2e/admin/logs/clear",
];

describe("CRITICAL raw request-target validation", () => {
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

  for (const target of TRAVERSAL_TARGETS) {
    it(`rejects raw target ${target} without reaching upstream`, async () => {
      const client = new HttpClient({ host: gw.host, port: gw.port });
      const res = await client.request("GET", target, { rawPath: true });
      assert.ok(
        res.status === 400 || res.status === 401 || res.status === 404 || res.status === 403,
        `expected rejection for ${target}, got ${res.status}`,
      );
      assert.equal(upstream.counts["/admin/session"], undefined, `upstream /admin/session reached via ${target}`);
      assert.equal(upstream.counts["/admin/logs/clear"], undefined, `upstream clear reached via ${target}`);
    });
  }

  it("rejects traversal attempts with a mutation body too", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.post(
      "/v1/%2e%2e/admin/logs/clear",
      { scope: "all", confirmation: "清空全部日志与统计" },
      { rawPath: true },
    );
    assert.equal(res.status, 400);
    assert.equal(upstream.counts["/admin/logs/clear"], undefined);
  });

  it("does not let an admin-looking path reach upstream unauthenticated", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    // A plain admin path must be 401 (no traversal trick needed), proving the
    // traversal targets above are not simply rejected because admin needs auth.
    const res = await client.get("/admin/session");
    assert.equal(res.status, 401);
    assert.equal(upstream.counts["/admin/session"], undefined);
  });

  it("accepts a legitimate /v1 path and reaches upstream", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.request("POST", "/v1/echo", {
      headers: { authorization: `Bearer ${upstream.callerKey}`, "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(res.status, 200);
    assert.ok((upstream.counts["/v1/echo"] ?? 0) >= 1, "legitimate inference reaches upstream");
  });

  describe("validateRequestTarget unit contract", () => {
    const allowed = [
      "/",
      "/healthz",
      "/dashboard/",
      "/dashboard/assets/app.js",
      "/sso/login?return_to=/dashboard/",
      "/v1/chat/completions",
      "/admin/session",
      "/admin/oauth/poll",
    ];
    for (const target of allowed) {
      it(`allows canonical target ${target}`, () => {
        validateRequestTarget(target);
      });
    }

    const rejected = [
      "",
      "//evil.example/",
      "/v1/../admin",
      "/v1/%2e%2e/admin",
      "/a/./b",
      "/a//b",
      "/v1\\admin",
      "/v1/%5cadmin",
      "/v1/%2fadmin",
      "/v1/%252e%252e/admin",
      "/v1/\u0000admin",
      "/v1/#frag",
      "not-absolute",
    ];
    for (const target of rejected) {
      it(`rejects ambiguous target ${JSON.stringify(target)}`, () => {
        assert.throws(() => validateRequestTarget(target), /invalid_request_target|ambiguous_path|invalid_path/);
      });
    }
  });
});
