> Historical implementation handoff. Commands, counts and unavailable tools below describe earlier snapshots. See [validation.md](./validation.md), [security-review.md](./security-review.md) and [deployment.md](./deployment.md) for final behavior and evidence.

# Proxy/deploy worker progress (owned: src/proxy.ts, src/static.ts, deploy/**, Dockerfile, .dockerignore, compose.yaml, .env.example, docs/deployment.md)

## Interface assumptions (from docs/internal-contract.md)
- Imports `GatewayConfig` from `./config.js`, `HttpError/json/readJson/requireSameOrigin/requireCsrf` from `./http.js`, `GatewaySession` from `./sessions.js`.
- `GatewayProxy(config)` -> `{ admin(req,res,url,session), inference(req,res,url), logout(session), close() }`.
- `serveStatic(req,res,url,config):Promise<boolean>` from `src/static.ts`.

## Backend bridge facts (reference repo read-only)
- POST {upstreamOrigin}/admin/session body `{api_key}` with legal `Origin` -> `{authenticated:true,csrf_token}` + `Set-Cookie: cb_admin_session=...` (path=/admin, SameSite=strict).
- AdminMiddleware: cookie session => server injects its OWN `Authorization`; requires `X-CSRF-Token` matching real csrf for mutations and `/admin/oauth/poll`.
- POST /admin/logs/clear scope=all: requires `confirmation === "清空全部日志与统计"` AND `api_key === server key`. Gateway validates text, injects api_key.

## Status
- [x] src/proxy.ts (GatewayProxy: admin/inference/logout/close)
- [x] src/static.ts (serveStatic, dashboard-only, realpath-contained)
- [x] Dockerfile / .dockerignore / compose.yaml / .env.example
- [x] deploy/nginx.conf + deploy/nginx-native.example.conf
- [x] docs/deployment.md

## Verified
- proxy.ts + static.ts typecheck clean under repo tsconfig (stubbed sessions.ts, removed after).
- CLEAR_CONFIRMATION byte-matches backend app/admin_api.py:25.
- Server.ts calls match contract signatures exactly.
- Env var names aligned to real config.ts: PUBLIC_ORIGIN, HOST, PORT, UPSTREAM_*.
- compose UPSTREAM_ORIGIN uses allowed host `codebuddy2api` (config privateUpstream allowlist).

## Initial-review fixes (this pass, verified)
Owner took over from exited gw-proxy. Implemented the 8 reviewed fixes; inspected fresh
source first to avoid duplicate work.

1. **`forwardStream` no longer aborts normal requests.** Was listening on `req.close`,
   which fires after a completed request body (even a healthy keep-alive GET/POST) and
   destroyed the upstream. Now uses `res.close` (guarded by a `finished` flag so a normal
   completion is ignored) + `req.aborted` (early request-stream abort). Real client
   disconnect still aborts upstream immediately.
2. **Header hygiene.** Response path strips `Set-Cookie`/`Set-Cookie2`/CORS plus every
   always-hop-by-hop header AND any header nominated by the upstream `Connection:` value.
   Request path strips the same hop-by-hop rules, the `Connection`-nominated headers, and
   a broad spoofable-identity set (`x-forwarded-*`, `x-real-ip`, `x-client-ip`,
   `x-auth-request-*`, `remote-user`/`x-remote-user`, `x-authenticated-user*`,
   `x-admin-identity`, `x-cb-admin`, `x-user-id`/`x-user-role`, `forwarded`, …).
   Inference preserves ONLY caller `Authorization`/`X-Api-Key`; no cookie/CSRF/server key.
   Admin bridge never forwards caller auth/cookies.
3. **https upstream transport.** `upstreamRequestFn(config)` picks `https.request` when the
   configured `UPSTREAM_ORIGIN` is `https:`, else `http.request`; used by both buffered and
   streaming paths. `.env.example` documents http/https.
4. **Upstream 401 clears the cached bridge.** On a 401 the per-session `upstream` cookie/CSRF
   is dropped so the next request re-establishes a fresh bridge. Non-mutating (GET/HEAD/OPTIONS)
   requests retry exactly once with the fresh bridge; mutations (and `/admin/oauth/poll`) are
   never retried and the 401 is surfaced.
5. **Static containment for BOTH index paths.** `containedIndex()` realpaths
   `<dir>/index.html` (directory-index case) and `<root>/index.html` (SPA fallback) and
   requires the canonical path inside `rootReal`; a symlinked index escaping the UI root now
   yields a non-200 refusal instead of serving the target file.
6. **Buffered admin is deadline- and cancel-bounded.** `upstreamFetch` now takes an
   `AbortSignal` and an absolute deadline covering connect + request + the ENTIRE response
   body (the old per-socket `timeout` only covered idle waits). `forwardBufferedAdmin` aborts
   the upstream when the downstream `res` closes mid-flight. SSE/streaming is untouched
   (still non-buffered, flushed immediately, `res.close`/`req.aborted` cancellation).
7. **Compose/Nginx topology.** `deploy/nginx.conf` (container variant) now proxies to
   `gateway:8788` (service DNS), NOT `127.0.0.1:8788` (which is Nginx itself in-container);
   `deploy/nginx-native.example.conf` keeps loopback and says so explicitly. Compose backend
   has an explicit `codebuddy2api` alias on the internal `private` network for deterministic
   gateway resolution, plus a separate non-internal `egress` network attached ONLY to the
   backend so CodeBuddy can reach the internet; the backend port is still never published
   and the internal network still blocks host/internet access to 8787. Compose no longer
   sets spoofable `X-Forwarded-*`/`X-Real-IP` in Nginx (gateway strips them anyway).
