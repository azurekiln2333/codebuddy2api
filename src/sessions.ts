/**
 * Gateway session state.
 *
 * The browser only ever holds an opaque session id in a Secure/HttpOnly
 * cookie; every credential (OIDC access/refresh token, upstream admin cookie
 * and CSRF) stays in this in-memory record. One process owns a bounded store,
 * so a restart intentionally logs everyone out and no replica is supported
 * until shared session storage and locks exist.
 *
 * The interface is frozen by docs/internal-contract.md: `src/auth.ts` creates
 * it, `src/proxy.ts` attaches the upstream bridge fields to the same object.
 */

/** Minimal safe identity projected from live OIDC UserInfo. No tokens. */
export interface GatewayUser {
  sub: string;
  username?: string;
  name?: string;
  role: 'admin';
}

/** Upstream (private FastAPI) admin session owned by the proxy bridge. */
export interface GatewayUpstreamSession {
  cookie: string;
  csrfToken: string;
}

export interface GatewaySession {
  /** Opaque 256-bit identifier; the only value the browser sees. */
  id: string;
  /** Gateway-side CSRF secret, distinct from any upstream CSRF token. */
  csrfToken: string;
  /** Subject asserted by the verified ID token at login time. */
  sub: string;
  /** Live OIDC access token, used for the per-request UserInfo check. */
  accessToken: string;
  /** Currently advertised identity; refreshed from live UserInfo. */
  user: GatewayUser;
  /** Live refresh token; rotated on every use. */
  refreshToken?: string;
  accessTokenExpiresAt: number;
  /** Absolute expiry of the gateway session. */
  expiresAt: number;
  /** Idle expiry, extended on every authorized access. */
  lastSeenAt: number;
  /** Upstream bridge state; set and read by src/proxy.ts. */
  upstream?: GatewayUpstreamSession;
  /** In-flight upstream login, so concurrent requests share one bridge login. */
  upstreamLogin?: Promise<void>;
  /** In-flight OIDC refresh, so concurrent requests share one rotation. */
  refreshPromise?: Promise<void>;
}

function charsetValid(value: string): boolean {
  return /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/**
 * Validate an untrusted session object (typically a cast-off proxy bridge) and
 * return the matching live session from `store`.
 *
 * Both sides come from the same process, so this is defence in depth: it keeps
 * a stale or corrupted reference from being used to authorize a request.
 */
export function isGatewaySession(value: unknown, store: Map<string, GatewaySession>): value is GatewaySession {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<GatewaySession>;
  if (typeof candidate.id !== 'string' || typeof candidate.csrfToken !== 'string') return false;
  return store.get(candidate.id) === (value as GatewaySession);
}

export { charsetValid as isOpaqueIdFormat };

/** Name of the browser cookie holding the opaque gateway session id. */
export const SESSION_COOKIE_NAME = 'cb_gateway_session';
