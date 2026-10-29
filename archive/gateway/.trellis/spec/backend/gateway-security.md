# Gateway security contract

## 1. Scope / Trigger

Read before changing routes, authentication, OIDC, proxying, session types,
environment wiring or deployment examples. Browser, gateway, identity provider
and original FastAPI backend are distinct trust boundaries.

## 2. Signatures

```ts
createGateway(config: GatewayConfig): http.Server
validateRequestTarget(target: string, method?: string): void
AuthService.requireAdmin(req, res): Promise<GatewaySession>
GatewayProxy.admin(req, res, url, session): Promise<void>
GatewayProxy.inference(req, res, url): Promise<void>
requireCsrf(req, session: { csrfToken: string }, config): void
```

`server.ts` validates the raw target before parsing/classification and authorizes
before `admin`. `auth.ts` owns session liveness. `proxy.ts` owns the per-session
upstream cookie/CSRF bridge. Shared types live in `sessions.ts`.

## 3. Contracts

- OIDC: confidential code exchange, S256 PKCE, one-use browser-bound state,
  nonce, RS256/JWKS and issuer/audience/expiry checks. Request `openid profile
  roles`, optionally `offline_access`; never `prompt` or `max_age`. Select one
  advertised client authentication method (Basic or POST).
- Every protected request independently fetches live UserInfo. Require
  `sub === session.sub && role === 'admin' && isAdmin === true`. Token claims
  and prior successful requests never replace this check.
- Re-check membership, idle and absolute expiry after asynchronous authorization.
  Refresh rotates under one per-session promise lock. Logout, expiry, eviction
  and refresh failure win over concurrent in-flight authorization.
- Browser: opaque `cb_gateway_session` only, HttpOnly, SameSite=Lax, Secure on
  HTTPS. Explicit HTTP loopback development is the only Secure exception.
  Stores are bounded, in memory, and owned by one process.
- `/sso/session`: `{authenticated, csrf_token, user}` with only `sub`, optional
  `username`/`name`, and `role:'admin'`. `/admin/session` GET synthesizes
  `{authenticated, csrf_token}`; POST is disabled; DELETE logs out gateway.
  `/admin/oauth` remains original backend account enrollment.
- Admin writes and `GET /admin/oauth/poll` require exact public Origin and
  gateway `X-CSRF-Token`. Strip browser auth/cookies/CSRF. Log into backend
  per session using `UPSTREAM_API_KEY` and canonical backend Origin; inject
  that bridge's cookie and distinct upstream CSRF. Never share bridge cookies.
- `/admin/logs/clear`, `scope:'all'`: require exact confirmation
  `清空全部日志与统计`, then replace any browser key with server key. Other
  scopes receive no injected key. Body must be a bounded JSON object.
- Storage uses original backend `GET /admin/storage` and
  `POST /admin/storage/archive` with integer `days` in 1–3650. Preserve upstream
  status/body, including missing-route 404. Diagnose deployed route availability
  before adding a fallback; do not manufacture storage data or hide errors.
- `/v1/*` preserves caller Bearer/X-Api-Key, drops cookies/identity/hop headers,
  and injects no server credentials. Responses drop upstream Set-Cookie, CORS
  and Connection-nominated headers.
- Route names remain literal. Reject traversal, backslashes, repeated
  separators, session aliases and encoded route names before parsing. The
  narrow exception is model IDs under literal `/admin/models/`: PUT/DELETE
  use full suffix; POST preview has literal `/preview`. Decode ID once;
  require `[A-Za-z0-9_.:/@-]{1,160}`; reject residual `%`, empty segments and
  `.` / `..` segments. Preserve encoded bytes in forwarding so ASGI `{id:path}`
  receives `org/model`, `vendor:model` or `@org/model`. Never relax `/v1` or
  `/admin/session` to support model data. Query encoding remains supported.
- Stream inference with immediate headers and backpressure. Cancel unfinished
  `res.close` / `req.aborted`; normal request `close` is not cancellation.
  Buffered admin deadlines cover connect and entire body; streams use their
  configured socket timeout.
- Required env: `PUBLIC_ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
  `OIDC_CLIENT_SECRET`, `UPSTREAM_API_KEY`. `loadConfig` requires HTTPS except
  explicit loopback opt-in. Backend origins are loopback/private IP or fixed
  `codebuddy2api` alias. See `.env.example` for bounds/defaults.
- Nginx terminates public TLS. Compose publishes only Nginx; backend `private`
  and `egress` networks have no backend host port mapping. Nginx log formats
  belong in HTTP context and omit query strings and Referer.

## 4. Validation & Error Matrix

| Condition | Result | Upstream access |
| --- | --- | --- |
| Missing/unknown/expired session | 401; session routes include unauthenticated shape | None |
| Wrong/missing live role, mismatched subject, revoked/timed-out UserInfo | 403 | None |
| Refresh failure | 403 and invalidate session | None |
| Wrong Origin/gateway CSRF | 403 | No protected mutation |
| Disabled POST `/admin/session` with valid session | 405 before CSRF | No upstream login |
| Ambiguous target/model traversal | 400 | None |
| Wrong full-clear confirmation | 403 | No log clear |
| Missing/wrong `/v1` credential | Original backend 401 | Caller credentials only |
| Unexpected gateway exception | Fixed 502 code | Never serialize raw errors |

## 5. Good/Base/Bad Cases

- Base: admin login, safe session projection, live UserInfo for dashboard.
- Good: model ID `org%2Fmodel` passes only matching model operations; browser
  CSRF G1 becomes distinct backend CSRF C1 and no backend cookie leaks.
- Bad: `/v1/../admin/session`, `/admin/%73ession`, model `%2e%2e` segments or
  residual `%2f` after one decode must never reach backend.

## 6. Tests Required

- `oauth.test.ts` / `auth.test.ts`: confidential exchange, state/nonce/JWT,
  concurrent rotation, expiry during UserInfo, late logout, stalled body abort.
- `authorization.test.ts` / `csrf.test.ts`: distinct tokens; role, Origin,
  revocation and timeout deny before protected upstream counters move.
- `rawpath.test.ts`, `alias.test.ts`, `model-paths.test.ts`: raw HTTP targets,
  rejected-path counters and legitimate encoded model transport.
- `backend.test.ts`: original FastAPI bridge/log clear/account OAuth, caller-key
  matrix, custom create lifecycle and model CRUD/preview with slash/colon/@.
- `inference.test.ts` / `proxy-regressions.test.ts`: first chunk before end,
  actual upstream cancellation, healthy GET/POST, wildcard identity and
  Connection-nominated header filtering.

## 7. Wrong vs Correct

```ts
// Wrong: parsing erases traversal before policy sees it.
const url = new URL(req.url!, config.publicOrigin);
// Wrong: banning every '%' also breaks IDs encoded by the UI.

// Correct: validate raw routes and narrow model exception first.
validateRequestTarget(req.url || '', req.method);
const url = new URL(req.url!, config.publicOrigin);
```

```ts
// Wrong: normal request completion aborts healthy SSE.
req.on('close', cancelUpstream);
// Correct: cancel only unfinished responses or aborted requests.
res.on('close', () => { if (!finished) cancelUpstream(); });
req.on('aborted', cancelUpstream);
```
