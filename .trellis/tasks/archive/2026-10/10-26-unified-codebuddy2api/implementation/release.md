# Release implementation report (Pi `w1F:pB`)

Task: `.trellis/tasks/10-26-unified-codebuddy2api`
Product root: `D:/My2KProjects/codebuddy2api` (branch `feat/unified-codebuddy2api`)
Scope: GitHub/CNB validation → packaging → image/Release. No commits/pushes performed.

## 1. Files (exclusive ownership)

Added
- `.cnb.yml` — CNB pipeline: one gated tag pipeline, PR reuses the same gates.
- `scripts/package.py` — deterministic archive, sha256, manifest, notes, CNB options, safe extraction.
- `scripts/release_tags.py` — single tag/registry resolver used by both platforms.
- `scripts/run_backend_tests.py` — shared backend runner (executes assertions, rejects `Ran 0 tests`).
- `tests/test_release_tags.py`, `tests/test_release_package.py`, `tests/test_release_pipeline.py`.

Modified
- `scripts/check_version.py` — `VERSION` authority; prerelease support; ref resolution for both platforms;
  `--check-pyproject`, `--check-compose`; emits `version`/`prerelease`/`tag` to `$GITHUB_OUTPUT`.
- `.github/workflows/docker.yml` — `test → web → package → {release, image}`; shared scripts; PR never logs in/publishes;
  `concurrency` that never cancels a tag release; amd64+arm64 preserved.
- `tests/test_version.py` — prerelease accepted + `prerelease` flag; pyproject/compose consistency gates.
- `.gitignore` — ignore `.venv-ci/` (CI venv) and `/dist/` (packaging output).

Explicitly **not** touched (other owners): `Dockerfile`, `docker-compose*.yml`, `.env.example`, `pyproject.toml`,
`requirements*`, `uv.lock`, `web/**`, `README*`, `docs/**`, `tests/test_deployment.py`, `app/**`.

## 2. Design mapping

| Requirement | Implementation |
| --- | --- |
| `VERSION` authoritative | `check_version.read_version`; `pyproject` + Compose default validated as derived values |
| Prerelease supported | `1.2.3-rc.1` valid; `prerelease=true`; release tag must equal `v<version>` |
| Same resolver on both platforms | `release_tags.resolve()`; stable = `vX.Y.Z,X.Y.Z,X.Y,X,sha-12,latest`; prerelease = `vX.Y.Z-pre,sha-12`; `main` = `edge,sha-12` (resolver capability; only GitHub publishes it — see §7.7); PR = `sha-12` only |
| Registry derivation, no hard-coded owner | GH: `ghcr.io/${GITHUB_REPOSITORY,,}`; CNB: `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}`; `RELEASE_IMAGE`/`CNB_IMAGE` override |
| PR isolation | GH `push:`/login gated on non-PR; CNB PR pipeline contains no `git:release`/`docker login`/attachments |
| Idempotent release | GH `release view` → `upload --clobber` + `edit`, else `create --verify-tag`; CNB `git:release optionsFrom` with `overlying: true` + `cnbcool/attachments` |
| Package content | backend (`converter.py`, `app/`, `requirements.txt`, `VERSION`, `Dockerfile`, `.dockerignore`) + compiled `web/dist/**` + `web` sources/lock/config + compose templates + `docs/` + notices |
| Denylist | `.env*` (except `.env.example`), `auth/`, `*.sqlite3*`, `*.info`, `*.token`, `*.log`, `.reveal`, `.trellis/.agents/.claude/.codex/.pi/...`, `node_modules`, `.git`, `tests/`, local `*.zip`/`*.tar.gz`, `*.ps1`; **any path part** starting with `.tmp`/`-tmp`/`.venv`, and browser/test report dirs (`playwright-report`, `blob-report`, `coverage`, `.nyc_output`, `.vite`, `.turbo`, `.eslintcache`) so local scratch helpers inside the allowlisted `web/` tree never ship |
| Safe extraction | `inspect_archive`/`safe_extract` reject absolute paths, `..`, links, special files; tested |
| Shared runner runs real assertions | `run_backend_tests.py` spawns each `tests/test_*.py` and fails on non-zero exit or `Ran 0 tests` |
| Multi-arch | GH `linux/amd64,linux/arm64`; CNB `CNB_PLATFORMS` default `linux/amd64,linux/arm64` (binfmt attempted) |
| Single CNB pipeline gate | one `"v*".tag_push` pipeline: all validation + package stages, then `publish-image`, then `create-release` → `upload-release-assets` (§7.9) |
| Publish ordering (no partial success) | GH `release` `needs: [test, package, image]`; CNB pushes the image **before** creating the Release, so a failed image never leaves a Release behind |

