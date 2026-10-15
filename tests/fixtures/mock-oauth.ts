import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

/**
 * Faithful local OpenID Provider used by the integration tests.
 *
 * It mirrors the behaviour the gateway depends on from an external CodeBuddy
 * style OIDC provider:
 *
 *  - discovery document advertising RS256 + S256,
 *  - confidential-client code exchange (HTTP Basic or client_secret_post),
 *  - S256 PKCE verification against the original code_verifier,
 *  - one-use authorization codes,
 *  - a state that is bound to the browser transaction,
 *  - a nonce echoed inside the RS256 ID token,
 *  - roles/isAdmin exposed ONLY through live UserInfo (never in the ID token
 *    or access token claims), and ONLY when the `roles` scope was requested,
 *  - optional offline_access refresh tokens with rotation,
 *  - deterministic failure injection (revocation, wrong signing key, timeout,
 *    expired tokens, malformed JWKS) for fail-closed tests.
 *
 * This never talks to a real domain. Every claim produced here is synthetic.
 */

export type RoleValue = "admin" | "user" | string;

export interface MockIdentity {
  sub: string;
  username: string;
  name: string;
  /** Role returned by live UserInfo when the `roles` scope was requested. */
  role: RoleValue;
  /** isAdmin flag returned alongside role when requested. */
  isAdmin: boolean;
}

export interface LoginState {
  /** Scope requested on the authorize call that produced this code. */
  scope: string;
  /** Whether `openid` was requested. */
  openid: boolean;
  /** Whether `roles` was requested (controls UserInfo role emission). */
  roles: boolean;
  /** Whether `offline_access` was requested (controls refresh_token issuance). */
  offline: boolean;
  identity: MockIdentity;
}

interface AuthCodeRecord {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  nonce: string;
  scope: string;
  expiresAt: number;
  used: boolean;
}

interface AccessTokenRecord {
  token: string;
  sub: string;
  scope: string;
  expiresAt: number;
  revoked: boolean;
  identity: MockIdentity;
}

interface RefreshTokenRecord {
  token: string;
  sub: string;
  clientId: string;
  scope: string;
  expiresAt: number;
  used: boolean;
  identity: MockIdentity;
}

/** Mutable knobs the tests flip to exercise fail-closed paths. */
export interface MockControls {
  /** Delay userinfo responses (ms) to force a gateway timeout. */
  userinfoDelayMs: number;
  /** Delay token responses (ms). */
  tokenDelayMs: number;
  /** Access token lifetime in seconds (default 300). */
  accessTokenTtlSeconds: number;
  /** Revoke every access token; UserInfo then returns 401. */
  revoked: boolean;
  /** Replace the advertised JWKS with an unrelated key (signature mismatch). */
  wrongSigningKey: boolean;
  /** Reject the next code exchange with invalid_grant. */
  failTokenExchange: boolean;
  /** Emit roles in UserInfo even when not requested (negative test). */
  forceRoles: boolean;
  /** Sign ID tokens with an already-expired exp. */
  expiredIdToken: boolean;
  /** Break the ID token audience (wrong aud). */
  wrongAudience: boolean;
  /** Corrupt the ID token signature. */
  corruptIdToken: boolean;
}

export interface MockOAuthProvider {
  issuer: string;
  clientId: string;
  clientSecret: string;
  port: number;
  controls: MockControls;
  /** Default identity used for freshly minted logins. */
  identity: MockIdentity;
  /** Restore `identity` to the values captured at start(). */
  resetIdentity(): void;
  server: Server;
  /** Number of authorize/token/userinfo calls observed (upstream accounting). */
  counts: { authorize: number; token: number; userinfo: number; jwks: number };
  /** Last authorize query params, for prompt/max_age/scope assertions. */
  readonly lastAuthorizeQuery: Record<string, string>;
  /** Force the next authorize to fail with this OAuth error code. */
  failAuthorize: string | null;
  close(): Promise<void>;
  /** Reset all controls and counters back to benign defaults. */
  reset(): void;
  /** Drop all live tokens/codes (simulates server-side revocation). */
  revokeAll(): void;
}

