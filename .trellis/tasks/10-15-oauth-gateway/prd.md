# External OAuth administration gateway

## Goal

Implement standalone OIDC gateway with live admin authorization, private upstream bridge, deployment and integration acceptance

## Requirements

- R1: Standalone Node22+/TS gateway on 8788, existing domain Nginx -> gateway -> private/loopback FastAPI8787. Both reference repositories remain read-only. UI owner w11:p1 provides D:/My2KProjects/codebuddy2api-ui/dist.
- R2: Confidential OIDC code/S256 PKCE, one-use browser-bound state, nonce, discovery, RS256/JWKS issuer/audience/expiry checks. Request openid profile roles; optional offline_access for refresh. Never send prompt/max_age.
- R3: Every protected request independently fetches live UserInfo and requires matching subject, role === admin AND isAdmin === true. Missing roles, ordinary users, errors, timeouts and revocation fail closed before upstream access; next request after revocation denied.
- R4: Opaque server sessions, Secure/HttpOnly/SameSite=Lax cookies, idle/absolute expiry, logout, same-origin/CSRF, timeouts, refresh rotation with lock, bounded stores, secret-free errors/logging.
- R5: Frozen docs/ui-contract.md. / redirects /dashboard/. /sso/session exposes safe admin identity + gateway CSRF; /sso/login, callback, logout. /admin/session GET compatibility; POST unavailable, DELETE gateway logout. 401 unauthenticated, 403 forbidden. Keep backend /admin/oauth account enrollment.
- R6: Per-gateway-session upstream cookie/CSRF bridge using server api_key and legal Origin. Only accept gateway CSRF, translate to distinct upstream CSRF. Filter upstream Set-Cookie; no browser original key/token/cookie. Full log clear injects key only after exact original confirmation.
- R7: /v1/* retains caller Bearer/X-Api-Key auth, injects no server secrets or cookies. Reject raw/encoded traversal, backslashes, duplicate normalization and classification bypass. Preserve legitimate encoded model IDs (`org/model`, `vendor:model`, `@org/model`) for original model edit/delete/preview routes with a strict parameter-only exception; model parameters containing dot segments or double encoding remain rejected. Strip spoofed identity/hop headers; stream SSE immediately with cancellation/timeouts.
- R8: Configurable UI path, Docker/compose/Nginx examples, env example, deployment/rollback/client registration docs.

## Acceptance Criteria

- [x] Faithful local OAuth mock checks confidential client, PKCE/state/nonce/JWKS and JWT failures; ordinary/missing-role/revoked/timeout users never reach upstream.
- [x] CSRF tests use distinct gateway G1 and upstream U1/C1; upstream sees C1 only. Cover same-origin, replay, open redirect, expiry/logout, concurrent rotating refresh and failure.
- [x] Raw HTTP paths (equivalent curl --path-as-is) prove /v1/../admin, encoded traversal/separators/backslashes cannot reach admin; assert upstream counters.
- [x] /v1 no key, wrong key, and only admin cookie denied by original backend; correct caller key accepted with no server credential injection.
- [x] Original FastAPI runs with isolated temporary state, verifies real bridge/log confirmation/account OAuth compatibility. Neither reference repository changes.
- [x] Real FastAPI model CRUD and preview accept encoded slash/colon/@ IDs while raw and encoded model traversal never reaches the upstream.
- [x] SSE first chunk arrives before end, cancellation reaches upstream, headers sanitized, backend never publicly exposed by deployment examples.
- [x] Build/typecheck/security tests pass; accurately record real OAuth/client credentials and Docker validation limits.

## Notes

- User explicitly approved task creation/start, planning, parallel implementation, validation and task-file Conventional Commits without push in the initial request and repeated authorization. No phase/commit confirmation is needed.
- Backend evidence: app/admin_api.py:233 session login requires legal Origin + api_key, returns cookie/nonempty CSRF; app/admin_auth.py:489 protects mutations and oauth/poll; app/admin_api.py:524 full log clearing requires confirmation/key.
- OAuth evidence: server.js:1369 discovery RS256/S256/Basic/Post; :1869 rejects prompt/max_age; :1090 emits roles only when requested. Access token has no role. OAuth repo contains unrelated dirty work and is read-only.
- Reference paths: backend `D:/My2KProjects/codebuddy2api`; OAuth provider `D:/MyNewWebProjects/azurekiln-oauth2`. `new-api` is not the OAuth reference.
- Out of scope: reference source changes, UI source implementation, production deploy/DNS/client registration without credentials, push, replacing inference auth. Real-domain acceptance requires later credentials; use faithful mock now.