## 3. Test evidence (local, Windows)

Toolchain present: `python 3.13`, `node`, `pnpm`, `git`, `tar`. **Missing: `docker`, `gh`, `uv`, `vp`.**

Release/version gates (own scope):
```
python scripts/check_version.py --check-pyproject --check-compose
  -> version=1.3.5 / prerelease=false / tag=v1.3.5  (exit 0)
python -B tests/test_release_tags.py     -> Ran 16 tests  OK
python -B tests/test_release_package.py  -> Ran 18 tests  OK
python -B tests/test_release_pipeline.py -> Ran 26 tests  OK
python -B tests/test_version.py          -> Ran  9 tests  OK   (needs runtime deps; venv)
```

Real-repo packaging smoke (current working tree, includes concurrent UI `web/dist`):
```
python scripts/package.py --output <tmp> --date 20261026
  -> codebuddy2api-v1.3.5-20261026.tar.gz  sha256=2be0b6ad…91fb  (164 files, prefix codebuddy2api-1.3.5)
python scripts/package.py --verify <tmp>/codebuddy2api-v1.3.5-20261026.tar.gz
  -> verified; no denied member
captured: Dockerfile, .env.example, docker-compose.yml, docker-compose.build.yaml,
          docs/design-system.md, docs/nginx.example.conf, VERSION, web/dist/index.html,
          web/src/**, web/pnpm-lock.yaml
excluded: .env, auth/*, *.sqlite3*, *.info, *.log, .trellis, .agents, node_modules, tests/, AGENTS.md
deterministic: two builds same date/epoch -> identical name + sha256
```

Backend suite through the shared runner (fresh venv, all `requirements.txt` hashes):
```
python scripts/run_backend_tests.py
  Windows locale (GBK)      -> 58/72  (14 failures: Windows-only locale/file-lock)
  PYTHONUTF8=1              -> 67/74  (7 failures: WinError 32/5 on SQLite WAL/shm tmp cleanup)
```
Baseline comparison (clean `git archive HEAD` snapshot, same runner): **identical failing set**.
The 7–14 residual failures are Windows-local `UnicodeDecodeError: 'gbk'` and
`PermissionError: [WinError 32/5] ... sqlite3` artifacts; on Linux/UTF-8 CI they pass.
**My changes introduced zero new failures**; the three new release test files pass in-suite.

## 4. Remote / platform limits (not executed — must not be claimed as released)

- `docker` absent → no `docker compose config`, no `docker build`, no image/health smoke.
- `gh` absent → no real `gh release create/upload`.
- `uv` absent → no `uv lock`/export (backend owner owns dependency lock).
- `vp` absent → no local `web check/test/build`; the `web`/`package` gates were validated by
  YAML/structure + `test_build_lock`/`test_release_pipeline`, not by executing the console build.
- `.cnb.yml` is **unverified on CNB** (no remote run). Specific unverified points: `cnbcool/default-dev-env`
  toolchain (python3 + node + docker buildx), `python3 -m venv` availability, buildx multi-arch with binfmt,
  `cnbcool/attachments` same-tag re-run idempotency, `cnbcool/attachments` path env expansion
  (`dist/$RELEASE_ARCHIVE`, matching the reference pattern).
- GitHub Actions YAML is syntactically valid and contract-tested, but not run on a remote repository.
- Artifact action SHAs pinned: `upload-artifact` v7 `cf430e0…`, `download-artifact` v8 `9000827…`
  (existing actions in the workflow keep their pinned SHAs).

## 5. Cross-owner integration notes

- **UI final gate**: no `implementation/ui-contract.md` existed at implementation time. The web gate mirrors
  `web/package.json` (`check`/`test`/`build`) and the `Dockerfile` frontend stage exactly:
  `vp install --frozen-lockfile && vp check && vp test run && vp build`, plus Playwright
  headless-shell + integration config. If the UI owner publishes different commands, update two places only:
  GH jobs `web`/`package` and the CNB `web-gates` stage.
- **Deployment owner**: `docker-compose.yml` is now pull-only (`${CODEBUDDY2API_IMAGE:-...:latest}`) and
  `docker-compose.build.yaml` exists — both are in the release archive. `check_version --check-compose`
  accepts `latest` (neutral) and the exact current version; it rejects a stale concrete version.
