# Unified application development

[Home](../README.md) · [简体中文](development.zh-CN.md)

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

Install Python dependencies with `uv sync --locked` or from the hashed
`requirements.txt` in an isolated environment, and install the locked web dependencies:

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

The archive has a SHA-256 sidecar and an updater-compatible `SHA256SUMS` asset and excludes local credentials, env files,
databases and agent state. The same Dockerfile builds a checkout or extracted
release. Stable release images update `latest`; prereleases leave stable
aliases unchanged. Publication paths derive from the fork's repository context.
Pull requests validate without publishing credentials or artifacts to a registry.

Server deployment uses `docker compose pull` followed by
`docker compose up -d --no-build`. Optional `auto-update` selects only this
deployment's enabled application container. The separate local build override
opts out of image updates. See [deployment](deployment.md) for private registry
credentials, update intervals, backups and version rollback.

## Simulated upstream preview

```bash
uv run --locked --no-build python -B -m preview                   # http://127.0.0.1:8790, key: preview
uv run --locked --no-build python -B -m preview --port 8790 --data-dir /tmp/cb-preview
```

| Option | Default | Purpose |
|--------|---------|---------|
| `--host` / `--port` | `127.0.0.1` / `8790` | Listener |
| `--api-key` | `preview` | External admin inference key; also the compatibility-mode admin password |
| `--data-dir` | new temporary directory | Keep the preview data across restarts; the directory must be empty or created by the preview |
| `--public` | off | Refuse actions unsafe on a shared demo; see [Shared API demos](#shared-api-demos-and-isolation) |
| `--reset-hours` | `0` (never) | Exit after this many hours so a supervisor restarts with fresh data |
| other options | — | Passed to the gateway unchanged, such as `--admin-allowed-origins` |

Use the API at `http://127.0.0.1:8790/v1` with the inference key `preview` (or the `--api-key` value). The preview also seeds standard keys demonstrating expiry, IP and model restrictions.

The preview's sandbox disables external network access and starts the backend in SSO-disabled compatibility mode. It therefore does not provide an OIDC sign-in for this fork's console. Do not use its local `admin` / `preview` password on the replacement UI. Use the native SSO integration fixture described above to exercise the console, or point `AZUREKILN_GATEWAY_URL` at an SSO-configured local gateway when running `pnpm --dir web dev`.

### What is simulated

Everything below the gateway is simulated; everything in it is the real code. Requests, failover, cooldowns, billing, audit records and background automation run as they do in production.

| Area | Behaviour |
|------|-----------|
| Accounts | Eight synthetic accounts: domestic and international, CodeBuddy and WorkBuddy, an unlimited and a metered enterprise tenant, and one signed-out account whose refresh token was revoked |
| History | A month of request records, so the overview, logs and statistics open populated |
| Balances | Credit packages with different expiries; requests consume them, check-ins, trips, tasks and trial credits add to them |
| Models | Per-region catalogs with rates, capabilities and limits |
| Inference | Chat Completions, Responses and Anthropic Messages stream a simulated reply that quotes your message, with reasoning where the model supports it |
| Media | Seeded images and videos plus simulated generation; public-mode media and model writes are restricted by the preview guard |
| Automation | Check-in, Buddy travel (a trip takes three minutes), growth tasks, trial credits and the international active check-in |
| Sign-in | Adding an account signs in a new synthetic account by itself after four seconds; the official login link it shows never needs to be opened |
| Search, fetch and MCP | `/v1/search`, `/v1/fetch` and the MCP `web_search` / `web_fetch` tools return simulated results on `example.com` |
| Updates | The release list holds only the current version, the mirror speed test downloads a simulated archive, and installing is disabled |

Upstream state lives in memory and starts over on every launch, while the gateway's own data stays in the data directory.

### Message directives

Put a directive anywhere in the last user message to steer the simulated model:

| Directive | Effect |
|-----------|--------|
| `[preview:tool]` / `[preview:tool=Name]` | Call the first or the named tool with placeholder arguments. Tools are never called without it, because a client may run whatever it is told to |
| `[preview:429]` | Answer 429 with a quota reset time, triggering cooldown and failover |
| `[preview:500]` | Answer an upstream server error |
| `[preview:slow]` | Stream slowly, to watch realtime streaming |
| `[preview:long]` | Append a long numbered list |

### Shared API demos and isolation

`--public` restricts management writes, credential transfers, log clearing, archiving and updates. `--reset-hours` exits so a supervisor can restart with fresh data. These options apply to the simulated API service; they do not add an SSO login or a public browser demo. Keep its known `preview` key separate from real deployments.

- The preview never reads the repository's `.env` or `auth/`: it removes every `CODEBUDDY*` variable from its environment, works from its own data directory and refuses to use `auth/`.
- Every httpx request is answered by the simulation. Other outbound sockets and DNS lookups are refused, and the active check-in channel, which bypasses httpx, is replaced. Endpoints that are not simulated answer 501 and are logged once as `[preview] 未模拟的上游接口`.
- One-click updates are disabled, so the working tree is never replaced.
