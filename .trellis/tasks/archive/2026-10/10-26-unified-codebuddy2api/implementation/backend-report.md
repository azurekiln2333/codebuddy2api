# Backend / OAuth2 implementation report

Owner: Pi backend pane (`trellis-implement`). Product root:
`D:/My2KProjects/codebuddy2api`, branch `feat/unified-codebuddy2api`.
Companion document: `implementation/backend-contract.md` (the frozen
env/enablement contract other owners code against).

## 1. Decision reproduced

The Node `codebuddy2api-oauth-gateway` is **not** shipped as a runtime. Its
security contracts are re-implemented natively inside the existing FastAPI
process, because in one process the SSO layer can assert
`scope["state"]["admin_identity"]` directly — the exact shape `AdminMiddleware`
already consumes. That removes a duplicate `/dashboard` static server, a second
session/CSRF store, the private `8788 → 8787` hop and the mandatory TLS Nginx
front for `Secure` cookies.

Result: one image, one process, one session store, same browser contract.

## 2. Files

New:

| File | Role |
| --- | --- |
| `app/sso_config.py` | `SSOConfig` + fail-closed `load()` from env, HTTPS/loopback policy, redirect URI, scopes |
| `app/sso_oidc.py` | `OidcClient`: cached discovery, JWKS, S256 PKCE, confidential code exchange, refresh, live UserInfo |
| `app/sso_auth.py` | `SSOService` (sessions + one-use transactions), `SSOAdminMiddleware`, `install_sso()` |
| `app/request_target.py` | raw request-target guard (SSO mode): encoded aliases, traversal, `//`, backslashes |

Modified (owned scope only):

| File | Change |
| --- | --- |
| `app/admin_api.py` | `install_admin(app, config, gateway, sso=None)`; SSO mode skips `AdminAuth` and the legacy `/admin/session` routes, mounts `SSOAdminMiddleware` with the audit dispatch hook, tolerates `auth is None` in settings, trusts the SSO identity (not a browser `api_key`) for full log clear |
| `app/runtime_management.py` | loads SSO config before any store opens; builds `install_sso` first; installs the target guard outermost; returns the service |
| `app/gateway_management.py` | `storage` joins the page whitelist; `contained_static` helper; `/dashboard/licenses/{path}` and `/dashboard/THIRD_PARTY_NOTICES.md`; assets/libs subtrees never fall back to the shell |
| `converter.py` | converts `SSOConfigError` into a clean CLI abort; startup banner reports the active administration mode |
| `pyproject.toml`, `requirements.in`, `requirements.txt`, `uv.lock` | add `PyJWT[crypto]>=2.15.1` (+ `cryptography`, `cffi`, `pycparser`) with hashes |

Tests: `tests/sso_fixture.py`, `tests/test_sso_config.py`,
`tests/test_sso_oidc.py`, `tests/test_sso_auth.py`, `tests/test_sso_admin.py`,
`tests/test_sso_race.py`, `tests/test_sso_static.py`,
`tests/test_request_target.py`.

Untouched by this pane: `Dockerfile`, `.env*`, `docker-compose*.yml`, `web/`,
`.github/workflows/*`, `docs/*`, `README*`.

## 3. Ported security contracts

