# Deployment

Topology (fixed):

```
Internet ──TLS──▶ Nginx (public 443) ──▶ gateway 8788 ──▶ private FastAPI 8787
```

- Nginx terminates TLS and is the only publicly reachable component.
- The gateway (`8788`) is reachable only from Nginx (loopback bind or private
  compose network).
- The upstream FastAPI listener (`8787`) is **never** published to the host or
  the public internet. It must only be reachable by the gateway.
- The browser never receives upstream admin cookies, CSRF tokens, the server
  api_key, or OIDC tokens. The gateway bridges each browser session to an
  independent upstream admin session.

## Required configuration

Copy `.env.example` to `.env` and set at minimum:

| Variable | Meaning |
| --- | --- |
| `PUBLIC_ORIGIN` | Public HTTPS origin browsers use (no trailing slash). |
| `UPSTREAM_ORIGIN` | Private FastAPI origin, e.g. `http://127.0.0.1:8787`. `https://` is also supported; the gateway selects the matching transport. |
| `UPSTREAM_API_KEY` | Same value as the backend `CODEBUDDY2API_KEY`. |
| `OIDC_ISSUER` | OIDC issuer with HTTPS discovery + JWKS. |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | Confidential client credentials. |
| `UI_STATIC_DIR` | External UI build (`codebuddy2api-ui/dist`). |

`OIDC_REFRESH=true` requests `offline_access` and enables rotating refresh.
`UPSTREAM_ORIGIN` must be loopback, a private IP, or the private
`codebuddy2api` compose service name. Startup fails closed when secrets are
missing or origins are not HTTPS, except when `ALLOW_INSECURE_LOCALHOST=true`
is set for explicit loopback development.

### OIDC client registration

Register a **confidential** client (Basic or POST secret) with:

- Redirect URI: `${PUBLIC_ORIGIN}/sso/callback`
- Grant: authorization code with PKCE (S256)
- Scopes: `openid profile roles` (add `offline_access` if `OIDC_REFRESH=true`).
  `roles` is required: the provider only emits `role` / `isAdmin` from UserInfo
  when that scope was granted. `profile` supplies the displayed identity.
- Do **not** enable implicit or prompt/max_age flows; the gateway never sends
  `prompt` or `max_age`.

Admin access requires a live UserInfo where `sub` matches the ID token and the
user is both `role === "admin"` and `isAdmin === true`. Every protected request
re-checks this; revocation takes effect on the next request.

## Container deployment (compose)

The example `compose.yaml` runs `upstream`, `gateway`, and `nginx` with the
upstream on an `internal: true` network and no host port mapping.

Before starting this example:

1. Build or provide the backend image named `codebuddy2api:local` (or edit
   `services.upstream.image` in `compose.yaml` to the image you already use).
2. Provide `deploy/certs/fullchain.pem` and `deploy/certs/privkey.pem` for the
   public domain; the example does not issue certificates.
3. Replace both `server_name` values in `deploy/nginx.conf` with that domain.
4. Build the separate UI and set `UI_DIST` to its absolute `dist` path.
   Compose mounts that path at `/opt/ui/dist` and overrides `UI_STATIC_DIR`; setting
   `UI_STATIC_DIR` alone does not choose the host artifact in Compose.

```bash
cp .env.example .env          # fill in real values, never commit .env
# build the UI first, then point UI_DIST at its dist directory
UI_DIST=/srv/codebuddy2api-ui/dist docker compose up -d --build
docker compose ps
curl -fsS https://gateway.example.com/healthz
```

### Networks

- `private` (`internal: true`): carries gateway -> `codebuddy2api:8787` without
  publishing either listener. This network supplies no internet egress; the
  backend uses its separate `egress` network for provider calls. Docker host
  administrators can still reach container networks, so isolation here means
  no public or host port mapping, with access limited by network membership.
- `edge`: Nginx <-> gateway.
- `egress` (non-internal): attached to `upstream` **only**, so the CodeBuddy
  backend can reach the CodeBuddy API and other configured providers. Do not
  attach the gateway or Nginx to it and never publish a port on it.

### Nginx upstream target

`deploy/nginx.conf` is the **container** variant and proxies to
`gateway:8788` (the compose service name). `127.0.0.1:8788` inside the Nginx
container would loop back to Nginx itself, not the gateway. The native variant
`deploy/nginx-native.example.conf` keeps `127.0.0.1:8788` because there Nginx
and the gateway share the host loopback. Pick the file that matches your
deployment.

### Backend container contract (verified against the reference repo)

The `upstream` service is a **docker image of the read-only CodeBuddy reference
repo**. Its real interface, confirmed against `converter.py` and that repo's
`Dockerfile` / `docker-compose.yml`:

