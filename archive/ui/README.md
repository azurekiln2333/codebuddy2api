# AzureKiln Administration UI

> 2026-10-26：本 UI 已整合进同工作区的 `codebuddy2api/web/`，正式应用由
> `codebuddy2api` 一个仓库提供后端、原生 OAuth2/OIDC 登录、控制台、镜像及发布。
> 后续产品修改、构建和部署请在 `../codebuddy2api` 进行。此仓库保留迁移前源码和任务记录；
> 下文的独立 SPA 开发说明仅用于历史参考。

AzureKiln is a standalone, browser-based administration console for managing
upstream accounts, model routing, and service state. It is a static React SPA
that runs behind a **same-origin gateway** which owns the `/sso/*` session
contract and the `/admin/*` management API.

- **Brand:** AzureKiln
- **Type:** static SPA (no server code, no embedded secrets, no production mocks)
- **Base path:** `/dashboard/`
- **Auth:** gateway SSO only — the UI never handles an administrative API key

---

## Features

- Dashboard overview of requests, success rate, tokens, and storage health.
- Model routing rules (enable/disable, public/upstream IDs, credential binding).
- Credential management, import/export, and upstream account OAuth enrollment.
- Request/event audit logs with scoped clearing.
- Service settings and storage inspection.
- Light/dark/system appearance, Chinese-first UI, responsive phone layouts.

Authentication is delegated to the gateway. Only an admin SSO session with a
non-empty CSRF token can enter the console; the browser never requests, accepts,
or retains the gateway's administrative API key.

---

## Quick start (development)

```bash
pnpm install --frozen-lockfile
AZUREKILN_GATEWAY_URL=http://127.0.0.1:8788 pnpm dev
```

The dev server listens on `http://127.0.0.1:5174`. Open
`http://127.0.0.1:5174/dashboard/`. `AZUREKILN_GATEWAY_URL` is the proxy target
for `/sso` and `/admin`; without it, API calls fail (there is no mock fallback).

## Build and verify

```bash
pnpm install --frozen-lockfile
pnpm check          # lint + type-check
pnpm test           # unit/component tests
pnpm build          # production build → dist/
pnpm test:browser   # optional Playwright contract tests
```

Publish `dist/` under the gateway's `/dashboard/` path. Full hosting, routing,
SPA fallback, rollback, and validation limits are in
[`docs/deployment.md`](docs/deployment.md). The request/response contract is in
[`docs/gateway-contract.md`](docs/gateway-contract.md). The reusable visual rules and
Tailwind mappings are in [`docs/design-system.md`](docs/design-system.md); final
verification evidence is in [`docs/validation.md`](docs/validation.md).

---

## How authentication works

1. The SPA calls `GET /sso/session`.
2. It renders the console only when the response is
   `{ authenticated: true, csrf_token, user: { …, role: "admin" } }`.
3. Writes send `X-CSRF-Token`; the token is kept in memory only.
4. `401` clears the session and returns to sign-in; `403` shows denied/revoked
   access.
5. Sign-in links to `/sso/login?return_to=/dashboard/`; the gateway owns
   `/sso/callback`; `POST /sso/logout` also sends the CSRF header.

The full contract, including log clearing (`scope`/`confirmation`, no API key in
the browser) and `/admin/oauth` upstream enrollment, is documented in
[`docs/gateway-contract.md`](docs/gateway-contract.md).

---

## Project layout

```
src/            React/TypeScript SPA source
  api.ts        SSO + /admin clients, session store, response validation
  App.tsx       shell, guard, login, routes
  pages/        Dashboard, Models, Credentials, Logs, Settings, Storage
  theme.scss    design tokens (AzureKiln)
  ui.module.scss component styles
e2e/            Playwright browser contract tests
docs/           design system, gateway contract, deployment and validation
dist/           build output (generated, not committed)
```

---

## Deployment summary

- Serve `dist/` at `/dashboard/`.
- `GET /` redirects to `/dashboard/`.
- SPA fallback for `/dashboard` and `/dashboard/**`, **excluding** `/admin` and
  `/sso`.
- Same origin as the gateway; cookies required.
- Verifiable smoke checks and honest validation limits are listed in
  [`docs/deployment.md`](docs/deployment.md).

---

## License and source attribution

This project is a derivative work of the original **codebuddy2api** web
administration UI and is distributed under the MIT License.

- **Upstream source:** `codebuddy2api` web UI
- **Upstream commit:** `fc95b046104ef74e9685066f8338ce01bf9d396b`
- **Upstream license:** MIT
- **Upstream copyright:** Copyright (c) 2026 墨菊

The full upstream license text is preserved verbatim in
[`LICENSE.upstream`](LICENSE.upstream) at the repository root and is included in
source distributions and build output. Third-party dependency notices are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

Modifications in this repository include AzureKiln branding and styling, the
gateway SSO authentication migration (replacing the browser API-key login), and
the removal of the browser-supplied administrative API key from log clearing.
The original upstream repository is not modified by this project.

> Note: this UI does **not** contain or derive from New API code or branding.