| Node gateway contract | Native implementation |
| --- | --- |
| PKCE S256, verifier never leaves the server | `code_challenge()`/`create_code_verifier()` in `sso_oidc.py`; verifier held in the one-use transaction |
| Confidential client, exactly one credential placement | `token_endpoint_auth_methods_supported` decides `client_secret_basic` **or** `client_secret_post`, never both |
| RS256 only, `kid` from cached JWKS | `jwt.decode(..., algorithms=["RS256"], audience=..., issuer=...)`, own key cache + cooldown |
| Exact `iss`/`aud`, `azp` if present, `nonce` at login, no future `iat`, `sub` required | `OidcClient.verify_id_token` |
| Discovery confined to the issuer origin, no redirect following | endpoint origin check + `follow_redirects=False`, bounded JSON (256 KiB) |
| One-use, browser-bound transaction; `return_to` limited to `/dashboard*` | `SSOService._consume_transaction` + `safe_return_to` |
| Session bound to the browser, `Secure` mandatory on HTTPS | `cb_sso_session` / `cb_sso_txn`, loopback escape only via `ALLOW_INSECURE_LOCALHOST` |
| Idle + absolute TTL, bounded session count | `SESSION_IDLE_MS` (30 m) / `SESSION_TTL_MS` (8 h) / `MAX_SESSIONS` |
| Live admin check on **every** request; revocation on the next request | `authorize()` re-reads UserInfo; `role == "admin" and isAdmin is True and sub` match |
| Refresh rotation serialized per session, logout can't be beaten | per-session `asyncio.Lock`, membership re-checked after each `await` |
| Exact `Origin` + CSRF on mutations, timing-safe compare | `_check_csrf` using `hmac.compare_digest`, `sec-fetch-site` cross-site rejection; mutations cannot omit `Origin` |
| `401` unauthenticated vs `403` forbidden | `/sso/session` literal `401`/`403`; `/admin/*` middleware split |
| Non-empty CSRF token on every success | `_new_csrf()` (32 random bytes, base64url) |
| Fixed, secret-free error codes | `OidcError` / `SSOAuthError` codes only; no token, URL or secret ever in a body |
| Full log clear needs the exact confirmation and no browser key | `CLEAR_CONFIRMATION` check kept; `api_key` read only in legacy mode |
| Encoded route aliases rejected, encoded model IDs preserved | `RequestTargetMiddleware` permits percent-encoding only inside the model-ID window |
| `/v1/*` uses caller credentials only | untouched: SSO never injects a `Bearer` for `/v1` |

Two contract points are deliberately *stronger* natively:

- In SSO mode `POST /admin/session` returns `405` and an admin API-key header
  cannot authorize `/admin/*`, so the API-key path cannot degrade the SSO gate.
- `/admin/*` denies when live UserInfo is unreachable (`403`), rather than
  falling back to the cached claim.

## 4. Test evidence

Environment: temporary venv installed from `requirements.txt` with
`--require-hashes` (uv 0.13.5, PyJWT 2.15.1, cryptography 50.0.2,
fastapi 0.141.1, starlette 1.6.0, httpx 0.28.1), `PYTHONUTF8=1`.

SSO-focused suite — 81 tests, 75 sub-tests, all green:

```
tests/test_sso_config.py        9 passed,  8 subtests passed
tests/test_sso_oidc.py         18 passed
tests/test_sso_auth.py         19 passed, 10 subtests passed
tests/test_sso_admin.py        16 passed,  2 subtests passed
tests/test_sso_race.py          4 passed
tests/test_sso_static.py        6 passed, 16 subtests passed
tests/test_request_target.py    9 passed, 39 subtests passed
------------------------------------------------------------
combined                       81 passed, 75 subtests passed
```

Affected backend regression (legacy auth, admin surface, static hosting,
inference admission) — 285 passed, 1 skipped, 414 sub-tests:

```
tests/test_admin_api.py tests/test_admin_boundaries.py tests/test_security.py
tests/test_login.py tests/test_webui_integration.py tests/test_inference_admission.py
+ all seven SSO files
=> 285 passed, 1 skipped, 414 subtests passed
```

Full suite: `1675 passed, 7 skipped, 13 failed, 4155 subtests passed`. All 13
failures are pre-existing Windows environment defects, not regressions — proven
by running the same files against a pristine `git archive HEAD` checkout in a
temp directory, which fails identically:

| Test file | Failure cause |
| --- | --- |
| `test_audit_store.py` (3) | `PermissionError [WinError 32]` unlinking an open SQLite file |
| `test_control_store.py` (3) | same SQLite handle-on-cleanup defect |
| `test_model_site_blocks.py`, `test_trial_integration.py`, `test_realtime_streaming.py` | temp/SQLite cleanup + locale |
| `test_trial_rewards.py` (3) | POSIX-only `fsync`/permission assertions |
| `test_native_noauth.py` | symlink privileges unavailable to the user |

Coverage of the frozen contracts is exercised, not asserted by inspection:
config fail-closed matrix, discovery/JWKS/claim rejection matrix, PKCE and
credential-placement matrix, transaction replay/expiry/`return_to` escape
matrix, CSRF/Origin/`sec-fetch-site` matrix, idle/absolute timeout, refresh
serialization (2 concurrent reads ⇒ exactly 1 token call), logout-during-refresh
(no resurrection), failed-refresh session destruction, `401`/`403` split,
key-login `405`, API-key header bypass `405`, log-clear confirmation, static
containment, encoded-alias rejection with encoded model IDs still allowed.

