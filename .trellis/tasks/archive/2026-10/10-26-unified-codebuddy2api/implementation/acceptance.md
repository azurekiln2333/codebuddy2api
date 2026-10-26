# Final acceptance — 2026-10-26

Maintained product: `D:/My2KProjects/codebuddy2api`.
Branch: `feat/unified-codebuddy2api`.
Local product commit: `f518a8c750c24f35a71ae67cf23233f51c2fd63a`
(`feat: unify console SSO and automated image delivery`).
The branch belongs to the product repository, while this task and journal live
in the historical UI/coordination repository. Neither remote was changed.

## Requirements and acceptance

| Requirement | Evidence and result |
| --- | --- |
| R1 / AC1 — reference design | Login, exact `正在连接控制台` screen, 52px header, 180/64px sidebar, light/dark/mobile and six management pages implemented. Main inspected screenshots of the actual reference and replacement. Design/layout browser assertions pass. |
| R2 / AC2 — one application | Product `web/` replaces the original console; native Python SSO removes the Node gateway runtime. No sibling checkout is needed for the image or extracted release. Extracted archive successfully booted the real backend and served the built console. |
| R3 / AC3 — authentication | PKCE/nonce/state, RS256, bounded/retrying OIDC transport, expiring JWKS cache, live administrator authorization, CSRF/origin, refresh/logout races and inference separation covered by backend tests. Actual Chromium completes login, management read/write, polling and logout against native backend/synthetic TCP IdP. Old admin key-login is unavailable in SSO mode. |
| R4 / AC4 — delivery | GitHub/CNB gates validate the complete app; matching version tags package and publish. Native browser suite is mandatory. Shared tag resolver covers stable/prerelease/PR guards and custom registry login. Image publication precedes Release creation. Archive content/checksum and extracted runtime pass locally. Remote publication remains unexecuted. |
| R5 / AC5 — pull-only deployment | Base Compose has no build, persists `/data/auth`, binds the documented listener and uses image liveness probe. Separate build override opts out of updates. Actual Compose renders pass. Container build/health execution requires an engine unavailable on this host. |
| R6 / AC6 — automatic updates | Pinned opt-in updater, enable labels plus project scope, self exclusion and local-build exclusion verified in rendered Compose (35 assertions). Docs cover interval, private-registry credential mount, disabling, manual update, digest pin, backup and rollback. |
| R7 / AC7 — four Pi agents | Existing panes `w1F:pC` backend, `pD` UI, `pB` release, `pE` deployment completed assigned changes/reports and stopped editing. pE independently reviewed cross-layer contracts; main reran integrated gates and archive runtime. |
| AC8 — verification | New/affected gates pass as recorded below. The complete backend run retains 13 independently reproduced upstream Windows failures; Docker-engine and remote-provider/publication checks are explicitly unexecuted. |

## Executed checks

Final main-controller checks, after integration unless otherwise stated:

- `pnpm exec vp check`: pass, matching Docker's full frontend gate (72
  formatted files; 63 files without lint/type warnings or errors).
- `pnpm exec vp test run --maxWorkers=2`: **179 passed / 18 files**.
- `pnpm exec vp build`: pass; 106 modules and all three legal documents emitted.
- Default Playwright: **44 passed (59.6s)**, desktop/mobile/light/dark and six
  management workflows. Output was placed outside Vite's source tree.
- Native Playwright: **2 passed (5.5s)** with `WEBUI_PYTHON` pointing to the
  hashed-requirements environment, ports 8795/8796. Includes actual built
  notice-file responses, footer destinations, login/callback/live data,
  guarded mutation, polling Referer, logout/reload denial.
- Backend integrated focused run: **440 passed, 4 skipped, 802 subtests**.
  Final release/deployment/version/environment run after custom CNB login-user
  fix: **88 passed, 3 skipped, 199 subtests**. These runs overlap; do not sum.
- Backend owner's full run during integration: **1721 passed, 7 skipped,
  13 failed, 4266 subtests passed**. All 13 also fail on pristine upstream
  `fc95b04` on Windows (SQLite/WAL temporary-file cleanup/permissions, fsync/
  POSIX and locale assumptions); no new full-suite failures were observed.
  See `backend-report.md`; the final added registry-user test passes in the
  focused release run above.
- Authoritative version/pyproject/Compose validation: pass, `1.3.5`.
- Actual Compose CLI default/update/build/custom-project renders: pass;
  `check-compose-assert.py` reports **35/35**.
- Relative documentation links: **13 files, 97 links, 0 broken**.
- Working and staged Git whitespace checks: pass.

An initial independent browser run wrote traces to `web/.tmp-final-browser`,
which Vite watched and used to reload open test pages. It produced one failure
and reached the global timeout. Moving only the output outside the served
tree yielded all 44 passing, including the affected deep-route case; product
code was unchanged. The final result above is the isolated run.

## Final local artifact

`D:/My2KProjects/codebuddy2api/dist/codebuddy2api-v1.3.5-20261026.tar.gz`

- Source commit matches `f518a8c750c24f35a71ae67cf23233f51c2fd63a`.
- SHA-256: `003226dcecb2dbeb8d5e0b93216038b5a8869e29a0695303b4a58b46ac753a40`.
- **168 files**; SHA sidecar verified both by package verifier and independent
  `hashlib.sha256`. Required sources, compiled UI, lockfile, build/deploy
  templates and licenses present; denied local/secret/runtime paths absent.
- `check-archive-runtime.py` safely extracted it to temporary storage and
  launched **the extracted converter**, with synthetic IdP and isolated data.
  Health, anonymous denial, OIDC login, live dashboard, built notice documents,
  CSRF rejection/accepted write, logout and post-logout denial all passed.
- Generated archive/sidecars/build metadata stay local and Git-ignored.

## Execution boundaries

No Docker engine exists on this host: no actual image build, container run,
health probe, updater replacement or multi-architecture execution is claimed.
No GitHub/CNB pipeline, registry publication, real identity-provider login or
production-server operation was executed. The default fork image needs its
first publication before server pulls can succeed. The existing upstream
`v1.3.5` tag is unchanged; choose a new authoritative version/tag for the fork's
first remote release. GitHub main publishes `edge`; CNB main only validates/
packages, and CNB version tags publish images.

The independent check review is closed: all findings were resolved or recorded
above as execution limits. Product code is committed locally. Unrelated local
agent scaffolding remains untouched and uncommitted. Only this task is archived;
other historical planning/bootstrap tasks are outside this delivery.

Bookkeeping note: the archive helper moved the task successfully, but its
auto-stage command also named the original, never-tracked task directory and
Git rejected that missing pathspec. Recovery stages only the new archive
destination and creates the expected archive commit; no product changes are
part of that recovery.
