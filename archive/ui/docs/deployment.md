# Deployment

This document describes how to build and host the **AzureKiln** administration UI
(`codebuddy2api-ui`) as static assets behind a same-origin gateway.

The UI is a browser-only React single-page application (SPA). It contains **no
server code, no secrets, and no production mock data**. It renders the original
`/admin/*` management workflows, but authentication and CSRF are delegated to a
same-origin gateway over the `/sso/*` contract.

---

## 1. What this artifact is

- A Vite/vite-plus production build that emits static `dist/` assets.
- Served under the `/dashboard/` base path.
- Talks to the gateway only over same-origin, cookie-authenticated endpoints:
  - `/sso/*` — browser session, login, logout (gateway-owned).
  - `/admin/*` — management API (gateway-owned), write requests carry `X-CSRF-Token`.
- Never accepts, stores, or transmits an administrative API Key.

It is **not** a standalone server. It must be placed behind the gateway that
terminates the `/sso` and `/admin` contracts.

---

## 2. Requirements

| Item | Requirement |
| --- | --- |
| Node.js | 22.12+ or a newer supported LTS |
| Package manager | pnpm `10.32.1` (see `packageManager` in `package.json`) |
| Gateway | Same-origin reverse proxy owning `/sso/*` and `/admin/*` |
| Browser | Evergreen Chromium/Firefox/Safari with cookies enabled |

Install dependencies strictly from the lockfile:

```bash
pnpm install --frozen-lockfile
```

Do **not** install with npm or yarn; the lockfile and `packageManager` field pin pnpm.

---

## 3. Build

```bash
pnpm install --frozen-lockfile
pnpm check          # lint + type-check (type-aware)
pnpm test           # unit/component tests (jsdom)
pnpm build          # production build → dist/
```

Optional browser contract test (Playwright, isolated local server with mocked
`/admin` responses):

```bash
pnpm test:browser
```

The build output is `dist/`. Because `base` is `/dashboard/`, emitted asset URLs
are absolute under `/dashboard/` (for example `/dashboard/assets/index-<hash>.js`).
`dist/` is the only directory to publish; it is git-ignored and must be produced
by the build, never committed.

---

## 4. Local development

```bash
pnpm install --frozen-lockfile
AZUREKILN_GATEWAY_URL=http://127.0.0.1:8788 pnpm dev
```

- The dev server listens on `http://127.0.0.1:5174` (strict port).
- With `AZUREKILN_GATEWAY_URL` set, the dev server proxies `/sso` and `/admin`
  to that gateway. Without it, no proxy is registered and API calls fail with a
  connection error — there is **no built-in mock fallback**.
- In development and production, the SPA base is `/dashboard/`; open
  `http://127.0.0.1:5174/dashboard/`.

Preview a production build locally (proxy is still required for live data):

```bash
pnpm build
AZUREKILN_GATEWAY_URL=http://127.0.0.1:8788 pnpm preview
```

`pnpm preview` serves the built `dist/` for inspection. It does not implement the
gateway or provide mock data.

> Environment variable: `AZUREKILN_GATEWAY_URL` is the single proxy target for
> the `/sso` and `/admin` prefixes in dev/preview. It is a build/dev-time proxy
> hint only; it is never embedded in the client bundle and has no effect on how
> production requests are routed (those are same-origin by definition).

---

## 5. Gateway hosting requirements

The gateway must satisfy the following contract. See
[`gateway-contract.md`](./gateway-contract.md) for request/response details.

### 5.1 Static hosting

- Serve `dist/` contents at the `/dashboard/` path prefix.
- `/dashboard/` must return the SPA `index.html`.

### 5.2 Root redirect

- `GET /` must redirect to `/dashboard/`.

The SPA itself also redirects unknown in-app routes (`*`) to `/dashboard/`, but
the server-side redirect at `/` is required so that bare-origin visits do not
404.

### 5.3 SPA fallback (history mode)

The UI uses client-side routing (`BrowserRouter`). The gateway must serve
`index.html` for unknown **app** routes so deep links work on refresh:

- Fallback applies to `/dashboard` and `/dashboard/**`.
- Fallback **must exclude** the following prefixes, which are gateway-owned and
  must never return `index.html`:
  - `/admin` and `/admin/**`
  - `/sso` and `/sso/**`

Recommended routing order:

1. `/admin/**` → management API (gateway)
2. `/sso/**` → session/identity (gateway)
3. `/dashboard/**` and `/dashboard` → static assets, then `index.html` fallback
4. `/` → `302`/`308` redirect to `/dashboard/`

### 5.4 Same-origin and cookies

- The UI and the gateway must share an origin (scheme + host + port). Cross-origin
  deployment is not supported: the browser sends session cookies to `/sso` and
  `/admin`, and cookie `SameSite`/`Domain` attributes are the gateway's
  responsibility.
- All browser requests are issued with `withCredentials: true`.

### 5.5 CSRF

- The gateway issues a CSRF token in `GET /sso/session`.
- The UI stores it in memory only (never in `localStorage`/`sessionStorage`/
  cookies) and attaches it as the `X-CSRF-Token` header on **every non-GET**
  request to `/admin/*` and on `POST /sso/logout`.
