# Security review

Task: `.trellis/tasks/10-15-oauth-gateway`. This review checked the gateway,
HTTP integration tests and deployment examples, and fixed local defects.
Reference source is read-only: backend `D:/My2KProjects/codebuddy2api` and the
actual OAuth provider `D:/MyNewWebProjects/azurekiln-oauth2`. The backend runs
with temporary databases, credentials and bytecode outside its source tree.
The provider source review is not a live-provider acceptance result.

## Resolved findings

### Route classification and model IDs

The original acceptance of encoded session aliases could forward
`/admin/%73ession` onto the real backend session endpoint. Raw target validation
now runs before URL parsing and rejects encoded route names, traversal, repeated
separators, backslashes and session aliases. `alias.test.ts` and `rawpath.test.ts`
assert rejected requests never reach the upstream.

A blanket percent-escape ban also broke the real UI's encoded model IDs. The
final policy allows encoding only inside the ID of literal
`PUT`/`DELETE /admin/models/{id:path}` and
`POST /admin/models/{id:path}/preview`. Prefix and preview suffix stay literal.
Decode the ID once, require 1-160 ASCII characters from `[A-Za-z0-9_.:/@-]`,
and reject residual percent escapes, empty slash segments and dot segments.
Forward accepted encoding unchanged to ASGI. No encoded session or inference
route alias is allowed. `model-paths.test.ts` covers transport and rejection;
`backend.test.ts` proves original FastAPI create/update/preview/delete behavior
for encoded `custom:<uuid>`, `org/model`, `vendor:model` and `@org/model`.

### Proxy cancellation and header filtering

Normal request `close` previously aborted healthy streams. Cancellation now
uses unfinished response `close` and request `aborted`. Regressions cover healthy
GET/POST, a first SSE chunk received before the finite upstream finishes,
actual unfinished upstream connection closure, and a stalled-header timeout.
The fixture records closure independently; request-open counters alone are
insufficient evidence of cancellation.

Both request and response paths strip Connection-nominated hop headers. Request
filtering now matches identity header families (`x-forwarded-*`,
`x-auth-request-*`, `x-authenticated-*`, `x-user-*`, `x-remote-*`) in addition to
explicit names. Tests exercise previously unlisted members on admin and
inference routes. Upstream fixtures deliberately emit CORS headers so CORS
suppression tests cannot pass just because the fixture omitted them.

### Browser, bridge and inference credentials

Live UserInfo is required for each protected request, with matching subject,
`role === 'admin'` and `isAdmin === true`. Revocation, missing roles, timeout and
subject mismatch deny before protected upstream access. Post-await liveness
checks include membership, idle and absolute expiry; concurrent logout wins.
OIDC body timeouts close stalled provider connections.

Gateway and upstream cookies/CSRF remain distinct. The browser receives neither
backend Set-Cookie nor tokens. Admin writes require exact gateway Origin and
CSRF, then receive the backend bridge's credentials. Full log clear checks the
exact confirmation before injecting the server key; malformed non-object JSON
now returns 400 before a clear request is forwarded.

Original-backend tests cover no caller key, wrong Bearer/X-Api-Key, admin-cookie
only, and explicit correct Bearer/X-Api-Key on `/v1/models`. An ASGI observer
records credential hashes before the real authentication code and confirms no
cookie or extra credential was injected. The real backend uses its configured
API key for both admin and inference; the fast mock uses separate values to
make accidental server-key injection easy to detect.

Original account OAuth handlers retain task ownership, poll CSRF, pending and
completed shapes, replay behavior, and real credential persistence. Only the
external account-provider I/O is replaced by a deterministic fixture adapter.
This does not prove real CodeBuddy account-provider connectivity.

### Static files and session compatibility

Static candidates and SPA indexes are realpath-contained, including symlinked
files/directories. Authenticated `POST /admin/session` now returns 405 before
CSRF validation. Session endpoints distinguish unauthenticated 401 from live
forbidden 403. The prior open method-ordering finding is resolved.

### Deployment examples

- Docker copies both TS configs required by the build; the prior missing-file
  finding is resolved by source inspection.
- Both Nginx examples declare `log_format` at HTTP include scope and apply the
  safe format on HTTP and HTTPS. Query strings and Referer are omitted so
  callback credentials are not written to access logs.
- Both examples pass real `nginx -t` using official Windows Nginx 1.27.5.
  Wrappers include each example in HTTP context and substitute local paths,
  a temporary certificate and loopback for container service DNS. This checks
  configuration syntax; it does not start or accept a deployment.
- Container Nginx addresses `gateway:8788`; native Nginx uses loopback.
- Compose publishes only Nginx. The backend has a private bridge plus an
  outbound egress network; an unpublished listener is not a guarantee of
  isolation from the Docker host itself.
- Deployment registration lists `openid profile roles`, with optional
  `offline_access`; `roles` is required by the live authorization contract.

## Verification and remaining limits

The final compiled-JavaScript runner passes **202/202** tests with no skips;
separate original-backend tests pass **15/15**. An earlier Windows Node
v24.15.0 run had a native child-process exit assertion after the scratch
test's assertions passed. Its finite responses and SSE cancellation are now
fully consumed/awaited, and test scripts compile with `tsconfig.test.json`
before executing emitted JavaScript. Eight isolated compiled proxy workers
also exit cleanly. The exact native Node/tsx cause remains unproven; no
production gateway behavior was changed to accommodate it.

No separate lint script is configured. See [validation.md](./validation.md)
for final logs, exact coverage and the earlier failed run, and
[ui-smoke.md](./ui-smoke.md) for browser evidence and intercepted actions.

No unresolved code finding was identified within the reviewed task scope.
Production IdP credentials, public TLS/DNS and Docker build/stack remain
unverified in this environment. Sessions intentionally remain
single-process and in memory. Local fixture success is not a claim that every
admin feature or production account-enrollment flow has been accepted.
