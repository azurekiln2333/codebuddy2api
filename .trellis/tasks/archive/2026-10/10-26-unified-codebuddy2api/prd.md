# Unified CodeBuddy2Api application and delivery

## Goal

Deliver one maintainable CodeBuddy2Api fork in `D:/My2KProjects/codebuddy2api`, including the inference backend, OAuth2/OIDC console login, replacement administration UI, and image-based deployment. The server operator should pull a published image and run Compose, with automatic image checks and updates available.

## Requirements

- R1: Reproduce the login page, initial loading screen displaying `正在连接控制台`, and console design from `D:/My2KProjects/cnb2api-panel`. Carry forward the earlier UI migration request.
- R2: Consolidate `codebuddy2api-ui` and `codebuddy2api-oauth-gateway` into `codebuddy2api` as a fork. Replace the original UI and eliminate production dependencies on sibling source checkouts.
- R3: Retain OAuth2/OIDC login, administrator authorization, browser sessions, CSRF, logout, expiry, and callback errors. Keep administrative secrets out of browser assets. Preserve credential-enrollment OAuth separately.
- R4: Support GitHub Actions and CNB validation, automatic releases, application archives and container-image publication. Deployment must consume the fork's images.
- R5: Default Compose to published-image deployment and persistent data. Supply a separate local build option.
- R6: Automatically check image updates and update only this application's intended containers. Document manual update and version rollback.
- R7: Use the four existing Pi agents on the right of the current Herdr workspace. Main coordinates interfaces, ownership and acceptance.

## Current evidence

- UI repository: clean `feat/azurekiln-admin-ui` at `b09f96c` before task artifacts.
- Backend: `main` at `fc95b04` (`v1.3.5`). Its existing `web/` is built by the root Dockerfile and served by `app/gateway_management.py` under `/dashboard`.
- The replacement UI uses `/sso/session`, `/sso/login?return_to=/dashboard/`, `/sso/callback`, `/sso/logout`, and `/admin/*` with in-memory identity and CSRF state.
- The independent Node gateway implements OIDC and proxies administration and inference requests to the backend.
- Existing backend Compose mixes `build` and an upstream image. GitHub builds images, but the fork needs complete release packaging and CNB configuration.
- The reference panel has GitHub/CNB releases and a scoped Compose updater. Reuse behavior while checking platform contracts and avoiding hard-coded repository ownership.
- Existing Pi panes: backend `w1F:pC`, UI `w1F:pD`, release `w1F:pB`, deployment `w1F:pE`. All four received read-only research work and were observed working.

## Acceptance criteria

- AC1 (R1): Rendered desktop/mobile login, connecting state, session errors and authenticated console follow the reference design. Existing management features remain usable.
- AC2 (R2): The backend repository alone builds and runs the full application. Its `web/` contains the replacement UI; the original console is removed.
- AC3 (R3): Tests exercise login/callback, anonymous/authenticated/forbidden sessions, live administrator checks, CSRF on writes and enrollment polling, logout, and expiry/revocation. Old management key-login routes cannot bypass OIDC. Inference API key behavior remains supported.
- AC4 (R4): Both pipelines validate the complete application. Version tags matching the authoritative version produce archives with SHA-256 and versioned images. Stable releases update `latest`; prereleases do not. PRs do not publish. Archives exclude local credentials, environment files, databases and agent runtime state.
- AC5 (R5): Compose defaults to pull-only deployment, retains credentials/databases across replacement, exposes the documented listener, and has an application health check. A documented override builds the same application locally.
- AC6 (R6): Updater labels and scope select only this application. Documentation covers interval, registry authentication, disabling automatic updates, manual pull and pinned-version rollback.
- AC7 (R7): Pi implementation ownership is explicit. Final integration review verifies the combined application instead of relying on independent reports.
- AC8: Relevant backend regressions, frontend check/unit/build/browser tests, release-package checks, Compose rendering and available image/runtime checks pass. Unavailable remote execution is identified precisely and is never represented as a public release.

## Scope boundaries

Use the backend as the product root. Preserve upstream inference/credential behavior and stored data. Keep sibling checkouts available during migration. Public pushes, registry publication and production-server changes depend on the user's destination and access; local implementation and validation do not depend on performing those external operations.

## Research artifacts

- Backend/OIDC: `research/backend.md`.
- UI/reference fidelity: `research/ui.md`.
- GitHub/CNB releases: `research/release.md`.
- Docker/update operation: `research/deploy.md`.

Finalize the implementation contracts from these reports in `design.md` and `implement.md` before execution.
