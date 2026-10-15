# Verification — 2026-10-16

## Scope and conclusion

No production gateway defect was reproduced. The unchanged original backend
at `fc95b04` exposes GET `/admin/storage` and POST `/admin/storage/archive` in
`app/admin_api.py:537/551`. Current gateway classification and forwarding allow
both exact targets. Read-only UI tracing confirms Axios builds these same
paths and displays an upstream string `detail`, including `Not Found`.

The user's deployed failure remains pending comparison with the running
backend, gateway target and failing browser request. It is not established as
a backend-version mismatch and is not claimed fixed. The deployment guide
links to exactly two read-only, secret-free diagnostic commands in
`docs/storage-diagnostics.md`: OpenAPI route presence and an authenticated
direct GET using the existing backend key from an environment variable.

## Checks

- `npm run check`: passed.
- `npm run build`: passed.
- `npx tsc -p tsconfig.test.json`: passed.
- `node --test .tmp/test-build/tests/backend.test.js .tmp/test-build/tests/storage.test.js`:
  19 passed, zero failed/skipped (18 original-backend tests plus one transparent
  404 regression covering both methods/paths).
- No active compiled-test/backend-fixture processes remained after the run.
- Original backend tracked diff remained empty. No UI, backend business code,
  OAuth/reference project, approval helper or runtime/runner files changed.
- Independent `trellis-check` review: no blocking finding; source evidence,
  transparent errors and the two diagnostic commands agree with the tests.

## Storage evidence

- GET: 200, numeric byte/retention metrics, `archives: []`, `degraded: false`;
  no upstream admin cookie exposed.
- POST `{days: 30}`: 200,
  `{"ok":true,"archived_requests":0,"archived_events":0,"file":null}`.
- POST `{days: 0}`: 400,
  `{"error":{"message":"请求参数、配置或策略无效，请检查类型、范围及冲突","type":"admin_error"}}`.
- Existing fixture with no storage handlers: GET and POST both preserve 404
  and `{"error":"not_found"}`. Exact upstream request records/counters confirm
  neither request was blocked or rewritten before reaching the upstream.

## Review boundary

Changes are limited to the four focused test cases, source-backed diagnostic
documentation, the gateway storage contract and this task's records. No full
suite, real IdP, container runtime or deployed-service acceptance is claimed
for this task. The isolated backend tests exercise real FastAPI with the
existing local mock OAuth provider.
