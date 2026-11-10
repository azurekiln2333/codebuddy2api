# Deployment

[Home](../README.md) · [简体中文](deployment.zh-CN.md)

Prefer the [WebUI](webui.md) for everyday account, model and log management. Run the commands below from the repository root.

Docker deployment needs **Docker Compose v2** (`docker compose`). The obsolete `version:` key is gone and the optional update service uses profiles, so Compose v1 / `docker-compose` is not supported.

## Configuration and data

On first setup, run `cp .env.example .env` and set `CODEBUDDY2API_KEY` to your own random key. It is an inference credential; configure OIDC below for the console's SSO sign-in. Keep an existing `.env` and add only the settings you need.

| Setting | Purpose |
|---------|---------|
| `CODEBUDDY2API_IMAGE` | Compose image to pull; the template points at this fork, never the upstream author's repository |
| `CODEBUDDY2API_SSO_ENABLED` / `PUBLIC_ORIGIN` / `OIDC_*` / `ALLOW_INSECURE_LOCALHOST` | Console login; see [Console login](#console-login-oidc) |
| `WATCHTOWER_POLL_INTERVAL` | Seconds between automatic image checks; default `600` |
| `CODEBUDDY2API_BIND` / `CODEBUDDY2API_PORT` | Native listener and Compose host mapping; default `127.0.0.1:8787` |
| `CODEBUDDY2API_AUTH_PATH` | Compose host data directory; defaults to `./auth`, mounted at `/data/auth` |
| `TZ` | Container time zone; daily guards follow it, and an unset value keeps UTC |
| `CODEBUDDY2API_ENV_FILE` | Optional Compose override for the env file path; defaults to `.env` |
| `CODEBUDDY2API_ALLOW_OPEN_NOAUTH` | Image/Compose compatibility opt-in, fixed `true` there. Only with no external or database keys does it anonymously expose inference **and account-pool billing**, with or without a placeholder token; any key row disables it |
| `CODEBUDDY2API_TRUSTED_PROXIES` | Trusted proxy IPs/CIDRs (comma separated); when the direct peer matches, the audit log records the client from `X-Forwarded-For`/`X-Real-IP` instead of the proxy address |
| `CODEBUDDY_AUTH_DIR` | Local Python data directory; defaults to the repository's `auth/`. Compose sets it to `/data/auth` inside the container |
| `CODEBUDDY_IMPORT_DIR` | Optional import directory; defaults to `imports/` under the data directory. Use container paths with Compose |
`.env.example` lists every active runtime variable with its default. Compose loads the whole file, so a key you comment out stays editable in the WebUI (tool metadata, Responses projection, origin allowlist, failover and similar). Zero disables aggregate/concurrency limits, per-item Responses trimming or extra retries, not the required positive inbound limit.

Compose loads `.env` into the container; shell variables still win for the image, host mapping and data path. The default host mapping is loopback. Set a random key, HTTPS and access restrictions before allowing remote connections. Container binding remains `0.0.0.0:8787`; change host exposure using `BIND/PORT`, not container listener arguments.

Mount the entire data directory on writable local storage, not just one SQLite file, and do not share it between instances. Stop the gateway and back up the whole directory before upgrading; see [data and backups](webui.md#data-and-backups).

## Console login and admission

Nothing has to be configured before the first `docker compose up`. The console starts with key login enabled and SSO off, and an incomplete OIDC block is not a startup error.

`PANEL_ADMIN_KEY` is the only credential a deployment must provide (12+ characters). It has two uses and they are independent:

- **Console login.** The login page asks for the key. It is exchanged for an HttpOnly session cookie; mutations additionally require the CSRF token the session endpoint returns.
- **Panel bearer.** A request to `/admin/*` carrying `Authorization: Bearer <PANEL_ADMIN_KEY>` is authorized without a cookie or CSRF token, because the unified panel is a server-side proxy and not a browser. Turning browser key login off does not revoke this path.

`PLATFORM_TOKEN` and `PANEL_KEY` remain accepted as aliases, but `PANEL_ADMIN_KEY` wins when both are set. A value shorter than 12 characters is treated as unset rather than degrading into a weak credential. In a unified deployment every console receives the same value.

### Configuring SSO in the console

SSO is managed in the browser under Settings, not in the environment. A saved change applies to the next request: no restart, no container recreate. The settings document stores the provider name, issuer, client ID and secret (write-only; the API returns only `hasClientSecret`), scope, callback URL and the admission lists.

| Field | Purpose |
|-------|---------|
| Provider name | Button label on the login page; defaults to `SSO`. |
| Issuer | HTTPS discovery and JWKS endpoint. Discovery is validated before the change is saved. |
| Client ID / Client secret | Confidential client credentials; the browser never receives the secret. Register the redirect URI `<PUBLIC_ORIGIN>/sso/callback` and grant `openid profile email`. |
| Scope | Must include `openid`. |
| Callback URL | Overrides the redirect base; empty derives it from `PUBLIC_ORIGIN` or the request. |
| Allowed subjects / Allowed e-mails | The admission allow-list; see below. |

Turning browser key login off requires an active SSO session saved under the same settings, so you cannot lock yourself out. Both methods can be enabled at once; at least one must remain.

### Admission is an allow-list

An SSO identity is admitted only when its subject appears in `allowedSubjects`, or its e-mail appears in `allowedEmails` **and** the provider marks that e-mail verified. Role and group claims no longer grant access — a claim is not an operator decision this service can audit. An empty allow-list admits nobody, so enabling SSO requires at least one entry.

### Environment is a one-time seed

`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PUBLIC_ORIGIN`, `CODEBUDDY2API_SSO_ENABLED`, `CODEBUDDY2API_SSO_ALLOWED_SUBJECTS` and `CODEBUDDY2API_SSO_ALLOWED_EMAILS` seed a console that has never been saved. Once settings exist in the data directory, the environment is ignored. A seed without an allow-list copies the provider values but leaves SSO off. Generate `PANEL_ADMIN_KEY` independently of every other secret; `CODEBUDDY2API_KEY` stays the inference credential and the console never uses it.

| Setting | Purpose |
|---------|---------|
| `PANEL_ADMIN_KEY` | Console login key and `/admin/*` bearer. Required for a console deployment. |
| `CODEBUDDY2API_SSO_ENABLED` | Seed only: `true` seeds SSO on (still needs an allow-list); default `false`. |
| `PUBLIC_ORIGIN` | Public HTTPS origin browsers use, no trailing slash. Origin allowlist and redirect base. |
| `OIDC_ISSUER` | Seed only: issuer exposing HTTPS discovery and JWKS. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Seed only: confidential client credentials. |
| `CODEBUDDY2API_SSO_ALLOWED_SUBJECTS` / `CODEBUDDY2API_SSO_ALLOWED_EMAILS` | Seed only: comma-separated admission lists. |
| `OIDC_REFRESH` | `true` requests `offline_access` and rotating refresh tokens. |
| `ALLOW_INSECURE_LOCALHOST` | Loopback development escape hatch for plain-HTTP origins and issuers. Keep `false` in production. |
| `SESSION_TTL_MS` / `SESSION_IDLE_MS` / `TRANSACTION_TTL_MS` / `MAX_SESSIONS` / `OAUTH_TIMEOUT_MS` | Optional tuning (empty keeps the default). Config fails closed when `SESSION_IDLE_MS` exceeds `SESSION_TTL_MS`. |

`CODEBUDDY2API_SSO_ENABLED=false` is no longer needed to run without a console: leave SSO off in Settings instead.
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

The console **Updates** page can also install this fork's release archives; see [Updates](webui.md#updates). In-container installs write the container's writable layer, so recreating it restores the image version. Prefer the image pull and recreate workflow above for production deployments.

## Reverse proxy and HTTPS

The default loopback mapping is the only safe exposure without extra work. When you put the application behind a reverse proxy on a domain, [`nginx.example.conf`](nginx.example.conf) is a ready example: TLS termination, streaming without buffering or compression, and an access-log format that never records the `/sso/callback` query string.

- Terminate TLS at the proxy and forward the original Host and scheme (`proxy_set_header Host $http_host` and `X-Forwarded-Proto $scheme` in nginx).
- `PUBLIC_ORIGIN` must equal the origin browsers actually use, and the proxy must forward the original Host and scheme unchanged (`proxy_set_header Host $http_host` and `X-Forwarded-Proto $scheme` in nginx). If the proxy rewrites them — HTTPS on the domain while the container sees HTTP — console login fails the Origin check. Correct the forwarded headers instead of relaxing the check: with console login enabled, `PUBLIC_ORIGIN` is the only accepted management origin, and the extra-origins setting does not apply.
- Configure an external inference key (`CODEBUDDY2API_KEY`) or a database key for any non-loopback exposure; console login does not replace it for `/v1/*`.

## Local Python setup

Requires Python 3.12+ and uv. Build the interface only when the distribution does not include it, using Node.js 24 and the vp CLI pinned by `vite-plus` in `web/package.json`.

```bash
uv sync --locked --no-build --python 3.12
(cd web && vp install --frozen-lockfile && vp build)
uv run --locked --no-build converter.py --host 127.0.0.1 --port 8787
```

`--locked` stops instead of re-resolving when `uv.lock` is stale, so a source launch never upgrades packages. `.env` in the working directory is read automatically, so `uv run` needs no `--env-file`. Distribution archives already contain the WebUI; skip the frontend build there.

That zero-configuration mode is API-compatible and the console works without any SSO setup: set `PANEL_ADMIN_KEY` and sign in with it, even on loopback. To use SSO locally instead, enable it under **Settings → Authentication**, or export `CODEBUDDY2API_SSO_ENABLED=true`, `PUBLIC_ORIGIN=http://127.0.0.1:8787`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, an allow-list (`CODEBUDDY2API_SSO_ALLOWED_SUBJECTS` or `CODEBUDDY2API_SSO_ALLOWED_EMAILS`) and `ALLOW_INSECURE_LOCALHOST=true`, then register `http://127.0.0.1:8787/sso/callback` on the identity provider. `ALLOW_INSECURE_LOCALHOST` only relaxes plain HTTP for loopback origins; keep it `false` everywhere else.

With SSO disabled, the backend compatibility mode also keeps a separate local admin account as the inner boundary. The external key may supply its initial password; otherwise startup displays a random initial password, using startup output when no controlling terminal is available. The console prefers `PANEL_ADMIN_KEY` and does not offer that password as a sign-in method. Inference keys are not created automatically; configure an external key or create a database key through the management API.

A legacy saved default key is migrated once to the initial admin password and a database admin key; database keys never become `CODEBUDDY2API_KEY`. Changing the account password decouples later logins from external-key changes and revokes existing sessions. Passwords are stored only as scrypt hashes.

Password output precedes the account commit. An output failure stops startup without writing the account; a commit failure retries initialization on the next start. Terminal or container-log retention remains outside the gateway's control, so change the initial password after first login.

Without uv, keep the same hash-locked set in a virtual environment:

```bash
python3 -m venv .venv
. .venv/bin/activate          # Windows: .venv\Scripts\activate
python3 -m pip install --require-hashes --only-binary=:all: -r requirements.txt
python3 converter.py --host 127.0.0.1 --port 8787
```

Both startup paths read `.env` in the current working directory when present, never parent directories. Precedence: explicit CLI > process environment > `.env` > saved SQLite values > defaults. Database keys are never promoted to the external key; blank external values are treated as unset. Listener changes require restart; `CODEBUDDY2API_IMAGE/AUTH_PATH` only affect Compose.

### Admin password recovery

This applies only to the SSO-disabled backend compatibility account, not the identity-provider account. Use the interactive recovery command with the same data directory as the gateway:

```bash
uv run --locked --no-build converter.py admin reset-password
uv run --locked --no-build converter.py admin reset-password --username admin
```

It prompts twice on a TTY and accepts no password argument. It also works while the service is running; the next management request uses the new account epoch and revokes every existing session. In Docker, run `docker compose exec codebuddy2api python3 converter.py admin reset-password`.


### Configuration migration

`.env` values stay authoritative, so any runtime key listed there occupies its WebUI field. To move them into the configuration store, stop the service and run the offline command; it never edits `.env` itself:

```bash
python3 converter.py config migrate            # cwd/.env -> ./auth/control.sqlite3
python3 converter.py config migrate --env-file /srv/app/.env --data-dir /srv/app/auth
python3 converter.py config status --db /srv/app/auth/control.sqlite3   # read-only
```

Both commands resolve the env file first, then the data directory it declares (`CODEBUDDY_AUTH_DIR`), so `--data-dir`/`--db` only override the resolved target. Before writing, `migrate` verifies the target really is this project's control store (SQLite header, `user_version=3`, `control`/`runtime_state`/`gateway_secrets`/`api_keys`, readable payload, `quick_check`) and refuses while a running instance holds the lease or the write lock; `--force` bypasses the lease warning only. Deployment keys (key, listener, data paths) are never migrated. Inside a container there is no `.env` file, so use the process environment:

A v2 control database must be opened once by the new service to complete its v3 upgrade before `config migrate` can read it.

```bash
docker compose stop
docker compose run --rm --no-deps -e CODEBUDDY_AUTH_DIR=/data/auth \
  codebuddy2api python3 converter.py config migrate --no-env --data-dir /data/auth
```

A successful run writes the values and disables the Dashboard notice in one revision; delete the printed `.env` lines when you want the WebUI to supply them. Instances started before this release write no lease, so confirm the service is stopped once after upgrading. `config status` never writes. `--lang zh|en|auto` selects the CLI output language and, for `serve`, `login` and `config migrate`, also saves the interface language; see [configuration and CLI](advanced.md#configuration-and-cli).

> The audit schema is single-writer: stop the old instance before starting a new version, and never run two gateway versions against one auth directory.

### Upgrade and state migration

Release-archive installs and git checkouts can update or roll back in one click on the WebUI **Updates** page: it verifies the archive, backs up the control database, swaps the program files in place and restarts with the original arguments; see [Updates](webui.md#updates). For a manual upgrade, stop the gateway and back up the entire data directory first. Startup imports legacy JSON sessions, cooldowns, credit/trial history, catalogs and usage into `control.sqlite3` once. Old files remain as backups and are no longer read or updated. Invalid critical state or a failed migration stops startup; repair it or restore a backup rather than deleting ledgers to bypass validation.

SQLite state read/validation failures stop startup without deleting sessions or replacing state with empty defaults. Repair the control database before retrying; only rebuildable cache write failures may retain the current in-memory data with a warning.

All runtime logs use `logs.sqlite3`; legacy `--log` / `CODEBUDDY2API_LOG` settings warn and no longer write text files. Initial passwords go only to the terminal/startup output, and audit stores key IDs rather than key secrets. Restrict access to the data directory; use a private user directory on Windows.

Startup upgrades control schema v2 to v3 and migrates the legacy default key. Older versions cannot read the v3 control database; downgrade requires restoring a pre-upgrade backup while stopped, not merely old code reading stale JSON. Never overwrite new claims, dispatches or session revocations with an outdated backup.
## Dependency locks

`pyproject.toml` owns direct dependencies; `uv.lock` pins all resolved versions. The hash-locked `requirements.txt` is the generated pip input for Docker and CI:

```bash
uv lock
python3 scripts/export_requirements.py
```

Use `uv add`/`uv remove` for intentional dependency changes, then export and review the lock. Normal startup uses `--locked` and never upgrades packages. Metadata stays at the current `VERSION`; releases must update both version fields. Pip/Docker still require matching hashes and binary wheels; do not disable these checks.

Docker's build frontend, Node and Python images are pinned by multi-platform digest. When refreshing them, retain `linux/amd64` and `linux/arm64` support and verify the build. Locks prevent drift, not future vulnerabilities; security updates still require reviewed refreshes.

## CLI login

When the WebUI is unavailable, browser login also works without starting the server:

```bash
uv run --locked --no-build converter.py login
uv run --locked --no-build converter.py login --site intl --no-browser
uv run --locked --no-build converter.py login --site intl-codebuddy --no-browser
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
