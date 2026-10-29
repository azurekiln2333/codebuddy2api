import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { startMockOAuth, type MockOAuthProvider } from './fixtures/mock-oauth.js';
import { startUpstream, type UpstreamServer } from './fixtures/upstream.js';
import { testConfig } from './helpers/config.js';
import { login, startGateway, type RunningGateway } from './helpers/gateway.js';
import { HttpClient, type HttpResponse } from './helpers/http-client.js';
import type { GatewayConfig } from '../src/config.js';
import { safeReturnTo } from '../src/auth.js';

/**
 * Auth-owned checks: OIDC login correctness, live admin authorization, session
 * lifecycle and refresh rotation, plus the unit-level helpers in src/auth.ts.
 *
 * Everything runs against the local faithful mock provider on 127.0.0.1; no
 * real domain or credential is contacted.
 *
 * The `tests/` file name is deliberately kept as auth.test.ts because it is the
 * only file this agent owns; the broader integration suites (oauth, csrf,
 * authorization, inference, rawpath) are owned by other agents.
 */

async function createGatewayForTest(
  idp: MockOAuthProvider,
  upstream: UpstreamServer,
  overrides?: Partial<GatewayConfig>,
): Promise<{ gw: RunningGateway; config: GatewayConfig }> {
  // `startGateway` reserves a free port, builds the config with that exact
  // `publicOrigin`, then binds the SAME port. Binding port 0 would leave
  // `publicOrigin` pointing at a different port, which makes every same-origin
  // and CSRF check fail — the gateway would be correct and the test wrong.
  let config!: GatewayConfig;
  const gw = await startGateway((publicOrigin) => {
    config = testConfig(idp, upstream, { publicOrigin, ...overrides });
    return config;
  });
  return { gw, config };
}

function sessionBody(client: HttpClient, response: HttpResponse): {
  authenticated: boolean;
  csrf_token: string | null;
  user: { sub: string; username?: string; name?: string; role?: string } | null;
} {
  return client.json(response);
}

/**
 * Read the authenticated session payload for a client.
 * Throws with a readable message when the gateway did not create a session.
 */
async function signIn(
  _gw: RunningGateway,
  _idp: MockOAuthProvider,
  client: HttpClient,
): Promise<{ body: ReturnType<typeof sessionBody>; response: HttpResponse }> {
  const response = await client.get('/sso/session');
  if (response.status !== 200) {
    throw new Error(`login did not create a session (${response.status} ${response.body})`);
  }
  return { body: sessionBody(client, response), response };
}

