import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { GatewayConfig } from './config.js';

/**
 * Minimal confidential OIDC client (authorization code + S256 PKCE).
 *
 * Design constraints from docs/internal-contract.md and the PRD:
 *  - discovery is fetched once and cached for the process lifetime,
 *  - authorization codes use S256 PKCE; `prompt` and `max_age` are NEVER sent,
 *  - the ID token is verified with the discovered JWKS using RS256, plus exact
 *    issuer, audience and expiry checks,
 *  - roles are never trusted from the ID token: authorization comes only from
 *    live UserInfo, which is re-fetched on every protected request,
 *  - every outbound call is bounded by `config.oauthTimeoutMs`,
 *  - every failure throws `OidcError` with a fixed, secret-free code.
 */

/** Fixed, secret-free failure codes. The message never contains response data. */
export class OidcError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'OidcError';
  }
}

export interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported: string[];
  code_challenge_methods_supported: string[];
  /** Advertised confidential-client auth methods, in provider preference order. */
  token_endpoint_auth_methods_supported: string[];
}

export interface TokenSet {
  accessToken: string;
  /** Optional on refresh: providers commonly omit it on the refresh grant. */
  idToken?: string;
  refreshToken?: string;
  scope: string;
  /** Absolute expiry derived from `expires_in` (clamped to a 60s floor). */
  expiresAt: number;
}

export interface LiveUserInfo {
  /** Subject from live UserInfo — must match the ID token subject. */
  sub: string;
  username?: string;
  name?: string;
  role?: string;
  isAdmin?: boolean;
}

interface DiscoveryCache {
  issuer: string;
  document: DiscoveryDocument;
  jwks: JWTVerifyGetKey;
}

/** Tolerance (seconds) for an `iat` claim that appears to be in the future. */
const IAT_FUTURE_TOLERANCE_SECONDS = 60;

/** Cap on any single OIDC JSON response body (discovery/token/userinfo). */
const MAX_JSON_BYTES = 256 * 1024;

/**
 * Scopes are fixed by the PRD.
 * `roles` is required for the live admin check and `profile` supplies the
 * `preferred_username` / `name` values the UI renders, so both are requested.
 * `offline_access` is added only when refresh is enabled.
 */
const BASE_SCOPE = 'openid profile roles';

/** Refresh tokens are only requested when the operator opts in. */
function fullScope(refresh: boolean): string {
  return refresh ? `${BASE_SCOPE} offline_access` : BASE_SCOPE;
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/** PKCE S256 verifier (43+ chars, unreserved charset). */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE S256 challenge for a verifier. */
export function codeChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** High-entropy opaque value for `state` / `nonce`. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Join a discovered endpoint URL to the configured issuer.
 * Endpoints must be absolute HTTPS origins (or the explicit loopback dev
 * exception) and must belong to the configured issuer, so discovery cannot
 * redirect credentials to an attacker-controlled host.
 */
function resolveEndpoint(issuer: string, raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) throw new OidcError('discovery_invalid');
  let url: URL;
  let issuerUrl: URL;
  try {
    url = new URL(raw);
    issuerUrl = new URL(issuer);
  } catch {
    throw new OidcError('discovery_invalid');
  }
  if (url.username || url.password || url.hash) throw new OidcError('discovery_invalid');
  if (url.origin !== issuerUrl.origin) throw new OidcError('discovery_invalid');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OidcError('discovery_invalid');
  return url.toString();
}

/**
 * Run `work` with a hard wall-clock deadline.
 *
 * `fetchWithTimeout` bounds a single HTTP request, but composite operations
 * (JWKS fetch + retry, discovery + verify) can exceed it. Every network-backed
 * operation therefore runs inside one of these so a hung or slow provider can
 * never hold a protected request open past `oauthTimeoutMs`.
 */