### Live end-to-end acceptance

A real `python converter.py` process was started with
`CODEBUDDY2API_SSO_ENABLED=true` against a live mock OIDC IdP on a real socket
(discovery, JWKS, `/authorize`, `/token` with `client_secret_basic` enforcement,
`/userinfo`), driven by `httpx` over TCP — not by AppTest or test doubles:

```
health                              200
anonymous /admin/models             401
anonymous /sso/session              {"authenticated": false, ...}
POST /admin/session (api_key)       405
POST /admin/session (Bearer key)    405
GET  /sso/login?return_to=…         302  -> IdP /authorize 302 -> /sso/callback
/sso/session                        200  authenticated, user{role: admin}
GET  /admin/session                 200  non-empty csrf_token
PATCH /admin/settings (no CSRF)     403
PATCH /admin/settings (+CSRF)       200   (real control-store mutation)
POST /admin/logs/clear wrong text   403
POST /admin/logs/clear exact text   200
GET  /dashboard                     200
GET  /v1/models (no key)            401
GET  /v1/models (admin key)         200
POST /sso/logout                    200
/sso/session after logout           401
GET  /admin/%73ession               400   (encoded alias rejected)
```

## 5. Operational notes for the other owners

- `docker-compose.yml` must set `CODEBUDDY2API_SSO_ENABLED=true`; the native
  default stays `false` so `python converter.py` remains API-key based.
- Sessions are in-process: exactly one Uvicorn worker, and a restart forces a
  new login. Do not add replicas without replacing the session store.
- Registered redirect URI is `${PUBLIC_ORIGIN}/sso/callback`; the IdP client
  must be granted `openid profile roles` (`+offline_access` when
  `OIDC_REFRESH=true`) or `role`/`isAdmin` never reach UserInfo.
- The UI must ship `web/dist/licenses/*` and `THIRD_PARTY_NOTICES.md`; the
  backend serves them at `/dashboard/licenses/{path}` and
  `/dashboard/THIRD_PARTY_NOTICES.md`.
- `storage` is now a valid `/dashboard/{page}` route; unknown pages still
  redirect to the shell.
- Adding `PyJWT[crypto]` was the only dependency change; `uv lock` was re-run
  and `scripts/export_requirements.py` regenerated `requirements.txt`
  (hash install verified in a clean venv).

---

# Acceptance record — real-browser and real-socket verification

This section records the second pass: three confirmed OIDC defects, a cross-layer
CSRF/origin defect, a static-artifact mismatch and a router gap, each fixed and
covered by a regression that exercises real behaviour.

## A1. OIDC defects fixed (`app/sso_oidc.py`)

| # | Defect | Fix |
| --- | --- | --- |
| 1 | `_load()` set `_discovery_failed = True` on any failure, so one transient IdP outage disabled SSO until restart (the comment claimed the opposite) | The failure is no longer cached; the next request retries under the same lock, matching the retired gateway's `this.discovery = null` behaviour |
| 2 | `JWKS_CACHE_SECONDS` was dead: a cached `kid` was returned forever, so revocation and rotation never took effect | Key reuse now requires a fresh set (`JWKS_CACHE_SECONDS`); an expired set or an unknown `kid` refetches, throttled by `JWKS_COOLDOWN_SECONDS` (which now also throttles *failed* refetches). A stale set is never trusted: if the provider cannot be reached, verification fails closed instead of using an unconfirmed key |
| 3 | `_request_json` used a buffered `client.request`, so `MAX_JSON_BYTES` was applied after the whole body was already in memory | Streaming via `client.stream(...)`, with `asyncio.timeout` wrapping connect+headers+body, so the cap aborts the transfer and the 3xx check happens before any body is read |

Regressions: `tests/test_sso_oidc_recovery.py` (discovery recovery after 1 and 3
failures, caching on success, JWKS freshness/expiry/revocation/rotation, unknown
`kid` refetch + rate limit, failed-refetch throttling, stale-set refusal) and
`tests/test_sso_oidc_bounds.py`, which uses a **real TCP listener** that streams
an 8 MiB body: the client raises `response_too_large` and the server provably
cannot deliver more than a fraction of it (the cap is enforced while reading, not
after buffering). A stalled body is cut off by the deadline.