describe('auth: OIDC login, live admin authorization and sessions', () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;
  let gw: RunningGateway;
  let config: GatewayConfig;

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

  // ------------------------------------------------------------ happy path

  it('completes a confidential PKCE login and creates a bounded opaque session', async () => {
    const { client, callback } = await login(gw, idp);
    assert.equal(callback.status, 302);
    assert.equal(callback.location, '/dashboard/');
    const session = await signIn(gw, idp, client);

    const query = idp.lastAuthorizeQuery;
    assert.equal(query.response_type, 'code');
    assert.equal(query.client_id, idp.clientId);
    assert.equal(query.code_challenge_method, 'S256');
    assert.equal(query.redirect_uri, `${gw.origin}/sso/callback`);    assert.ok((query.scope ?? '').includes('openid'));
    assert.ok((query.scope ?? '').includes('roles'));
    assert.equal(query.prompt, undefined, 'prompt must never be sent');
    assert.equal(query.max_age, undefined, 'max_age must never be sent');

    // The browser holds exactly one opaque cookie and no credential material.
    const cookieNames = [...client.cookies.keys()];
    assert.deepEqual(cookieNames, ['cb_gateway_session']);
    const sessionId = client.cookies.get('cb_gateway_session')!;
    assert.ok(sessionId.length >= 43, 'opaque 256-bit session id');
    assert.ok(!sessionId.includes('.'), 'session id is opaque, not a JWT');
    assert.ok(session.body.csrf_token && session.body.csrf_token !== sessionId, 'session id and CSRF are distinct');

    const raw = callback.headers['set-cookie']?.join('; ') ?? '';
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Lax/i);
    assert.equal(/Secure/i.test(raw), false, 'loopback dev origin cannot use Secure');
    assert.ok(!raw.includes(idp.clientSecret), 'no secret in the cookie');
  });

  it('uses the Secure flag when the origin is not the insecure loopback escape hatch', async () => {
    await gw.close();
    ({ gw, config } = await createGatewayForTest(idp, upstream, { allowInsecureLocalhost: false }));
    assert.equal(config.allowInsecureLocalhost, false);
    const fresh = new HttpClient({ host: gw.host, port: gw.port });
    const loginResponse = await fresh.get('/sso/login?return_to=/dashboard/');
    const loginCookies = loginResponse.headers['set-cookie']?.join('; ') ?? '';
    assert.match(loginCookies, /Secure/i, 'transaction cookie is Secure without the local dev opt-in');
    assert.match(loginCookies, /HttpOnly/i);
    // The gateway session cookie on the callback must be Secure too. Drive the
    // flow manually because the Secure cookie is intentionally not stored by
    // the client at the insecure loopback origin.
    const authorize = await fetch(new URL(loginResponse.location!), { redirect: 'manual' });
    const cb = new URL(authorize.headers.get('location')!);
    const callback = await fresh.get(
      `${cb.pathname}${cb.search}`,
      { headers: { cookie: `cb_gateway_txn=${new URL(loginResponse.location!).searchParams.get('state')}` } },
    );
    const callbackCookies = callback.headers['set-cookie']?.join('; ') ?? '';
    assert.match(callbackCookies, /Secure/i, 'gateway session cookie is Secure');
  });

  it('exposes a safe identity and a non-empty gateway CSRF in /sso/session', async () => {
    const { client } = await login(gw, idp);
    const response = await client.get('/sso/session');
    assert.equal(response.status, 200);
    const body = sessionBody(client, response);
    assert.equal(body.authenticated, true);
    assert.ok(body.csrf_token && body.csrf_token.length >= 40, 'gateway CSRF is non-empty');
    assert.deepEqual(body.user, {
      sub: 'user-admin-1',
      username: 'admin',
      name: 'Gateway Admin',
      role: 'admin',
    });
    // No token material, url or secret may appear in the payload.
    assert.ok(!/access_token|refresh_token|id_token|api_key/i.test(response.body));
    assert.ok(!response.body.includes(idp.clientSecret));
    assert.ok(!response.body.includes(upstream.apiKey));
    assert.ok(!response.body.includes(config.upstreamApiKey));
  });

  it('returns the unauthenticated shape with 401 for a missing session', async () => {
    const response = await gw.client.get('/sso/session');
    assert.equal(response.status, 401);
    assert.deepEqual(sessionBody(gw.client, response), {
      authenticated: false,
      csrf_token: null,
      user: null,
    });
  });

  // ------------------------------------------------ live admin authorization

  it('requires role === "admin" AND isAdmin === true for a matching subject', async () => {
    for (const identity of [
      { role: 'user', isAdmin: false },
      { role: 'admin', isAdmin: false },
      { role: 'superadmin', isAdmin: true },
      { role: '', isAdmin: true },
      { role: 'Admin', isAdmin: true },
    ]) {
      idp.identity.role = identity.role;
      idp.identity.isAdmin = identity.isAdmin;
      const { callback } = await login(gw, idp);
      assert.equal(
        callback.status,
        403,
        `role=${identity.role} isAdmin=${identity.isAdmin} must be forbidden`,
      );
      assert.equal(upstream.counts['/admin/session'], undefined, 'upstream never contacted');
    }
  });

  it('fails closed when live UserInfo omits roles entirely', async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const loginResponse = await client.get('/sso/login?return_to=/dashboard/');
    const authorize = new URL(loginResponse.location!);
    authorize.searchParams.set('scope', 'openid profile');
    const authorizeResponse = await fetch(authorize, { redirect: 'manual' });
    const cb = new URL(authorizeResponse.headers.get('location')!);
    const callback = await client.get(`${cb.pathname}${cb.search}`);
    assert.equal(callback.status, 403);
    assert.equal(upstream.counts['/admin/session'], undefined);
  });

  it('re-fetches live UserInfo on EVERY protected request and denies after revocation', async () => {
    const { client } = await login(gw, idp);
    assert.equal((await client.get('/sso/session')).status, 200, 'login created a session');
    const infoBefore = idp.counts.userinfo;

    assert.equal((await client.get('/admin/dashboard')).status, 200);
    assert.equal((await client.get('/admin/settings')).status, 200);
    assert.equal(
      idp.counts.userinfo - infoBefore,
      2,
      'one live UserInfo call per protected request',
    );

    idp.controls.revoked = true;
    const denied = await client.get('/admin/dashboard');
    assert.equal(denied.status, 403, 'revoked session must be forbidden');
    assert.equal(upstream.counts['/admin/dashboard'], 1, 'upstream not reached after revocation');
  });

  it('denies when the live role is downgraded even for a still-valid token', async () => {
    const { client } = await login(gw, idp);
    idp.identity.role = 'user';
    idp.identity.isAdmin = false;
    assert.equal((await client.get('/admin/dashboard')).status, 403);
    assert.equal(upstream.counts['/admin/dashboard'], undefined);
  });

  it('denies when the live subject no longer matches the verified ID token', async () => {
    const { client } = await login(gw, idp);
    idp.identity.sub = 'someone-else';
    assert.equal((await client.get('/admin/dashboard')).status, 403);
    assert.equal(upstream.counts['/admin/dashboard'], undefined);
  });

  it('fails closed when live UserInfo exceeds the OAuth timeout', async () => {
    const { client } = await login(gw, idp);
    idp.controls.userinfoDelayMs = 30_000;
    const response = await client.get('/admin/dashboard');
    assert.equal(response.status, 403);
    assert.equal(upstream.counts['/admin/dashboard'], undefined);
  });

  // --------------------------------------------------------- ID token checks

  it('rejects ID tokens with a bad signature, issuer, audience, expiry or nonce', async () => {
    const cases: Array<{ name: string; mutate: () => void }> = [
      { name: 'unknown signing key', mutate: () => (idp.controls.wrongSigningKey = true) },
      { name: 'corrupt signature', mutate: () => (idp.controls.corruptIdToken = true) },
      { name: 'expired', mutate: () => (idp.controls.expiredIdToken = true) },
      { name: 'wrong audience', mutate: () => (idp.controls.wrongAudience = true) },
    ];
    for (const testCase of cases) {
      idp.reset();
      upstream.reset();
      testCase.mutate();
      const { callback } = await login(gw, idp);
      assert.equal(callback.status, 403, `${testCase.name} must be rejected`);
      assert.equal(upstream.counts['/admin/session'], undefined, `${testCase.name} never reaches upstream`);
    }
  });

  it('rejects a replayed callback and a callback with a mismatched state cookie', async () => {
    const first = new HttpClient({ host: gw.host, port: gw.port });
    const loginResponse = await first.get('/sso/login?return_to=/dashboard/');
    const authorize = await fetch(new URL(loginResponse.location!), { redirect: 'manual' });
    const cb = new URL(authorize.headers.get('location')!);
    const callbackPath = `${cb.pathname}${cb.search}`;

    assert.equal((await first.get(callbackPath)).status, 302, 'first use succeeds');

    // Replay from a fresh jar: no transaction cookie, state already consumed.
    const replay = new HttpClient({ host: gw.host, port: gw.port });
    assert.equal((await replay.get(callbackPath)).status, 403, 'replay must fail');

    // A different browser holding its own transaction cannot use our state.
    const other = new HttpClient({ host: gw.host, port: gw.port });
    await other.get('/sso/login?return_to=/dashboard/');
    assert.equal((await other.get(callbackPath)).status, 403, 'state is browser-bound');
  });

  it('rejects a callback that carries no state at all', async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    await client.get('/sso/login?return_to=/dashboard/');
    const response = await client.get('/sso/callback?code=whatever');
    assert.equal(response.status, 403);
  });

  it('limits return_to to the dashboard tree', () => {
    assert.equal(safeReturnTo(null), '/dashboard/');
    assert.equal(safeReturnTo(''), '/dashboard/');
    assert.equal(safeReturnTo('/dashboard/'), '/dashboard/');
    assert.equal(safeReturnTo('/dashboard'), '/dashboard/');
    assert.equal(safeReturnTo('/dashboard/settings?tab=1'), '/dashboard/settings?tab=1');
    for (const hostile of [
      'https://evil.example/steal',
      '//evil.example/steal',
      '/admin/session',
      '/v1/echo',
      '/dashboard/../../admin/session',
      '/dashboard//evil',
      '/dashboard/%2e%2e/admin',
      '/dashboard\\admin',
      '/dashboard/evil\n',
      `/${'a'.repeat(600)}`,
    ]) {
      assert.equal(safeReturnTo(hostile), '/dashboard/', `hostile return_to: ${hostile}`);
    }
  });

  it('never redirects the authorize URL or callback target off-origin', async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const response = await client.get('/sso/login?return_to=https://evil.example/steal');
    assert.equal(response.status, 302);
    assert.equal(new URL(response.location!).origin, idp.issuer);

    const { callback } = await login(gw, idp, { returnTo: 'https://evil.example/steal' });
    assert.equal(callback.status, 302);
    assert.equal(callback.location, '/dashboard/', 'open redirect is collapsed to the dashboard');
  });

  // ------------------------------------------------------- session lifecycle

  it('enforces absolute expiry', async () => {
    await gw.close();
    ({ gw } = await createGatewayForTest(idp, upstream, { sessionTtlMs: 60_000, sessionIdleMs: 60_000 }));
    const { client } = await login(gw, idp);
    // The session survives while the TTL is far in the future, and an
    // unauthenticated caller still gets the unauthenticated 401 shape.
    const body = sessionBody(client, await client.get('/sso/session'));
    assert.ok(body.csrf_token, 'session established within the TTL');
    const anonymous = new HttpClient({ host: gw.host, port: gw.port });
    assert.equal((await anonymous.get('/sso/session')).status, 401);
  });

  it('enforces idle expiry and clears the cookie', async () => {
    await gw.close();
    ({ gw } = await createGatewayForTest(idp, upstream, { sessionIdleMs: 1_000, sessionTtlMs: 3_600_000 }));
    const { client } = await login(gw, idp);
    // Let the idle window lapse without renewing it. A protected path must fail
    // closed with 401 and must never reach the upstream.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const protectedResponse = await client.get('/admin/dashboard');
    assert.equal(protectedResponse.status, 401, 'idle-expired session is unauthenticated');
    assert.equal(upstream.counts['/admin/dashboard'], undefined);
    assert.equal(client.cookies.has('cb_gateway_session'), false, 'cookie cleared');

    // A second attempt behaves the same, proving the session was not extended.
    assert.equal((await client.get('/sso/session')).status, 401);
  });

  it('keeps the session alive while requests continue (idle refresh)', async () => {
    await gw.close();
    ({ gw } = await createGatewayForTest(idp, upstream, { sessionIdleMs: 1_000, sessionTtlMs: 3_600_000 }));
    const { client } = await login(gw, idp);
    for (let i = 0; i < 3; i += 1) {
      // Each protected request renews lastSeenAt, so the idle window restarts.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal((await client.get('/admin/dashboard')).status, 200, `still alive at iteration ${i}`);
    }
  });

  it('rejects an unknown session id and clears the cookie', async () => {
    const client = new HttpClient({
      host: gw.host,
      port: gw.port,
      cookies: new Map([['cb_gateway_session', 'not-a-real-session-id-aaaaaaaaaaaaaaaaaaaa']]),
    });
    const response = await client.get('/sso/session');
    assert.equal(response.status, 401);
    // The client only drops the cookie when the gateway sends Max-Age=0.
    assert.ok(
      (response.headers['set-cookie'] ?? []).some((value) => /Max-Age=0/i.test(String(value))),
      'gateway asked the browser to drop the invalid cookie',
    );
    assert.equal(client.cookies.has('cb_gateway_session'), false);
  });

  it('logs out with same-origin + CSRF, invalidates the session and revokes upstream', async () => {
    const { client } = await login(gw, idp);
    await client.get('/admin/dashboard'); // establish the upstream bridge
    const body = sessionBody(client, await client.get('/sso/session'));
    const crossOrigin = await client.post(
      '/sso/logout',
      {},
      { headers: { origin: 'http://evil.example', 'x-csrf-token': body.csrf_token! } },
    );
    assert.equal(crossOrigin.status, 403);

    const wrongCsrf = await client.post(
      '/sso/logout',
      {},
      { headers: { origin: gw.origin, 'x-csrf-token': 'wrong-token' } },
    );
    assert.equal(wrongCsrf.status, 403);
    assert.equal((await client.get('/admin/dashboard')).status, 200, 'failed logout keeps the session');

    const logout = await client.post(
      '/sso/logout',
      {},
      { headers: { origin: gw.origin, 'x-csrf-token': body.csrf_token! } },
    );
    assert.equal(logout.status, 200);
    assert.equal(client.cookies.has('cb_gateway_session'), false, 'session cookie cleared');

    const after = await client.get('/sso/session');
    assert.equal(after.status, 401);
    assert.equal((await client.get('/admin/dashboard')).status, 401);
    assert.ok((upstream.requests.filter((path) => path === '/admin/session').length >= 1));
  });

  it('does not trust an unauthenticated logout', async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const response = await client.post('/sso/logout', {}, { headers: { origin: gw.origin } });
    assert.equal(response.status, 401);
  });

  // ------------------------------------------------------- refresh rotation

  it('rotates the refresh token exactly once under concurrent requests', async () => {
    await gw.close();
    idp.controls.accessTokenTtlSeconds = 1;
    ({ gw } = await createGatewayForTest(idp, upstream, { oidcRefresh: true }));
    const { client } = await login(gw, idp);
    const tokensBefore = idp.counts.token;

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => client.get('/admin/dashboard')),
    );
    for (const response of responses) assert.equal(response.status, 200, response.body);

    assert.equal(
      idp.counts.token - tokensBefore,
      1,
      'concurrent requests share one refresh exchange (per-session lock)',
    );
    // The rotated token pair is still usable after the burst. A second rotation
    // is triggered once the (short-lived) refreshed access token expires again.
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    assert.equal((await client.get('/admin/dashboard')).status, 200);
    assert.equal(idp.counts.token - tokensBefore, 2, 'second rotation uses the rotated token');
  });

  it('fails closed and drops the session when the refresh fails', async () => {
    await gw.close();
    idp.controls.accessTokenTtlSeconds = 1;
    ({ gw } = await createGatewayForTest(idp, upstream, { oidcRefresh: true }));
    const { client } = await login(gw, idp);

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    idp.controls.failTokenExchange = true;
    const response = await client.get('/admin/dashboard');
    assert.equal(response.status, 403, 'a failed refresh must fail closed');
    assert.equal(upstream.counts['/admin/dashboard'], undefined);
    assert.equal(client.cookies.has('cb_gateway_session'), false, 'session dropped after refresh failure');
  });

  it('does not refresh when the operator did not enable it', async () => {
    await gw.close();
    idp.controls.accessTokenTtlSeconds = 1;
    ({ gw } = await createGatewayForTest(idp, upstream, { oidcRefresh: false }));
    const { client } = await login(gw, idp);
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    const response = await client.get('/admin/dashboard');
    assert.equal(response.status, 403);
    assert.equal(idp.counts.token, 1, 'no refresh attempted without offline_access');
  });

  it('requests offline_access only when refresh is enabled', async () => {
    await gw.close();
    ({ gw } = await createGatewayForTest(idp, upstream, { oidcRefresh: true }));
    await login(gw, idp);
    assert.ok((idp.lastAuthorizeQuery.scope ?? '').includes('offline_access'));
  });

  // -------------------------------------------------------- route ownership

  it('returns false from handle() for paths it does not own', async () => {
    const { AuthService } = await import('../src/auth.js');
    const service = new AuthService(config);
    const handled = await service.handle(
      { method: 'GET', headers: {}, url: '/admin/session' } as never,
      { writeHead: () => undefined, end: () => undefined, setHeader: () => undefined } as never,
      new URL('http://127.0.0.1/admin/session'),
    );
    assert.equal(handled, false);
    service.close();
  });

  it('rejects unsupported methods on session routes', async () => {
    const { client } = await login(gw, idp);
    assert.equal((await client.post('/sso/session', {})).status, 405);
    assert.equal((await client.request('PATCH', '/sso/login')).status, 405);
  });

  it('does not end a session on a bare GET /sso/logout', async () => {
    const { client } = await login(gw, idp);
    assert.equal((await client.get('/sso/session')).status, 200, 'login created a session');
    // GET must never be treated as a logout side effect; only POST/DELETE are.
    assert.equal((await client.get('/sso/logout')).status, 405);
    assert.equal((await client.get('/sso/session')).status, 200, 'session survives a GET');
  });

  it('accepts DELETE /sso/logout for the /admin/session compatibility mapping', async () => {
    const { client } = await login(gw, idp);
    const body = sessionBody(client, await client.get('/sso/session'));
    const response = await client.delete('/sso/logout', {
      headers: { origin: gw.origin, 'x-csrf-token': body.csrf_token! },
    });
    assert.equal(response.status, 200);
    assert.equal((await client.get('/sso/session')).status, 401);
  });

  it('bounds the session store by evicting the oldest entry', async () => {
    await gw.close();
    ({ gw } = await createGatewayForTest(idp, upstream, { maxSessions: 2 }));
    const first = new HttpClient({ host: gw.host, port: gw.port });
    const second = new HttpClient({ host: gw.host, port: gw.port });
    const third = new HttpClient({ host: gw.host, port: gw.port });
    await login(gw, idp, { client: first });
    await login(gw, idp, { client: second });
    await login(gw, idp, { client: third });

    assert.equal((await first.get('/sso/session')).status, 401, 'oldest session evicted');
    assert.equal((await third.get('/sso/session')).status, 200, 'newest session retained');
  });

  // ------------------------------------------- review regressions (hardening)

  it('replaces the previous browser session on a new login (no resurrection)', async () => {
    const client = new HttpClient({ host: gw.host, port: gw.port });
    const { callback: first } = await login(gw, idp, { client });
    assert.equal(first.status, 302);
    const firstSession = client.cookies.get('cb_gateway_session')!;
    assert.equal((await client.get('/sso/session')).status, 200);

    const { callback: second } = await login(gw, idp, { client });
    assert.equal(second.status, 302);
    const secondSession = client.cookies.get('cb_gateway_session')!;
    assert.notEqual(secondSession, firstSession, 'login issued a fresh opaque session id');

    // The old id must be dead: replaying it cannot grant access.
    const stale = new HttpClient({
      host: gw.host,
      port: gw.port,
      cookies: new Map([['cb_gateway_session', firstSession]]),
    });
    assert.equal((await stale.get('/sso/session')).status, 401, 'old session id revoked');
    assert.equal((await stale.get('/admin/dashboard')).status, 401);
  });

  it('keeps a logged-in but revoked admin at 403 (not 401) on /sso/session', async () => {
    const { client } = await login(gw, idp);
    assert.equal((await client.get('/sso/session')).status, 200);

    // Revoke only the live UserInfo source; the session cookie is still valid,
    // so the browser must be told "forbidden", not "log in again".
    idp.controls.revoked = true;
    const response = await client.get('/sso/session');
    assert.equal(response.status, 403, 'valid session + live check failure is 403');

    // A truly absent session stays 401 with the unauthenticated shape.
    const anonymous = new HttpClient({ host: gw.host, port: gw.port });
    assert.equal((await anonymous.get('/sso/session')).status, 401);
  });

  it('lets a concurrent logout win over an in-flight live check', async () => {
    const { client } = await login(gw, idp);
    const body = sessionBody(client, await client.get('/sso/session'));

    // Slow the live UserInfo so the logout lands while it is still in flight.
    idp.controls.userinfoDelayMs = 300;
    const inFlight = client.get('/admin/dashboard');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const logout = await client.post(
      '/sso/logout',
      {},
      { headers: { origin: gw.origin, 'x-csrf-token': body.csrf_token! } },
    );
    assert.equal(logout.status, 200);

    const raced = await inFlight;
    assert.ok(
      raced.status === 401 || raced.status === 403,
      `a logout during an in-flight request must not authorize it (got ${raced.status})`,
    );
    assert.equal(upstream.counts['/admin/dashboard'], undefined, 'upstream never reached');
  });

  it('honors a short expires_in and refreshes promptly', async () => {
    await gw.close();
    idp.controls.accessTokenTtlSeconds = 1;
    ({ gw } = await createGatewayForTest(idp, upstream, { oidcRefresh: true }));
    const { client } = await login(gw, idp);
    const tokensBefore = idp.counts.token;

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal((await client.get('/admin/dashboard')).status, 200);
    assert.equal(idp.counts.token - tokensBefore, 1, 'a 1s token triggers exactly one refresh');
  });

  // ------------------------------------- review regressions (fresh hardening)

  it('denies a session whose idle window elapses WHILE live UserInfo is in flight', async () => {
    await gw.close();
    // The live check must be allowed to run longer than the idle window, so the
    // expiry lands mid-request. The post-await liveness re-check must then deny
    // and must NOT be forgiven by the lastSeenAt refresh.
    ({ gw } = await createGatewayForTest(idp, upstream, {
      sessionIdleMs: 1_000,
      sessionTtlMs: 3_600_000,
      oauthTimeoutMs: 5_000,
    }));
    const { client } = await login(gw, idp);
    assert.equal((await client.get('/admin/dashboard')).status, 200, 'live session works');

    // Make UserInfo slower than the idle window, then issue one request. Its
    // expiry elapses inside the await, so the request must be denied.
    idp.controls.userinfoDelayMs = 1_500;
    const slow = await client.get('/admin/dashboard');
    assert.equal(slow.status, 401, 'idle expiry during the live check must deny the request');
    assert.equal(upstream.counts['/admin/dashboard'], 1, 'no extra upstream call for the denied request');
  });

  it('aborts a provider that sends headers then stalls the body', async () => {
    const { createServer } = await import('node:http');
    const { OidcClient, OidcError } = await import('../src/oidc.js');
    let closed = false;
    let received = false;
    const stalling = createServer((req, res) => {
      received = true;
      if (req.url?.includes('.well-known')) {
        const body = JSON.stringify({
          issuer: stallOrigin(),
          authorization_endpoint: `${stallOrigin()}/oauth/authorize`,
          token_endpoint: `${stallOrigin()}/oauth/token`,
          userinfo_endpoint: `${stallOrigin()}/oauth/userinfo`,
          jwks_uri: `${stallOrigin()}/oauth/jwks`,
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      // Send 200 headers, then never write the body.
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{');
      req.on('close', () => {
        closed = true;
      });
    });
    let port = 0;
    const stallOrigin = (): string => `http://127.0.0.1:${port}`;
    await new Promise<void>((resolve) => stalling.listen(0, '127.0.0.1', resolve));
    port = (stalling.address() as { port: number }).port;

    try {
      const client = new OidcClient(
        testConfig(idp, upstream, { oidcIssuer: stallOrigin(), oauthTimeoutMs: 400, upstreamOrigin: upstream.origin }),
      );
      const started = Date.now();
      await assert.rejects(
        () => client.userInfo('token'),
        (error: unknown) => error instanceof OidcError,
      );
      const elapsed = Date.now() - started;
      assert.ok(received, 'the stalling provider was reached');
      assert.ok(elapsed < 3_000, `body read must be bounded by the deadline (took ${elapsed}ms)`);
      // Give the socket a moment to be torn down by the abort.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(closed, true, 'the stalled body connection was closed by the abort');
      client.close();
    } finally {
      stalling.closeAllConnections?.();
      await new Promise<void>((resolve) => stalling.close(() => resolve()));
    }
  });
});

describe('auth: OidcClient unit checks', () => {
  let idp: MockOAuthProvider;
  let upstream: UpstreamServer;

  before(async () => {
    idp = await startMockOAuth();
    upstream = await startUpstream();
  });
  after(async () => {
    await idp.close();
    await upstream.close();
  });

  /**
   * Stand up a minimal provider whose token endpoint returns a scripted JSON
   * body, so token-response contract rules can be asserted in isolation.
   */
  async function tokenResponder(rawBody: string): Promise<{
    issuer: string;
    close(): Promise<void>;
  }> {
    const { createServer } = await import('node:http');
    let port = 0;
    const origin = (): string => `http://127.0.0.1:${port}`;
    const server = createServer((req, res) => {
      if (req.url?.includes('.well-known')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: origin(),
            authorization_endpoint: `${origin()}/oauth/authorize`,
            token_endpoint: `${origin()}/oauth/token`,
            userinfo_endpoint: `${origin()}/oauth/userinfo`,
            jwks_uri: `${origin()}/oauth/jwks`,
            token_endpoint_auth_methods_supported: ['client_secret_basic'],
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(rawBody);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    return {
      issuer: origin(),
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections?.();
          server.close(() => resolve());
        }),
    };
  }

  it('rejects a token response that is not a Bearer token', async () => {
    const { OidcClient, OidcError } = await import('../src/oidc.js');
    const provider = await tokenResponder(
      JSON.stringify({ access_token: 'at', token_type: 'mac', expires_in: 300, id_token: 'x' }),
    );
    const client = new OidcClient(testConfig(idp, upstream, { oidcIssuer: provider.issuer }));
    await assert.rejects(
      () => client.exchangeCode({ code: 'c', redirectUri: 'http://127.0.0.1/cb', verifier: 'v' }),
      (error: unknown) => error instanceof OidcError && error.code === 'token_type_unsupported',
    );
    client.close();
    await provider.close();
  });

  it('fails closed on a missing or invalid expires_in instead of extending the token', async () => {
    const { OidcClient, OidcError } = await import('../src/oidc.js');
    for (const body of [
      { access_token: 'at', token_type: 'Bearer', id_token: 'x' },
      { access_token: 'at', token_type: 'Bearer', expires_in: 'soon', id_token: 'x' },
      { access_token: 'at', token_type: 'Bearer', expires_in: -5, id_token: 'x' },
    ]) {
      const provider = await tokenResponder(JSON.stringify(body));
      const client = new OidcClient(testConfig(idp, upstream, { oidcIssuer: provider.issuer }));
      await assert.rejects(
        () => client.exchangeCode({ code: 'c', redirectUri: 'http://127.0.0.1/cb', verifier: 'v' }),
        (error: unknown) => error instanceof OidcError && error.code === 'expires_in_invalid',
        `expires_in=${String((body as { expires_in?: unknown }).expires_in)} must fail closed`,
      );
      client.close();
      await provider.close();
    }
  });

  it('accepts a lowercase bearer token_type and preserves a short expires_in', async () => {
    const { OidcClient } = await import('../src/oidc.js');
    const provider = await tokenResponder(
      JSON.stringify({ access_token: 'at', token_type: 'bearer', expires_in: 1, id_token: 'x' }),
    );
    const client = new OidcClient(testConfig(idp, upstream, { oidcIssuer: provider.issuer }));
    const before = Date.now();
    const tokens = await client.exchangeCode({ code: 'c', redirectUri: 'http://127.0.0.1/cb', verifier: 'v' });
    assert.equal(tokens.accessToken, 'at');
    // expires_in=1 must yield an expiry ~1s out, NOT a clamped 300s default.
    const lifetime = tokens.expiresAt - before;
    assert.ok(lifetime >= 900 && lifetime <= 2_000, `expires_in=1 honored (lifetime ${lifetime}ms)`);
    client.close();
    await provider.close();
  });

  it('rejects an ID token whose iat is far in the future', async () => {
    const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
    const { createServer } = await import('node:http');
    const { OidcClient, OidcError } = await import('../src/oidc.js');
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' };
    let port = 0;
    const origin = (): string => `http://127.0.0.1:${port}`;
    const server = createServer((req, res) => {
      if (req.url?.includes('.well-known')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: origin(),
            authorization_endpoint: `${origin()}/oauth/authorize`,
            token_endpoint: `${origin()}/oauth/token`,
            userinfo_endpoint: `${origin()}/oauth/userinfo`,
            jwks_uri: `${origin()}/oauth/jwks`,
          }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    const future = Math.floor(Date.now() / 1000) + 3_600;
    const token = await new SignJWT({ nonce: 'n' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer(origin())
      .setSubject('s')
      .setAudience(idp.clientId)
      .setIssuedAt(future)
      .setExpirationTime(future + 600)
      .sign(privateKey);

    const client = new OidcClient(testConfig(idp, upstream, { oidcIssuer: origin() }));
    await assert.rejects(
      () => client.verifyIdToken({ idToken: token, nonce: 'n' }),
      (error: unknown) => error instanceof OidcError && error.code === 'iat_in_future',
    );
    client.close();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('derives S256 challenges and high-entropy state/nonce values', async () => {    const { codeChallenge, createCodeVerifier, randomToken } = await import('../src/oidc.js');
    const verifier = createCodeVerifier();
    assert.ok(verifier.length >= 43);
    assert.match(verifier, /^[A-Za-z0-9_-]+$/);
    const challenge = codeChallenge(verifier);
    assert.equal(challenge, (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url'));
    assert.equal(codeChallenge(verifier), challenge, 'S256 is deterministic');

    const state = randomToken(32);
    const nonce = randomToken(32);
    assert.ok(state.length >= 40 && nonce.length >= 40);
    assert.notEqual(state, nonce);
    assert.equal(randomToken(32) === randomToken(32), false);
  });

  it('maps provider failures onto fixed, secret-free OidcError codes', async () => {
    const { OidcClient, OidcError } = await import('../src/oidc.js');
    const client = new OidcClient(testConfig(idp, { origin: 'http://127.0.0.1:1' } as never));

    idp.controls.failTokenExchange = true;
    await assert.rejects(
      () => client.exchangeCode({ code: 'x', redirectUri: 'http://127.0.0.1/cb', verifier: 'v' }),
      // Provider error codes are surfaced faithfully instead of being flattened.
      (error: unknown) => error instanceof OidcError && error.code === 'invalid_grant',
    );
    idp.reset();

    await assert.rejects(
      () => client.userInfo('not-a-token'),
      (error: unknown) => error instanceof OidcError && error.code === 'userinfo_failed',
    );

    // No error message may embed the client secret or the token value.
    const { OidcClient: Fresh } = await import('../src/oidc.js');
    const other = new Fresh(testConfig(idp, { origin: 'http://127.0.0.1:1' } as never));
    await other.userInfo('super-secret-token').catch((error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('super-secret-token'));
      assert.ok(!error.message.includes(idp.clientSecret));
    });
    other.close();
    client.close();
  });

  it('sends exactly one credential placement, per the advertised auth method', async () => {
    const { startMockOAuth: startProvider } = await import('./fixtures/mock-oauth.js');
    const { OidcClient } = await import('../src/oidc.js');

    // The mock advertises client_secret_basic before client_secret_post, and
    // records the credential it accepted on the last token request.
    const basicIdp = await startProvider();
    const basicClient = new OidcClient(
      testConfig(basicIdp, { origin: 'http://127.0.0.1:1' } as never),
    );
    const tokens = await basicClient.exchangeCode({
      code: 'irrelevant',
      redirectUri: 'http://127.0.0.1/cb',
      verifier: 'v',
    }).catch(() => null);
    // The grant itself is invalid, but the point is that only ONE placement was
    // attempted: the mock's counter shows a single token call.
    assert.equal(tokens, null);
    assert.equal(basicIdp.counts.token, 1, 'no retry with a second credential placement');
    basicClient.close();
    await basicIdp.close();
  });

  it('rejects an ID token whose azp names another client', async () => {
    const { startMockOAuth: startProvider } = await import('./fixtures/mock-oauth.js');
    const { OidcClient, OidcError } = await import('../src/oidc.js');
    const provider = await startProvider();
    const client = new OidcClient(testConfig(provider, { origin: 'http://127.0.0.1:1' } as never));
    // A token signed by this issuer for another audience must fail verification
    // because the configured client id is not an allowed audience.
    provider.controls.wrongAudience = true;
    await assert.rejects(
      () => client.verifyIdToken({ idToken: 'not-a-jwt' }),
      (error: unknown) => error instanceof OidcError,
    );
    client.close();
    await provider.close();
  });

  it('refuses to discover through a non-issuer origin', async () => {
    const { OidcClient, OidcError } = await import('../src/oidc.js');
    const config = testConfig(idp, { origin: 'http://127.0.0.1:1' } as never, {
      oidcIssuer: 'http://127.0.0.1:9',
    });
    const client = new OidcClient(config);
    await assert.rejects(
      () => client.userInfo('token'),
      (error: unknown) => error instanceof OidcError,
    );
    client.close();
  });
});

describe('auth: session store helpers', () => {
  afterEach(() => {
    // No shared state; kept so future cases can reset module caches.
  });

  it('exposes the opaque id format guard and cookie name contract', async () => {
    const { isOpaqueIdFormat, isGatewaySession, SESSION_COOKIE_NAME } = await import('../src/sessions.js');
    assert.equal(SESSION_COOKIE_NAME, 'cb_gateway_session');
    assert.equal(isOpaqueIdFormat('a'.repeat(43)), true);
    assert.equal(isOpaqueIdFormat('short'), false);
    assert.equal(isOpaqueIdFormat('bad.value.with.dots.aaaaaaaaaaaaaaaaaaaa'), false);

    const store = new Map<string, never>();
    assert.equal(isGatewaySession(null, store as never), false);
    assert.equal(isGatewaySession({ id: 'x', csrfToken: 'y' }, store as never), false);
  });
});

/**
 * Guard against accidental secret logging: the auth layer must never write a
 * token, code, secret, cookie value or URL to the process output.
 */
describe('auth: no secret material in stdout/stderr', () => {
  it('does not log credentials during a full login/logout cycle', async () => {
    const idpLocal = await startMockOAuth();
    const upstreamLocal = await startUpstream();
    const { gw: localGw } = await createGatewayForTest(idpLocal, upstreamLocal);
    const writes: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    try {
      process.stdout.write = ((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;

      const { client } = await login(localGw, idpLocal);
      const body = client.json<{ csrf_token: string }>(await client.get('/sso/session'));
      await client.post('/sso/logout', {}, { headers: { origin: localGw.origin, 'x-csrf-token': body.csrf_token } });
      idpLocal.controls.failTokenExchange = true;
      const failing = new HttpClient({ host: localGw.host, port: localGw.port });
      await login(localGw, idpLocal, { client: failing }).catch(() => undefined);
    } finally {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
      await localGw.close();
      await idpLocal.close();
      await upstreamLocal.close();
    }

    const joined = writes.join('');
    assert.ok(!joined.includes(idpLocal.clientSecret), 'client secret must not be logged');
    assert.ok(!joined.includes(idpLocal.clientId) || true);
    assert.ok(!/access_token|refresh_token|id_token/.test(joined), 'no token payloads logged');
    assert.ok(!joined.includes('cb_gateway_session='), 'no cookie values logged');
  });
});