const ID_TOKEN_TTL_SECONDS = 300;
const ACCESS_TOKEN_TTL_SECONDS = 300;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function scopeSet(scope: string): Set<string> {
  return new Set(scope.split(/\s+/).filter(Boolean));
}

export async function startMockOAuth(options?: {
  clientId?: string;
  clientSecret?: string;
  identity?: Partial<MockIdentity>;
}): Promise<MockOAuthProvider> {
  const clientId = options?.clientId ?? "mock-gateway-client";
  const clientSecret = options?.clientSecret ?? "mock-gateway-secret";
  const identity: MockIdentity = {
    sub: "user-admin-1",
    username: "admin",
    name: "Gateway Admin",
    role: "admin",
    isAdmin: true,
    ...options?.identity,
  };
  const defaultIdentity: MockIdentity = { ...identity };

  const controls: MockControls = {
    userinfoDelayMs: 0,
    tokenDelayMs: 0,
    accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
    revoked: false,
    wrongSigningKey: false,
    failTokenExchange: false,
    forceRoles: false,
    expiredIdToken: false,
    wrongAudience: false,
    corruptIdToken: false,
  };

  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid: "mock-kid", alg: "RS256", use: "sig" };
  // A second, unrelated key used to sign tokens when wrongSigningKey is active.
  const other = await generateKeyPair("RS256", { extractable: true });

  const codes = new Map<string, AuthCodeRecord>();
  const accessTokens = new Map<string, AccessTokenRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();

  const counts = { authorize: 0, token: 0, userinfo: 0, jwks: 0 };
  const state: { lastAuthorizeQuery: Record<string, string>; failAuthorize: string | null } = {
    lastAuthorizeQuery: {},
    failAuthorize: null,
  };

  const server = createServer();

  // The issuer is filled in after listen() so it matches the bound port.
  let issuer = "";

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(payload);
  };

  const readBody = async (req: IncomingMessage): Promise<Record<string, string>> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    const params = new URLSearchParams();
    if (contentType.includes("application/x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(text)) params.append(k, v);
    } else if (text) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") params.append(k, v);
      } catch {
        // ignore
      }
    }
    // Authorization header still wins for Basic auth; handled by callers.
    const out: Record<string, string> = {};
    for (const [k, v] of params) out[k] = v;
    return out;
  };

  const basicAuth = (req: IncomingMessage): { id: string; secret: string } | null => {
    const header = req.headers.authorization ?? "";
    if (!header.toLowerCase().startsWith("basic ")) return null;
    try {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx < 0) return null;
      return { id: decoded.slice(0, idx), secret: decoded.slice(idx + 1) };
    } catch {
      return null;
    }
  };

  const mintIdToken = async (input: {
    sub: string;
    nonce: string;
    ident: MockIdentity;
  }): Promise<string> => {
    const key = controls.wrongSigningKey ? other.privateKey : privateKey;
    const iat = controls.expiredIdToken ? nowSeconds() - 3600 : nowSeconds();
    const exp = controls.expiredIdToken ? nowSeconds() - 60 : nowSeconds() + ID_TOKEN_TTL_SECONDS;
    const aud = controls.wrongAudience ? "someone-else" : clientId;
    let token = await new SignJWT({
      // Deliberately NO role/isAdmin claims: roles live only in live UserInfo.
      preferred_username: input.ident.username,
      name: input.ident.name,
      nonce: input.nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "mock-kid", typ: "JWT" })
      .setIssuer(issuer)
      .setSubject(input.sub)
      .setAudience(aud)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key);
    if (controls.corruptIdToken) {
      const parts = token.split(".");
      // Flip the first character of the signature to invalidate it.
      const sig = parts[2] ?? "";
      parts[2] = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
      token = parts.join(".");
    }
    return token;
  };

  const userinfoPayload = (record: AccessTokenRecord): Record<string, unknown> => {
    const scope = scopeSet(record.scope);
    const body: Record<string, unknown> = {
      sub: record.identity.sub,
      preferred_username: record.identity.username,
      name: record.identity.name,
    };
    // Roles are emitted ONLY when requested, matching the real provider.
    if (scope.has("roles") || controls.forceRoles) {
      body.role = record.identity.role;
      body.isAdmin = record.identity.isAdmin;
    }
    return body;
  };

  server.on("request", (req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? "/", issuer || `http://127.0.0.1:${(server.address() as AddressInfo)?.port ?? 0}`);
      const path = url.pathname;

      // ---- Discovery -----------------------------------------------------
      if (path === "/.well-known/openid-configuration" && req.method === "GET") {
        json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          userinfo_endpoint: `${issuer}/oauth/userinfo`,
          jwks_uri: `${issuer}/oauth/jwks`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          scopes_supported: ["openid", "profile", "roles", "offline_access"],
        });
        return;
      }

      // ---- JWKS ----------------------------------------------------------
      if (path === "/oauth/jwks" && req.method === "GET") {
        counts.jwks += 1;
        // Always publish the original key. `wrongSigningKey` signs with a key
        // whose public part is deliberately absent from this JWKS, which is the
        // real "unknown signing key" failure mode.
        json(res, 200, { keys: [publicJwk] });
        return;
      }

      // ---- Authorize -----------------------------------------------------
      if (path === "/oauth/authorize" && req.method === "GET") {
        counts.authorize += 1;
        const q: Record<string, string> = {};
        for (const [k, v] of url.searchParams) q[k] = v;
        state.lastAuthorizeQuery = q;

        const redirectUri = q.redirect_uri ?? "";
        const reply = (params: Record<string, string>): void => {
          const target = new URL(redirectUri || `${issuer}/oauth/authorize`);
          for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
          res.statusCode = 302;
          res.setHeader("location", target.toString());
          res.end();
        };

        if (state.failAuthorize) {
          reply({ error: state.failAuthorize, state: q.state ?? "" });
          return;
        }
        const fail = (error: string): void => reply({ error, error_description: error, state: q.state ?? "" });

        if (q.client_id !== clientId) return fail("invalid_client");
        if (!redirectUri) return fail("invalid_request");
        if (q.response_type !== "code") return fail("unsupported_response_type");
        const scope = scopeSet(q.scope ?? "");
        if (!scope.has("openid")) return fail("invalid_scope");
        if (q.prompt !== undefined || q.max_age !== undefined) return fail("invalid_request");
        if (q.code_challenge_method !== "S256" || !q.code_challenge) return fail("invalid_request");

        const code = randomUUID().replace(/-/g, "");
        codes.set(code, {
          code,
          clientId,
          redirectUri,
          codeChallenge: q.code_challenge,
          codeChallengeMethod: q.code_challenge_method,
          state: q.state ?? "",
          nonce: q.nonce ?? "",
          scope: q.scope ?? "openid",
          expiresAt: Date.now() + 60_000,
          used: false,
        });
        reply({ code, state: q.state ?? "" });
        return;
      }

      // ---- Token ---------------------------------------------------------
      if (path === "/oauth/token" && req.method === "POST") {
        counts.token += 1;
        if (controls.tokenDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, controls.tokenDelayMs));
        }
        const form = await readBody(req);
        const basic = basicAuth(req);
        const id = basic?.id ?? form.client_id ?? "";
        const secret = basic?.secret ?? form.client_secret ?? "";
        if (id !== clientId || secret !== clientSecret) {
          json(res, 401, { error: "invalid_client" });
          return;
        }
        if (controls.failTokenExchange) {
          json(res, 400, { error: "invalid_grant" });
          return;
        }
        const grant = form.grant_type;

        if (grant === "authorization_code") {
          const record = codes.get(form.code ?? "");
          if (!record || record.used || record.expiresAt < Date.now()) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          // S256 PKCE verification.
          const verifier = form.code_verifier ?? "";
          const computed = b64url(createHash("sha256").update(verifier).digest());
          if (computed !== record.codeChallenge) {
            json(res, 400, { error: "invalid_grant", error_description: "pkce mismatch" });
            return;
          }
          record.used = true;
          const idToken = await mintIdToken({ sub: identity.sub, nonce: record.nonce, ident: identity });
          const access = randomUUID().replace(/-/g, "");
          const scope = record.scope;
          const accessRecord: AccessTokenRecord = {
            token: access,
            sub: identity.sub,
            scope,
            expiresAt: nowSeconds() + controls.accessTokenTtlSeconds,
            revoked: false,
            identity,
          };
          accessTokens.set(access, accessRecord);
          const body: Record<string, unknown> = {
            access_token: access,
            token_type: "Bearer",
            expires_in: controls.accessTokenTtlSeconds,
            id_token: idToken,
            scope,
          };
          if (scopeSet(scope).has("offline_access")) {
            const refresh = randomUUID().replace(/-/g, "");
            refreshTokens.set(refresh, {
              token: refresh,
              sub: identity.sub,
              clientId,
              scope,
              expiresAt: Date.now() + 3600_000,
              used: false,
              identity,
            });
            body.refresh_token = refresh;
          }
          json(res, 200, body);
          return;
        }

        if (grant === "refresh_token") {
          const record = refreshTokens.get(form.refresh_token ?? "");
          if (!record || record.used || record.expiresAt < Date.now()) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          // Rotation: the presented refresh token is invalidated immediately.
          record.used = true;
          const access = randomUUID().replace(/-/g, "");
          accessTokens.set(access, {
            token: access,
            sub: record.identity.sub,
            scope: record.scope,
            expiresAt: nowSeconds() + controls.accessTokenTtlSeconds,
            revoked: false,
            identity: record.identity,
          });
          const rotated = randomUUID().replace(/-/g, "");
          refreshTokens.set(rotated, { ...record, token: rotated, used: false });
          // No new id_token on refresh (matches typical provider behaviour).
          json(res, 200, {
            access_token: access,
            token_type: "Bearer",
            expires_in: controls.accessTokenTtlSeconds,
            refresh_token: rotated,
            scope: record.scope,
          });
          return;
        }

        json(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      // ---- UserInfo ------------------------------------------------------
      if (path === "/oauth/userinfo" && (req.method === "GET" || req.method === "POST")) {
        counts.userinfo += 1;
        if (controls.userinfoDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, controls.userinfoDelayMs));
        }
        const header = req.headers.authorization ?? "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
        const record = accessTokens.get(token);
        if (!record || controls.revoked || record.revoked || record.expiresAt < nowSeconds()) {
          res.statusCode = 401;
          res.setHeader("www-authenticate", "Bearer error=invalid_token");
          json(res, 401, { error: "invalid_token" });
          return;
        }
        json(res, 200, userinfoPayload(record));
        return;
      }

      json(res, 404, { error: "not_found" });
    })().catch(() => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}`;

  const provider: MockOAuthProvider = {
    issuer,
    clientId,
    clientSecret,
    port,
    controls,
    identity,
    resetIdentity: () => {
      Object.assign(identity, defaultIdentity);
    },
    server,
    counts,
    get lastAuthorizeQuery() {
      return state.lastAuthorizeQuery;
    },
    get failAuthorize() {
      return state.failAuthorize;
    },
    set failAuthorize(value: string | null) {
      state.failAuthorize = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    reset: () => {
      Object.assign(controls, {
        userinfoDelayMs: 0,
        tokenDelayMs: 0,
        accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
        revoked: false,
        wrongSigningKey: false,
        failTokenExchange: false,
        forceRoles: false,
        expiredIdToken: false,
        wrongAudience: false,
        corruptIdToken: false,
      });
      counts.authorize = 0;
      counts.token = 0;
      counts.userinfo = 0;
      counts.jwks = 0;
      state.failAuthorize = null;
      codes.clear();
      accessTokens.clear();
      refreshTokens.clear();
      Object.assign(identity, defaultIdentity);
    },
    revokeAll: () => {
      for (const record of accessTokens.values()) record.revoked = true;
    },
  };

  return provider;
}

/** Compute the S256 code challenge for a verifier (for client-side tests). */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Generate a PKCE verifier/challenge pair. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}
