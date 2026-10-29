# Gateway contract

This document is the integration contract between the **AzureKiln** administration
UI (this SPA) and the same-origin gateway. It is derived from the implemented
client code (`src/api.ts`, `src/App.tsx`, `src/OAuth.tsx`,
`src/components.tsx`) and is the source of truth for what the UI sends and
requires.

The UI is browser-only. It never implements these endpoints; the gateway must.

---

## 1. Origin and authentication model

- **Same-origin only.** All requests are relative and sent with
  `withCredentials: true`. Cookie-based session auth is assumed.
- The UI authenticates **only** through the gateway SSO session. There is no
  API Key input field, and the browser never requests, accepts, or retains the
  gateway's administrative API key.
- Two axios clients exist:
  - `sso` — `baseURL: "/sso"`, timeout 20s, `withCredentials: true`.
  - `api` — `baseURL: "/admin"`, timeout 20s, `withCredentials: true`.
- On application start the UI checks `GET /sso/session` to establish or reject
  the session. Explicit retry can start a newer check; obsolete responses cannot
  restore an identity after logout, revocation, or a newer check.

---

## 2. SSO session endpoints (gateway-owned)

### 2.1 `GET /sso/session`

Returns the current browser session. Two valid shapes.

**Authenticated (admin):**

```json
{
  "authenticated": true,
  "csrf_token": "non-empty-string",
  "user": {
    "sub": "non-empty-string",
    "username": "optional-string",
    "name": "optional-string",
    "role": "admin"
  }
}
```

**Unauthenticated:**

```json
{ "authenticated": false, "csrf_token": null, "user": null }
```

UI validation rules (mismatch → session error, management UI not rendered):

- `authenticated` must be exactly `true` or `false`.
- For `true`: `csrf_token` must be a non-empty string; `user` must be an object
  with a non-empty string `sub`; `username`/`name`, if present, must be strings;
  `role` must be exactly `"admin"`.
- For `false`: `csrf_token` and `user` must be `null`.
- If `role !== "admin"`, the UI enters a **forbidden** state (no data rendered)
  and offers re-login — this is the denied/revoked-user path.

HTTP status behavior:

- `401` → treated as anonymous; identity and CSRF are cleared.
- `403` → treated as forbidden/denied; a denial message is shown.
- Any non-2xx that is neither 401 nor 403, or a malformed body → session **error**
  state with a retry action.
- Success with `role: "admin"` and a non-empty token → **authenticated**; the
  token is held in memory only.

### 2.2 `GET /sso/login?return_to=/dashboard/`

The UI constructs this URL exactly as:

```
/sso/login?return_to=/dashboard/
```

It is used as a plain link/redirect. The gateway initiates provider login and
must honor `return_to=/dashboard/` so the user lands on the SPA after the
callback.

### 2.3 `GET /sso/callback` (gateway-owned)

Provider callback. The gateway completes the exchange, establishes the session
cookie, and redirects to `return_to` (the SPA under `/dashboard/`). The UI has no
route or handler for this path.

### 2.4 `POST /sso/logout`

- Method: `POST`, empty body.
- Header: `X-CSRF-Token: <session csrf_token>` (required).
- The UI only sends this when the session is authenticated with a non-empty
  token; otherwise it throws "当前会话不可用，请重新登录。" without a request.
- On success the UI clears identity and CSRF and shows the signed-out state.
- On `401`/`403` the UI also clears/denies the session.

---

## 3. CSRF contract

- Source: `csrf_token` from `GET /sso/session`.
- Storage: in-memory Zustand store only. Never persisted to
  `localStorage`/`sessionStorage`/cookies.
- Attachment: the `api` interceptor attaches `X-CSRF-Token: <token>` to all
  authenticated admin requests, including reads. Every write and the mutating
  `GET /admin/oauth/poll` require an authenticated session and a non-empty token
  before dispatch. `POST /sso/logout` sends the same header explicitly.
- Guard: if a write or account poll is attempted without an authenticated session or with an empty token,
  the request is **aborted client-side** with "当前会话不可用，请重新登录后再操作。"
  The gateway should still enforce CSRF independently.
- The gateway must reject state-changing requests that lack a valid
  `X-CSRF-Token`.

---

## 4. Error and status semantics

The UI distinguishes the following. The gateway must return these statuses
consistently, optionally with an error body.

| Status | Meaning | UI behavior |
| --- | --- | --- |
| `401` | Not authenticated / session expired | Clear in-memory identity + CSRF; show signed-out state; require re-login. |
| `403` | Authenticated but not permitted / revoked | Show denied/revoked access message; clear identity; offer re-login. |
| `409` | Conflicting concurrent update | Prompt to close the editor, refresh, and retry. |
| other 4xx/5xx | Request failure | Surface `error.message` / `detail` / `detail.error.message` when present; else a generic HTTP failure. |
| network error | No response | "无法连接管理 API…" with retry. |

Preferred error bodies (any of these are recognized):

```json
{ "error": { "message": "..." } }
{ "detail": "..." }
{ "detail": { "message": "..." } }
{ "detail": { "error": { "message": "..." } } }
```

A `409` conflict may instead carry a model-reference payload:

```json
{ "detail": { "models": ["model-a", "model-b"] } }
```

which the UI renders as "凭证仍被模型规则引用，请先解除绑定：…".

