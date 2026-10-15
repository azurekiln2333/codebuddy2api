# Validation evidence

## 2026-10-16 visual correction

The user rejected the first visual delivery and reopened the original task.
The new shell follows the audited New API Base UI/Tailwind 4 structure through
an independent implementation: full-width 48px header, sidebar below it at
208px/44px, 8px workspace inset, visible h1 and native-dialog mobile navigation.
The dashboard, management table toolbars and settings layout were rebuilt.

Final verification after navigation/copy corrections:

| Check | Result |
| --- | --- |
| `pnpm check` | Passed: 65 formatted / 58 lint/type files; no warnings or errors |
| `pnpm test` | Passed: 18 files, 176 tests; final run 07:33:15 on 2026-10-16 |
| `pnpm build` | Passed: 106 modules; upstream license and 35 runtime dependency licenses retained |
| Browser scenarios | All 36 verified: full run 35/36, then the sole test fixture was supplied its missing revision and the affected scenario reran 1/1 successfully; no production fix required |

The coordinating root independently reviewed the final desktop light/dark and
mobile navigation screenshots and accepted the correction. Browser geometry
checks verify the 48px full-width header, 208px/44px sidebar below it, inset main
panel, visible h1 hit testing, current-page navigation and mobile containment.
The native dialog handles Escape and restores trigger focus; no manual focus
trap was added. CDP reported YaHei for the Chinese text nodes in both themes.
The browser worker confirmed port 5174 had no residual server.

Persistent local evidence (generated files, excluded from Git):

- `D:/AppData/Local/Temp/azurekiln-ui-newapi-review/after-desktop-light.png`
- `D:/AppData/Local/Temp/azurekiln-ui-newapi-review/after-desktop-dark.png`
- `D:/AppData/Local/Temp/azurekiln-ui-newapi-review/after-mobile-light.png`
- `D:/AppData/Local/Temp/azurekiln-ui-newapi-review/after-mobile-drawer-light.png`
- `D:/AppData/Local/Temp/azurekiln-ui-newapi-review/after-mobile-drawer-dark.png`
- `D:/AppData/Local/Temp/azurekiln-ui-newapi-review/browser-diagnostic.json`
- Build archive: `D:/AppData/Local/Temp/azurekiln-ui-artifacts/azurekiln-ui-newapi-dist-20261016-073031.zip`

An independent checker reviewed the changed source and confirmed unchanged
API/SSO/CSRF behavior, real-data calculations and settings draft preservation.
Its confirmed navigation Drawer cascade issue was fixed. Two unit assertions
using the old collapse-button name were updated without removing behavior checks;
the final 176-test run passed. A further static menu-clipping hypothesis did not
receive a production change: the coordinator froze source after acceptance and
stopped additional investigation. This report does not claim a new browser test
for that hypothesis.

The 2026-10-15 captures below are historical and cannot serve as acceptance for
this visual correction. Production source is frozen; the coordinating root owns
the explicit-path commit and journal. No push or deployment was performed.

No API, SSO, CSRF or administrator authorization contract was changed by this
visual batch. Storage and its 404 handling belong to the coordinating root.

## 2026-10-15 delivery history

Code gate after the original 208px sidebar correction:

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
