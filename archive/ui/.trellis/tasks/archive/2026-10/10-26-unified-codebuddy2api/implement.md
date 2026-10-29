# Execution plan

## Phase gate

- [x] Inspect live working trees and the reference project.
- [x] Locate the four existing Pi panes and dispatch bounded research.
- [x] Persist requirements, design, scope and ownership.
- [x] Finish reviewing all four research artifacts; validate context manifests.
- [x] Present the final planning summary and obtain subsequent approval (user replied `继续` after the final approval request).
- [x] Start the task and create backend branch `feat/unified-codebuddy2api` without changing remotes.

## Implementation sequence

1. Dispatch the existing four Pi agents with the approved artifacts, explicit ownership from `design.md`, and child-side spec loading. Backend and UI work can proceed independently. Release/deployment templates can proceed against the design contracts and must integrate the final env/build commands before completion.
2. Backend owner implements native SSO and admin integration. Port the gateway security assertions with a synthetic IdP. Preserve inference and credential enrollment behavior; reject old key-login bypass in SSO mode. Regenerate pinned Python dependencies using the existing export mechanism.
3. UI owner replaces the backend `web/` source with the current UI, then implements the reference login/loading/console design. Align routes/static notices and browser tests. Leave sibling source trees intact as migration references.
4. Release owner creates shared version/package/release tooling and both workflow definitions. Preserve PR isolation, stable/prerelease tags and existing supported image architectures. Validate artifact allowlists and SHA-256.
5. Deployment owner adapts the single Python runtime Dockerfile and creates pull-only Compose plus build override and scoped update profile. Integrate backend env names and document exact pull/update/rollback commands.
6. Main integrates root docs/specs and runs the complete application against a mock IdP with real HTTP/browser actions. Inspect generated login/loading/console screenshots at desktop/mobile light/dark sizes. Fix cross-owner gaps through targeted follow-up assignments.
7. Run full-scope Trellis check with current artifacts and actual validation results. Verify every PRD requirement against current code/output, then update specs and record deliberate commits/session evidence. Do not claim remote image publication or real-provider authentication without execution evidence.

## Validation commands and evidence

Run from `D:/My2KProjects/codebuddy2api` unless noted:

- `python scripts/check_version.py` plus new version/package regression tests.
- Existing backend convention: execute relevant `tests/test_*.py` scripts and then the complete suite once integrated. Confirm the runner executes assertions; do not substitute mere import/compilation.
- `pnpm --dir web install --frozen-lockfile`.
- `pnpm --dir web check`, `pnpm --dir web test`, `pnpm --dir web build`.
- `pnpm --dir web exec playwright test` and the integrated browser configuration updated for native SSO/mock IdP.
- Shared release-package command and explicit archive-content/hash verification; smoke-run the extracted artifact in temporary storage.
- `docker compose --env-file <synthetic-env> config` for default, auto-update profile and build override when a Docker CLI is available. Otherwise validate YAML/contracts and record the missing Docker evidence.
- Docker image build and health/runtime smoke if a usable engine is available; do not treat YAML parsing as a container execution test.
- Workflow contract validation for GitHub/CNB triggers, permissions, registry destinations, version gating, release inputs and publication guards.

## Review checkpoints

- SSO off preserves supported backend regression behavior; SSO on cannot fall back to API-key management auth.
- Anonymous/forbidden/error/loading states never render protected management data.
- Log clearing and account enrollment polling retain confirmation/CSRF requirements.
- New UI storage routes and notice assets work through native static hosting.
- No sibling checkout, local secret, session snapshot or database enters image/build/release artifacts.
- Stable and prerelease image/tag semantics match on both platforms.
- Local-build Compose disables update selection; two project instances do not select each other's containers.
- Full `/data/auth` persistence and schema rollback documentation remain coherent.

## Rollback and coordination

All product changes occur on the backend feature branch with original history retained. No working sibling directory is removed. Roll back source through normal Git changes; do not use resets that discard concurrent work. Deployment rollback pins a previous image and restores a compatible data backup when required by the schema. Never roll a database back while the application is running.

Workers report exact changed paths, tests run, failures and unresolved dependencies. Main reviews ownership overlap before staging. Remote publication is not inferred from local build success.

## Completion

- [x] All four existing Pi agents implemented their owned changes and reported final results.
- [x] Main integrated native SSO, replacement UI, delivery and deployment contracts.
- [x] Independent cross-layer findings resolved; final lint, unit, browser and native gates passed.
- [x] Actual Compose renders and extracted release runtime/checksum/content verified.
- [x] Requirement-by-requirement evidence and execution limits recorded in `implementation/acceptance.md`.
- [x] Project specs updated for the unified application and new design.
- [x] Product committed locally as `f518a8c` without pushes, branch switches or remote changes.
- [x] Historical UI README redirects maintained development to the unified product.