- **Upstream-owner rule**: publication defaults no longer reference the upstream author. Remaining
  `maiphucgiang` text is either legitimate MIT attribution (`README.md:114`) or negative assertions in
  `tests/test_deployment.py` — not a blocker.
- **Release archive is rebuildable** by the same `Dockerfile` (ships `web` sources + `pnpm-lock.yaml` + config),
  so no Dockerfile conditional branch is required.

## 6. Residual risks

1. CNB pipeline runtime is unverified end-to-end (see §4); first real tag push should be observed and, if needed,
   `CNB_PLATFORMS=linux/amd64` set for arm64-less runners.
2. `check_version --check-compose` is a CI gate: if the Compose default regains a concrete non-current version tag,
   the `test` job fails by design.
3. Release archive date uses the commit date (fallback: UTC build date) so re-running the same tag yields the same
   filename and `--clobber` stays idempotent; the manifest `builtAt` is informational only.

---

# 7. Second review pass (final audit)

Independent re-audit of publish conditions, stable/prerelease handling, allowlist packaging, image-owner
derivation, plus a real archive build. Three defects were found and fixed; one CI-breaking defect came from the
main coordinator's review.

## 7.1 Defects found and fixed

| # | Defect | Fix |
| --- | --- | --- |
| D1 | **CI-invalidating**: `web` job / CNB `web-gates` ran `-c playwright.integration.config.ts`, which `throw`s at config-load when `AZUREKILN_INTEGRATION_URL` is unset | Gate removed; CI now runs the isolated suite plus the **self-starting** `playwright.native.config.ts` suite |
| D2 | `resolve_tags` used `ref.startswith("refs/heads/main")`, so `main-fix`/`maintenance`/`mainline` would move the shared `edge` tag | Exact match `ref == "refs/heads/main"` + regression test |
| D3 | A corrupt/non-gzip `.tar.gz` raised an uncaught `tarfile.ReadError` traceback instead of a clean error | `inspect_archive`/`safe_extract` wrap `TarError`/`OSError`/`EOFError` into `PackageError`; CLI exits 1 with one line; regression test added |

## 7.2 Browser gate decision (coordinated with main + pC)

CI **unconditionally** runs the native SSO suite; there is no `if [ -f ... ]` silent skip, because it is a core
SSO integration gate:

- GitHub `web` job: `vp exec playwright test` then `vp exec playwright test -c playwright.native.config.ts`
- CNB `web-gates`: same two commands
- `playwright.integration.config.ts` + `e2e/backend.integration.ts` remain **manual-only** (they need an external
  `AZUREKILN_INTEGRATION_URL`) and are asserted absent from both CI files by `test_release_pipeline.py`.

CNB interpreter wiring: `WEBUI_PYTHON` is now the **absolute** path `$repo_root/.venv-ci/bin/python`, and the stage
creates/installs that venv if the `backend-tests` stage did not (`repo_root="$(pwd -P)"` before `cd web`, so the
path never resolves relative to `web/`).

**Release-blocking dependency**: `web/playwright.native.config.ts` did **not** exist at review time
(`native_config_exists=False`). CI is now correct but red until pC lands it. pC's contract: self-start the native
backend + synthetic IdP via Playwright `webServer`, honour `WEBUI_PYTHON`/`WEBUI_CHROMIUM`, never read
`AZUREKILN_INTEGRATION_URL`. The archive already ships it automatically (`web/**` is allowlisted;
`is_denied("web/playwright.native.config.ts") == False`).

## 7.3 Re-verified contracts

- Publish conditions: PR never logs in/publishes (GH `push:`/login gated; CNB PR pipeline has no `git:release`,
  `docker login`, `--push`); image publication gated on `test`+`web`+`package`.
- Stable vs prerelease: stable tag → `vX.Y.Z,X.Y.Z,X.Y,X,sha-12,latest`; prerelease → `vX.Y.Z-pre,sha-12` only;
  `main` → `edge,sha-12` (GitHub publishes `edge`; CNB does not — §7.7); PR → `sha-12`. Release notes/`preRelease`/`latest` derive from the same flag.
- Image owner derivation: GH `ghcr.io/${GITHUB_REPOSITORY,,}`; CNB `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}`;
  `RELEASE_IMAGE`/`CNB_IMAGE` override; no upstream/owner literal in CI or `scripts/*.py`.
- Allowlist packaging unchanged in behaviour: backend + `web/dist` + web sources/lock/config + compose templates +
  docs/notices; denylist still blocks `.env*` (except `.env.example`), `auth/`, SQLite, `*.info`, logs, `.git`,
  agent state, `node_modules`, `tests/`, local archives — plus (since §7.8) local scratch paths and test/browser
  report directories, matched on any path part.

