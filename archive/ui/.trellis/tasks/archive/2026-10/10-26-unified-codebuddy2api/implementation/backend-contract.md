# Backend / OAuth2 implementation contract

Owner: Pi backend pane. Product root: `D:/My2KProjects/codebuddy2api`.
Read by the deployment owner before env integration and by main for integration review.
Contract is fixed at implementation time; change only through the coordinator.

## 1. Enable switch

| Purpose | Env var | Values | Default |
| --- | --- | --- | --- |
| Native SSO mode | `CODEBUDDY2API_SSO_ENABLED` | `true`/`false` (also `1/0`, `yes/no`, `on/off`) | `false` |

- Native default is `false`: `python converter.py` keeps the existing API-key
  administration behaviour, so all legacy regression is preserved.
- Production `docker-compose.yml` MUST set `CODEBUDDY2API_SSO_ENABLED=true`
  explicitly. SSO mode is fail-closed: startup aborts when any required value
  below is missing or unsafe.
- Once SSO mode is on there is **no API-key fallback for `/admin/*`**:
  `POST /admin/session` returns 405, and a Bearer/X-Api-Key header cannot
  authorize management routes. `/v1/*` inference API keys keep working.

## 2. Required when `CODEBUDDY2API_SSO_ENABLED=true`

| Env var | Meaning | Constraint |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | Browser-facing origin of this application | HTTPS; no path/query/userinfo. Loopback HTTP only with `ALLOW_INSECURE_LOCALHOST=true` |
| `OIDC_ISSUER` | OIDC issuer base (discovery under `{issuer}/.well-known/openid-configuration`) | HTTPS; a path is allowed (e.g. `/realms/x`) |
| `OIDC_CLIENT_ID` | Confidential client id | non-empty |
| `OIDC_CLIENT_SECRET` | Confidential client secret | non-empty |
| `OIDC_REFRESH` | Request `offline_access` and rotate refresh tokens | `true`/`false`, default `false` |
| `ALLOW_INSECURE_LOCALHOST` | Explicit loopback dev escape: allow HTTP origins and non-Secure cookies | `true`/`false`, default `false`. Never enable in production |

Registered redirect URI: `${PUBLIC_ORIGIN}/sso/callback`. Scopes:
`openid profile roles` (plus `offline_access` when `OIDC_REFRESH=true`).
`roles` is required — `role`/`isAdmin` only appear in UserInfo when granted.

## 3. Optional SSO tuning (Node-gateway names preserved)

| Env var | Default | Range |
| --- | --- | --- |
| `SESSION_TTL_MS` | `28800000` (8 h) | 60000..86400000 |
| `SESSION_IDLE_MS` | `1800000` (30 m) | 60000..86400000, must be ≤ `SESSION_TTL_MS` |
| `TRANSACTION_TTL_MS` | `300000` (5 m) | 10000..600000 |
| `MAX_SESSIONS` | `1000` | 1..100000 |
| `OAUTH_TIMEOUT_MS` | `5000` | 100..30000 |

No `MAX_BODY_BYTES` port: the native backend already bounds management request
bodies (`admin_api._body`, `MAX_UPLOAD_BYTES`).

## 4. Runtime shape

- One Python process, one Uvicorn worker. SSO sessions and one-use login
  transactions live in process memory only; a restart requires a new login
  (same as the retired gateway). No shared store, no horizontal scaling.
- `/sso/*`, `/admin/*`, `/v1/*`, `/dashboard/*`, `/health` are served by FastAPI.
- `/admin/*` requires a live SSO identity: `sub` matches the ID token and live
  UserInfo reports `role === "admin"` **and** `isAdmin === true`, re-checked on
  every request. `401` = no usable session; `403` = session present but not/no
  longer an authorized administrator.
- Introduction of SSO adds a raw-request-target guard (SSO mode only) that
  rejects encoded route aliases, traversal, duplicate separators and backslashes
  while preserving legal percent-encoded model IDs.

## 4a. Browser origin contract (real behaviour)

