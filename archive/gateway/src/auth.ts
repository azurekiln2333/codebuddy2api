import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayConfig } from './config.js';
import { HttpError, json, requireSameOrigin } from './http.js';
import {
  createCodeVerifier,
  OidcClient,
  OidcError,
  randomToken,
  type LiveUserInfo,
  type TokenSet,
} from './oidc.js';
import {
  SESSION_COOKIE_NAME,
  type GatewaySession,
  type GatewayUser,
} from './sessions.js';

/**
 * Authentication, live administrator authorization and session lifecycle.
 *
 * Frozen surface (docs/internal-contract.md):
 *   - `handle(req, res, url)` owns `/sso/*` and returns false for other paths,
 *   - `requireAdmin(req, res)` performs a LIVE UserInfo check on every call,
 *   - `logout(req, res)` ends the gateway session,
 *   - `close()` releases timers.
 *
 * Security rules implemented here:
 *   - one-use, browser-bound login transactions (HttpOnly cookie) holding the
 *     PKCE verifier, `state` and `nonce`,
 *   - confidential code exchange + RS256 ID token verification + live UserInfo,
 *   - authorization requires a matching subject, `role === "admin"` AND
 *     `isAdmin === true`; anything unknown fails closed with 403,
 *   - opaque bounded session store with idle + absolute expiry,
 *   - refresh rotation serialized by a per-session promise lock so concurrent
 *     requests trigger exactly one exchange,
 *   - every await is followed by a membership recheck, so a concurrent logout
 *     or refresh failure can never resurrect or grant a stale session,
 *   - all errors are reduced to fixed codes; no token, secret or URL leaks.
 *
 * Status contract:
 *   - 401 = the caller has no usable session (missing, unknown, expired, or
 *     replaced by a newer login),
 *   - 403 = there is a session, but it is not (or no longer) an authorized
 *     administrator: live UserInfo failure, timeout, revocation, role loss,
 *     subject mismatch, or a failed refresh rotation.
 */

/** Browser cookie names owned by the auth layer. */
const TRANSACTION_COOKIE = 'cb_gateway_txn';

/** Cap on any single transaction/CSRF/state value read back from a cookie. */
const MAX_COOKIE_VALUE = 512;

/** Interval for the bounded-store sweep, in ms. */
const SWEEP_INTERVAL_MS = 30_000;

interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

interface CookieJar {
  [name: string]: string;
}

/** Parse the Cookie header defensively: bounded count, size and charset. */
function parseCookies(header: string | undefined): CookieJar {
  const jar: CookieJar = {};
  if (!header) return jar;
  let seen = 0;
  for (const part of header.split(';')) {
    if (seen >= 20) break;
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!/^[\w-]{1,32}$/.test(name) || value.length === 0 || value.length > MAX_COOKIE_VALUE) continue;
    if (/[\x00-\x20\x7f;,]/.test(value)) continue;
    if (name in jar) continue;
    jar[name] = value;
    seen += 1;
  }
  return jar;
}

/** Constant-time comparison for opaque values of equal length. */
function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** Redirect within the gateway origin only. The target is always a literal. */
function redirect(res: ServerResponse, location: string, status = 302): void {
  res.writeHead(status, { location, 'cache-control': 'no-store' });
  res.end();
}

/**
 * Decide whether cookies must carry the Secure attribute.
 *
 * Secure is mandatory whenever the public origin is HTTPS — a local-dev opt-in
 * must never weaken a real deployment. It is omitted only for a plain-HTTP
 * loopback origin, where browsers drop Secure cookies outright and the operator
 * has explicitly opted into insecure localhost development.
 */
function cookiesRequireSecure(config: GatewayConfig): boolean {
  if (config.publicOrigin.startsWith('https://')) return true;
  // http:// origin: only the explicit loopback development escape omits Secure.
  return !config.allowInsecureLocalhost;
}

