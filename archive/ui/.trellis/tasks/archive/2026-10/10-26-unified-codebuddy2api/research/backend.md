# Backend / OAuth2 research — unified CodeBuddy2Api

Scope: read-only. Decide whether FastAPI natively hosts `/sso` (single process)
or whether the Node gateway is imported into one repo/image. Owner: backend/OAuth2.
No product code changed, no secrets/auth data copied.

## 1. Evidence (files inspected)

### Target repo `D:/My2KProjects/codebuddy2api` (upstream `maiphucgiang/codebuddy2api`, v1.3.5)
- `converter.py` (3999 lines): builds `app = FastAPI(...)` at line 1912, defines
  `/health`, `/admin/*`, `/v1/*` routes, mounts `runtime_management.install(app)`.
- `app/runtime_management.py`: `install()` wires `install_admin(app, config, management)`
  then middlewares (Audit, PolicyScope, InboundBodyLimit, ConcurrencyLimit,
  InferenceAuth, RequestContext) and finally
  `install_pages(app, Path(gateway.__file__).parent / "web" / "dist")`.
- `app/admin_auth.py` (23 KB): `AdminAuth` = single-key API-key sessions,
  `cb_admin_session` cookie (`SESSION_TTL=12h`, HttpOnly/SameSite=strict/Path=/admin),
  CSRF token per session, Origin allowlist, login throttling (10/min/IP),
  key-epoch revocation with persisted snapshot (file or `state_store`),
  and `AdminMiddleware` guarding `/admin/*`. It already accepts **either**
  a Bearer/X-Api-Key key identity (`header_identity`, `"key:"+identity`) **or**
  the cookie session, and when cookie-authenticated it injects
  `Authorization: Bearer <api_key>` into the ASGI admin scope.
- `app/admin_api.py` (`install_admin`): registers the v1 management API:
  `POST/GET/DELETE /admin/session`, `/admin/settings (GET/PATCH)`,
  `/admin/models (GET/POST/preview/PUT id:path/POST id:path/preview/DELETE id:path)`,
  `/admin/credentials/{id}` (PATCH, upload, export), `/admin/logs`, `/admin/logs/clear`
  (`CLEAR_CONFIRMATION = "清空全部日志与统计"`), `/admin/storage (GET/archive)`,
  `/admin/dashboard`. Also `GET/POST /admin/oauth/start|poll` dispatch.
- `app/gateway_management.py`: `Management` views + `install_pages(app, dist)` serving
  `/dashboard` and `/dashboard/{page:path}` (page whitelist
  `{"", models, credentials, logs, settings, login}`) and
  `/dashboard/assets/{path}` from the local UI build.
- `app/auth_oauth.py`: **CodeBuddy account OAuth** (device/authorization for
  credentials) — unrelated to admin IdP SSO; keep separate.
- `app/settings.py` + `app/observability.py`: `trusted_proxies` (IP/CIDR) already
  gate acceptance of `x-forwarded-*`/`x-real-ip`; `run_server` uses a single
  uvicorn worker (`app/startup.py:100`).
- Deps: `fastapi`, `starlette`, `httpx==0.28.1`, `uvicorn` — **no JWT/JWKS lib, no authlib**.

### Gateway repo `D:/My2KProjects/codebuddy2api-oauth-gateway` (Node/TS)
- `src/config.ts`: env contract incl. `PUBLIC_ORIGIN`, `UPSTREAM_ORIGIN`
  (loopback/private only), `UPSTREAM_API_KEY` (= backend `CODEBUDDY2API_KEY`),
  OIDC client, TTLs, `ALLOW_INSECURE_LOCALHOST`.
- `src/oidc.ts` (544): confidential client, discovery cached, S256 PKCE,
  RS256-only ID token verify (iss/aud/azp/nonce/iat), `token_endpoint_auth_methods_supported`
  single-placement selection, hard `oauthTimeoutMs` deadlines, `redirect:'manual'`,
  `roles`+`profile`(+`offline_access`) scopes, **no `prompt`/`max_age`**.
