# Execution

> Reopened 2026-10-16. Execute [correction.md](./correction.md): shell/dashboard
> first, review fresh screenshots, unify management pages, run check/unit/build
> and browser regressions, then coordinating root reviews and commits. Storage
> and layout/navigation browser tests belong to the external coordinator.

## Correction batch

- [x] Restore original task and persist corrected requirements/design/ownership.
- [x] Dispatch isolated shell, dashboard and management-page implementers.
- [x] Rebuild full-width header, inset workspace, grouped sidebar and mobile dialog.
- [x] Rework real dashboard summaries, table toolbars and settings structure.
- [x] First integrated check / 176 unit tests / build pass.
- [ ] Complete translated navigation and page copy; repeat affected checks.
- [ ] Review fresh light/dark/mobile screenshots and actual Chinese platform fonts.
- [ ] Coordinate complete browser regressions and root review; unified commit by root.

## Original delivery history

- [x] Migrate upstream web source/config/tests/license with attribution.
- [x] Curate manifests and start task; dispatch fixed file ownership.
- [x] Replace API Key auth with SSO; test cookies, CSRF, malformed session, 401/403/logout.
- [x] Apply AzureKiln shell/styles, light/dark/mobile; preserve functional selectors.
- [x] Preserve core operations; remove browser admin secret from log clearing.
- [x] Run pnpm check, pnpm test, pnpm build; fix substantive failures.
- [x] Run browser gateway-contract checks/screenshots desktop/light/dark/mobile; fixtures exist only in tests.
- [x] Commit the complete verified batch (feat(ui)); explicit paths, no push.
- [x] trellis-check review; capture spec/deployment/validation notes.
- [x] Archive completed task; record the final handoff journal.

Gates: pnpm check; pnpm test; pnpm build; pnpm exec playwright test. Do not claim live OAuth validation without configured gateway/provider. Record environment blockers. Verified commits define rollback points; no destructive reset/source repository mutation.

Final code gate: check clean, 18 test files / 176 tests passed, build passed. Browser worker: 34 passed; 208px desktop and 375px mobile geometry/screenshots reviewed. See docs/validation.md.