**401 vs 403 distinction is contractual.** `401` means "sign in"; `403` means
"your account is denied or was revoked". The UI maps them to different states and
messages and must not conflate them.

---

## 5. Management API (`/admin/*`)

These endpoints preserve the original behavior and are proxied to the gateway.

- All reads are `GET` and require the session cookie.
- All writes (`POST`/`PUT`/`PATCH`/`DELETE`) require the session cookie **and**
  `X-CSRF-Token`.
- The UI validates response shapes and throws a contract error on malformed data
  rather than rendering partial results.

Representative endpoints used by the preserved workflows (shape expectations are
enforced by the client):

- `GET /admin/dashboard` — summary, series, models, profiles, health, storage.
- `GET /admin/models` — `{ revision, models[], model_guard*, model_capability_guard* }`.
- `GET /admin/credentials` — `{ credentials: [{ account_key|id, name|filename, ... }] }`.
  The public identifier is `account_key` (or `id`); a name containing path
  separators is rejected client-side.
- `GET /admin/logs` — request/event audit pages.
- `GET /admin/settings` — `{ revision, items[], audit, session }` service config.
- `GET /admin/storage` — storage metrics.

The UI sends mutation requests for models, credentials, settings, and similar
resources; each carries `X-CSRF-Token`. The exact resource bodies mirror the
original management API and are unchanged by the SSO migration.

### 5.1 Log clearing — `POST /admin/logs/clear`

Request body (exactly these fields; **no API key**):

```json
{ "scope": "details" | "all", "confirmation": "" | "清空全部日志与统计" }
```

- `scope: "details"` — clear request details/event logs, keep aggregate stats.
  `confirmation` is an empty string.
- `scope: "all"` — clear everything (details, events, and statistics).
  `confirmation` must equal the exact phrase `清空全部日志与统计`; the UI disables
  the confirm button until it matches.
- Success must be `{ "ok": true }`; any other body (including `ok` not `true`)
  is treated as unconfirmed failure.

**Server-side responsibility:** the gateway deletes using its own server-side
credentials. The browser never provides, and the request never contains, the
administrative API key. This is the core of the migration: log deletion
authorization comes from the admin SSO session + CSRF, and the elevated API key
stays on the server.

### 5.2 Upstream account enrollment — `/admin/oauth`

`/admin/oauth` is **account enrollment**, not UI authentication. The UI drives it
to add an upstream provider account:

- `POST /admin/oauth/start?site=<site>` → `{ login_id, verification_uri, expires_in }`.
  - `login_id` must be a non-empty string.
  - `verification_uri` is validated against an official allow-list before being
    shown/opened; a non-allow-listed URL is rejected client-side.
  - Polling window is capped at 600 seconds.
- `GET /admin/oauth/poll` → `{ done: boolean, ... }` (`done` must be boolean),
  polled while awaiting provider authorization.

Both require `X-CSRF-Token`, including the GET poll because it can import
credentials, and are proxied by the gateway. The gateway owns the upstream provider exchange and stores the resulting
account token.

---

## 6. Routing contract (client and server)

### 6.1 Client routes

| Path | Purpose |
| --- | --- |
| `/` | Redirects to `/dashboard/` (catch-all `*` route). |
| `/dashboard/` | Dashboard overview (index). |
| `/dashboard/models` | Model routing. |
| `/dashboard/credentials` | Credentials + OAuth enrollment. |
| `/dashboard/logs` | Audit logs. |
| `/dashboard/settings` | Service settings. |
| `/dashboard/storage` | Storage. |
| `/dashboard/login` | Sign-in card (unauthenticated/forbidden). |
| any unknown path | Redirects to `/dashboard/`. |

An authenticated user visiting `/dashboard/login` is redirected to `/dashboard/`.

### 6.2 Server (gateway) routing

- `GET /` → redirect to `/dashboard/`.
- `/admin/**` → gateway management API (never SPA fallback).
- `/sso/**` → gateway SSO (never SPA fallback).
- `/dashboard` and `/dashboard/**` → static assets, then `index.html`
  fallback for the app shell.

See [`deployment.md`](./deployment.md) §5 for the required routing order.

---

## 7. Security invariants

These must hold in any integration:

1. The browser never sends, stores, or displays the administrative API key as a
   UI credential.
2. The SSO CSRF token lives only in memory and is sent as `X-CSRF-Token` on every
   write and on logout.
3. `GET /sso/session` is the sole source of UI identity; `role` must be `admin`.
4. Log clearing uses the SSO session + CSRF, and the gateway performs deletion
   with server-side credentials.
5. `/admin/oauth` is upstream account enrollment, unrelated to UI sign-in.
6. `401` (sign in) and `403` (denied/revoked) remain semantically distinct.

---

## 8. Contract test coverage and limits

Covered by automated tests (mocked, in-repo):

- Session parsing, malformed session, admin-role gating, `401`/`403` handling.
- CSRF header attachment on writes and client-side write guard.
- Log-clear `scope`/`confirmation` body shaping and `{ ok: true }` validation.
- Routing, redirects, and theme/viewport rendering (Playwright contract specs).

Not covered (requires a real gateway/provider/admin account):

- Real provider login and `/sso/callback` behavior.
- Real `X-CSRF-Token` verification at the gateway.
- Live upstream OAuth enrollment and real upstream API calls.

Where the gateway's actual behavior differs from this document, the gateway and
this contract must be reconciled deliberately; do not paper over differences with
client-side mocks.
