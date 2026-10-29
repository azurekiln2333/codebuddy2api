# Validation report

Validated locally on 2026-10-15 with a mock OIDC provider, synthetic upstream
fixtures, the original FastAPI backend in isolated temporary state, and a
separate browser smoke using the real UI build. No production IdP, real client
credential, public TLS/DNS or production deployment was used.

## Commands and result

```bash
npm run check
npm run build
npm test
npm run test:backend
```

The final gate ran on Windows Node.js **24.15.0**: typecheck and build pass;
the full suite has **202 tests, 202 pass, 0 fail, 0 skipped, 16 suites**.
The original FastAPI suite independently passes **15/15**. No separate lint
script exists. Final logs are `.tmp/final-root-tests.log` and
`.tmp/final-root-backend.log`.

Tests first compile with `tsc -p tsconfig.test.json` into ignored
`.tmp/test-build`, then run emitted JavaScript with `node --test`. The prior
failed Windows loader run and its cleanup fixes are described below. Eight
isolated compiled proxy-worker invocations also exit successfully. The
production image uses Node.js 22; its container runtime is unverified here.

Both deployment examples also pass **real `nginx -t`** with the official
Windows Nginx 1.27.5 package. Each wrapper includes one example in HTTP context,
substitutes local certificate/log paths and loopback for the container service
DNS name, and uses a disposable self-signed certificate. The command is:

```text
nginx.exe -t -p <temporary-runtime>/ -c <wrapper-container-or-native.conf>
```

Both report `syntax is ok` and `test is successful`; logs are in ignored
`.tmp/nginx-validation/{container,native}-result.log`. No Nginx server was
started and no ports were bound. This establishes syntax compatibility for
the checked Nginx version, not real TLS, service DNS or container operation.

Backend prerequisites live outside the read-only reference repository:

```powershell
python -m venv .tmp/backend-venv
.tmp\backend-venv\Scripts\python -m pip install fastapi httpx python-dotenv "uvicorn[standard]"
```

`tests/backend/server_fixture.py` imports the original backend at
`D:/My2KProjects/codebuddy2api`. Auth files and SQLite state use a temporary
directory; bytecode is disabled/redirected outside the reference tree. A missing
venv or source tree fails with an actionable message. No reference source files
are changed. The actual provider source is
`D:/MyNewWebProjects/azurekiln-oauth2`; it is reviewed read-only, never started
or contacted by these tests.

## Automated coverage

| File | Tests | Evidence |
| --- | ---: | --- |
| `auth.test.ts` | 47 | OIDC login, safe identity, live role checks, session expiry/logout races, Secure cookies, serialized rotating refresh, token validation and stalled-provider body cancellation. |
| `oauth.test.ts` | 13 | Confidential code/S256 exchange, one-use state, nonce, JWKS/signature/audience/expiry failures and secret-free browser responses. |
| `authorization.test.ts` | 14 | Ordinary/missing-role/revoked/timeout/mismatched subjects denied before protected upstream calls; cookie/CSRF isolation. |
| `csrf.test.ts` | 20 | Origin/CSRF, distinct gateway/upstream credentials, log confirmation/key injection, non-object JSON rejection, logout, expiry, concurrent refresh and CORS suppression. |
| `rawpath.test.ts` | 39 | Raw traversal and encoded separator/backslash attempts rejected before routing, with upstream counters. |
| `alias.test.ts` | 23 | Encoded/trailing-slash/case/dot session aliases rejected; synthesized session and disabled POST remain intact. |
| `model-paths.test.ts` | 6 | Strict model-ID-only encoding exception, original encoded bytes preserved, one-decode validation, unsafe IDs/encoded route aliases denied, auth/Origin/CSRF retained. Tests contain matrices of multiple paths. |
| `inference.test.ts` | 8 | Caller Bearer/X-Api-Key only, no cookie or server-key injection, first SSE chunk before finite upstream completion, actual disconnect propagated. |
| `proxy-regressions.test.ts` | 9 | Hop headers in both directions, identity families on both routes, cookie/CORS suppression, healthy GET/POST streams, actual cancellation and stalled-header timeout. |
| `static.test.ts` | 7 | Dashboard index/assets and redirect, traversal rejection, symlink containment and contained SPA fallback. |
| `backend.test.ts` | 15 | Original FastAPI bridge, real full-log clear, caller-key matrix with independently observed headers, account OAuth ownership/CSRF/save, real custom-model creation, encoded slash/colon/@ model update/preview/delete. |
| `scratch-proxy.test.ts` | 1 | Typed named HTTP bridge lifecycle regression independent of OIDC, including distinct CSRF, full-clear key replacement and cookie isolation. |

## Fixture boundaries