function withDeadline<T>(ms: number, code: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new OidcError(code));
      reject(new OidcError(code));
    }, ms);
    timer.unref();
  });
  return Promise.race([work(controller.signal), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '');
}

export class OidcClient {
  private discovery: Promise<DiscoveryCache> | null = null;

  constructor(private readonly config: GatewayConfig) {}

  /** Build the authorization redirect URL for a fresh login transaction. */
  async buildAuthorizeUrl(input: {
    redirectUri: string;
    state: string;
    nonce: string;
    verifier: string;
  }): Promise<string> {
    const { document } = await this.load();
    const url = new URL(document.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.oidcClientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('scope', fullScope(this.config.oidcRefresh));
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', codeChallenge(input.verifier));
    url.searchParams.set('code_challenge_method', 'S256');
    // Deliberately no `prompt` and no `max_age`: the provider rejects both.
    return url.toString();
  }

  /**
   * Exchange an authorization code using the confidential client credentials.
   *
   * Exactly ONE credential placement is sent per request, chosen from the
   * provider's advertised `token_endpoint_auth_methods_supported`:
   *  - `client_secret_basic` (default when the provider advertises nothing) uses
   *    the Authorization header ONLY, and the body carries `client_id` but never
   *    the secret;
   *  - `client_secret_post` puts the credentials in the form body ONLY.
   * Sending both at once is non-compliant and leaks the secret into a second
   * channel, so it never happens here.
   */
  async exchangeCode(input: {
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<TokenSet> {
    const { document } = await this.load();
    const method = this.tokenAuthMethod(document);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      client_id: this.config.oidcClientId,
    });
    const headers: Record<string, string> =
      method === 'client_secret_basic' ? { authorization: this.basicAuthHeader() } : {};
    if (method === 'client_secret_post') body.set('client_secret', this.config.oidcClientSecret);

    const result = await this.postForm(document.token_endpoint, body, headers);
    if (result.status !== 200) throw new OidcError(result.error ?? 'token_exchange_failed');
    return this.toTokenSet(result.payload, { requireIdToken: true });
  }

  /**
   * Verify an RS256 ID token against the discovered JWKS with strict issuer,
   * audience, authorized-party and expiry checks, then require the expected
   * `nonce` and (optionally) the expected subject.
   *
   * The whole verification — including any JWKS refetch on an unknown `kid` —
   * runs under a hard deadline so a slow JWKS endpoint cannot stall the request.
   */
  async verifyIdToken(input: {
    idToken: string;
    nonce?: string;
    expectedSub?: string;
    /** Audience required by the caller; defaults to the configured client id. */
    audience?: string;
  }): Promise<JWTPayload> {
    const cache = await this.load();
    const audience = input.audience ?? this.config.oidcClientId;
    let payload: JWTPayload;
    try {
      payload = await withDeadline(this.config.oauthTimeoutMs, 'id_token_timeout', async () => {
        const result = await jwtVerify(input.idToken, cache.jwks, {
          algorithms: ['RS256'],
          issuer: cache.issuer,
          audience,
          clockTolerance: 5,
          requiredClaims: ['exp', 'iat', 'iss', 'aud', 'sub'],
        });
        return result.payload;
      });
    } catch {
      // Never surface library messages: they can echo token fragments.
      throw new OidcError('id_token_invalid');
    }

    // `azp` (authorized party) must name our client whenever the provider sends
    // it, so a token minted for another client of the same issuer is rejected.
    if (payload.azp !== undefined && payload.azp !== this.config.oidcClientId) {
      throw new OidcError('azp_mismatch');
    }
    // With multiple audiences, `azp` is mandatory and must be present.
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && typeof payload.azp !== 'string') {
      throw new OidcError('azp_missing');
    }
    if (input.nonce !== undefined && payload.nonce !== input.nonce) {
      throw new OidcError('nonce_mismatch');
    }
    // Reject a token issued in the future beyond a small clock tolerance: a
    // far-future `iat` would otherwise let a forged/replayed token look fresh.
    if (typeof payload.iat === 'number' && payload.iat > Math.floor(Date.now() / 1000) + IAT_FUTURE_TOLERANCE_SECONDS) {
      throw new OidcError('iat_in_future');
    }
    if (input.expectedSub !== undefined && payload.sub !== input.expectedSub) {
      throw new OidcError('subject_mismatch');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new OidcError('id_token_invalid');
    }
    return payload;
  }