- Write requests are rejected client-side (before dispatch) if there is no
  authenticated session or the token is empty.
- The gateway must verify `X-CSRF-Token` on all state-changing requests and its
  own session logout.
- `GET /admin/oauth/poll` also requires the token because account polling can
  import credentials. The UI attaches CSRF to authenticated admin reads too.

### 5.6 SPA assets and caching

- Hashed assets under `/dashboard/assets/*` may be served with long-lived
  immutable caching.
- `/dashboard/index.html` should be served with no-cache / revalidate so new
  builds are picked up.

---

## 6. Deployment procedure

1. Build in CI or on the release host:
   ```bash
   pnpm install --frozen-lockfile
   pnpm check && pnpm test && pnpm build
   ```
2. Publish `dist/` to the gateway's static root for `/dashboard/`.
3. Ensure gateway routing matches §5 (redirect, fallback, `/sso`, `/admin`).
4. Verify the smoke checks in §8.

### Atomic replacement and rollback

- Ship each build as an immutable, versioned directory (for example
  `dist-<git-sha>/`) and switch the `/dashboard/` document root atomically
  (symlink swap or equivalent).
- Keep the previous known-good artifact. Rollback = repoint the document root to
  the previous artifact and reload. No data migration is involved because the
  UI is stateless.
- Because clients cache `index.html` only briefly, a reload after the switch
  picks up the new bundle.

There is **no automated production deployment in this repository**. Publishing is
a manual/CI step performed by the operator.

---

## 7. Configuration and data

- The UI ships no runtime configuration endpoint and no secrets. Service
  configuration (settings, models, credentials) is read and written through the
  existing `/admin/*` API.
- Credentials and upstream account tokens shown in the UI are **business data**
  managed by the gateway. The browser receives them only as administrator
  content, never as an access credential for the UI itself.
- Log clearing (`POST /admin/logs/clear`) is destructive and confirmed in the UI.
  For `scope: "all"` the operator must type the exact confirmation phrase
  `清空全部日志与统计`. The request body carries only `scope` and `confirmation`
  — it never carries an API key. The gateway performs the deletion with its own
  server-side credentials.

---

## 8. Smoke checks after deploy

1. `GET /` redirects to `/dashboard/`.
2. Opening `/dashboard/` while unauthenticated shows the sign-in card and does
   not render management data.
3. Following "使用统一身份登录" goes to `/sso/login?return_to=/dashboard/`, and the
   gateway returns to `/dashboard/` after the provider callback.
4. `GET /sso/session` returns `{ authenticated, csrf_token, user }` for an admin.
5. A write action (for example saving a model rule) sends `X-CSRF-Token`.
6. `POST /sso/logout` sends `X-CSRF-Token` and returns the browser to the
   signed-out state.
7. Deep links such as `/dashboard/logs` and `/dashboard/settings` survive a
   hard refresh (SPA fallback active).
8. `/admin/session` and `/sso/session` are **not** rewritten to `index.html`.
9. Light and dark themes and a phone-width viewport render without clipped tables.

---

## 9. Honest validation limits

The following are **not** validated in this repository and must be confirmed
against a real gateway, identity provider, and upstream account before relying on
them in production:

- No live identity-provider login is exercised. Provider callback behavior,
  cookie attributes, and real `return_to` handling are gateway/IdP concerns.
- No live upstream OAuth enrollment (`/admin/oauth/start` + `/admin/oauth/poll`)
  is completed against the real provider. The UI's user-code/verification-URI
  handling is covered only by contract tests with mocked responses.
- The standard unit/browser suites do not contact a real management API or
  credential store: unit tests use jsdom and browser contract tests use route
  mocks. The optional integration configuration targets a dedicated synthetic
  fixture; it must never point at production. A separate gateway-owned local
  smoke run used the real backend with isolated data and a synthetic OAuth
  provider; see [validation.md](./validation.md). There is no production mock
  fallback in the app.
- The UI suites assert the CSRF and 401/403 client contract. Gateway security
  verification is recorded in the gateway repository; production session expiry
  and provider behavior still require deployment acceptance.

Treat sections 5 and 8 as the acceptance criteria to validate during a real
staged rollout.

---

## 10. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Blank page, 404 on `/dashboard/assets/*` | Wrong base path or document root; assets must be served under `/dashboard/`. |
| Deep link 404 on refresh | SPA fallback missing for `/dashboard/**`, or fallback incorrectly swallowing `/admin`/`/sso`. |
| "无法连接管理 API" on every action | Gateway not proxying `/admin`, or dev/preview missing `AZUREKILN_GATEWAY_URL`. |
| Write actions fail with "当前会话不可用" | Session not authenticated or `csrf_token` empty in `/sso/session`. |
| Write actions fail with HTTP 403 | `X-CSRF-Token` missing/mismatched at the gateway, or the user lacks the admin role. |
| Signed out unexpectedly | Gateway returned `401`, which clears in-memory identity and returns to sign-in. |
| Login loop after callback | `return_to` must be `/dashboard/`, and the session cookie domain/`SameSite` must be valid for the origin. |