## A2. CSRF / origin contract (`app/sso_auth.py`)

The implementation reused the legacy `same_origin()` helper, which compared
against `request.url` and merged the mutable `admin_allowed_origins` allowlist —
neither is the frozen SSO contract. Now:

- mutations require an `Origin` **exactly equal** to `PUBLIC_ORIGIN`;
- `Origin` must be a bare origin (credentials, path, query, fragment rejected);
- `GET /admin/oauth/poll` may instead present a `Referer` whose origin matches
  `PUBLIC_ORIGIN` (path/query allowed, credentials/fragment rejected), because
  browsers omit `Origin` on same-origin GETs;
- `Sec-Fetch-Site` must be `same-origin` or `none` when present;
- `admin_allowed_origins` is no longer read at all (`set_admin_allowed_origins`
  removed), so a legacy allowlist entry cannot widen SSO trust;
- CSRF comparison stays constant-time.

Regressions: `CsrfOriginContractTests` in `tests/test_sso_admin.py` (legacy
allowlist cannot extend trust, scheme/host/port matrix, malformed-`Origin`
matrix, `Referer` accept/reject matrix, cross-site Fetch Metadata refusal,
Origin-less write refusal, poll via Referer, poll still needing CSRF).

The browser run empirically confirmed the contract: a same-origin `fetch` write
reached the CSRF check (so Chrome **does** send a matching `Origin`), and the
same request without `X-CSRF-Token` was rejected with `csrf_denied` — the exact
reason, not `origin_denied`.

## A3. Static artifact contract (`app/gateway_management.py`)

The UI build emits `dist/LICENSE.upstream.txt`, `dist/THIRD_PARTY_NOTICES.txt` and
`dist/THIRD_PARTY_LICENSES.txt`, but only a Markdown notice and `dist/licenses/*`
were routed. All three `.txt` documents now have explicit routes under
`/dashboard/` (`text/plain; charset=utf-8`, `nosniff`, `max-age=86400`), the
Markdown variant stays as an optional compatibility route, and a missing file is
a real `404`. `tests/test_sso_static.py` verifies this against the **real**
`web/dist` (`RealBuildTests`), not only a synthetic layout.

## A4. Router gap (`page_fallback`)

`/sso/missing` fell through to the SPA fallback and `302`-redirected to
`/dashboard`. `sso` is now in the API prefix set alongside `v1`, `admin` and
`health`, so unknown `/sso/*` paths answer `404`. Covered by
`test_api_surfaces_never_redirect_to_the_shell`.

## A5. Real-socket fixture

`tests/native_sso_fixture.py` starts a synthetic OIDC IdP on a TCP port and the
**actual** `converter.py` process with `CODEBUDDY2API_SSO_ENABLED=true`, and is
used by both the Python and the Playwright suites. It is isolated by
construction:

- the backend runs with `cwd` set to a temporary directory and is invoked by
  absolute path, so no repository `.env`, SQLite file or auth directory is read
  or written;
- every inherited `CODEBUDDY*`, `OIDC_*`, `PUBLIC_ORIGIN`,
  `ALLOW_INSECURE_LOCALHOST`, session/TTL and admin-origin variable is dropped
  before the synthetic values are applied. `EnvironmentIsolationTests` proves
  this by exporting a hostile production-looking environment and asserting the
  fixture still starts SSO against the synthetic IdP;
- the IdP itself enforces PKCE S256 and exactly one client-credential placement,
  so the assertions are about real protocol behaviour.

## A6. Commands and results

```
# Python: unit + real-socket integration (venv from requirements.txt hashes)
$env:PYTHONUTF8="1"
python -m pytest tests/test_sso_config.py tests/test_sso_oidc.py \
  tests/test_sso_oidc_recovery.py tests/test_sso_oidc_bounds.py \
  tests/test_sso_auth.py tests/test_sso_admin.py tests/test_sso_race.py \
  tests/test_sso_static.py tests/test_request_target.py \
  tests/test_native_sso_integration.py -q
=> 116 passed, 133 subtests passed

# Affected backend regression
python -m pytest tests/test_admin_api.py tests/test_admin_boundaries.py \
  tests/test_security.py tests/test_login.py tests/test_webui_integration.py \
  tests/test_inference_admission.py tests/test_request_limits.py -q
=> 219 passed, 1 skipped, 383 subtests passed

# Full suite
python -m pytest tests -q
=> 1721 passed, 7 skipped, 13 failed, 4266 subtests passed
   (the same 13 pre-existing Windows temp/SQLite/symlink failures reproduced on a
    pristine `git archive HEAD` checkout; no new failures)

# Real browser (Chromium 1248 via Playwright 1.63)
cd web
$env:WEBUI_PYTHON="<venv>/Scripts/python.exe"   # NATIVE_SSO_PYTHON also accepted
npx playwright test -c playwright.native.config.ts
=> 2 passed (5.2s)
```