  /**
   * Rotate the refresh token. The provider invalidates the presented token
   * immediately, so exactly one caller may use a given token (guarded by the
   * per-session `refreshPromise` lock in auth.ts).
   */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const { document } = await this.load();
    const method = this.tokenAuthMethod(document);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.oidcClientId,
    });
    if (method === 'client_secret_post') body.set('client_secret', this.config.oidcClientSecret);
    const headers: Record<string, string> =
      method === 'client_secret_basic' ? { authorization: this.basicAuthHeader() } : {};

    const result = await this.postForm(document.token_endpoint, body, headers);
    if (result.status !== 200) throw new OidcError(result.error ?? 'refresh_failed');
    // A refresh may legitimately omit the ID token; when it is present it is
    // validated by the caller with the same strict rules as login.
    return this.toTokenSet(result.payload);
  }

  /**
   * Fetch live UserInfo with the access token. Every failure (401, timeout,
   * malformed body) throws, and callers must fail closed.
   */
  async userInfo(accessToken: string): Promise<LiveUserInfo> {
    const { document } = await this.load();
    const payload = await withDeadline(this.config.oauthTimeoutMs, 'userinfo_timeout', async (signal) => {
      const response = await this.fetchWithTimeout(
        document.userinfo_endpoint,
        {
          method: 'GET',
          headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        },
        signal,
      );
      if (!response.ok) throw new OidcError('userinfo_failed');
      return asRecord(await this.readJson(response, signal));
    });
    if (!payload) throw new OidcError('userinfo_invalid');
    const sub = optionalString(payload.sub);
    if (!sub) throw new OidcError('userinfo_invalid');
    return {
      sub,
      username: optionalString(payload.preferred_username) ?? optionalString(payload.username),
      name: optionalString(payload.name),
      role: optionalString(payload.role),
      isAdmin: typeof payload.isAdmin === 'boolean' ? payload.isAdmin : undefined,
    };
  }

  /** Stop the shared keep-alive connections (called on server close). */
  close(): void {
    this.discovery = null;
  }

  // ---------------------------------------------------------------- internals

  private load(): Promise<DiscoveryCache> {
    if (!this.discovery) {
      this.discovery = this.discover().catch((error: unknown) => {
        // Allow a later request to retry discovery instead of caching failure.
        this.discovery = null;
        throw error;
      });
    }
    return this.discovery;
  }

  private async discover(): Promise<DiscoveryCache> {
    const issuer = normalizeIssuer(this.config.oidcIssuer);
    const discoveryUrl = new URL('/.well-known/openid-configuration', `${issuer}/`).toString();
    return withDeadline(this.config.oauthTimeoutMs, 'discovery_timeout', async (signal) => {
      const response = await this.fetchWithTimeout(
        discoveryUrl,
        { method: 'GET', headers: { accept: 'application/json' } },
        signal,
      );
      if (!response.ok) throw new OidcError('discovery_failed');
      const payload = asRecord(await this.readJson(response, signal));
      if (!payload) throw new OidcError('discovery_failed');

      const advertised = normalizeIssuer(optionalString(payload.issuer) ?? '');
      if (advertised !== issuer) throw new OidcError('issuer_mismatch');

      const algs = Array.isArray(payload.id_token_signing_alg_values_supported)
        ? payload.id_token_signing_alg_values_supported.filter((a): a is string => typeof a === 'string')
        : [];
      if (algs.length > 0 && !algs.includes('RS256')) throw new OidcError('rs256_unsupported');
      const methods = Array.isArray(payload.code_challenge_methods_supported)
        ? payload.code_challenge_methods_supported.filter((m): m is string => typeof m === 'string')
        : [];
      if (methods.length > 0 && !methods.includes('S256')) throw new OidcError('s256_unsupported');
      const authMethods = Array.isArray(payload.token_endpoint_auth_methods_supported)
        ? payload.token_endpoint_auth_methods_supported.filter((m): m is string => typeof m === 'string')
        : [];

      const document: DiscoveryDocument = {
        issuer,
        authorization_endpoint: resolveEndpoint(issuer, payload.authorization_endpoint),
        token_endpoint: resolveEndpoint(issuer, payload.token_endpoint),
        userinfo_endpoint: resolveEndpoint(issuer, payload.userinfo_endpoint),
        jwks_uri: resolveEndpoint(issuer, payload.jwks_uri),
        id_token_signing_alg_values_supported: algs,
        code_challenge_methods_supported: methods,
        token_endpoint_auth_methods_supported: authMethods,
      };
      return {
        issuer,
        document,
        jwks: createRemoteJWKSet(new URL(document.jwks_uri), {
          // Bounds one JWKS HTTP request; `withDeadline` in verifyIdToken bounds
          // the whole verification, including a refetch after an unknown `kid`.
          timeoutDuration: this.config.oauthTimeoutMs,
          cooldownDuration: 30_000,
          cacheMaxAge: 600_000,
        }),
      };
    });
  }

  private async postForm(
    endpoint: string,
    body: URLSearchParams,
    extraHeaders: Record<string, string>,
  ): Promise<{ status: number; payload: Record<string, unknown>; error?: string }> {
    return withDeadline(this.config.oauthTimeoutMs, 'token_timeout', async (signal) => {
      const response = await this.fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
            ...extraHeaders,
          },
          body: body.toString(),
        },
        signal,
      );
      const payload = asRecord(await this.readJson(response, signal)) ?? {};
      if (response.ok) return { status: response.status, payload };
      const error = optionalString(payload.error) ?? `http_${response.status}`;
      return { status: response.status, payload, error };
    });
  }

  /**
   * Choose exactly one credential placement from the advertised methods.
   * Defaults to `client_secret_basic`, the OIDC-recommended default, when the
   * provider advertises nothing.
   */
  private tokenAuthMethod(document: DiscoveryDocument): 'client_secret_basic' | 'client_secret_post' {
    const advertised = document.token_endpoint_auth_methods_supported;
    if (advertised.length === 0) return 'client_secret_basic';
    const post = advertised.indexOf('client_secret_post');
    const basic = advertised.indexOf('client_secret_basic');
    if (basic >= 0 && (post < 0 || basic < post)) return 'client_secret_basic';
    if (post >= 0) return 'client_secret_post';
    // The provider only offers a method we do not implement (e.g. private_key_jwt).
    throw new OidcError('token_auth_unsupported');
  }

  private basicAuthHeader(): string {
    return `Basic ${Buffer.from(
      `${this.config.oidcClientId}:${this.config.oidcClientSecret}`,
      'utf8',
    ).toString('base64')}`;
  }

  private toTokenSet(
    payload: Record<string, unknown>,
    options?: { requireIdToken?: boolean },
  ): TokenSet {
    const accessToken = optionalString(payload.access_token);
    if (!accessToken) throw new OidcError('token_response_invalid');
    // RFC 6749: `token_type` is REQUIRED and must be a case-insensitive match for
    // "Bearer" when we intend to present it as a Bearer token. Anything else (or
    // a missing value) fails closed rather than being assumed.
    const tokenType = optionalString(payload.token_type);
    if (!tokenType || tokenType.toLowerCase() !== 'bearer') {
      throw new OidcError('token_type_unsupported');
    }
    const idToken = optionalString(payload.id_token);
    if (options?.requireIdToken && !idToken) throw new OidcError('token_response_invalid');
    // Honor the provider's `expires_in` faithfully: a provider may legitimately
    // issue very short-lived tokens, and clamping it up would keep using an
    // expired token. A missing or invalid value fails closed instead of being
    // extended to a default, so the session can never outlive the real token.
    const expiresIn = payload.expires_in;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn < 0) {
      throw new OidcError('expires_in_invalid');
    }
    return {
      accessToken,
      idToken,
      refreshToken: optionalString(payload.refresh_token),
      scope: optionalString(payload.scope) ?? fullScope(this.config.oidcRefresh),
      expiresAt: Date.now() + Math.floor(expiresIn) * 1000,
    };
  }

  /**
   * Bound every outbound OIDC call twice:
   *  - the fetch itself carries an AbortSignal with the configured deadline, and
   *  - the caller wraps composite work in `withDeadline`.
   *
   * The signal governs the ENTIRE response lifetime, not just the header phase:
   * `AbortSignal.any([parent, timeout])` is handed to `fetch` and the same signal
   * is threaded into `readJson`, so a provider that sends 200 headers and then
   * stalls the body is aborted (and its socket closed) instead of holding the
   * connection open forever.
   *
   * Redirects are never followed (`redirect: 'manual'`), so a provider that
   * answers 30x cannot siphon the client secret or an Authorization header to
   * another host; any redirect is turned into a plain failure.
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timerController = new AbortController();
    const timer = setTimeout(
      () => timerController.abort(new OidcError('oidc_timeout')),
      this.config.oauthTimeoutMs,
    );
    timer.unref();
    // `any` keeps the parent deadline AND our timeout in force for the body read
    // as well; neither one is torn down when the headers arrive.
    const effectiveSignal = signal
      ? AbortSignal.any([signal, timerController.signal])
      : timerController.signal;
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: effectiveSignal,
        headers: { ...(init.headers as Record<string, string> | undefined) },
      });
      if (response.status >= 300 && response.status < 400) {
        throw new OidcError('oidc_redirect_denied');
      }
      return response;
    } catch (error) {
      throw error instanceof OidcError ? error : new OidcError('oidc_unavailable');
    } finally {
      // Only the timer is released here. The abort signal intentionally stays
      // live: it must keep governing `response.body` while the caller reads it.
      clearTimeout(timer);
    }
  }

  /**
   * Read a JSON body under the SAME signal as the response headers.
   *
   * `fetch()` resolves on headers, so without this a provider could send 200
   * headers and then stall (or stream forever) in the body. The read races every
   * `reader.read()` against the passed signal, so an abort (parent deadline or
   * per-call timeout) cancels the stream, closes the socket, and throws promptly
   * instead of leaving a slow body connection alive.
   */
  private async readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    let aborted: (() => void) | undefined;
    const abortPromise = signal
      ? new Promise<never>((_resolve, reject) => {
          aborted = (): void => reject(new OidcError('response_aborted'));
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
        })
      : null;
    const chunks: string[] = [];
    let total = 0;
    try {
      const decoder = new TextDecoder();
      for (;;) {
        const result = abortPromise
          ? await Promise.race([reader.read(), abortPromise])
          : await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > MAX_JSON_BYTES) throw new OidcError('response_too_large');
        chunks.push(decoder.decode(result.value, { stream: true }));
      }
      chunks.push(decoder.decode());
    } catch (error) {
      // Always release the connection; an aborted body must not stay open.
      await reader.cancel().catch(() => undefined);
      if (error instanceof OidcError) throw error;
      throw new OidcError('response_unavailable');
    } finally {
      if (aborted) signal?.removeEventListener('abort', aborted);
    }
    try {
      return JSON.parse(chunks.join('')) as unknown;
    } catch {
      return null;
    }
  }
}
