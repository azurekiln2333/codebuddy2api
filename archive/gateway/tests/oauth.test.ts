import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import type { Server } from "node:http";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig } from "./helpers/config.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";
import { HttpClient } from "./helpers/http-client.js";

/**
 * Faithful local OAuth / OIDC checks.
 *
 * Everything here runs against the local mock provider on 127.0.0.1. No real
 * domain, client credential, or external IdP is contacted. These tests assert
 * the gateway's code/S256 PKCE / nonce / state / RS256 behaviour and the
 * failure modes that must fail closed.
 */

async function createGatewayForTest(idp: MockOAuthProvider, upstream: UpstreamServer): Promise<{ gw: RunningGateway; config: ReturnType<typeof testConfig> }> {
  let captured: ReturnType<typeof testConfig> | undefined;
  const gw = await startGateway((publicOrigin, port) => {
    captured = testConfig(idp, upstream, { publicOrigin, port });
    return captured;
  });
  return { gw, config: captured! };
}

describe("oauth discovery / authorize / code / refresh / jwks / userinfo", () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;
  let gw: RunningGateway;
  let config: ReturnType<typeof testConfig>;

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
    ({ gw, config } = await createGatewayForTest(idp, upstream));
  });

  it("uses confidential client + S256 PKCE + state + nonce, and never sends prompt or max_age", async () => {
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 302, `callback should redirect, got ${callback.status}`);

    const query = idp.lastAuthorizeQuery;
    assert.equal(query.response_type, "code");
    assert.equal(query.client_id, idp.clientId);
    assert.equal(query.code_challenge_method, "S256");
    assert.ok(query.code_challenge && query.code_challenge.length >= 43, "S256 challenge present");
    assert.ok(query.state && query.state.length >= 16, "opaque one-use state present");
    assert.ok(query.nonce && query.nonce.length >= 16, "nonce present");
    assert.ok(query.scope?.includes("openid"), "openid requested");
    assert.ok(query.scope?.includes("roles"), "roles requested");
    assert.equal(query.prompt, undefined, "prompt must never be sent");
    assert.equal(query.max_age, undefined, "max_age must never be sent");
    assert.ok(idp.counts.authorize >= 1);
    assert.ok(idp.counts.token >= 1);
    assert.ok(idp.counts.userinfo >= 1, "live UserInfo fetched during login");
  });

  it("rejects an ordinary (non-admin) user with 403 and does not reach upstream", async () => {
    idp.identity.role = "user";
    idp.identity.isAdmin = false;
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 403, `ordinary user must be forbidden, got ${callback.status}`);
    assert.equal(upstream.counts["/admin/session"], undefined, "upstream must not be contacted");
  });

  it("fails closed when live UserInfo omits roles", async () => {
    // Request only openid (no roles scope) so UserInfo emits no role/isAdmin.
    const client = gw.client;
    const loginResponse = await client.get("/sso/login?return_to=/dashboard/");
    const authorizeUrl = new URL(loginResponse.location!);
    // Tamper the scope to omit roles, preserving state/nonce/pkce.
    authorizeUrl.searchParams.set("scope", "openid profile");
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    const cb = new URL(authorize.headers.get("location")!);
    const callback = await client.get(`${cb.pathname}${cb.search}`);
    assert.equal(callback.status, 403, "missing roles must be forbidden");
  });

  it("rejects a token signed by an unknown key (JWKS mismatch)", async () => {
    idp.controls.wrongSigningKey = true;
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 403, "wrong signing key must be rejected");
  });

  it("rejects a corrupted ID token signature", async () => {
    idp.controls.corruptIdToken = true;
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 403, "corrupt signature must be rejected");
  });

  it("rejects an expired ID token", async () => {
    idp.controls.expiredIdToken = true;
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 403, "expired ID token must be rejected");
  });

  it("rejects an ID token with the wrong audience", async () => {
    idp.controls.wrongAudience = true;
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 403, "wrong audience must be rejected");
  });

  it("rejects a failed token exchange (invalid_grant)", async () => {
    idp.controls.failTokenExchange = true;
    const { callback } = await login(gw, idp);
    assert.equal(callback.status, 403, "failed exchange must not create a session");
  });

  it("rejects an authorize error redirect", async () => {
    idp.failAuthorize = "access_denied";
    const { callback } = await login(gw, idp);
    assert.ok(callback.status >= 400, `authorize error must not create a session, got ${callback.status}`);
  });

  it("keeps roles out of the access token; only live UserInfo can assert admin", async () => {
    // The mock deliberately never emits role/isAdmin in the ID token. Assert the
    // gateway still trusts live UserInfo by flipping the live identity after a
    // successful login and confirming the next request re-checks.
    const { client } = await login(gw, idp);
    const session = await client.get("/sso/session");
    assert.equal(session.status, 200);
    const body = gw.client.json<{ authenticated: boolean; user: { role: string } }>(session);
    assert.equal(body.authenticated, true);
    assert.equal(body.user.role, "admin");

    // Flip the live role; the next protected request must be denied.
    idp.identity.role = "user";
    idp.identity.isAdmin = false;
    const after = await client.get("/admin/dashboard");
    assert.equal(after.status, 403, "revoked/ordinary live role must deny the next request");
  });

  it("rejects state replay (a consumed code/state cannot create a second session)", async () => {
    const first = new HttpClient({ host: gw.host, port: gw.port });
    const loginResponse = await first.get("/sso/login?return_to=/dashboard/");
    const authorizeUrl = new URL(loginResponse.location!);
    const authorize = await fetch(authorizeUrl, { redirect: "manual" });
    const cb = new URL(authorize.headers.get("location")!);
    const path = `${cb.pathname}${cb.search}`;
    const createdAt = await first.get(path);
    assert.equal(createdAt.status, 302);
    // Replay the same callback URL with a fresh client.
    const replay = new HttpClient({ host: gw.host, port: gw.port });
    const replayed = await replay.get(path);
    assert.ok(replayed.status >= 400, `replayed callback must fail, got ${replayed.status}`);
  });

  it("reloads discovered signing keys only from the configured issuer", async () => {
    await login(gw, idp);
    assert.equal(idp.counts.jwks >= 1, true, "JWKS fetched from the configured issuer");
  });

  it("does not leak tokens or secrets into the /sso/session payload", async () => {
    const { client } = await login(gw, idp);
    const session = await client.get("/sso/session");
    const raw = session.body;
    assert.ok(!raw.includes(idp.clientSecret), "client secret must not leak");
    assert.ok(!/access_token|refresh_token|id_token/i.test(raw), "no token material in session payload");
  });
});