- **Command:** `python3 converter.py --host 0.0.0.0 --port 8787 --skip-check`
  (the image CMD; `compose.yaml` sets it explicitly).
- **`CODEBUDDY2API_BIND` / `CODEBUDDY2API_PORT` are host-port variables** in the
  reference compose (`${BIND}:${PORT}:8787`), not container listener settings.
  Do not use them to configure the in-container listener; the `--host/--port`
  CLI flags win.
- **Real container env used by the gateway topology:**
  - `CODEBUDDY2API_KEY` — server api_key; must equal `UPSTREAM_API_KEY`.
  - `CODEBUDDY2API_ADMIN_ORIGINS` — legal browser Origin(s) for admin login/CSRF.
  - `CODEBUDDY_AUTH_DIR` — credential/SQLite storage dir (`/data/auth`).
  - `CODEBUDDY2API_ALLOW_OPEN_NOAUTH` — the reference image bakes this to `true`
    so a `0.0.0.0` bind passes its startup guard. This compose sets it to
    `false` so the backend **fails closed** if `CODEBUDDY2API_KEY` is ever unset;
    keep it `false` and always provide the key.
  - `CODEBUDDY2API_ADMIN_CSRF` — keep `true` to enforce Origin + CSRF on
    cookie-authenticated admin requests.

### Gateway image build

`Dockerfile` copies **both** `tsconfig.json` and `tsconfig.build.json` into the
build stage before `npm run build` (`tsc -p tsconfig.build.json`, which
`extends ./tsconfig.json`). Copying only one of them breaks the image build.

Verify the upstream port is not published:

```bash
docker compose port upstream 8787   # should print nothing
```

## Native deployment

```bash
npm ci
npm run build
# run the gateway on loopback
HOST=127.0.0.1 PORT=8788 node --env-file=.env dist/main.js
```

Install `deploy/nginx-native.example.conf` as an Nginx server block, adjust the
cert paths and `server_name`, then `nginx -t && systemctl reload nginx`.

## Logging safety

Both example Nginx configs declare a `gateway_safe` log format in the HTTP
context (the standard `conf.d` include), then select it in each server. It logs
`$request_method $uri` and **no query string**. The OIDC callback
(`/sso/callback?code=...&state=...`) carries one-time authorization codes and
state tokens; writing `$request_uri`/`$args` would persist them in access logs.
If even request paths are considered sensitive, use `access_log off;` for the
`/sso/` locations. Never add a format that includes `$request_uri`, `$args`,
`$arg_code`, or `$arg_state`.

## Streaming requirements

`/v1/*` responses stream immediately and must not be buffered or compressed.
The provided Nginx configs set `proxy_buffering off`, `gzip off`, and
`X-Accel-Buffering: no`, and use long read/send timeouts. Preserve these when
customizing; otherwise SSE first chunks are delayed.

Client cancellation is propagated: when the browser disconnects the gateway
aborts the upstream request immediately (detected via the response `close`
event and `req.aborted`, never via a normal request `close`). Buffered admin
routes are bounded by an absolute deadline that covers connect **and** the full
response body, and are cancelled if the browser goes away.

## Safe response handling

On every browser-facing route the gateway strips upstream `Set-Cookie`
(including `Set-Cookie2`), CORS headers, and all hop-by-hop headers named by
`Connection`. The browser never receives upstream session cookies, CSRF tokens,
the server api_key, or OIDC tokens. Keep this behaviour when adding routes: do
not relay an upstream cookie or token to the browser "for convenience".

## Rollback and bypass

Rollback order matters — never expose the upstream admin port directly while
bypassing the gateway.

1. Restore the previous gateway/Nginx configuration and image tag:
   ```bash
   docker compose down
   git checkout <previous-tag> -- compose.yaml deploy/ Dockerfile
   docker compose up -d --build
   ```
2. If the gateway must be bypassed entirely, keep `8787` on loopback and ensure
   the backend's own admin authentication (`CODEBUDDY2API_KEY`,
   `CODEBUDDY2API_ADMIN_ORIGINS`, CSRF) is enabled and the original admin UI is
   reachable only through an authenticated reverse proxy. Do **not** publish
   `8787` to `0.0.0.0` or the public internet.
3. Re-verify after rollback: `/healthz`, admin login, a mutation (CSRF), and
   that `docker compose port upstream 8787` is empty.

## Validation limits

For a storage-management `Not Found`, see
[storage diagnostics](./storage-diagnostics.md) for the verified source routes
and two read-only checks against the running backend. A local passing test
does not identify the cause in a separate deployment.

Real OIDC credentials and public TLS are environment-specific and are not
verified by the repository's automated checks. Use a faithful local OIDC mock
for CI, and treat Docker/Nginx acceptance as a manual, credentialed step.