Browser coverage: unauthenticated visitor is redirected to `/dashboard/login`
with no API-key input, clicking `使用统一身份登录` completes the real
`/sso/login → IdP /authorize → /sso/callback → /dashboard/` chain, the console
renders `运行概览` fed by a `200` `/admin/dashboard`, a page-issued `PATCH
/admin/settings` succeeds with the CSRF token and is refused (`csrf_denied`)
without it, the CSRF-gated `GET /admin/oauth/poll` passes via the browser's
same-origin `Referer`, `退出登录` returns to the login page, `/sso/session` and
`/admin/settings` then answer `401`, and a reload cannot resurrect the session.

## A7. Reproducing the fixture by hand

There are two separate modes; do not mix them.

**1) Automatic (the supported, single command).** The config owns the fixture's
lifetime. Run it on its own, with nothing already bound to 8791/8792:

```powershell
cd D:/My2KProjects/codebuddy2api/web
$env:WEBUI_PYTHON = "<venv>\Scripts\python.exe"   # or NATIVE_SSO_PYTHON
npx playwright test -c playwright.native.config.ts
```

**2) Manual (for looking at the running app in a browser only).** Start the
fixture yourself and open the URLs it prints:

```powershell
cd D:/My2KProjects/codebuddy2api
python tests/native_sso_fixture.py --backend-port 8791 --idp-port 8792
# prints {"backend":"http://127.0.0.1:8791","issuer":"http://127.0.0.1:8792", ...}
# open http://127.0.0.1:8791/dashboard/ and sign in through the synthetic IdP
```

Because the config sets `reuseExistingServer: false`, running the Playwright
config while a manually started fixture still holds 8791/8792 fails to bind —
stop the manual fixture first, then run mode 1 alone. `NATIVE_SSO_BASE_URL` only
changes the address the specs address; it does **not** make an externally started
fixture a supported mode, and it does not skip the config's own `webServer` start
and health poll. Stop through the terminal (Ctrl+C) or kill the wrapper's process
tree; the fixture terminates the backend it launched, so no listener is left
behind (verified: no listeners on 8791/8792 after every run).

### How the automatic mode starts the fixture

The config's `webServer` command is `node scripts/start-native-fixture.mjs`: a
shell-free Node wrapper that spawns the fixture with an argument array
(`shell: false`), so an interpreter path containing spaces works on Windows.
Interpreter precedence is `WEBUI_PYTHON` (the CI convention; `.cnb.yml` exports
it as an absolute venv path) → `NATIVE_SSO_PYTHON` → `python` on `PATH`. On exit
the wrapper terminates the whole process tree (`taskkill /T` on Windows,
`SIGTERM` elsewhere), and the fixture terminates the backend it launched, so no
listener survives a run. Ports 8791/8792 are defaults and are overrideable with
`NATIVE_SSO_BACKEND_PORT` / `NATIVE_SSO_IDP_PORT`; 8765 is deliberately avoided
because another local preview server already uses it.

Verified interpreter paths for the browser suite:

| `WEBUI_PYTHON` | Result |
| --- | --- |
| `<venv>\Scripts\python.exe` (no spaces) | 2 passed |
| `%TEMP%\cb2 api spaced venv\Scripts\python.exe` (path **with spaces**, via a directory junction to the same venv) | 2 passed |
| unset, `NATIVE_SSO_PYTHON` set instead | 2 passed |

`vp check` (format + lint + types) passes for `playwright.native.config.ts`,
`e2e/native-sso.integration.ts` and `scripts/start-native-fixture.mjs`, and
`tsc --noEmit` passes for the whole `web` project.
