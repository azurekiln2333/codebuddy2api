# Frozen UI / gateway contract

Gateway w12:p1; UI w11:p1. Public Nginx -> gateway8788 -> private FastAPI8787. UI build `D:/My2KProjects/codebuddy2api-ui/dist`, configured via UI_STATIC_DIR. Coordinate before contract changes.

| Request | Behavior |
| --- | --- |
| GET / | 302 /dashboard/ |
| GET /dashboard/ and nested paths | External UI build |
| GET /sso/session | `{authenticated:boolean,csrf_token:string|null,user:{sub:string,username?:string,name?:string,role:"admin"}|null}` |
| GET /sso/login?return_to=/dashboard/ | Start code/S256 login, return limited to dashboard paths |
| GET /sso/callback | Consume state once, verify tokens, create session, redirect |
| POST /sso/logout | Same Origin and X-CSRF-Token required |
| GET /admin/session | `{authenticated:boolean,csrf_token:string|null}` with gateway CSRF |
| /admin/* | Original API, live administrator check each request; writes use gateway X-CSRF-Token |

Unauthenticated protected/session requests return 401; session endpoints include unauthenticated shape. Authenticated but forbidden/unverifiable role returns 403. Successful session always has nonempty CSRF. Role must be exactly admin and isAdmin true from live UserInfo. Next request after revocation denied.

Browser removes original key sign-in and never receives tokens/upstream admin cookies/CSRF. Full log clear sends scope=all plus original confirmation, omitting api_key; gateway validates text then injects key. GET /admin/oauth/poll also requires gateway CSRF because it can change account state. /admin/oauth remains original CodeBuddy account enrollment.

/v1/* retains caller Bearer/X-Api-Key enforcement without server key/cookies. No cross-origin CORS APIs. Logout ends gateway session, not IdP global SSO. POST /admin/session disabled; DELETE compatibility maps gateway logout.
