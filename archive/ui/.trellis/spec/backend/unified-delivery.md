# Unified application and delivery contract

## 1. Scope / trigger

Applies when editing the maintained `codebuddy2api` product's native SSO,
console hosting, release scripts, Dockerfile or Compose configuration. The
2026-10-26 migration supersedes the separate SPA/Node gateway deployment.

## 2. Signatures

- FastAPI owns `/sso/{login,callback,session,logout}`, `/admin/*`, `/v1/*`,
  `/dashboard/*` and `/health` in one process, one Uvicorn worker.
- `python scripts/check_version.py --check-pyproject --check-compose` checks
  `VERSION` against metadata and a release ref.
- `python scripts/package.py` builds an allowlisted archive and SHA-256;
  `python scripts/package.py --verify <archive>` verifies it.
- `docker compose pull` then `docker compose up -d --no-build` deploys images.
- `docker compose --profile auto-update up -d --no-build` enables the updater.
- Local builds add `-f docker-compose.yml -f docker-compose.build.yaml`.

## 3. Contracts

Native SSO is opt-in for direct Python compatibility and on by default in
Compose. Required configuration is `CODEBUDDY2API_SSO_ENABLED=true`,
`PUBLIC_ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`.
Production origins use HTTPS. Only explicit loopback development may enable
`ALLOW_INSECURE_LOCALHOST`. Register `${PUBLIC_ORIGIN}/sso/callback`.

SSO sessions contain opaque HttpOnly cookie IDs. Tokens and client secrets
stay server-side. Sessions are bounded and in memory; restart requires login.
Use PKCE S256, browser-bound one-use state/nonce and RS256 ID tokens. Validate
claims and require matching UserInfo `sub`, `role=admin`, `isAdmin=true` on
each management request. SSO mode never falls back to API-key administration.
Inference independently uses the caller's configured API key.

The browser receives `authenticated`, non-empty `csrf_token`, and
`user{sub,role,username?,name?}`. Keep identity/CSRF in memory. Mutations and
credential-enrollment polling carry `X-CSRF-Token`; the backend validates the
public origin independently. Full log clear sends the exact confirmation
`清空全部日志与统计`, never a browser-supplied admin key.

Release tags match `v<VERSION>`. Stable tags update version aliases and
`latest`; prereleases keep stable aliases unchanged. GitHub/CNB derive image
repositories from current-platform repository context. PRs cannot publish.
Archives contain backend, compiled console, web sources/lockfile, deployment
templates and notices; exclude credentials, databases, actual env files,
agent state, local dependencies and temporary outputs.

Base Compose pulls an image and persists the whole `/data/auth` directory.
The optional pinned updater requires both enable labels and matching project
scope. It excludes itself; the local-build override opts out. A health check
reports liveness and does not implement application rollback.

## 4. Validation and error matrix

| Condition | Expected result |
| --- | --- |
| Incomplete enabled SSO configuration | Startup fails before opening stores |
| Missing/expired session | HTTP 401; UI returns to login |
| UserInfo denies admin or is unavailable | HTTP 403; no protected UI |
| Missing/wrong CSRF or invalid origin | HTTP 403; no mutation |
| API-key login in SSO mode | HTTP 405; no SSO bypass |
| SSO cookie without inference key | Cannot authorize `/v1/*` |
| Missing static/API resource | HTTP 404, no SPA HTML for API/static paths |
| Version/ref mismatch or archive hash mismatch | Non-zero gate exit |
| Pull request | Validation/build only, no login or publication |

## 5. Good / base / bad cases

Good: a stable release passes backend, web, real native SSO browser and package
gates before publication; the server pulls the fork image and retains data.
Base: the updater is disabled; operators manually pull and recreate.
Bad: an archive contains `.env`, UI handles an admin key, SSO silently falls
back to legacy auth, or CI skips a missing native integration configuration.

## 6. Tests required

Use `tests/test_sso_*.py`, `test_request_target.py` and existing admin/inference
regressions. Assert claim rejection, transient provider failure recovery,
bounded streamed responses, JWKS expiry, CSRF/origin, logout/refresh races and
actual built notice-file hosting. Run frontend check, unit tests, build and
Playwright; native integration must self-start synthetic IdP/backend and drive
real browser login, mutation and logout without intercepted auth responses.
Verify package contents/checksums, publication guards, Compose default/profile/
build rendering and project isolation. Record unavailable engine/remote tests.

## 7. Wrong vs correct

Wrong: count mocked session responses as end-to-end OIDC acceptance, inspect
the body limit after an HTTP client has already buffered the response, or
trust independent worker reports without checking their integrated output.

Correct: run a browser against the native app and a synthetic provider on real
TCP sockets; enforce limits during streaming; independently inspect rendered
screenshots and combined tests before committing the unified application.