## 7.4 Real archive generation and checksum evidence

```
python scripts/package.py --output <tmp>
  -> codebuddy2api-v1.3.5-20261015.tar.gz   (date = HEAD commit date; deterministic)
     sha256 = cbfa4360ac9630da060ad6b738c450b5ce48ff91d81ebd0ad0681377a21a32b2   164 files
independent check: Get-FileHash == <archive>.sha256 == build-manifest.json.sha256   all_match=True
python scripts/package.py --verify <archive>            -> exit 0
python scripts/package.py --verify <corrupt .tar.gz>    -> exit 1, clean single-line PackageError
```

## 7.5 Test results (local, Windows)

Release scope (no runtime deps needed):

```
python -B tests/test_release_package.py   -> Ran 18 tests  OK
python -B tests/test_release_tags.py      -> Ran 16 tests  OK
python -B tests/test_release_pipeline.py  -> Ran 26 tests  OK
python -B tests/test_version.py           -> Ran  9 tests  OK   (venv)
=> 69 release/version assertions pass
```

Full backend suite via `scripts/run_backend_tests.py` on the current tree (pC's 6 new `test_sso*` files included,
80 scripts total):

```
PYTHONUTF8=1 -> 73/80 passed; 7 failures, identical to the clean-HEAD baseline set:
  test_audit_store, test_control_store, test_model_site_blocks, test_native_noauth,
  test_realtime_streaming, test_trial_integration, test_trial_rewards
causes (Windows-only, verified individually):
  PermissionError [WinError 32/5] on SQLite/WAL temp-dir cleanup,
  UnicodeDecodeError decoding GBK console output as utf-8,
  Windows OSError/byte-size differences
```

My changes introduce zero new failures: the failing set is byte-identical to the clean `git archive HEAD` baseline,
and none of the failures are in a file or code path this scope touches.

## 7.6 What could not be executed (not claimed as released)

- `docker` absent → no `docker compose config`, no image build, no `/health` runtime smoke.
- `gh` absent → no real `gh release create/upload/edit` execution.
- `vp` absent → `web check/test/build` and both Playwright runs were **not** executed locally; the CI wiring is
  validated structurally (`test_release_pipeline.py`, `test_build_lock.py`) only.
- `.cnb.yml` never executed on CNB. Unverified: `cnbcool/default-dev-env` toolchain (python3 + node + docker buildx),
  `python3 -m venv`, buildx multi-arch/binfmt, `cnbcool/attachments` same-tag re-run idempotency and its
  `dist/$RELEASE_ARCHIVE` expansion.
- GitHub Actions workflow never run on a remote repository.

## 7.7 `edge` is GitHub-only (no CNB main-branch publication)

The shared resolver can emit `edge` for `refs/heads/main` on either platform, but **publication** is
asymmetric by design and stays that way:

| Platform | `main` push behaviour | `edge` |
| --- | --- | --- |
| GitHub Actions | `test` → `web` → `package` → `image`; image job logs in and pushes | **published** (`edge` + `sha-12`) |
| CNB | `main`/`api_trigger`/`pull_request` run validate + package only (no `release_tags.py`, no registry login, no `git:release`, no `--push`) | **not published** |

CNB publishes images only on `tag_push` (exact version tags, plus `latest` for stable tags). This matches
`design.md` ("Main-branch validation **can** retain `edge`") — it is a permission, not a requirement, so
no CNB main-branch publish was added. Encoded as tests:
`test_github_main_push_can_publish_edge` and `test_branch_pipelines_never_publish`.

**Docs follow-up (pE owns `docs/`)**: `docs/deployment.md:64` and `docs/deployment.zh-CN.md:65` currently
say "`edge` follows main" immediately under the CNB image example, which reads as if the CNB registry also
ships `edge`. It should be qualified to attribute `edge` to the GitHub workflow and state that the CNB
registry publishes version tags and `latest` only. Tracked as item 6 in `implementation/deploy.md`; not
edited here because `docs/deployment*.md` is the deployment owner's file.

## 7.8 Denylist hardened for local work files inside `web/`

`web` is allowlisted as a whole tree, so anything untracked that a developer drops next to the sources was
collected (`collect_files` walks the filesystem, not git). The concrete near-miss: a temporary visual script
`web/.tmp-reference.mjs` sat in that tree during UI work and would have shipped in the next source package.

Rule added in `scripts/package.py` — matched **per path part, at any depth**:

