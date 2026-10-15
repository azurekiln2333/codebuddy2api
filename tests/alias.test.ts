import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startMockOAuth, type MockOAuthProvider } from "./fixtures/mock-oauth.js";
import { startUpstream, type UpstreamServer } from "./fixtures/upstream.js";
import { testConfig } from "./helpers/config.js";
import { login, startGateway, type RunningGateway } from "./helpers/gateway.js";
import { HttpClient } from "./helpers/http-client.js";

/**
 * CRITICAL: canonical-path classification and route-alias confusion.
 *
 * A request target that URL-decodes to an admin route but is not the literal
 * admin path (for example `/admin/%73ession` -> `/admin/session`) must not slip
 * past the gateway's synthesized session handling and reach the real upstream
 * route. If the ASGI backend decodes `%73` to `s`, the raw upstream session
 * (including its CSRF) would be returned to the browser, and POST /admin/session
 * would no longer be disabled.
 *
 * The gateway must either reject ambiguous encodings or canonicalize the path
 * BEFORE classification, so only the literal route is handled.
 */

const ALIAS_TARGETS = [
  "/admin/%73ession",
  "/admin/sess%69on",
  "/admin/%73%65%73%73%69%6f%6e",
  "/admin/session/",
  "/admin//session",
  "/admin/./session",
  "/admin/%2e/session",
  "/admin/session%2f",
  "/admin/SESSION",
  "/admin/../admin/session",
];

describe("CRITICAL admin route alias / canonical classification", () => {
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

  for (const target of ALIAS_TARGETS) {
    it(`GET ${target} is not treated-as/served-by the real upstream session route`, async () => {
      const { client } = await login(gw, idp);
      // Warm up the bridge with a genuinely proxied route so the one-time
      // upstream login is not counted as part of the alias probe.
      await client.get("/admin/dashboard");
      const before = upstream.counts["/admin/session"] ?? 0;
      const res = await client.request("GET", target, { rawPath: true });
      const afterCount = upstream.counts["/admin/session"] ?? 0;
      // The gateway must not hand the browser a real upstream session payload.
      // Either reject it, or keep serving its own synthesized shape — but it must
      // never route the alias onto the real /admin/session.
      assert.equal(
        afterCount,
        before,
        `alias ${target} reached the real upstream /admin/session (status ${res.status}): ${res.body.slice(0, 200)}`,
      );
      assert.ok(
        res.status === 400 || res.status === 404 || res.status === 403 || res.status === 405,
        `alias ${target} must not be proxied; got ${res.status}`,
      );
    });
  }

  for (const target of ALIAS_TARGETS) {
    it(`POST ${target} cannot reach the upstream session login`, async () => {
      const { client } = await login(gw, idp);
      // Warm up the bridge first (see above).
      await client.get("/admin/dashboard");
      const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
      const before = upstream.counts["/admin/session"] ?? 0;
      const res = await client.request("POST", target, {
        rawPath: true,
        headers: {
          "content-type": "application/json",
          "x-csrf-token": session.csrf_token,
          origin: gw.origin,
        },
        body: JSON.stringify({ api_key: "x" }),
      });
      assert.ok(res.status >= 400, `POST alias ${target} must be rejected; got ${res.status}`);
      const afterCount = upstream.counts["/admin/session"] ?? 0;
      assert.equal(afterCount, before, `POST alias ${target} reached the upstream session route`);
    });
  }

  it("still serves the literal synthesized session route", async () => {
    const { client } = await login(gw, idp);
    const res = await client.get("/admin/session");
    assert.equal(res.status, 200);
    const body = gw.client.json<{ authenticated: boolean; csrf_token: string }>(res);
    assert.equal(body.authenticated, true);
    assert.ok(body.csrf_token.length >= 16);
  });

  it("still disables the literal POST /admin/session", async () => {
    const { client } = await login(gw, idp);
    const session = gw.client.json<{ csrf_token: string }>(await client.get("/sso/session"));
    const res = await client.post(
      "/admin/session",
      { api_key: "x" },
      { headers: { origin: gw.origin, "x-csrf-token": session.csrf_token } },
    );
    assert.equal(res.status, 405);
  });

  it("denies POST /admin/session with 405 BEFORE the CSRF check", async () => {
    // The disabled method must be reported regardless of CSRF, so a caller can
    // distinguish "wrong method" (405) from "missing CSRF" (403).
    const { client } = await login(gw, idp);
    const res = await client.post("/admin/session", { api_key: "x" });
    assert.equal(res.status, 405, `expected 405 for a disabled method, got ${res.status}`);
  });
});
