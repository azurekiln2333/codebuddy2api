# Design

Node22+ TypeScript ESM, node:http, jose JWT verification. Existing-domain Nginx terminates TLS, gateway8788 bridges private FastAPI8787. One process owns bounded in-memory sessions; restart logs everyone out. No replica support until shared session storage/locks exist.

## Ownership
- Auth agent: src/auth.ts, src/oidc.ts, src/sessions.ts, tests/auth.test.ts.
- Proxy/deploy agent: src/proxy.ts, src/static.ts, deploy/**, Dockerfile, .dockerignore, compose.yaml, .env.example, docs/deployment.md.
- Security/check agent: tests/** except auth.test.ts, faithful mock and original backend fixtures, docs/validation.md. Review other code read-only; send findings to owner/main.
- Main: package/lock/tsconfig, src/config.ts, src/http.ts, src/server.ts, src/main.ts, README, docs/ui-contract.md, docs/internal-contract.md, Trellis and commits.

## Data flow and security boundaries
Server stores browser-bound state/verifier/nonce once; callback exchanges code with confidential credentials, verifies RS256 ID token using discovered JWKS and live UserInfo, rotates opaque session. Tokens/cookies remain server-side. Return paths limited to dashboard tree.

Every protected call invokes requireAdmin for independent live UserInfo after refresh under per-session promise lock. Exact role/admin flag and matching subject required. /sso/session and /admin/session synthesize safe identity/gateway CSRF. Mutations and oauth/poll validate gateway CSRF and Origin. Logout invalidates session and best-effort revokes upstream session.

Admin proxy creates per-session upstream cookie/CSRF using server key and canonical backend Origin. Browser auth/cookie/CSRF is stripped and real backend cookie/CSRF injected; never forward backend Set-Cookie. Full log clear parses bounded JSON, checks original confirmation then supplies key. Preserve API shapes; inspect backend sensitive response redaction. Inference receives caller credentials only, no browser cookie. No global authenticated HTTP client.

Raw request target validation precedes URL parsing/classification: reject dot segments, encoded route aliases, backslashes and noncanonical paths so neither URL parser nor backend can reinterpret /v1 as admin. Ordinary route names remain literal. Only the original model edit/delete/preview parameter under literal `/admin/models/` may use percent escapes; decode once, validate the model ID alphabet/length and reject dot/empty segments and residual escapes before forwarding. Preserve encoded parameter data so slash/colon/@ model IDs reach the original `{id:path}` routes. Only explicit routes proxy. Stream through node:http with backpressure/header flush, abort on close/timeouts, disable Nginx buffering/compression. Static realpath stays within configured external UI directory.

## Operations
Safe config fails startup without secrets/HTTPS (explicit loopback development escape). Docker has no published backend port. Rollback keeps backend private and restores safe access controls before bypassing gateway. Real OAuth and public TLS remain unverified until client credentials exist.