| Kind | Match | Examples now pruned |
| --- | --- | --- |
| prefix | part starts with `.tmp`, `-tmp`, `.venv` | `web/.tmp-reference.mjs`, `web/.tmp/visual.mjs`, `web/.tmp-shots/home.png`, `web/.venv-ci/bin/python`, `web/e2e/-tmp-state/state.json` |
| dir name | exact part | `web/playwright-report/`, `web/blob-report/`, `web/coverage/`, `web/.nyc_output/`, `web/.vite/`, `web/.turbo/` |
| file name | exact part | `web/.eslintcache` |

Deliberately *not* a blanket `*report*`/`*tmp*` substring rule: `web/src/tmp-helpers.ts`, `web/src/report-card.tsx`
and `web/src/coverage-notes.md` must keep shipping, and `web/dist/**` must keep shipping (it is the compiled
console the image needs). Those are asserted as negative controls.

Regression tests (`tests/test_release_package.py`, 14 → 17):

- `test_collect_files_skips_local_scaffolding_inside_web` — calls `collect_files()` on a fixture that plants all
  nine scratch paths, asserts each is absent, asserts sibling payload (`web/src/main.tsx`, `web/e2e/login.spec.ts`,
  `web/dist/index.html`, `web/package.json`, `web/pnpm-lock.yaml`) survives, and that output stays sorted/unique.
- `test_verify_rejects_a_scratch_member_smuggled_into_the_archive` — rebuilds a valid archive with an extra
  `web/.tmp-reference.mjs` member; `verify_archive()` must raise `PackageError` containing `denied`, so the check
  is enforced on the read path too, not only at collection time.
- `test_is_denied_predicate` — extended true-cases plus the substring false-cases above.
- `test_denylist_excludes_secrets_data_and_agent_state` — fixture decoys + all nine paths asserted absent from the
  verified member list.

Real-repo proof (plants created, real `build_package` + `verify_archive`, then removed):

```
collect_files before plants: 165   after plants: 165   newly collected: NONE   legit files dropped: NONE
archive: codebuddy2api-v1.3.5-20261015.tar.gz   members: 166   scratch members: NONE
package.py --verify -> exit 0
```

The count not moving is the point: the plants contributed zero members and nothing legitimate was lost.

## 7.9 Publish ordering: no Release for a half-published tag

A Release must never be recorded for a tag whose images did not actually land. Both platforms previously
allowed that; both are now ordered.

| Platform | Before | After |
| --- | --- | --- |
| GitHub Actions | `release` and `image` both `needs: [test, package]` → ran in **parallel**, so a failed image left a successful Release | `release.needs: [test, package, image]` — the Release is written only after the image push succeeds |
| CNB | `create-release` → `upload-release-assets` → `publish-image`, so a failed image left a Release with assets | `publish-image` → `prepare-release-metadata` → `create-release` → `upload-release-assets` |

**Branch-guard caveat on GitHub.** A job skipped via `if:` propagates the skip through `needs:`, so adding any
branch-only guard to `image` would silently skip `release` for tags too. `image` therefore keeps **no** `if:`
(it runs on PRs and simply does not log in or push there); this is asserted, not just commented.

**Draft releases: checked, not used.** The verified `git:release` schema
(`research/release.md`, from `build/internal-steps/git/release.md`) exposes exactly `overlying`, `tag`, `title`,
`description`/`descriptionFromFile`, `preRelease` and `latest` — there is **no `draft`** option, and `git:release`
cannot carry attachments at all. So no draft was invented to close the create→upload window; the option set is
pinned to the verified five keys by `test_publish_options_use_only_verified_git_release_keys` (which also asserts
`"draft" not in options`) so a later well-meaning addition fails loudly instead of guessing a schema.

**Residual window (stated, not hidden).** On CNB, if `upload-release-assets` fails *after* `create-release`
succeeds, the Release exists without its archive. Causes: `cnbcool/attachments` behaviour, network, or token
scope. Repair path: re-run the tag pipeline — `overlying: true` converges the Release instead of delete-and-recreate.
Without a draft option there is no way to make the two steps atomic, and a re-run is the honest fallback. On GitHub
the equivalent window does not exist: `gh release create/upload --clobber` runs in a single step, checksum-verified
before upload.

New ordering contracts (`tests/test_release_pipeline.py`, 24 → 26):
`test_release_is_published_only_after_the_image_succeeds` (release depends on image, image has no `if:`, image still
pushes on `refs/tags/v`) and `test_image_publish_precedes_any_release_stage` (publish-image precedes both release
stages, and creation precedes asset upload).