function setCookie(
  res: ServerResponse,
  config: GatewayConfig,
  input: { name: string; value: string; maxAgeSeconds: number; path?: string },
): void {
  const attributes = [
    `${input.name}=${input.value}`,
    `Path=${input.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(input.maxAgeSeconds))}`,
  ];
  if (cookiesRequireSecure(config)) attributes.push('Secure');
  res.appendHeader('set-cookie', attributes.join('; '));
}

function clearCookie(res: ServerResponse, config: GatewayConfig, name: string, path = '/'): void {
  setCookie(res, config, { name, value: '', maxAgeSeconds: 0, path });
}

/**
 * Reduce an arbitrary `return_to` to a literal dashboard path.
 * Anything outside the dashboard tree collapses to `/dashboard/`, which makes
 * an open redirect impossible.
 */
export function safeReturnTo(raw: string | null): string {
  if (!raw) return '/dashboard/';
  if (raw.length > 512 || /[\x00-\x20\x7f\\#]/.test(raw)) return '/dashboard/';
  if (!raw.startsWith('/dashboard')) return '/dashboard/';
  if (raw !== '/dashboard' && !raw.startsWith('/dashboard/') && !raw.startsWith('/dashboard?')) {
    return '/dashboard/';
  }
  if (/\/{2,}|(?:^|\/)\.{1,2}(?:\/|$)|\/[/?]$/.test(raw.split('?')[0]!)) return '/dashboard/';
  // Encoded separators/dot segments and percent escaping would be reinterpreted
  // by a downstream parser, so any percent-encoding collapses to the default.
  if (raw.includes('%')) return '/dashboard/';
  return raw === '/dashboard' ? '/dashboard/' : raw;
}

function isAdminIdentity(user: LiveUserInfo, expectedSub: string): boolean {
  return user.sub === expectedSub && user.role === 'admin' && user.isAdmin === true;
}

export class AuthService {
  private readonly oidc: OidcClient;
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly transactions = new Map<string, LoginTransaction>();
  private readonly sweepTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly config: GatewayConfig,
    private readonly cleanup?: (session: GatewaySession) => Promise<void>,
  ) {
    this.oidc = new OidcClient(config);
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  // ------------------------------------------------------------- public API

  /** Route `/sso/*`. Returns false when the path is not owned by this layer. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    switch (url.pathname) {
      case '/sso/login':
        await this.handleLogin(req, res);
        return true;
      case '/sso/callback':
        await this.handleCallback(req, res, url);
        return true;
      case '/sso/session':
        await this.handleSession(req, res);
        return true;
      case '/sso/logout':
        await this.logout(req, res);
        return true;
      default:
        return false;
    }
  }

  /**
   * Authorize a protected request.
   *
   * Resolves the opaque session, refreshes the access token when it has expired
   * (once, under the per-session lock), then performs a LIVE UserInfo request.
   * The request is authorized only when live UserInfo matches the session
   * subject and asserts `role === "admin"` AND `isAdmin === true`.
   *
   * Membership is re-checked after EVERY await, so a logout, eviction, expiry or
   * refresh failure that happens while a request is in flight can never be
   * overtaken by a stale authorization result.
   */
  async requireAdmin(req: IncomingMessage, res: ServerResponse): Promise<GatewaySession> {
    const session = this.resolveSession(req, res);
    if (!session) throw new HttpError(401, 'unauthenticated');

    try {
      await this.ensureFreshToken(session);
    } catch (error) {
      // A failed refresh tears the session down; drop the now-useless cookie so
      // the browser stops presenting a dead session id.
      clearCookie(res, this.config, SESSION_COOKIE_NAME);
      throw error;
    }
    // The refresh may have failed and torn the session down (or a logout may
    // have landed meanwhile): never continue with a dead session.
    this.assertLive(session);

    let info: LiveUserInfo;
    try {
      info = await this.oidc.userInfo(session.accessToken);
    } catch {
      // Revoked, expired, malformed or timed-out UserInfo: fail closed.
      throw new HttpError(403, 'forbidden');
    }
    // Re-check FULL liveness/expiry after the network round trip, not just Map
    // membership: a concurrent logout must win, and an absolute/idle expiry that
    // elapsed while UserInfo was in flight must not be forgiven by lastSeenAt.
    // `assertLive` covers membership, absolute expiry and idle expiry, and it
    // tears the session down when it has expired.
    try {
      this.assertLive(session);
    } catch (error) {
      clearCookie(res, this.config, SESSION_COOKIE_NAME);
      throw error;
    }
    if (!isAdminIdentity(info, session.sub)) throw new HttpError(403, 'forbidden');

    session.user = this.projectUser(info);
    session.lastSeenAt = Date.now();
    return session;
  }

  /**
   * End the gateway session and best-effort revoke the upstream bridge.
   *
   * `POST` is the contract method; `DELETE` is accepted for the /admin/session
   * compatibility mapping that the server layer performs. No other method is
   * accepted, and this is NEVER routed as a side effect of `GET`.
   */
  async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? '';
    if (method !== 'POST' && method !== 'DELETE') throw new HttpError(405, 'method_not_allowed');
    requireSameOrigin(req, this.config);
    const session = this.resolveSession(req, res);
    if (!session) throw new HttpError(401, 'unauthenticated');
    const supplied = req.headers['x-csrf-token'];
    if (typeof supplied !== 'string' || !safeEquals(supplied, session.csrfToken)) {
      throw new HttpError(403, 'csrf_denied');
    }
    await this.destroy(session);
    clearCookie(res, this.config, SESSION_COOKIE_NAME);
    json(res, 200, { authenticated: false });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    this.oidc.close();
    for (const session of [...this.sessions.values()]) this.forget(session);
    this.transactions.clear();
  }

  // -------------------------------------------------------------- /sso/login

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');

    // A new login supersedes any session this browser already holds, so the
    // previous session id can never be reused (and its upstream bridge is
    // revoked) in parallel with the fresh one.
    const existing = this.lookupSession(req);
    if (existing) await this.destroy(existing);

    const url = new URL(req.url || '/', this.config.publicOrigin);
    const returnTo = safeReturnTo(url.searchParams.get('return_to'));

    this.sweep();
    if (this.transactions.size >= this.config.maxSessions) {
      const oldest = this.transactions.keys().next();
      if (!oldest.done) this.transactions.delete(oldest.value);
    }

    const state = randomToken(32);
    const nonce = randomToken(32);
    const verifier = createCodeVerifier();
    this.transactions.set(state, {
      state,
      nonce,
      verifier,
      returnTo,
      expiresAt: Date.now() + this.config.transactionTtlMs,
    });

    const authorizeUrl = await this.oidc.buildAuthorizeUrl({
      redirectUri: `${this.config.publicOrigin}/sso/callback`,
      state,
      nonce,
      verifier,
    });
    setCookie(res, this.config, {
      name: TRANSACTION_COOKIE,
      value: state,
      maxAgeSeconds: Math.floor(this.config.transactionTtlMs / 1000),
    });
    redirect(res, authorizeUrl);
  }

  // ----------------------------------------------------------- /sso/callback

  private async handleCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');

    const cookies = parseCookies(req.headers.cookie);
    const cookieState = cookies[TRANSACTION_COOKIE] || '';
    const suppliedState = url.searchParams.get('state') || '';

    // One-use transaction: consumed before any exchange is attempted, and the
    // transaction must be bound to this browser via the HttpOnly cookie.
    const transaction = suppliedState ? this.transactions.get(suppliedState) : undefined;
    if (suppliedState) this.transactions.delete(suppliedState);
    clearCookie(res, this.config, TRANSACTION_COOKIE);

    if (!transaction || !cookieState || !safeEquals(transaction.state, cookieState)) {
      throw new HttpError(403, 'login_transaction_invalid');
    }
    if (transaction.expiresAt < Date.now()) throw new HttpError(403, 'login_transaction_expired');

    const error = url.searchParams.get('error');
    if (error) throw new HttpError(403, 'authorize_failed');
    const code = url.searchParams.get('code');
    if (!code) throw new HttpError(403, 'authorize_failed');

    let tokens: TokenSet;
    try {
      tokens = await this.oidc.exchangeCode({
        code,
        redirectUri: `${this.config.publicOrigin}/sso/callback`,
        verifier: transaction.verifier,
      });
    } catch {
      throw new HttpError(403, 'token_exchange_failed');
    }

    // The code exchange must yield an ID token; `requireIdToken` enforces this in
    // the OIDC client, so this is a defensive narrowing rather than an assertion.
    const idToken = tokens.idToken;
    if (!idToken) throw new HttpError(403, 'id_token_invalid');

    let subject: string;
    try {
      const claims = await this.oidc.verifyIdToken({ idToken, nonce: transaction.nonce });
      if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new OidcError('id_token_invalid');
      subject = claims.sub;
    } catch {
      throw new HttpError(403, 'id_token_invalid');
    }

    // Live, fail-closed administrator check. The ID token deliberately carries
    // no roles, so this is the only authorization source.
    let info: LiveUserInfo;
    try {
      info = await this.oidc.userInfo(tokens.accessToken);
    } catch {
      throw new HttpError(403, 'forbidden');
    }
    if (!isAdminIdentity(info, subject)) throw new HttpError(403, 'forbidden');

    // Replace any session this browser already held, so only one live session
    // (and one upstream bridge) exists per browser at a time.
    const previous = this.lookupSession(req);
    if (previous) await this.destroy(previous);

    const session = this.createSession(subject, tokens, this.projectUser(info));
    setCookie(res, this.config, {
      name: SESSION_COOKIE_NAME,
      value: session.id,
      maxAgeSeconds: Math.floor(this.config.sessionTtlMs / 1000),
    });
    redirect(res, transaction.returnTo);
  }

  // ------------------------------------------------------------ /sso/session

  private async handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
    try {
      const session = await this.requireAdmin(req, res);
      json(res, 200, {
        authenticated: true,
        csrf_token: session.csrfToken,
        user: { ...session.user },
      });
    } catch (error) {
      // Only "no usable session" becomes the unauthenticated shape; a session
      // that exists but is not (or is no longer) an admin must stay 403 so the
      // UI can distinguish "log in" from "you are not allowed".
      if (error instanceof HttpError && error.status === 403) throw error;
      json(res, 401, { authenticated: false, csrf_token: null, user: null });
    }
  }

  // ------------------------------------------------------------- internals

  /** Create a bounded opaque session; evicts the oldest entry at capacity. */
  private createSession(sub: string, tokens: TokenSet, user: GatewayUser): GatewaySession {
    const now = Date.now();
    if (this.sessions.size >= this.config.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (!oldest.done) {
        const victim = this.sessions.get(oldest.value);
        if (victim) this.forget(victim);
      }
    }
    const session: GatewaySession = {
      id: randomBytes(32).toString('base64url'),
      csrfToken: randomBytes(32).toString('base64url'),
      sub,
      accessToken: tokens.accessToken,
      user,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.expiresAt,
      expiresAt: now + this.config.sessionTtlMs,
      lastSeenAt: now,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Remove a session from the store, then hand the ORIGINAL object (including
   * the upstream bridge fields) to the cleanup hook so the proxy bridge can
   * still revoke the upstream admin session.
   */
  private forget(session: GatewaySession): void {
    this.sessions.delete(session.id);
    // Credential-bearing auth material is dropped eagerly; `upstream` is kept
    // until cleanup ran, because revoking it requires the cookie/CSRF values.
    session.accessToken = '';
    session.refreshToken = undefined;
  }

  private async destroy(session: GatewaySession): Promise<void> {
    const wasLive = this.sessions.has(session.id);
    this.forget(session);
    if (!wasLive) return;
    try {
      await this.cleanup?.(session);
    } catch {
      // Local logout must never depend on upstream availability.
    } finally {
      delete session.upstream;
      delete session.upstreamLogin;
      delete session.refreshPromise;
    }
  }

  /** Look up the session referenced by the request cookie without validating. */
  private lookupSession(req: IncomingMessage): GatewaySession | null {
    const cookies = parseCookies(req.headers.cookie);
    const id = cookies[SESSION_COOKIE_NAME];
    if (!id) return null;
    return this.sessions.get(id) ?? null;
  }

  /** Resolve, validate and idle-refresh the opaque session cookie. */
  private resolveSession(req: IncomingMessage, res: ServerResponse): GatewaySession | null {
    const cookies = parseCookies(req.headers.cookie);
    const id = cookies[SESSION_COOKIE_NAME];
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) {
      clearCookie(res, this.config, SESSION_COOKIE_NAME);
      return null;
    }
    const now = Date.now();
    if (now >= session.expiresAt || now - session.lastSeenAt >= this.config.sessionIdleMs) {
      void this.destroy(session);
      clearCookie(res, this.config, SESSION_COOKIE_NAME);
      return null;
    }
    return session;
  }

  /** Throw unless the session is still the live, unexpired store entry. */
  private assertLive(session: GatewaySession): void {
    if (this.sessions.get(session.id) !== session) throw new HttpError(401, 'unauthenticated');
    const now = Date.now();
    if (now >= session.expiresAt || now - session.lastSeenAt >= this.config.sessionIdleMs) {
      void this.destroy(session);
      throw new HttpError(401, 'unauthenticated');
    }
  }

  /**
   * Refresh the access token once it has EXPIRED (plus a small clock skew).
   *
   * A still-valid token is never replaced, so the provider sees one exchange per
   * rotation instead of one per request. Concurrent protected requests share
   * `session.refreshPromise`, so a rotating provider sees exactly one exchange
   * per rotation; a failed refresh destroys the session and fails closed.
   *
   * When the provider returns a rotated ID token it is verified with the same
   * strict issuer/audience/azp/subject rules as the login ID token, so a refresh
   * response cannot silently re-bind the session to another subject.
   */
  private async ensureFreshToken(session: GatewaySession): Promise<void> {
    // Only the expiry decision lives here; the actual deadline bounding is done
    // by the OIDC client. A small skew keeps an about-to-expire token from being
    // used for the UserInfo call.
    const skewMs = 5_000;
    if (Date.now() < session.accessTokenExpiresAt - skewMs) return;
    if (!this.config.oidcRefresh || !session.refreshToken) {
      throw new HttpError(403, 'forbidden');
    }
    if (!session.refreshPromise) {
      session.refreshPromise = (async (): Promise<void> => {
        const refreshToken = session.refreshToken;
        if (!refreshToken) throw new OidcError('refresh_failed');
        const tokens = await this.oidc.refresh(refreshToken);
        // A concurrent logout may have removed the session while the network
        // call was in flight: fail closed instead of writing to a dead record.
        if (this.sessions.get(session.id) !== session) throw new OidcError('session_revoked');
        if (tokens.idToken) {
          // Validation failure throws and tears the session down (fail closed).
          await this.oidc.verifyIdToken({ idToken: tokens.idToken, expectedSub: session.sub });
          if (this.sessions.get(session.id) !== session) throw new OidcError('session_revoked');
        }
        session.accessToken = tokens.accessToken;
        session.accessTokenExpiresAt = tokens.expiresAt;
        // Rotation: adopt the new token, keep the old one only if none issued.
        session.refreshToken = tokens.refreshToken ?? refreshToken;
      })();
    }
    const pending = session.refreshPromise;
    try {
      await pending;
    } catch {
      await this.destroy(session);
      throw new HttpError(403, 'forbidden');
    } finally {
      if (session.refreshPromise === pending) delete session.refreshPromise;
    }
  }

  /** Project live UserInfo onto the minimal browser-safe identity. */
  private projectUser(info: LiveUserInfo): GatewayUser {
    const user: GatewayUser = { sub: info.sub, role: 'admin' };
    if (info.username) user.username = info.username;
    if (info.name) user.name = info.name;
    return user;
  }

  /** Bounded-store maintenance: drop expired sessions and transactions. */
  private sweep(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now >= session.expiresAt || now - session.lastSeenAt >= this.config.sessionIdleMs) {
        this.forget(session);
      }
    }
    for (const [state, transaction] of this.transactions) {
      if (transaction.expiresAt < now) this.transactions.delete(state);
    }
  }
}