- `src/auth.ts` (529): `/sso/{login,callback,session,logout}`; one-use browser-bound
  transaction (`cb_gateway_txn`); live UserInfo on every protected request
  (`sub` match AND `role==="admin"` AND `isAdmin===true`); idle+absolute expiry,
  bounded stores, refresh rotation under per-session lock, post-await liveness
  re-checks; 401 (no usable session) vs 403 (session but not/ no longer admin);
  Secure-cookie policy (mandatory on https, skipped only for explicit loopback dev).
- `src/sessions.ts`: opaque 256-bit id, all credentials server-side, in-memory only.
- `src/http.ts`: `HttpError`, JSON, bounded body, exact-Origin + Fetch-Metadata,
  timing-safe CSRF compare.
- `src/proxy.ts` (580): per-gateway-session upstream admin bridge (login with
  `UPSTREAM_API_KEY` → `cb_admin_session` cookie+CSRF, cached), strips
  browser auth/cookie/CSRF and `x-forwarded-*`/`x-auth-request-*`/`x-user-*`/`x-remote-*`
  families, injects canonical upstream Origin, suppresses upstream `Set-Cookie`/CORS/
  hop-by-hop; `/v1/*` streams preserving caller `authorization`/`x-api-key` only;
  full-log-clear injects server key after exact confirmation text check.
- `src/server.ts`: `validateRequestTarget()` — raw-path validation before URL parsing
  (percent-encoding only inside model IDs of literal model routes), route allowlist,
  `/healthz`, `/`→`/dashboard/`, error redaction to fixed codes.
- `src/static.ts` (207): realpath-contained `/dashboard/*` serving + SPA fallback,
  immutable asset caching, nosniff.
- Tests: 202 gateway tests + 15 backend-integration tests (`tests/`, `docs/validation.md`).
- Docs = frozen contracts: `docs/internal-contract.md`, `docs/ui-contract.md`,
  `docs/deployment.md`, `docs/security-review.md`.
- `compose.yaml`: 3 services (upstream private:8787, gateway:8788, nginx).
  8787 never published; gateway reached only via nginx.

### UI repo `D:/My2KProjects/codebuddy2api-ui`
- `src/api.ts`: `axios` baseURL `/admin` with `withCredentials`, `sso` baseURL `/sso`,
  `SSO_LOGIN_URL="/sso/login?return_to=/dashboard/"`, CSRF header `X-CSRF-Token`
  on writes **and** on `GET /admin/oauth/poll`, 401→anonymous / 403→forbidden.
- All backend calls are **relative** on the same origin → the UI is origin-agnostic
  and works whether served by the Node gateway or by FastAPI directly.

## 2. Findings: current capability overlap

| Capability | Python backend | Node gateway | Duplicate? |
| --- | --- | --- | --- |
| `/dashboard/*` static UI | `install_pages` (web/dist) | `static.ts` (UI_STATIC_DIR) | **Yes** |
| `/admin/session` | `admin_api` (API-key login) | synthesized → proxy → same handler | **Yes** |
| Origin + CSRF (browser) | `AdminAuth`/`AdminMiddleware` | `http.ts` | **Yes** |
| Admin session store | in-memory + optional snapshot | in-memory | **Yes** |
| `/admin/*` protection | `AdminMiddleware` | gateway session + upstream bridge | **Yes** |
| `/v1/*` auth/limits | local middlewares | passthrough stream | Gateway only proxies |
| OIDC RP + `/sso/*` | **absent** | `oidc.ts`+`auth.ts` | Gateway only |
| Upstream admin bridge | n/a (is the trust root) | `proxy.ts` | Needed only for 2-process |

The Node admin proxy exists **only** to translate a browser OIDC identity into the
backend's API-key admin session. Inside a single process that translation
disappears: the SSO layer can assert `scope["state"]["admin_identity"]` directly,
which is exactly what `AdminMiddleware` already consumes.

