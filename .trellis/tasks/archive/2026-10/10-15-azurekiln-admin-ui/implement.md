# Execution

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
