# Gateway session contract

## 1. Scope / trigger

Applies to src/api.ts, App guards and every /admin operation. Authentication
migrated from an administrative API key to the same-origin OAuth gateway.

## 2. Signatures

- `establishSession(): Promise<void>`: GET /sso/session.
- `endSession(): Promise<void>`: POST /sso/logout with X-CSRF-Token.
- `api`: axios client, /admin base, credentials enabled, 20s timeout.
- `sso`: axios client, /sso base, credentials enabled, 20s timeout.
- Login URL: /sso/login?return_to=/dashboard/.

## 3. Contracts

Authenticated payload: `{ authenticated: true, csrf_token: string,
user: { sub: string, role: "admin", username?: string, name?: string } }`.
Token and sub must contain non-whitespace characters.
Anonymous payload: `{ authenticated: false, csrf_token: null, user: null }`.

Identity and CSRF remain only in memory. A present token is attached to all
/admin requests. Every non-GET/HEAD/OPTIONS request and GET /admin/oauth/poll
require an authenticated session and token before dispatch. Account polling can
import credentials. Logout sends the same token explicitly.

POST /admin/logs/clear sends scope and confirmation only. Scope all requires
the exact confirmation documented in docs/gateway-contract.md; the browser never
supplies api_key. The gateway owns provider callbacks and original backend
secrets. AZUREKILN_GATEWAY_URL is a dev/preview proxy hint, never a client secret.

## 4. Validation & error matrix

| Condition | Required state |
| --- | --- |
| Valid admin payload | authenticated |
| Explicit false with null user/token, or HTTP 401 | anonymous; clear identity/token |
| Non-admin role, or HTTP 403 | forbidden; clear identity/token |
| Missing/invalid identity/token, malformed payload, other failure | error; no management UI; retry |
| Write/poll without authenticated token | reject before network dispatch |
| Obsolete response after newer check/logout/revocation | ignore; never restore old identity |

## 5. Good / base / bad cases

Good: admin payload with a non-empty token permits a model update carrying CSRF.
Base: 401 shows sign-in; a valid anonymous body is also accepted.
Bad: HTTP 200 with admin role but blank token must not unlock the application.

## 6. Tests required

src/sso.test.tsx and e2e/sso.spec.ts cover parsing, role denial, CSRF, logout,
401/403, and race behavior. Workflow tests assert log-clear body excludes
api_key and enrollment polling includes CSRF. Browser mocks validate the client
contract only; a real IdP login and deployment need separate acceptance.

## 7. Wrong vs correct

Wrong: trust a role field alone, persist CSRF, omit CSRF for all GETs, or let a
late successful check restore a logged-out user.

Correct: validate the complete session, retain identity/token in memory, require
CSRF for the mutating account poll, and guard responses with sessionGeneration.