## 3. Recommendation

**Choose native FastAPI `/sso`; retire the Node gateway as a separate runtime.
Deliver a single Python process / single image.** Keep the Node repo's *contracts
and test matrix* as the porting spec, not its runtime.

Rationale
- The backend already owns `/admin/*` auth, `/dashboard/*` static serving,
  Origin/CSRF, body limits, and proxy-trust. Only the OIDC relying-party is missing.
- Single process removes: a second runtime + npm toolchain/lockfile, a private
  HTTP hop that must strip identity headers, two CSRF/session stores, the
  `8787`-must-stay-private constraint, and the mandatory TLS-terminating Nginx
  just to make cookies Secure. Fewer moving parts = the "cleanest maintainable"
  shape the task asks for.
- The only real cost is re-implementing + re-verifying the OIDC RP in Python.
  Mitigate by porting the gateway's ~202 security assertions to pytest and using
  vetted crypto (`joserfc`/`PyJWT` for RS256+JWKS, existing `httpx` for I/O).

Fallback (only if the OIDC port cannot be scheduled): import the Node gateway into
the same repo and ship **one image with two processes** (supervisor/entrypoint),
keeping the frozen `ui-contract.md`. This is single-repo but still multi-process;
treat as a temporary stage, not the target.

Non-negotiable either way: do **not** copy `.env`, tokens, session snapshots,
`auth/`, SQLite files, or the `.zip` bundles. New deployment starts empty.

## 4. Must-migrate functionality + files

Into `codebuddy2api` (new `app/sso_*.py`), reusing existing admin plumbing:

1. `app/sso_oidc.py` — OIDC client: discovery (cached, issuer-origin-checked
   endpoints), S256 PKCE, confidential token exchange with single auth-method
   placement, RS256 JWKS verify (iss/aud/azp/nonce/iat/exp/sub), bounded calls.
   Port of `src/oidc.ts`.
2. `app/sso_auth.py` — RP state machine: `/sso/login`, `/sso/callback`,
   `/sso/session`, `/sso/logout`; one-use browser-bound transaction cookie;
   opaque session store (idle+absolute TTL, bounded); live UserInfo admin check
   per request; refresh rotation with a per-session lock; 401/403 contract.
   Port of `src/auth.ts` + `src/sessions.ts` + `src/http.ts` (CSRF/Origin).
3. `app/sso_middleware.py` (or extend `AdminMiddleware`) — treat a verified SSO
   session as an admin identity; keep API-key identity for automation; single
   cookie + single CSRF so `admin_api` routes need no change.
4. Raw-path guard — port `validateRequestTarget()` (server.ts) as an ASGI
   middleware reading `scope["raw_path"]`: reject percent-encoding except inside
   the model-ID segment of the literal model routes, reject `//`, dot segments,
   backslashes, `/admin/session/` aliases. This is a **security contract**, not a
   proxy detail.
5. UI serving — point `install_pages` at the merged UI `dist`; delete the old
   `web/` UI. Keep the `/dashboard` page whitelist aligned with UI routes
   (existing UI i18n already flags `/dashboard/storage` missing from the whitelist).
6. Build/delivery — single `Dockerfile` + `docker-compose.yml`; UI built in a
   stage and served by FastAPI; keep `trusted_proxies` knob.

Becomes **dead code** after the merge (do not port):
- `proxy.ts` bridge logic, `config.ts` `UPSTREAM_*`/`PUBLIC_ORIGIN` plumbing,
  `server.ts` upstream routing, `static.ts` (replaced by `install_pages`),
  the separate `registry`/login-page sign-in that the UI contract removed,
  Node `compose.yaml` with 3 services, the `.zip` artifacts.

## 5. Security contracts that MUST be preserved

