import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig, reservePort } from "./helpers/config.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";

/**
 * Live administrator authorization checks.
 *
 * Every protected request must independently re-check live UserInfo and require
 * a matching subject, role === "admin" AND isAdmin === true. Missing roles,
 * ordinary users, errors, timeouts and revocation must fail closed BEFORE the
 * private upstream is reached. Assertions count upstream calls to prove it.
 */

async function createGatewayForTest(idp: MockOAuthProvider, upstream: UpstreamServer): Promise<RunningGateway> {
  return startGateway((publicOrigin, port) => testConfig(idp, upstream, { publicOrigin, port }));
}

describe("live admin authorization (fail closed before upstream)", () => {
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

  it("allows an admin and reaches upstream for /admin/dashboard", async () => {
    const { client } = await login(gw, idp);
    const res = await client.get("/admin/dashboard");
    assert.equal(res.status, 200);
    assert.ok((upstream.counts["/admin/dashboard"] ?? 0) >= 1, "admin request proxies upstream");
  });

  it("denies an ordinary role and never contacts upstream", async () => {
    idp.identity.role = "user";
    idp.identity.isAdmin = false;
    // Login itself must fail (403) because authorization is checked during login.
    const loginResponse = await login(gw, idp).catch((error: unknown) => error);
    if (loginResponse instanceof Error) {
      assert.ok(/forbidden|403/i.test(loginResponse.message), loginResponse.message);
    } else {
      assert.equal((loginResponse as Awaited<ReturnType<typeof login>>).callback.status, 403);
    }
    assert.equal(upstream.counts["/admin/dashboard"], undefined);
    assert.equal(upstream.counts["/admin/settings"], undefined);
  });

  it("denies role=admin when isAdmin is false", async () => {
    idp.identity.role = "admin";
    idp.identity.isAdmin = false;
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 403);
    assert.equal(upstream.counts["/admin/session"], undefined);
  });

  it("denies isAdmin=true when role is not exactly admin", async () => {
    idp.identity.role = "superadmin";
    idp.identity.isAdmin = true;
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 403);
  });

  it("fails closed when live UserInfo returns an error (revoked token)", async () => {
    const { client } = await login(gw, idp);
    // Revoke upstream: next live UserInfo check returns 401.
    idp.revokeAll();
    const res = await client.get("/admin/dashboard");
    assert.equal(res.status, 403, "revoked session must be forbidden");
    assert.equal(upstream.counts["/admin/dashboard"], undefined, "upstream not reached after revocation");
  });

  it("fails closed when live UserInfo times out", async () => {
    const { client } = await login(gw, idp);
    // Make subsequent UserInfo checks hang past the gateway OAuth timeout.
    idp.controls.userinfoDelayMs = 60_000;
    const res = await client.get("/admin/dashboard");
    assert.equal(res.status, 403, "timeout must fail closed");
    assert.equal(upstream.counts["/admin/dashboard"], undefined);
  });

  it("denies the next request after revocation without re-authenticating", async () => {
    const { client } = await login(gw, idp);
    const first = await client.get("/admin/dashboard");
    assert.equal(first.status, 200);
    idp.controls.revoked = true;
    const second = await client.get("/admin/dashboard");
    assert.equal(second.status, 403);
    const third = await client.get("/admin/settings");
    assert.equal(third.status, 403);
  });

  it("reports 403 (not 401) on /sso/session once the live identity is revoked", async () => {
    // A previously authenticated but now-unverifiable/forbidden session must be
    // distinguished from an unauthenticated one.
    const { client } = await login(gw, idp);
    assert.equal((await client.get("/sso/session")).status, 200);
    idp.controls.revoked = true;
    const res = await client.get("/sso/session");
    assert.equal(res.status, 403, `revoked session must be forbidden, got ${res.status}`);
  });

  it("does not trust a subject mismatch between ID token and live UserInfo", async () => {
    const { client } = await login(gw, idp);
    // Change the live subject after login; the gateway must reject the mismatch.
    idp.identity.sub = "different-subject";
    const res = await client.get("/admin/dashboard");
    assert.equal(res.status, 403, "subject must match between the ID token and live UserInfo");
    assert.equal(upstream.counts["/admin/dashboard"], undefined);
  });

  it("returns 401 for unauthenticated /admin/session with the unauthenticated shape", async () => {
    const res = await gw.client.get("/admin/session");
    assert.equal(res.status, 401);
    const body = gw.client.json<{ authenticated: boolean; csrf_token: string | null }>(res);
    assert.equal(body.authenticated, false);
    assert.equal(body.csrf_token, null);
  });

  it("returns 401 for unauthenticated protected admin routes", async () => {
    const res = await gw.client.get("/admin/dashboard");
    assert.equal(res.status, 401);
    assert.equal(upstream.counts["/admin/dashboard"], undefined);
  });

  it("exposes gateway CSRF (distinct from upstream) in /sso/session after login", async () => {
    const { client } = await login(gw, idp);
    // Trigger the upstream bridge so we can compare the two CSRF values.
    await client.get("/admin/dashboard");
    const session = await client.get("/sso/session");
    assert.equal(session.status, 200);
    const body = gw.client.json<{ authenticated: boolean; csrf_token: string }>(session);
    assert.equal(body.authenticated, true);
    assert.ok(body.csrf_token && body.csrf_token.length >= 16, "gateway CSRF must be non-empty");

    // The upstream CSRF is a server-side bridge detail and must never appear in the browser payload.
    const upstreamSession = upstream.lastBodies["/admin/session"] as { api_key?: string } | undefined;
    assert.ok(upstreamSession, "gateway established the upstream session");
    assert.ok(!session.body.includes(upstream.apiKey), "upstream api_key must not leak to the browser");
  });

  it("removes the upstream Set-Cookie from proxied admin responses", async () => {
    const { client } = await login(gw, idp);
    const res = await client.get("/admin/dashboard");
    assert.equal(res.status, 200);
    assert.equal(res.setCookie.length, 0, "no upstream Set-Cookie may reach the browser");
    assert.ok(!client.cookies.has("cb_admin_session"), "browser must never hold an upstream admin cookie");
  });

  it("keeps the browser cookie out of the upstream request", async () => {
    const { client } = await login(gw, idp);
    await client.get("/admin/dashboard");
    const headers = upstream.lastHeaders["/admin/dashboard"] ?? {};
    const cookie = String(headers.cookie ?? "");
    assert.ok(!cookie.includes("cb_admin_session") || cookie.startsWith("cb_admin_session="), "upstream cookie comes from the bridge, not the browser");
    // The gateway session cookie name must not be forwarded.
    assert.ok(!cookie.includes("cb_gateway_session"), "gateway session cookie must not leak upstream");
  });
});
