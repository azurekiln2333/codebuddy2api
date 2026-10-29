import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Server } from "node:http";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig } from "./helpers/config.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";
import { HttpClient } from "./helpers/http-client.js";

/**
 * CSRF, session lifecycle and refresh-rotation behaviour.
 *
 * Requirement: the browser holds a gateway cookie G1 and gateway CSRF; the
 * gateway owns a DISTINCT upstream cookie U1 and CSRF C1. The browser only ever
 * sees the gateway CSRF; the upstream sees only C1. Tests assert both.
 */

async function createGatewayForTest(
  idp: MockOAuthProvider,
  upstream: UpstreamServer,
  overrides?: Parameters<typeof testConfig>[2],
): Promise<RunningGateway> {
  return startGateway((publicOrigin, port) => testConfig(idp, upstream, { publicOrigin, port, ...overrides }));
}

describe("CSRF and session lifecycle", () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;
  let gw: RunningGateway;

  before(async () => {
    idp = await startMockOAuth();
    upstream = await startUpstream();
  });
  after(async () => {
    await gw?.close();
    await idp.close();
    await upstream.close();
  });
  beforeEach(async () => {
    await gw?.close();
    idp.reset();
    upstream.reset();
    gw = await createGatewayForTest(idp, upstream);
  });

  it("rejects a mutation without a CSRF token", async () => {
    const { client } = await login(gw, idp);
    const res = await client.post(
      "/admin/logs/clear",
      { scope: "details" },
      { headers: { origin: gw.origin } },
    );
    assert.equal(res.status, 403, "mutation without CSRF must be forbidden");
  });

  it("rejects a mutation with the wrong CSRF token", async () => {
    const { client } = await login(gw, idp);
    const res = await client.post(
      "/admin/logs/clear",
      { scope: "details" },
      { headers: { origin: gw.origin, "x-csrf-token": "not-the-token" } },
    );
    assert.equal(res.status, 403);
  });

  for (const body of ["null", "[]", '"text"']) {
    it(`rejects a non-object log-clear JSON body ${body}`, async () => {
      const { client } = await login(gw, idp);
      const session = client.json<{ csrf_token: string }>(await client.get("/sso/session"));
      const res = await client.post("/admin/logs/clear", body, {
        headers: { origin: gw.origin, "x-csrf-token": session.csrf_token },
      });
      assert.equal(res.status, 400);
      assert.equal(upstream.counts["/admin/logs/clear"], undefined);
    });
  }

  it("accepts a mutation with the gateway CSRF and translates it to the distinct upstream CSRF C1", async () => {
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const gatewayCsrf = session.csrf_token;

    const res = await client.post(
      "/admin/logs/clear",
      { scope: "details" },
      { headers: { origin: gw.origin, "x-csrf-token": gatewayCsrf } },
    );
    assert.equal(res.status, 200);

    // Upstream must have seen its own CSRF, not the gateway's.
    const headers = upstream.lastHeaders["/admin/logs/clear"] ?? {};
    const upstreamCsrf = String(headers["x-csrf-token"] ?? "");
    assert.ok(upstreamCsrf.length > 0, "upstream CSRF injected");
    assert.notEqual(upstreamCsrf, gatewayCsrf, "upstream CSRF must be distinct from gateway CSRF");
  });

  it("rejects a cross-origin mutation (open-origin / CSRF)", async () => {
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const res = await client.post(
      "/admin/logs/clear",
      { scope: "details" },
      { headers: { origin: "http://evil.example", "x-csrf-token": session.csrf_token } },
    );
    assert.equal(res.status, 403, "cross-origin mutation must be forbidden");
  });

  it("injects the server api_key only for scope=all after the exact confirmation", async () => {
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const headers = { origin: gw.origin, "x-csrf-token": session.csrf_token };

    // Wrong confirmation text must be rejected locally, upstream never called.
    const bad = await client.post(
      "/admin/logs/clear",
      { scope: "all", confirmation: "wrong text" },
      { headers },
    );
    assert.equal(bad.status, 403);

    const good = await client.post(
      "/admin/logs/clear",
      { scope: "all", confirmation: "清空全部日志与统计" },
      { headers },
    );
    assert.equal(good.status, 200, good.body);
    const body = upstream.lastBodies["/admin/logs/clear"] as { api_key?: string; scope?: string };
    assert.equal(body.scope, "all");
    assert.equal(body.api_key, upstream.apiKey, "gateway injects the server api_key");
  });

  it("omits any browser-supplied api_key for full log clear", async () => {
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const res = await client.post(
      "/admin/logs/clear",
      { scope: "all", confirmation: "清空全部日志与统计", api_key: "browser-supplied-key" },
      { headers: { origin: gw.origin, "x-csrf-token": session.csrf_token } },
    );
    assert.equal(res.status, 200);
    const body = upstream.lastBodies["/admin/logs/clear"] as { api_key?: string };
    assert.equal(body.api_key, upstream.apiKey, "browser key must be replaced by the server key");
  });

  it("requires CSRF for GET /admin/oauth/poll", async () => {
    const { client } = await login(gw, idp);
    const without = await client.get("/admin/oauth/poll");
    assert.equal(without.status, 403, "oauth poll is state-changing and needs CSRF");

    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const withCsrf = await client.get("/admin/oauth/poll", {
      headers: { "x-csrf-token": session.csrf_token, origin: gw.origin },
    });
    assert.equal(withCsrf.status, 200);
  });

  it("logout requires same-origin + CSRF and ends the session", async () => {
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));

    const noCsrf = await client.post("/sso/logout", {}, { headers: { origin: gw.origin } });
    assert.equal(noCsrf.status, 403);

    const logout = await client.post(
      "/sso/logout",
      {},
      { headers: { origin: gw.origin, "x-csrf-token": session.csrf_token } },
    );
    assert.ok(logout.status === 200 || logout.status === 204, `logout status ${logout.status}`);

    const after = await client.get("/sso/session");
    assert.equal(after.status, 401);
  });

  it("DELETE /admin/session maps to gateway logout", async () => {
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const res = await client.delete("/admin/session", {
      headers: { origin: gw.origin, "x-csrf-token": session.csrf_token },
    });
    assert.ok(res.status === 200 || res.status === 204, `delete status ${res.status}`);
    const after = await client.get("/admin/session");
    assert.equal(after.status, 401);
  });

  it("POST /admin/session is not available", async () => {
    const { client } = await login(gw, idp);
    const res = await client.post("/admin/session", { api_key: "x" });
    assert.equal(res.status, 405);
  });

  it("limits return_to to the dashboard tree (no open redirect)", async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const res = await client.get("/sso/login?return_to=https://evil.example/steal");
    assert.equal(res.status, 302);
    // Either rejected or the redirect stays local after callback; the authorize
    // URL must be to the configured issuer, never to evil.example.
    assert.ok(res.location, "login redirects");
    const target = new URL(res.location);
    assert.equal(target.origin, idp.issuer, "authorize must go to the configured issuer");
  });

  it("enforces idle expiry on an inactive session", async () => {
    await gw.close();
    gw = await createGatewayForTest(idp, upstream, { sessionIdleMs: 1_000, sessionTtlMs: 3_600_000 });
    const { client } = await login(gw, idp);
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    const res = await client.get("/admin/dashboard");
    assert.equal(res.status, 401, "idle-expired session must be unauthenticated");
  });

  it("rotates refresh tokens exactly once under concurrent protected requests", async () => {
    await gw.close();
    // Short access-token lifetime so the next request triggers a refresh.
    idp.controls.accessTokenTtlSeconds = 1;
    gw = await createGatewayForTest(idp, upstream, { oidcRefresh: true });
    const { client } = await login(gw, idp);
    const tokenBefore = idp.counts.token;

    // Wait until the access token is expired, then fire concurrent requests.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => client.get("/admin/dashboard")),
    );
    for (const res of results) assert.equal(res.status, 200, res.body);

    const refreshGrants = idp.counts.token - tokenBefore;
    assert.equal(refreshGrants, 1, `expected a single refresh exchange, saw ${refreshGrants}`);
  });

  it("fails closed when a concurrent refresh fails", async () => {
    await gw.close();
    idp.controls.accessTokenTtlSeconds = 1;
    gw = await createGatewayForTest(idp, upstream, { oidcRefresh: true });
    const { client } = await login(gw, idp);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    idp.controls.failTokenExchange = true;
    const res = await client.get("/admin/dashboard");
    assert.equal(res.status, 403, "refresh failure must fail closed");
    assert.equal(upstream.counts["/admin/dashboard"], undefined);
  });

  it("keeps the upstream cookie U1 distinct from the gateway cookie G1", async () => {
    const { client } = await login(gw, idp);
    await client.get("/admin/dashboard");
    // Browser-visible cookie names never include the upstream admin cookie.
    for (const name of client.cookies.keys()) {
      assert.notEqual(name, "cb_admin_session", `browser must not hold ${name}`);
    }
    // The bridge used an upstream cookie that differs from every browser cookie.
    const headers = upstream.lastHeaders["/admin/dashboard"] ?? {};
    const upstreamCookie = String(headers.cookie ?? "");
    assert.ok(upstreamCookie.startsWith("cb_admin_session="), "upstream cookie injected by bridge");
    for (const value of client.cookies.values()) {
      assert.ok(!upstreamCookie.includes(value), "upstream cookie value differs from browser cookies");
    }
  });

  it("suppresses upstream Set-Cookie on every proxied admin response", async () => {
    const { client } = await login(gw, idp);
    const a = await client.get("/admin/dashboard");
    const b = await client.get("/admin/settings");
    assert.equal(a.setCookie.length, 0);
    assert.equal(b.setCookie.length, 0);
  });

  it("does not relay upstream CORS headers", async () => {
    const { client } = await login(gw, idp);
    const res = await client.get("/admin/dashboard");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
    assert.equal(res.headers["access-control-allow-credentials"], undefined);
  });
});
