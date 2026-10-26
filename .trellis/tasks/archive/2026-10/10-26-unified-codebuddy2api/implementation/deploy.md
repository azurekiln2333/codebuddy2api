# Deployment implementation report (Docker / auto-update)

Owner: Docker & update. Product root: `D:/My2KProjects/codebuddy2api` (branch `feat/unified-codebuddy2api`).
Scope stayed inside the assigned paths: no edits to `app/`, `pyproject.toml`, `requirements*`, `web/`,
`.github/`, `.cnb.yml`, `scripts/`, README, or other owners' tests. No commits, no branch changes,
no resets; concurrent work by the other agents was left untouched.

## 1. Changed paths

| Path | Status | Purpose |
|---|---|---|
| `Dockerfile` | modified | Added the image health check (`/health`, Python stdlib, one line). Everything else untouched: single normal build path (console compiled in the frontend stage), pinned base images, hash-verified pip install, exec-form `CMD`, no source-missing bypass. |
| `docker-compose.yml` | modified | Pull-only default: `image` only, no `build:`, obsolete `version:` removed, `init: true`, json-file log rotation (10m × 3), update labels, optional `watchtower` service behind `profiles: [auto-update]`. Existing port/bind names, `/data/auth` bind mount, `command:` and the whole optional-env block preserved verbatim. |
| `docker-compose.build.yaml` | **new** | Local build override: `pull_policy: build`, `image: ${CODEBUDDY2API_LOCAL_IMAGE:-codebuddy2api:local}`, and `watchtower.enable: "false"` so a locally built image is never auto-replaced. |
| `.dockerignore` | modified | Kept the `**` + `!` allowlist contract (`**` still on line 2). Widened the web tree to `!web/**` with `web/node_modules`, `web/dist`, `web/test-results`, `web/.tmp-*` re-excluded, so the merged console's sources, configs and notice script reach the frontend stage. |
| `.env.example` | modified | `CODEBUDDY2API_IMAGE` now defaults to the fork registry (never the upstream author) with GHCR/CNB examples; added the console-login contract (`CODEBUDDY2API_SSO_ENABLED`, `PUBLIC_ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REFRESH`, `ALLOW_INSECURE_LOCALHOST`) and `WATCHTOWER_POLL_INTERVAL`. Every pre-existing active key/value preserved. |
| `docs/deployment.md` | modified | Compose v2 requirement; console-login section; pull/`up -d --no-build`; registry authentication; local build override; automatic updates (enable/disable/pin); upgrade; rollback with schema caveat; health-check verification; single-container `docker run`. |
| `docs/deployment.zh-CN.md` | modified | Same content, Chinese. |
| `docs/nginx.example.conf` | **new** | Optional host reverse proxy: TLS, unbuffered streaming, `X-Accel-Buffering`, access-log format without the callback query string. Placed in `docs/` because `scripts/package.py` allowlists the `docs` tree but not a root `deploy/` dir, so the release archive cannot end up with a dead doc link. |
| `tests/test_deployment.py` | modified | Replaced the pre-SSO image/`version:`/README-owner assertions and added 7 deployment contracts (see §3). Also fixed a pre-existing Windows-only breakage in the helper (`relative_to()` path separators → `as_posix()`), and marked the audit-hook isolation test `skipIf(win32)` with the real reason. |

## 2. Contracts implemented

