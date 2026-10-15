# Validation evidence

Final code gate on 2026-10-15, after the 208px sidebar correction:

| Check | Result |
| --- | --- |
| `pnpm check` | Passed: 63 formatted files; 58 lint/type-checked files; no warnings |
| `pnpm test` | Passed: 18 files, 176 tests |
| `pnpm build` | Passed: 104 modules; upstream license and 35 runtime dependency licenses included |
| `pnpm exec playwright test` | Passed: 34 browser tests (browser worker report, 52.3s) |

The final check/test/build were rerun during handoff. Their local logs are
`.tmp-final-{check,test,build}.log` (ignored). Browser evidence is the completed
worker run and `test-results/.last-run.json` (`status: passed`, no failed tests).
Documentation-only edits followed these runs; application code was unchanged.

The new `e2e/layout.spec.ts` measures a 208px desktop sidebar, workspace and
title positions, and the actual painted element at the title centre.
It also checks no horizontal overflow at 375px. The worker and coordinator
reviewed the resulting 1440px light/dark and 375px light screenshots under
`test-results/azurekiln-*.png`. Generated artifacts are not committed.

The standard browser suite uses synthetic SSO/admin route fixtures; its success
does not prove a production identity-provider login or real upstream account
enrollment. A separate gateway-owned smoke run exercised the built UI, the real
gateway, a synthetic OAuth provider and the original FastAPI backend with
isolated data. See the gateway repository's `docs/ui-smoke.md` for its exact
scope and limitations. No production service or real user data was used.

Production provider registration, TLS/domain routing, actual administrator
login, upstream account enrollment and deployment acceptance remain operator
checks. See [deployment.md](./deployment.md).