Only `PUBLIC_ORIGIN` is trusted. The legacy `CODEBUDDY2API_ADMIN_ORIGINS`
allowlist is **not** consulted in SSO mode and cannot widen this check.

| Request | Required |
| --- | --- |
| Any mutation (`POST`/`PUT`/`PATCH`/`DELETE`) | `Origin` exactly `PUBLIC_ORIGIN` (scheme+host+port, with **no** credentials, path, query or fragment) **and** a matching `X-CSRF-Token` |
| `GET /admin/oauth/poll` (CSRF-gated read) | Either the same exact `Origin`, or — because browsers omit `Origin` on a same-origin GET — a `Referer` whose origin is `PUBLIC_ORIGIN` (a path/query is allowed, credentials and a fragment are not) **and** a matching `X-CSRF-Token` |
| Any request | `Sec-Fetch-Site`, when present, must be `same-origin` or `none`; `cross-site` and `same-site` are always refused |

Errors are `403 {"error":"origin_denied"}` or `403 {"error":"csrf_denied"}`;
the token compare is constant time. A mutation that omits `Origin` is refused
even when a plausible `Referer` is present.

## 4b. Static interface delivered to the UI build

The UI build ships four documents at the dist root, all reachable under
`/dashboard/`: `LICENSE.upstream.txt`, `THIRD_PARTY_NOTICES.txt`,
`THIRD_PARTY_LICENSES.txt` (all `text/plain; charset=utf-8`) and, for older
builds, an optional `THIRD_PARTY_NOTICES.md` (`text/markdown`). A missing
document is a real `404`, not the SPA shell. Pages are the whitelist
`"" models credentials logs settings storage login`; `/dashboard/assets/*` is
immutable, `/dashboard/licenses/*` is served from `dist/licenses/` when present.
API prefixes (`/v1`, `/admin`, `/health`, `/sso`, `/cn/v1`, `/intl/v1`) answer
their own `404`s and never redirect to the dashboard shell.

## 5. Cookies

| Cookie | Path | Attributes | Holds |
| --- | --- | --- | --- |
| `cb_sso_session` | `/` (root) | HttpOnly, SameSite=Lax, Secure on HTTPS | opaque session id only |
| `cb_sso_txn` | `/` (root) | HttpOnly, SameSite=Lax, Secure on HTTPS | one-use login transaction id |

- Distinct from the legacy `cb_admin_session` cookie; the legacy cookie is never
  issued in SSO mode.
- Browser never receives OIDC tokens, client secret or any upstream credential.

## 6. Public response shapes (unchanged from the retired gateway)

```
GET  /sso/session  200 {"authenticated":true,"csrf_token":"…","user":{"sub":…,"username"?,"name"?,"role":"admin"}}
                   401 {"authenticated":false,"csrf_token":null,"user":null}
                   403 fixed error body (session exists but not admin)
GET  /sso/login?return_to=/dashboard/   302 to the authorization endpoint
GET  /sso/callback                       302 back to a dashboard path
POST /sso/logout                         200 {"authenticated":false}  (Origin + X-CSRF-Token)
GET  /admin/session                      200 {"authenticated":true,"csrf_token":"…"} / 401 shape
DELETE /admin/session                    logout, {"authenticated":false}
POST /admin/session                      405 (never an API-key login in SSO mode)
```

All errors reduce to fixed, secret-free codes (`unauthorized`, `forbidden`,
`login_transaction_invalid`, `token_exchange_failed`, `id_token_invalid`, …).

## 7. What stays the same

- `/v1/*` caller API-key authorization and streaming are unchanged.
- Account-enrollment OAuth (`/admin/oauth/start|poll`) keeps task ownership,
  CSRF on `GET /admin/oauth/poll`, and credential persistence.
- `POST /admin/logs/clear` still requires the exact
  `confirmation` (`清空全部日志与统计`) for `scope=all`; in SSO mode the trusted
  SSO identity replaces the browser-supplied `api_key`, which is never read.