The mock OIDC provider advertises RS256/S256 and confidential Basic/POST
client authentication. It verifies one-use codes and PKCE, echoes nonce, and
emits roles only via live UserInfo when requested. It supports revocation,
rotation, malformed JWTs and deterministic network failures.

The fast upstream mirrors the backend's relevant admin Cookie/Origin/CSRF and
log-clear behavior. It deliberately emits sensitive response headers and tracks
raw targets, decoded paths, request headers and unfinished stream closure.
Its inference caller key differs from the server key as an injection detector.
The original backend uses one configured API key for both surfaces; real-backend
checks preserve precisely the explicitly supplied caller credential and drop
all cookies, verified before the original inference authentication code.

The original backend's account OAuth start/poll handlers and credential-save
code execute unchanged. A fixture adapter replaces only external account
provider start/poll I/O, returning synthetic credentials under an allowlisted
domain. Seeded custom model rules provide IDs `org/model`, `vendor:model` and
`@org/model`; real API handlers validate and persist mutations in temporary
SQLite state. This verifies transport compatibility and backend processing,
not account-provider networking or model inference availability.

## Windows test-process teardown finding

The newer failure is a native assertion after the scratch test reports success:
`!(handle->flags & UV_HANDLE_CLOSING)`, `src/win/async.c:76`. The runner then
reports an additional failed file-level test. No gateway behavior assertion
failed in that log; a precise Node/tsx native root cause is not established.

The scratch harness had five finite fetch responses whose bodies were not
consumed, and it resolved its SSE probe on first data before awaiting either
client or upstream closure. The fix uses the existing native HTTP helper to
consume every finite response, waits for request/response close and actual
unfinished upstream stream close, and revokes the bridge before server
teardown. The same test and assertions remain; a 5-second test timeout exposes
a cleanup hang. No sleeps, failure retries or skipped tests were added.

After all earlier test processes exited, an isolated fixed scratch run passed
**1/1**. A controlled comparison ran the scratch/inference/proxy group in five
fresh invocations per variant: reconstructed pre-fix **5 x 18/18**, fixed
**5 x 18/18**, with no native assertion in either set. This did not reproduce
the intermittent native crash and therefore does not prove its native cause.
Evidence is in ignored `.tmp/scratch-cleanup-comparison.json` and the individual
probe logs. For final acceptance, test scripts compile TypeScript before
starting Node's standard JavaScript test runner, removing the runtime TS
loader from worker startup/exit. Test cases, coverage and concurrency remain
unchanged. The final full run, independent backend run and eight isolated
proxy-worker exits all pass. The precise native assertion cause remains
unproven; this is evidence for the final runner, not a claim about every
Windows Node/tsx version.

## Browser smoke

[ui-smoke.md](./ui-smoke.md) records a separate local Chromium run with the real
`D:/My2KProjects/codebuddy2api-ui/dist`, gateway, mock OIDC and original FastAPI.
The final recorded run passes **32 checks**: six page headings and navigation,
real read endpoints, theme/mobile rendering, session identity, live denial,
and real model creation/update/deletion. The browser sends the generated
`custom:<uuid>` ID as `custom%3A<uuid>`; original FastAPI returns 201 for create
and 200 for both encoded-ID mutations.

The browser harness intercepts account OAuth start to exercise the UI poll timer
and CSRF header; it is not a complete browser account-enrollment acceptance.
The browser covers the encoded colon in a generated model ID. Encoded slash/@
IDs and encoded-ID preview are proven by the HTTP suites above, and are not
claimed as browser-driven checks. No blanket claim of full administrative
feature coverage is made.

## Unverified limits

- No live login against the actual OAuth provider or real client registration.
  Basic/POST negotiation, JWKS and rotation are fixture-tested only.
- No public TLS/DNS or real certificate acceptance. Loopback tests explicitly
  opt into HTTP; production Secure-cookie behavior is separately checked.
- No Docker image build or Compose runtime was run here. Docker's TS-config
  copy is verified by source review. Nginx syntax passes with the substitutions
  above; actual Linux/container networking and TLS remain unverified. Backend
  ports are unpublished in Compose, but host/network isolation is
  deployment-specific.
- SSE timing/cancellation is validated against controlled HTTP fixtures, not
  real model-provider output. Stream timeout is the configured socket timeout.
- Account OAuth external I/O is synthetic; account-provider connectivity,
  credentials and production enrollment remain unverified.
- The browser smoke is a selected-flow check, not exhaustive model/settings/
  credentials/logs/storage feature acceptance. Consult its interception notes.
- Static symlink tests run on this machine; other Windows hosts may need
  Developer Mode or symlink privileges.
- Sessions are single-process/in-memory. Restart logout is intentional; no
  shared session storage or multi-replica behavior is validated.