**One runtime process, console built in.** No second server, no runtime UI mount, no `UI_DIST`.
Dockerfile keeps a single build path; the release archive carries the web sources, so no
missing-source branch was added (per the user's explicit instruction).

**Pull-only default.** `docker-compose.yml` has an `image` and no `build:` — `docker compose up`
can never silently compile a stale checkout. Local builds use the separate override file, whose
service is labelled out of the updater.

**Health check.** `HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3` runs
`urllib.request` against `http://127.0.0.1:8787/health`; no `curl`/`wget` in the runtime image.
Start period covers first-boot SQLite migration. Documentation states explicitly that this is
liveness only and is **not** an automatic rollback capability.

**Runtime hygiene.** `init: true`, `restart: unless-stopped`, bounded json-file logs on both services.

**Scoped updater.** `nickfedor/watchtower:1.23.2` (maintained fork; `containrrr/watchtower` is
archived) behind `profiles: [auto-update]`, with `WATCHTOWER_LABEL_ENABLE=true`,
`WATCHTOWER_SCOPE=${COMPOSE_PROJECT_NAME:-codebuddy2api}`, `WATCHTOWER_POLL_INTERVAL` (default 600),
`WATCHTOWER_CLEANUP=true`. The application carries `enable: "true"`; the updater labels itself
`enable: "false"` so it never self-updates. Labels stay in the `com.centurylinklabs.watchtower.*`
namespace, which the fork kept from the original project (verified in its source).
`${COMPOSE_PROJECT_NAME}` is provided by Compose itself for interpolation — verified empirically,
so each deployment directory or `-p` name gives a distinct scope.

**Persistence.** Single bind mount `${CODEBUDDY2API_AUTH_PATH:-./auth}:/data/auth` retained; no
named volume was introduced, so "back up the directory" stays the documented workflow.

**Console-login env is forwarded and fails closed.** Compose selects SSO mode by default and passes
empty OIDC values rather than inventing defaults; startup fails closed upstream. `CODEBUDDY2API_KEY`
remains the inference/automation credential and is never the browser's login.

**Rollback.** Documented as: stop → pin previous `X.Y.Z` → `pull` → `up -d --no-build`; the control
database migrates forward only, so a schema-crossing downgrade requires restoring a matching
pre-upgrade copy of the whole `auth/` directory while stopped.

## 3. Test evidence

Environment: Windows dev host, **no Docker CLI/engine**, Python 3.13 (UTF-8 mode `PYTHONUTF8=1`).
A portable official Compose binary (`docker-compose v5.6.1`, Windows x86_64 from the docker/compose
release) was downloaded outside the repos to render configurations. Per the task rules, this is
configuration rendering only — **no image was built and no container was ever run.**

| Command | Result |
|---|---|
| `python -B tests/test_deployment.py` | **OK, 16 tests, 1 skipped** (the audit-hook import isolation test, which cannot run on Windows; see §5) |
| `python -B tests/test_build_lock.py` | OK, 5 tests (Dockerfile digest pinning, hash-verified installs, CI parse) |
| `python -B tests/test_version.py` | OK, 9 tests |
| `python -B tests/test_environment_config.py` | OK, 18 tests, 2 skipped (the two that require a `docker` binary) |
| `python -B tests/test_sqlite_state.py` | OK, 33 tests (also reads the Dockerfile `CMD`/`ENV`) |
| `python -B tests/test_native_noauth.py` | OK, 1 test (runs the image's default command natively) |
| `python -B tests/test_release_pipeline.py` / `test_release_package.py` / `test_release_tags.py` | OK, 20 / 14 / 15 tests (release owner's suite still green against my compose files) |
| `docker-compose v5.6.1 config` (default / `--profile auto-update` / `-f …build.yaml` / `-p alpha` / empty env) | exit 0 for all; rendered image, labels, scope, profiles, `pull_policy`, ports and env inspected |
| Compose contracts of `tests/test_environment_config.py` replayed through the portable CLI (33 assertions: dotenv forwarding, `CODEBUDDY_AUTH_DIR=/data/auth`, `command[:5]`, host/port mapping, `CODEBUDDY_IMPORT_DIR` default, 11 optional keys rendered `null`) | **33/33 PASS** |
| Docs link resolution over READMEs + `docs/**` | 0 broken links |
| YAML parse of both compose files, `shlex` tokenization of every Dockerfile line, nginx brace balance | all OK |

New contract tests added to `tests/test_deployment.py`:
`test_default_compose_pulls_the_application_image_and_never_builds`,
`test_local_build_override_exists_and_opts_out_of_automatic_updates`,
`test_update_service_is_profile_scoped_and_never_updates_itself`,
`test_image_health_check_probes_health_with_the_standard_library`,
`test_compose_forwards_the_console_login_contract`,
`test_deployment_docs_cover_pull_update_disable_and_rollback`,
`test_reverse_proxy_example_keeps_streaming_and_hides_callback_query`.

## 4. Cross-owner integration notes (for the main coordinator)

1. **Watchtower location.** The updater lives in the *base* `docker-compose.yml` behind a profile,
   which is what makes `docker compose --profile auto-update up -d` (as written in the README)
   valid. `scripts/package.py` has an unused `docker-compose.update.yaml` entry — harmless, but a
   separate update file would break that README command, so keep the profile-in-base form.
2. **Env additions must come to me.** `.env.example` currently documents every `CODEBUDDY2API_*`
   name the backend references (verified by `test_example_covers_all_active_runtime_environment_names`).
   If the backend adds another `CODEBUDDY2API_*` variable, that test fails until the name is added
   here; send the final list.
3. **Console login contract assumed literally**: `CODEBUDDY2API_SSO_ENABLED`, `PUBLIC_ORIGIN`,
   `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REFRESH`,
   `ALLOW_INSECURE_LOCALHOST`. If the backend renames any of them, update compose + `.env.example`
   + docs + the two contract tests together.
4. **`docs/nginx.example.conf`** ships via the `docs` allowlist. If the coordinator prefers a
   root `deploy/` directory instead, `scripts/package.py` (`INCLUDE_TREES`) must add `"deploy"`
   in the same change, or the archive will contain a dead documentation link.
5. **Release archive build check** needs a built `web/dist/index.html`; I did not build the console,
   so a full archive run remains for the release/UI owners.
6. **`edge` is GitHub-only — `docs/deployment.md:64` / `docs/deployment.zh-CN.md:65` need a registry
   qualifier.** Confirmed against both pipelines: the GitHub `image` job publishes the floating
   main-branch tag on `main` pushes, while the CNB `main`/`api_trigger`/`pull_request` pipeline only
   validates and packages — it never calls `scripts/release_tags.py`, never logs in to a registry and
   never pushes an image. CNB publishes only on `tag_push` (exact version tags, plus `latest` for stable
   tags), so **the CNB registry has no `edge`**. The two doc lines currently say "`edge` follows main"
   right under the CNB image example, which reads as if CNB also ships `edge`. Please qualify it, e.g.
   "`edge` is published by the GitHub workflow; the CNB registry publishes version tags and `latest`
   only". This is a documentation correction only — no CNB main-branch publish was added (design.md only
   says main-branch validation *can* retain `edge`). Details: `implementation/release.md` §7.7.

## 5. Limitations and risks (stated, not hidden)

- **No image build, no container run.** No Docker engine exists here. The Dockerfile changes are
  structurally validated only (pin/lint/parse contracts + a natively executed default command in
  `test_native_noauth.py`). Image build, health-check behaviour on a real engine, and multi-arch
  publication are unverified.
- **`test_docker_runtime_file_set_imports_in_isolation` is skipped on Windows**, not passing:
  `import asyncio` initializes Winsock, which that test's no-network audit hook forbids. It runs on
  Linux CI; the skip is platform-scoped and explicit so it cannot pass silently.
- **`test_environment_config`'s two compose tests skip locally** (they invoke `docker compose`).
  Their assertions were replayed manually through the portable CLI and all pass, but that is a
  substitute, not the real test.
- **Watchtower is a community fork** whose upstream README itself says it is not for production.
  Mitigations in place: profile-gated, version-pinned, label+scope confined, self-update disabled,
  and the documented manual `pull`/`up -d --no-build` path. An alternative (cron/systemd timer or a
  notify-only agent) remains a coordinator decision, not mine to make unilaterally.
- **`docker.sock` is mounted into the updater** (root-equivalent on the host) — required for updates
  and unavoidable; documented, never published, and it holds no application traffic.
- **`container_name: codebuddy2api` is kept** because the docs and `docker compose exec` rely on it;
  it blocks `scale:`/rolling restarts for now. Renaming is a separate, coordinated change.
- **Two stacks on one host** are isolated by the interpolated Compose project name. If an operator
  forces the same project name for two deployments, they share a scope — documented behaviour.
- **`--profile auto-update` + `--no-build`**: the base file has nothing to build, so the flag is
  inert; with the build override the app is labelled `enable=false` and will not be replaced.
- Frontend build cost: the image still runs `vp check && vp test run && vp build` in the frontend
  stage (pre-existing behaviour, kept deliberately as the single normal build path). It requires the
  console's full source tree in the build context, which is why `.dockerignore` now allows `!web/**`.

## 8. Round 2 — documentation corrections (same owner, same paths)

The main controller reported six real defects in the deployment docs I own. All six are fixed in
`docs/deployment.md`, `docs/deployment.zh-CN.md`, `docker-compose.yml` and `.env.example`:

| # | Defect | Fix |
|---|---|---|
| 1 | "reuse that host login for the update service" was wrong: `docker login` writes the host's `~/.docker/config.json`, which the updater container cannot read | Documented that the default Compose file mounts no credentials, added a local `docker-compose.registry.yaml` override mounting `${HOME}/.docker/config.json:/config.json:ro` (the path the updater reads unless `DOCKER_CONFIG` says otherwise), warned that the override must only be added while that file exists (a missing bind-mount source becomes a directory), noted `${HOME}` is not expanded on Windows, and added the credential-helper caveat: the image ships no helper, so mount the helper and adjust `HOME`/`PATH`, or use a dedicated minimal `{"auths": …}` file |
| 2 | "Preserve the data directory to retain login state" was wrong for the new console | Now: the data directory retains accounts, credentials and databases; console login sessions are in-memory, so a recreate/restart/auto-update requires signing in again |
| 3 | reverse-proxy section steered operators to `CODEBUDDY2API_ADMIN_ORIGINS` / extra trusted origins, which no longer apply under SSO | Bullet reduced to `PUBLIC_ORIGIN` + unchanged Host/scheme forwarding; the anchor link into `advanced.md` was dropped so it cannot collide with the controller's rewrite |
| 4 | local Python startup was described as if the console worked without `.env` | Added: zero-configuration startup is API-compatible only; the console has no key login, and the local SSO recipe (`PUBLIC_ORIGIN=http://127.0.0.1:8787`, OIDC values, `ALLOW_INSECURE_LOCALHOST=true`, loopback callback) is given |
| 5 | duplicated empty `### 构建当前源码` heading in the Chinese file | Deleted |
| 6 | a pinned `:X.Y.Z` tag was promised to be immutable ("checks are a no-op because the tag never moves") | Now: tags are mutable and re-publishing replaces the digest; for an absolute pin use `@sha256:<digest>` from `docker inspect --format '{{index .RepoDigests 0}}'`, and the rollback section pins the digest rather than a version tag |

Also in this round: the 5 optional SSO tuning knobs read by `app/sso_config.py` are now forwarded by
Compose (rendering as `""`, which the code maps to its defaults) and documented in `.env.example` and
the console-login tables; the CNB image example was corrected to `docker.cnb.cool/<cnb-repo-slug>`
(the slug already contains the repository name); `.env.example` gained the digest-pin note.

Verification after the corrections: the four `compose config` renders still exit 0 and
`check-compose-assert.py` reports 35/35 with 0 failures; `test_deployment` 16 OK (1 skip),
`test_environment_config` 18 OK (2 skip), `test_version` 9 OK, `test_build_lock` 5 OK,
`test_release_package`/`_pipeline`/`_tags` 17/24/16 OK, `test_sso_static`/`_auth`/`_oidc`
10/19/18 OK; `check-doc-links.py` reports 12 files, 92 links, 0 broken (files and heading anchors).

Open cross-owner issue found while reviewing and left with its owner (not my path):
`web/dist` ships `THIRD_PARTY_NOTICES.txt` / `THIRD_PARTY_LICENSES.txt` / `LICENSE.upstream.txt` and
no `licenses/` directory, while `app/gateway_management.py` serves `THIRD_PARTY_NOTICES.md` and
`/dashboard/licenses/*`, so every notice/licence URL 404s against the real build (all six are
statically served only by a synthetic fixture in `tests/test_sso_static.py`). Separately,
`Dockerfile:19` runs `vp check`, which currently fails on `web/src/App.tsx` formatting, so the image
build cannot succeed until the UI owner runs `vp check --fix`. Both are detailed with evidence in
`implementation/check-review.md`.