8. **No secrets in Nginx access logs.** Both configs use a `gateway_safe` log format that
   logs `$request_method $uri` (NO query string), so `/sso/callback?code=…&state=…` one-time
   codes/state never hit the logs. `/healthz` is `access_log off`. Docs warn never to add
   `$request_uri`/`$args`.

Also: docs/deployment.md gains Networks, Nginx-upstream-target, Logging safety,
Streaming/cancellation and Safe-response-handling sections; `.env.example` documents
http/https upstream and the compose alias.

### Evidence (proxy-internal scratch, since removed; tests/** is the security agent's)
- `npm run check` clean; `npm run build` clean.
- Full non-backend suite: `node --import tsx --test tests/*.test.ts` -> **159/159 pass**
  (alias, authorization, inference, csrf, oauth, auth, rawpath, scratch-proxy).
- Scratch verification (real HTTP through `GatewayProxy`, temporary file removed): normal
  GET completes (fix 1); spoofed identity/hop/Connection-nominated headers absent upstream
  while the real upstream cookie is injected and `Set-Cookie` is not relayed (fix 2);
  inference keeps only caller creds (fix 2); mutation 401 not retried + bridge cleared +
  next GET re-logs-in (fix 4); symlinked `index.html` escape refused on BOTH directory-index
  and SPA-fallback paths (fix 5); confirmation text byte-exact.
- **Not verified (environment limits):** Docker/`docker compose config`/`nginx -t` unavailable
  on this host; real CodeBuddy internet egress and TLS upstream not exercised. Compose YAML was
  reviewed by hand (no tabs, structure valid). Treat container/Nginx acceptance as a manual
  credentialed step (already stated in docs/deployment.md).

## Follow-up pass: Dockerfile + backend interface verification (this pass)
Independent checker findings, all verified against source before fixing:

- **Dockerfile build was broken.** `npm run build` runs `tsc -p tsconfig.build.json`,
  which `extends ./tsconfig.json`, but the build stage copied only `tsconfig.json`.
  Fix: `COPY tsconfig.json tsconfig.build.json ./`. Proved by simulating the build
  context: old context -> `error TS5058: The specified path does not exist:
  'tsconfig.build.json'` (exit 1); new context -> `tsc` exit 0 with all 9 modules in
  `dist/`.
- **Backend env names / CMD verified against the reference repo** (`converter.py`,
  `Dockerfile`, `docker-compose.yml`):
  - Image CMD is `python3 converter.py --host 0.0.0.0 --port 8787 --skip-check`.
  - `CODEBUDDY2API_BIND`/`CODEBUDDY2API_PORT` are **host-port** vars in the reference
    compose, NOT container listener settings. Removed them from `upstream.environment`
    and set an explicit `command:` instead.
  - Confirmed real env names: `CODEBUDDY2API_KEY`, `CODEBUDDY2API_ADMIN_ORIGINS`,
    `CODEBUDDY_AUTH_DIR`, and (startup) `CODEBUDDY2API_ALLOW_OPEN_NOAUTH`
    (`startup.py:58`) and `CODEBUDDY2API_ADMIN_CSRF` (`converter.py:4284`).
  - The reference image bakes `CODEBUDDY2API_ALLOW_OPEN_NOAUTH=true` so a `0.0.0.0`
    bind passes its startup guard. Compose now sets it to `false` (and
    `CODEBUDDY2API_ADMIN_CSRF=true`) so the backend fails closed if the key is unset.
  - docs/deployment.md gained a **Backend container contract** + **Gateway image
    build** section recording all of the above.
- **Case-alias `/admin/SESSION` / global percent rejection:** main's `server.ts`
  already handles this (`path.includes('%')` + `sessionAlias` lowercase check).
  Confirmed by reading server.ts; **no duplicate fix added** in my owned files.

Re-verified after the changes: `npm run check` clean, `npm run build` clean, full
non-backend suite **177/177 pass**. Docker/`nginx -t` still unavailable on this host.

## Handoff to main (w12:p1)
- **DONE**: all 8 initial-review fixes are implemented in my owned files and verified as above.
  Follow-up pass also fixed the broken Dockerfile tsconfig copy and corrected the compose
  backend CMD/env to the verified reference interface (fail-closed `ALLOW_OPEN_NOAUTH=false`).
  `npm run check` and `npm run build` are clean; 177/177 non-backend tests pass.
- **No interface changes** outside my files: `GatewayProxy`/`serveStatic` exports and
  signatures unchanged; main's server.ts/config.ts/http.ts untouched.
- **Relies on main's raw-path gate**: percent-encoding rejected in pathname (global `%`),
  case-insensitive `/admin/session` aliases, dot/backslash/duplicate-separator — confirmed
  present in server.ts. I did not modify it; test owner covers.
- **Ask for main/security review**: (a) reconnect of the internal-only + egress split for the
  backend, (b) whether `/sso/` locations should also `access_log off` rather than safe-format,
  (c) confirm no other route needs the buffered-admin deadline semantics.
- **Uncommitted** per instructions (no commits).

## Notes for integration/check
- Proxy admin bridge: POST {upstream}/admin/session {api_key} + Origin=upstreamOrigin -> cookie+csrf; cached per session with upstreamLogin promise lock. On 401 the cache is cleared; GET retries once with a fresh bridge, mutations are never retried (browser re-auths).
- /admin/logs/clear scope=all: gateway strips browser api_key, requires exact confirmation, injects server key.
- inference: strips cookie + spoofable identity/hop headers, keeps caller Authorization/X-Api-Key, injects no server secret, pipes stream.
- Set-Cookie/Cookie/CORS/hop-by-hop/Connection-nominated headers stripped on all proxied responses.
