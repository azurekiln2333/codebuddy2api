# Deployment

[Home](../README.md) · [简体中文](deployment.zh-CN.md)

Prefer the [WebUI](webui.md) for everyday account, model and log management. Run the commands below from the repository root.

Docker deployment needs **Docker Compose v2** (`docker compose`). The obsolete `version:` key is gone and the optional update service uses profiles, so Compose v1 / `docker-compose` is not supported.

## Configuration and data

On first setup, run `cp .env.example .env` and set `CODEBUDDY2API_KEY` to your own random key. Keep an existing `.env` and add only the settings you need.

| Setting | Purpose |
|---------|---------|
| `CODEBUDDY2API_IMAGE` | Compose image to pull; the template points at this fork, never the upstream author's repository |
| `CODEBUDDY2API_SSO_ENABLED` / `PUBLIC_ORIGIN` / `OIDC_*` / `ALLOW_INSECURE_LOCALHOST` | Console login; see [Console login](#console-login-oidc) |
| `WATCHTOWER_POLL_INTERVAL` | Seconds between automatic image checks; default `600` |
| `CODEBUDDY2API_BIND` / `CODEBUDDY2API_PORT` | Native listener and Compose host mapping; default `127.0.0.1:8787` |
| `CODEBUDDY2API_AUTH_PATH` | Compose host data directory; defaults to `./auth`, mounted at `/data/auth` |
| `CODEBUDDY2API_TRUSTED_PROXIES` | Trusted proxy IPs/CIDRs (comma separated); when the direct peer matches, the audit log records the client from `X-Forwarded-For`/`X-Real-IP` instead of the proxy address |
| `CODEBUDDY_AUTH_DIR` | Local Python data directory; defaults to the repository's `auth/`. Compose sets it to `/data/auth` inside the container |
| `CODEBUDDY_IMPORT_DIR` | Optional import directory; defaults to `imports/` under the data directory. Use container paths with Compose |
The example lists all active runtime variables, including inbound/aggregate byte limits, concurrency, tool retries and failover. Compose forwards these limits; unset optional settings (tool metadata, Responses projection, origin allowlist, failover and similar) remain configurable in the WebUI. Zero disables aggregate/concurrency limits, per-item Responses trimming or extra retries, not the required positive inbound limit.

Compose reads declared variables from `.env`; shell variables take precedence. The default host mapping is loopback. Set a random key, HTTPS and access restrictions before allowing remote connections. Container binding remains `0.0.0.0:8787`; change host exposure using `BIND/PORT`, not container listener arguments.

Mount the entire data directory on writable local storage, not just one SQLite file, and do not share it between instances. Stop the gateway and back up the whole directory before upgrading; see [data and backups](webui.md#data-and-backups).

## Console login (OIDC)

Compose runs in console-login mode (`CODEBUDDY2API_SSO_ENABLED=true`). Fill in every value below before the first `docker compose up`; startup fails closed when they are missing, and there is no API-key fallback for console login while this mode is enabled.

| Setting | Purpose |
|---------|---------|
| `PUBLIC_ORIGIN` | Public HTTPS origin browsers use, no trailing slash. Also the Origin allowlist and the redirect base. |
| `OIDC_ISSUER` | Issuer exposing HTTPS discovery and JWKS. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Confidential client credentials; the browser never receives the secret. |
| `OIDC_REFRESH` | `true` requests `offline_access` and rotating refresh tokens. |
| `ALLOW_INSECURE_LOCALHOST` | Loopback development escape hatch for plain-HTTP origins. Keep `false` in production. |
| `SESSION_TTL_MS` / `SESSION_IDLE_MS` / `TRANSACTION_TTL_MS` / `MAX_SESSIONS` / `OAUTH_TIMEOUT_MS` | Optional tuning (empty keeps the default). Config fails closed when `SESSION_IDLE_MS` exceeds `SESSION_TTL_MS`. |

Register the redirect URI `<PUBLIC_ORIGIN>/sso/callback` and grant `openid profile roles`. `roles` is required: administrator authorization reads live user info and needs both the admin role and its admin flag. `CODEBUDDY2API_KEY` stays the inference and automation credential, and the console never uses it. Set `CODEBUDDY2API_SSO_ENABLED=false` only for legacy local API operation without a console login.

## Docker Compose

### Use published images

Set `CODEBUDDY2API_IMAGE` in `.env` to your fork's published image. The template default points at the fork's GHCR path; replace the owner with your own when you deploy elsewhere. Both registries publish the same release tags:

```dotenv
# GitHub fork
CODEBUDDY2API_IMAGE=ghcr.io/<github-owner>/codebuddy2api:latest
# CNB fork (the repository slug already ends with the repository name)
CODEBUDDY2API_IMAGE=docker.cnb.cool/<cnb-repo-slug>:latest
```

Then pull and start without building anything on the host:

```bash
docker compose pull
docker compose up -d --no-build
```

The workflows target `linux/amd64` and `linux/arm64`. `latest` follows stable releases only; `X.Y.Z` selects a stable release and `vX.Y.Z-<pre>` selects a prerelease. GitHub also publishes `edge` from main; CNB main runs validation and packaging, with image publication on version tags. Features depend on the selected version. Publish the fork's first image before using these pull commands; the local build override is available beforehand.

The image ships a liveness health check on `/health`. Confirm it with `docker compose ps` (status should become `healthy`) or `docker inspect --format '{{.State.Health.Status}}' codebuddy2api`.

### Registry authentication

A public GHCR package pulls anonymously. For a private package or registry, log in once on the host before `docker compose pull`:

```bash
# GHCR, classic PAT with read:packages
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

# CNB, CNB_TOKEN from the repository or platform settings
echo "$CNB_TOKEN" | docker login docker.cnb.cool -u cnb --password-stdin
```

Keep credentials out of `.env` and the Compose files; they belong in the host's Docker credential store.

That host login does **not** reach the update service. `docker login` writes `~/.docker/config.json` on the host, while the updater runs in its own container with its own filesystem, so the default Compose file mounts no credentials at all. When the registry needs authentication and you also want automatic updates, add a local override. Save it as `docker-compose.registry.yaml` next to `docker-compose.yml` (never commit it) and start with both files:

```yaml
services:
  watchtower:
    volumes:
      # The updater reads /config.json unless DOCKER_CONFIG points elsewhere.
      - ${HOME}/.docker/config.json:/config.json:ro
```

```bash
docker compose -f docker-compose.yml -f docker-compose.registry.yaml --profile auto-update up -d
```

Add the override only while that file exists: Docker creates a directory for a missing bind-mount source and the updater then cannot read it. `${HOME}` is not expanded on Windows — use the absolute path there, or set `DOCKER_CONFIG` to a directory that holds the file.

If the host `config.json` relies on a credential helper (`credsStore` / `credHelpers`), the helper binary has to exist inside the updater container, because the image ships none. Either mount the helper and adjust `HOME`/`PATH`, or give the updater a dedicated minimal `config.json` that contains only this registry's credentials and mount that instead:

```json
{ "auths": { "ghcr.io": { "auth": "<base64 user:token>" } } }
```

Keep that file outside the repository. Without the override, the update service simply cannot pull a private image; the application container itself still starts fine from a manually pulled image.

### Build current source

A separate override keeps `build:` out of the default file, so a pull-only deployment can never silently compile a local checkout:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yaml up -d --build
```

The build includes the console; Node.js and Python are not required on the host. Open `http://127.0.0.1:8787/dashboard` and sign in through the identity provider. Locally built images are labelled out of the update service, because a rebuild is the only way that image changes.

### Automatic image updates

The update service is off by default and only starts when its profile is requested:

```bash
docker compose --profile auto-update up -d
```

It polls the registry every `WATCHTOWER_POLL_INTERVAL` seconds (default `600`), and only touches containers carrying the update label for this Compose project. The updater never updates itself, and another deployment directory or `-p` project name has a different scope, so two stacks on one host never select each other's containers.

It restarts a container only when the image digest changes. A passing health check afterwards means the application is up, not that accounts or models work: there is no automatic application rollback.

Disable automatic updates by leaving the profile off, or by stopping a running updater:

```bash
docker compose --profile auto-update stop watchtower
docker compose --profile auto-update rm -f watchtower
```

A pinned release tag (`:X.Y.Z`) narrows the blast radius but does not freeze the image: tags are mutable, so re-publishing a release replaces the digest behind the same tag and the updater deploys the new digest. For an immutable pin, reference the digest instead — copy it from `docker inspect --format '{{index .RepoDigests 0}}' codebuddy2api` or from the release notes and set `CODEBUDDY2API_IMAGE=<registry>/codebuddy2api@sha256:<digest>`. A digest reference never changes, so the updater's checks stay no-ops for it, and that is the intended way to freeze one deployment while the project stays on `latest` elsewhere.

### Upgrades and recreates

After editing `.env`, repeat `docker compose up -d` to recreate containers whose configuration changed. `docker compose restart` alone does not apply changed environment values. The data directory keeps accounts, credentials and databases across a recreate; console login sessions live in memory only, so everyone signs in again after a recreate, restart or automatic update.

For a published image, the manual upgrade is always:

```bash
docker compose pull
docker compose up -d --no-build
```

### Rollback

Pin the previous release and recreate from it:

```bash
# 1. Stop the application before touching its data.
docker compose down
# 2. Set the last known-good release, then start it.
#    CODEBUDDY2API_IMAGE=<registry>/codebuddy2api:X.Y.Z   (edit .env)
docker compose pull
docker compose up -d --no-build
```

The control database migrates forward only: an older image cannot read a database written by a newer one. When the downgrade crosses a schema change, stop the application, restore the matching pre-upgrade copy of the whole `auth/` directory, and only then start the older image. Never roll the database back underneath a running instance, and never restore an outdated backup over claims, dispatches or revocations made after it. If the update profile is running, pin the target first — a digest reference cannot move, while a re-published version tag can — otherwise the updater pulls the newer image again.

## Reverse proxy and HTTPS

The default loopback mapping is the only safe exposure without extra work. When you put the application behind a reverse proxy on a domain, [`nginx.example.conf`](nginx.example.conf) is a ready example: TLS termination, streaming without buffering or compression, and an access-log format that never records the `/sso/callback` query string.

- Terminate TLS at the proxy and forward the original Host and scheme (`proxy_set_header Host $http_host` and `X-Forwarded-Proto $scheme` in nginx).
- `PUBLIC_ORIGIN` must equal the origin browsers actually use, and the proxy must forward the original Host and scheme unchanged (`proxy_set_header Host $http_host` and `X-Forwarded-Proto $scheme` in nginx). If the proxy rewrites them — HTTPS on the domain while the container sees HTTP — console login fails the Origin check. Correct the forwarded headers instead of relaxing the check: with console login enabled, `PUBLIC_ORIGIN` is the only accepted management origin, and the extra-origins setting does not apply.
- Keep the inference credential (`CODEBUDDY2API_KEY`) set for any non-loopback exposure; console login does not replace it for `/v1/*`.

## Local Python setup

Requires Python 3.12+, uv, and Node.js with the vp CLI to build the interface:

```bash
uv sync --locked --no-build --python 3.12
(cd web && vp install --frozen-lockfile && vp build)
uv run converter.py
```

Local startup does not require `.env`. Without an explicit key, the first loopback startup generates a `cb-…` default key in `auth/control.sqlite3` and displays it once in the interactive terminal after listening succeeds. Restarts reuse it without printing it again. Keep it safe: management and API requests share this key. Configure a key explicitly for first-time headless or non-loopback deployment.

That zero-configuration mode is API-compatible only. The replacement console has no key login, so `/dashboard` cannot be used until console login (SSO) is configured, even on loopback. To open the console locally, export `CODEBUDDY2API_SSO_ENABLED=true`, `PUBLIC_ORIGIN=http://127.0.0.1:8787`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `ALLOW_INSECURE_LOCALHOST=true`, and register `http://127.0.0.1:8787/sso/callback` on the identity provider. `ALLOW_INSECURE_LOCALHOST` only relaxes plain HTTP for loopback origins; keep it `false` everywhere else.

One-time disclosure goes directly to the controlling terminal (`/dev/tty` or Windows `CONOUT$`), not stdout/stderr; redirecting standard output does not capture the key. Terminal recording remains outside the gateway's control.

A failed terminal write or database commit leaves the same key pending for the next interactive start. A crash between display and commit can therefore repeat the notice; a successfully committed display is not repeated.

Without uv, run `python3 -m venv .venv`, activate it, install dependencies with `pip install --require-hashes --only-binary=:all: -r requirements.txt`, then run `python3 converter.py`. Distribution archives include the WebUI; source installs still need the frontend build.

Both commands optionally read `.env` in the current working directory, never parent directories. Precedence: explicit CLI > process environment > `.env` > saved SQLite values > defaults. Overrides do not replace the saved default key; an explicitly empty key still locks management. Listener changes require restart; `CODEBUDDY2API_IMAGE/AUTH_PATH` are Compose-only.

> The audit schema is single-writer: stop the old instance before starting a new version, and never run two gateway versions against one auth directory.

### Upgrade and state migration

Stop the gateway and back up the entire data directory first. Startup imports legacy JSON sessions, cooldowns, credit/trial history, catalogs and usage into `control.sqlite3` once. Old files remain as backups and are no longer read or updated. Invalid critical state or a failed migration stops startup; repair it or restore a backup rather than deleting ledgers to bypass validation.

SQLite state read/validation failures stop startup without deleting sessions or replacing state with empty defaults. Repair the control database before retrying; only rebuildable cache write failures may retain the current in-memory data with a warning.

All runtime logs use `logs.sqlite3`; legacy `--log` / `CODEBUDDY2API_LOG` settings warn and no longer write text files. Generated keys enter private configuration, never logs. Restrict access to the data directory; use a private user directory on Windows.

Older versions cannot read the upgraded control database. Downgrades require a stopped gateway and matching state migration, not merely old code reading stale JSON. Never overwrite new claims, dispatches or session revocations with an outdated backup.

## Dependency locks

`pyproject.toml` owns direct dependencies; `uv.lock` pins all resolved versions. `requirements.in` and the hash-locked `requirements.txt` are generated compatibility files for pip, Docker and CI:

```bash
uv lock
python3 scripts/export_requirements.py
```

Use `uv add`/`uv remove` for intentional dependency changes, then export and review both locks. Normal startup uses `--locked` and never upgrades packages. Metadata stays at the current `VERSION`; releases must update both version fields. Pip/Docker still require matching hashes and binary wheels; do not disable these checks.

Docker's build frontend, Node and Python images are pinned by multi-platform digest. When refreshing them, retain `linux/amd64` and `linux/arm64` support and verify the build. Locks prevent drift, not future vulnerabilities; security updates still require reviewed refreshes.

## CLI login

When the WebUI is unavailable, browser login also works without starting the server:

```bash
uv run --locked --no-build --env-file .env converter.py login
uv run --locked --no-build --env-file .env converter.py login --site intl --no-browser
uv run --locked --no-build --env-file .env converter.py login --site intl-codebuddy --no-browser
```

The first command uses the domestic site. `--site intl` selects international WorkBuddy (`www.workbuddy.ai`); `--site intl-codebuddy` selects international CodeBuddy (`www.codebuddy.ai`). `--no-browser` prints a link you can open on another device. Even after the browser reports success, wait for the terminal to confirm that credentials were saved. Links expire after 10 minutes; press `Ctrl+C` to cancel.

In Docker, use `docker compose exec codebuddy2api python3 converter.py login --no-browser`; append `--site intl` or `--site intl-codebuddy` for the selected international product. The image must include the corresponding login option.

Login and the server must use the same `CODEBUDDY_AUTH_DIR`. Default directory scanning loads new accounts automatically; logging in again updates the same identity. A server started with `--auth-file` only uses the specified files.

With the default local mode and no `CODEBUDDY_AUTH_DIR`, startup imports missing credentials from an already logged-in desktop client. You can also add `.info` files to the managed directory. Independent desktop and gateway token refreshes may invalidate each other; prefer separate browser login.

## Without Compose

Run a published image without Compose:

```bash
docker run -d --name codebuddy2api --init --restart unless-stopped \
  -p 127.0.0.1:8787:8787 --env-file .env \
  -v "$PWD/auth:/data/auth" \
  -e CODEBUDDY_AUTH_DIR=/data/auth <registry>/codebuddy2api:latest
```

Build the local image first with `docker build -t codebuddy2api:local .` when you want to run a checkout instead. This uses the default port and directory explicitly, not Compose port mappings. Add accounts in the console or run `docker exec -it codebuddy2api python3 converter.py login --no-browser`.

## Verification

`curl http://127.0.0.1:8787/health` should return `{"status":"ok"}`. It is the same check the image health check runs: liveness only, not account or model availability; inspect those in the console. Compose reports it as the container health status, so `docker compose ps` shows whether a pull or restart produced a running application. See [client configuration](clients.md) for API access and the [advanced reference](advanced.md) for errors and retry boundaries.
