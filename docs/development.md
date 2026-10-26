# Unified application development

This repository contains the complete fork. `converter.py` and `app/` provide
the inference gateway, native OIDC console login and management API. `web/`
contains the replacement React console. The Dockerfile builds the console and
ships one Python runtime. Sibling UI, OAuth gateway and panel checkouts are
migration references and are not needed to build or run this repository.

## Authentication boundaries

Production Compose enables `CODEBUDDY2API_SSO_ENABLED=true`. Direct Python
startup keeps the legacy API mode unless SSO is enabled. The replacement
console requires SSO. See [deployment](deployment.md) for provider setup.

Native SSO owns `/sso/login`, `/sso/callback`, `/sso/session` and `/sso/logout`.
It uses confidential OIDC with PKCE S256, one-use browser-bound state/nonce and
RS256 verification. Browser cookies contain opaque IDs; tokens and client
secrets remain in the backend. Each management request checks live UserInfo
for a matching subject, `role=admin` and `isAdmin=true`. API-key headers cannot
authorize management in SSO mode. `/v1/*` independently checks the inference
key; a console cookie cannot authorize inference.

The console keeps identity and CSRF only in memory. Writes and credential
enrollment polling carry `X-CSRF-Token`. The backend validates the public
origin; the legacy CSRF switch cannot disable SSO checks. Full log clearing
requires the exact confirmation `清空全部日志与统计`. Credential enrollment is
a separate OAuth flow from console login.

Use one Uvicorn worker. Sessions and pending logins are bounded, in memory and
lost on restart. Credentials, settings and audit data persist in the full
`auth/` directory. Do not share that directory between running instances.

## Local checks

Install Python dependencies from the hashed `requirements.txt` in an isolated
environment, and install the locked web dependencies:

```bash
python -m pip install --require-hashes --only-binary=:all: -r requirements.txt
pnpm --dir web install --frozen-lockfile
python scripts/check_version.py --check-pyproject --check-compose
python scripts/run_backend_tests.py
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright install chromium-headless-shell
pnpm --dir web exec playwright test
pnpm --dir web exec playwright test -c playwright.native.config.ts
```

Set `WEBUI_PYTHON` to the isolated environment's Python executable for native
browser integration. `WEBUI_CHROMIUM` can select an installed Chromium binary.
The native suite starts a synthetic OIDC provider and the actual backend on
loopback TCP sockets with isolated temporary data; it drives login, callback,
real management requests, CSRF checks and logout. Browser route mocks in the
default suite cover client behavior separately. The older external integration
configuration requires a dedicated fixture and is not a CI entry point.

Build output includes the upstream MIT notice and full dependency license
texts. Review actual desktop/mobile screenshots in light and dark themes.
The panel-inspired design uses a 52px header, 180/64px sidebar and the initial
`正在连接控制台` screen; see [design system](design-system.md).

## Releases and deployment

`VERSION` is authoritative; keep `pyproject.toml` metadata synchronized before
tagging `v<VERSION>`. GitHub Actions and CNB validate the application and produce
a source archive containing the built UI and its rebuildable source/lockfile:

```bash
python scripts/package.py
python scripts/package.py --verify dist/<archive>.tar.gz
```

The archive has a SHA-256 sidecar and excludes local credentials, env files,
databases and agent state. The same Dockerfile builds a checkout or extracted
release. Stable release images update `latest`; prereleases leave stable
aliases unchanged. Publication paths derive from the fork's repository context.
Pull requests validate without publishing credentials or artifacts to a registry.

Server deployment uses `docker compose pull` followed by
`docker compose up -d --no-build`. Optional `auto-update` selects only this
deployment's enabled application container. The separate local build override
opts out of image updates. See [deployment](deployment.md) for private registry
credentials, update intervals, backups and version rollback.