1. Authz = live `role==="admin"` AND `isAdmin===true` AND `sub` matches ID token,
   re-checked on **every** protected request; revocation effective next request.
2. 401 = no usable session; 403 = session but not/no-longer admin; success always
   carries a non-empty CSRF.
3. OIDC: S256 PKCE; confidential client with **one** credential placement chosen
   from advertised methods; RS256 only; exact issuer/audience; `azp` when present
   must match; `nonce` for login; `iat` not far-future; no `prompt`/`max_age`;
   discovery endpoints confined to the issuer origin; no redirect following.
4. One-use, browser-bound login transaction (HttpOnly cookie); `return_to`
   limited to `/dashboard*`, percent-encoding and dot segments collapsed.
5. CSRF: exact Origin + Fetch-Metadata (`sec-fetch-site`); timing-safe token
   compare; mutations cannot omit Origin; `GET /admin/oauth/poll` also CSRF-gated
   (it mutates account state); logout is POST only (DELETE mapped for
   `/admin/session`), never a GET side effect.
6. Cookies: `HttpOnly`, `SameSite`, `Secure` mandatory on HTTPS; omitted only
   under an explicit loopback-dev opt-in; single process-owned session store
   (in-memory ⇒ single worker; document no horizontal scaling).
7. Never leak tokens/secrets/URLs/raw network errors to the browser: fixed error
   codes only. Browser never receives upstream cookie/CSRF/api_key.
8. Full-log-clear keeps the exact confirmation text check and never trusts a
   browser-supplied `api_key`.
9. `/v1/*` keeps caller `authorization`/`x-api-key` only; server key/cookies are
   never injected/relayed; forwarded identity headers honored only from
   `trusted_proxies`.
10. UI files must be realpath-contained under the configured dist root.

## 6. Regression tests to port / keep

Port to pytest (new `tests/test_sso_*.py`), mirroring gateway tests:
- `auth.test.ts` → login/callback/session/logout state machine, transaction
  one-use + browser binding, 401 vs 403, post-await liveness, revoke-then-deny,
  refresh rotation single-exchange, concurrent logout wins.
- `oidc` coverage → discovery issuer mismatch, unsupported auth method, RS256-only,
  azp/aud/nonce/iat/subject rejection, timeout/abort of stalled bodies, no redirects.
- `csrf.test.ts` → Origin/Fetch-Metadata, timing-safe compare, poll CSRF, missing
  Origin on mutation.
- `rawpath.test.ts` / `alias.test.ts` / `model-paths.test.ts` → encoded
  `/admin/%73ession` rejected; encoded model IDs (`org/model`, `vendor:model`,
  `@org/model`, `custom:<uuid>`) accepted and forwarded once-decoded.
- `static.test.ts` → traversal/symlink escape, SPA fallback, immutable caching.
- `backend.test.ts` → admin routes still work through the new identity path;
  wrong/missing credentials on `/v1/models` denied; no extra cookie/key injected.
- Keep existing `tests/test_admin_api.py`, `test_admin_boundaries.py`,
  `test_login.py`, `test_security.py`, `test_native_noauth.py`,
  `test_environment_config.py` green.
- Add an end-to-end smoke: SSO login via a local OIDC mock → dashboard →
  one mutation with CSRF → logout → denied.

## 7. Open questions for the coordinator

1. Confirm native-Python `/sso` is the target (vs. Node-as-sidecar single image).
2. Which OIDC lib: `joserfc` (JWKS+RS256) vs `PyJWT`+`cryptography`; need a
   dependency review (currently not in `requirements.txt`).
3. Session persistence: in-memory only (single worker) vs. reuse
   `state_store` SQLite so restarts don't force re-login — affects the
   "revocation must win" tests.
4. Single cookie name for the merged admin/SSO session (`cb_admin_session`
   reuse vs new `cb_sso_session`) and the resulting UI contract field names.
5. Who owns the old-UI removal + `web/` decommission, and the new build pipeline.