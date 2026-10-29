# Cross-layer check review — unified CodeBuddy2Api

Reviewer role: independent Trellis check (read-only over other owners' code; mechanical fixes only in
the deploy files this agent owns). Product repo `D:/My2KProjects/codebuddy2api`, branch
`feat/unified-codebuddy2api`. No commits, no pushes, no branch changes, no agent dispatch.
Host has **no Docker engine**: nothing below claims an image was built or a container was run.

Reviewed diff scope: `git status`/`git diff` of the whole integration (backend SSO + static hosting,
replacement `web/`, Docker/Compose, release pipeline, docs), plus `prd.md` / `design.md` /
`implement.md` / `check.jsonl` of task `10-26-unified-codebuddy2api`.

---

## 0. Reproducing the Compose renders (for the main controller)

Portable Compose CLI (official standalone binary, no daemon, no engine):

```
D:\My2KProjects\.compose-cli\docker-compose.exe      # Docker Compose version v5.6.1
```

Synthetic env file used for all renders — `D:\AppData\Local\Temp\cb2a-render\synthetic.env`:

```dotenv
CODEBUDDY2API_IMAGE=ghcr.io/example/codebuddy2api:1.3.5
CODEBUDDY2API_AUTH_PATH=./auth
CODEBUDDY2API_SSO_ENABLED=true
PUBLIC_ORIGIN=https://console.example.com
OIDC_ISSUER=https://idp.example.com
OIDC_CLIENT_ID=client-abc
OIDC_CLIENT_SECRET=secret-xyz
OIDC_REFRESH=true
ALLOW_INSECURE_LOCALHOST=false
CODEBUDDY2API_KEY=test-key
```

Written with:

```powershell
$tmp = 'D:\AppData\Local\Temp\cb2a-render'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
@'
CODEBUDDY2API_IMAGE=ghcr.io/example/codebuddy2api:1.3.5
CODEBUDDY2API_AUTH_PATH=./auth
CODEBUDDY2API_SSO_ENABLED=true
PUBLIC_ORIGIN=https://console.example.com
OIDC_ISSUER=https://idp.example.com
OIDC_CLIENT_ID=client-abc
OIDC_CLIENT_SECRET=secret-xyz
OIDC_REFRESH=true
ALLOW_INSECURE_LOCALHOST=false
CODEBUDDY2API_KEY=test-key
'@ | Set-Content "$tmp\synthetic.env" -Encoding utf8
```

The three renders (plus one scope-isolation probe), from `D:\My2KProjects\codebuddy2api`:

```powershell
$cli = 'D:\My2KProjects\.compose-cli\docker-compose.exe'
$tmp = 'D:\AppData\Local\Temp\cb2a-render'
$env = "$tmp\synthetic.env"

# default (pull-only base)
& $cli -f docker-compose.yml --env-file $env config --format json |
    Out-File -Encoding utf8 "$tmp\out-default.json"

# auto-update profile
& $cli -f docker-compose.yml --env-file $env --profile auto-update config --format json |
    Out-File -Encoding utf8 "$tmp\out-update.json"

# build override
& $cli -f docker-compose.yml -f docker-compose.build.yaml --env-file $env config --format json |
    Out-File -Encoding utf8 "$tmp\out-build.json"

# project-scope isolation probe
& $cli -f docker-compose.yml -f docker-compose.build.yaml --env-file $env `
    --profile auto-update -p alpha config --format json |
    Out-File -Encoding utf8 "$tmp\out-alpha.json"
```

All four exit `0`. Gotchas that cost time, so they are written down:

* `--format json` is **required** — v5.6.1 renders YAML by default, and the loader then fails.
* Use `| Out-File -Encoding utf8`, not `>`. `>` writes UTF-16LE in Windows PowerShell 5.1.
* `config` only interpolates/normalises YAML; it never pulls, builds or runs anything.

Assertions (35 checks, all passing) — `implementation/check-compose-assert.py`:

```powershell
python -B implementation/check-compose-assert.py "D:\AppData\Local\Temp\cb2a-render"
```

Result: `total failures: 0`. It asserts, among others: base service has **no** `build:`; watchtower
absent from the default render and present only under `auto-update`; `nickfedor/watchtower:1.23.2`
(no `containrrr`, no `:latest`); updater self-label `false` and app label `true`; updater scope ==
app scope; `-p alpha` moves the scope to `alpha`; build override sets `pull_policy: build`, a local
image tag, `watchtower.enable=false`, and a context that contains the `Dockerfile`; loopback host
port; `/data/auth` bind mount; the 7 fixed SSO env names forwarded; the 5 optional tuning knobs
forwarded as empty strings (so the code keeps its defaults).

Other reusable probes in this directory:

| Script | Purpose |
|---|---|
| `check-static-probe.py` | Serves the **real** `web/dist` through `install_pages` and reports status codes for page/notice/licence URLs. |
| `check-doc-links.py` | Validates every relative Markdown link + heading anchor in root and `docs/` (12 files, 92 links, 0 broken). |

---

## 1. Findings

### F1 — RESOLVED: the image build gate passes again

`Dockerfile:19` runs the frontend gate inside the image:

```
RUN GOMAXPROCS=2 GOMEMLIMIT=512MiB RAYON_NUM_THREADS=2 vp check && vp test run && vp build
```

Originally `vp check` failed on `web/src/App.tsx:274-279` (a 5-attribute `<div>` wrapped although it
fit the print width), which blocked `docker build`, the build override and the release pipeline.

Re-checked after the UI owner's fix:

```
> vp check src e2e scripts vite.config.ts playwright.config.ts playwright.integration.config.ts \
          playwright.native.config.ts tsconfig.json index.html package.json
pass: All 70 files are correctly formatted (1064ms, 24 threads)
pass: Found no warnings, lint errors, or type errors in 63 files (718ms, 24 threads)
EXIT=0
```

Owner: UI (fixed). Nothing left for me to do; the image build no longer stops on formatting.

### F2 — RESOLVED: notices and licences are reachable from the real build

Originally the build emitted `THIRD_PARTY_NOTICES.txt` / `THIRD_PARTY_LICENSES.txt` /
`LICENSE.upstream.txt` at the dist root while the backend served an invented
`THIRD_PARTY_NOTICES.md` plus `/dashboard/licenses/*`, so every notice URL 404'd in production, and
`tests/test_sso_static.py` passed only because it fabricated the expected tree.

Now the contract matches on all three sides — build, routes, UI:

* `app/gateway_management.py:284-291` registers exactly the three emitted documents at
  `/dashboard/<name>` and serves them through `root_document(...)` as `text/plain; charset=utf-8`;
  `:293-296` keeps `.md` only as an optional legacy variant.
* `tests/test_sso_static.py:108-128` adds a real-dist class (`REAL_DIST`), asserting every document
  the build actually emits is reachable — the fixture weakness is closed. It ran (not skipped):
  `Ran 10 tests … OK`.
* `web/src/App.tsx:320-321` links `/dashboard/THIRD_PARTY_NOTICES.txt` and
  `/dashboard/THIRD_PARTY_LICENSES.txt` from the footer, so the assets are discoverable, not just
  addressable.

Probe against the real `web/dist` (`check-static-probe.py`):

```
200  /dashboard/THIRD_PARTY_NOTICES.txt         # Third-Party Notices …
200  /dashboard/THIRD_PARTY_LICENSES.txt        agent-base@6.0.2 (MIT) …
200  /dashboard/LICENSE.upstream.txt            MIT License … Copyright (c) 2026 墨菊
404  /dashboard/THIRD_PARTY_NOTICES.md          (legacy only; absent from the real build)
404  /dashboard/licenses/DM-Sans.txt            (no licenses/ dir is emitted)
```

Upstream MIT attribution is preserved in `LICENSE.upstream.txt`. `design.md:19` / `implement.md:41`
("notice assets work through native static hosting") now hold.

Residual, informational only: the `/dashboard/licenses/{asset_path}` mount still exists but has no
source directory in the real build, so it can only ever answer 404 — dead but harmless, and it keeps
working for any future build that emits per-dependency files. `LICENSE.upstream.txt` is served but not
linked in the footer (the notices document covers attribution); linking it too would be cosmetic.

### F3 — MEDIUM: console login sessions do not survive a recreate (docs claimed they did)

Fixed in my files (see §2), recorded here because the wrong claim was user-visible: "Preserve the
data directory to retain login state" is false for the new console. The data directory keeps
accounts, credentials and databases; SSO sessions live in `SSOService.sessions` in memory, so every
recreate/restart/auto-update forces a fresh login. Docs now say exactly that.

### F4 — MEDIUM: host `docker login` does not authenticate the update service

`docker login` writes `~/.docker/config.json` on the host; the updater runs in its own container with
its own filesystem, so the previous wording ("reuse that login for the optional update service") was
wrong and would leave automatic updates silently unable to pull a private image. Upstream
(`docs/advanced-features/private-registries/index.md` of the updater fork) confirms: the container
reads `/config.json` unless `DOCKER_CONFIG` points elsewhere, and the image ships **no** credential
helpers. Docs now provide a `docker-compose.registry.yaml` local override (read-only
`${HOME}/.docker/config.json:/config.json`), warn that the override must only be added while the file
exists (Docker creates a directory for a missing bind-mount source), note `${HOME}` does not expand
on Windows, and explain that a credential helper must exist inside the updater container — otherwise
use a dedicated minimal `{"auths": …}` file. The default Compose file still mounts no credentials.

### F5 — MEDIUM: `:X.Y.Z` tags were documented as immutable

Tags are mutable; re-publishing a release replaces the digest behind the same tag and the updater
then deploys the new digest. The "checks are a no-op because the tag never moves" claim is gone;
docs now recommend a digest pin (`<registry>/codebuddy2api@sha256:<digest>`, from
`docker inspect --format '{{index .RepoDigests 0}}'`) for an absolute freeze, and the rollback
section says to pin the digest (not merely a version tag) before downgrading while the profile runs.

### F6 — MEDIUM: reverse proxy guidance pointed at the wrong knob under SSO

The docs told operators to add their public address to the extra-trusted-management-origins setting
or `CODEBUDDY2API_ADMIN_ORIGINS` / `--admin-allowed-origins`. With console login enabled,
`PUBLIC_ORIGIN` is the only accepted management origin (pC is tightening this), so that advice leads
to a dead end. Both docs now say: forward the original Host/scheme unchanged and correct the proxy
instead of relaxing the check; the extra-origins setting does not apply in console-login mode. The
link to `advanced.md#management-origin--csrf-switch` was removed from these bullets to avoid
overlapping with the main controller's rewrite of `advanced.md` / `clients.md`.

### F7 — MEDIUM: local Python mode cannot use the console, docs implied otherwise

Zero-configuration local startup (no `.env`, generated `cb-…` key) is API-compatible only: the
replacement console has **no** API-key login path — `web/src/App.tsx:89` links only
`SSO_LOGIN_URL` (`/sso/login?return_to=/dashboard/`), and `/sso/*` routes do not exist unless SSO is
enabled. Both docs now state this and give the local recipe
(`CODEBUDDY2API_SSO_ENABLED=true`, `PUBLIC_ORIGIN=http://127.0.0.1:8787`, the OIDC client values,
`ALLOW_INSECURE_LOCALHOST=true`, callback `http://127.0.0.1:8787/sso/callback`).

### F8 — LOW: optional SSO tuning knobs were unreachable from Compose

`app/sso_config.py:165-169` reads `SESSION_TTL_MS`, `SESSION_IDLE_MS`, `TRANSACTION_TTL_MS`,
`MAX_SESSIONS`, `OAUTH_TIMEOUT_MS` from the process environment, but neither `docker-compose.yml`
nor `.env.example` mentioned them, so a Compose deployment could not change them. Added as optional
entries rendering as `""` (`_integer("")` → default), documented in both docs. Verified by the render
assertions and `test_environment_config` (18 OK).

### F9 — LOW: CNB image path example was wrong

`release_tags.resolve_image` derives CNB as `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}`, and
the slug already ends with the repository name. The old example
`docker.cnb.cool/<cnb-slug>/codebuddy2api:latest` would have produced a doubled path. Now
`docker.cnb.cool/<cnb-repo-slug>:latest` with a note, in both docs and `.env.example`.

### F10 — INFO: default image is not anonymously pullable yet

Anonymous GHCR token request for `azurekiln2333/codebuddy2api` returns **403**, and CNB
`/v2/azurekiln/codebuddy2api/tags/list` returns **401**. That is expected before the fork's first
publication, but it means `docker compose pull` with the template default fails on a fresh clone
until the package is published and public (or the operator authenticates). Owner: main
controller/user (publication + package visibility), not a code defect.

### F11 — INFO: stale console copy about the storage whitelist

`web/src/i18n.tsx:15,378` and `web/src/pages/Storage.tsx:38` still ship the "gateway does not
whitelist `/dashboard/storage`" message. The backend now whitelists `storage`
(`app/gateway_management.py:251`), so that branch can no longer trigger. Harmless dead copy; UI
owner may drop it whenever convenient.

---

## 2. Changes I made in this round (my own deploy files only)

| File | Change |
|---|---|
| `docs/deployment.md`, `docs/deployment.zh-CN.md` | Registry-auth rewrite (F4, incl. `docker-compose.registry.yaml` override + credential-helper caveat); recreate no longer promises login retention (F3); digest-vs-tag wording in auto-update and rollback (F5); reverse-proxy bullet reduced to `PUBLIC_ORIGIN` (F6); local-Python console/SSO paragraph (F7); tuning knobs row (F8); CNB path example (F9); removed the duplicated empty `### 构建当前源码` heading in the Chinese file |
| `docker-compose.yml` | Forward the 5 optional SSO tuning knobs (empty by default) |
| `.env.example` | Digest-pin note on `CODEBUDDY2API_IMAGE`; CNB path fix; commented tuning knobs |

Not touched: `app/`, `web/`, `scripts/`, `.github/`, `.cnb.yml`, READMEs, `docs/advanced*.md`,
`docs/clients*.md`, other owners' tests.

---

## 3. What I verified as correct (with method)

### 3.1 OIDC bypass — no bypass found

* `app/sso_config.py:150` — SSO is opt-in and **fail-closed**: when `CODEBUDDY2API_SSO_ENABLED` is
  truthy, `PUBLIC_ORIGIN`/`OIDC_ISSUER`/`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` are mandatory
  (`_secret` raises), origins must be HTTPS except explicit loopback, and `SESSION_IDLE_MS >
  SESSION_TTL_MS` aborts startup.
* `converter.py:4397` — `SSOConfigError` from `runtime_management.initialize` becomes `ap.error(...)`
  **before** any store is opened or a socket is accepted.
* `app/runtime_management.py` — in SSO mode `AdminAuth` is never constructed, `AdminMiddleware` is
  not installed, and the legacy `/admin/session` routes are not registered; `install_admin(...,
  sso=service)` installs `SSOAdminMiddleware` instead. A stale `cb_admin_session` cookie is therefore
  inert.
* `app/admin_api.py` — every `auth.*` use is inside the non-SSO branch; the log-clear `scope ==
  "all"` path no longer reads `api_key` in SSO mode; `oauth_dispatch` keys tasks on
  `request.state.admin_identity`, which SSO sets to `"sso:" + sub`, so cross-session task theft is
  not possible.
* `app/sso_auth.py` — `/admin/*` is guarded for every method, `/admin/session` is rejected as a
  boundary (405/404), POST requires the CSRF token from the SSO session, `no-store` is applied, and
  there is no API-key fallback in SSO mode.
* `app/sso_oidc.py` — discovery/JWKS URLs are origin-checked, redirects are not followed, `alg` must
  be `RS256`, issuer/audience/`azp`/nonce/`exp` are validated, errors are fixed strings with no
  secrets, and JWKS refetch is cooldown-limited (30 s) with a 600 s cache.
* `app/request_target.py` — raw ASGI path validation is installed **last** (outermost), rejects
  `//`, `.`/`..`, `%` (outside the model-ID window), `;`, backslash and NUL, so
  `/admin/%73ession`-style normalisation tricks cannot reach a route.

### 3.2 Static fallback — pages only, no swallow

`install_pages` registers `/dashboard`, `/dashboard/{page:path}`, `/dashboard/assets/{...}`,
`/dashboard/licenses/{...}`, the three build documents and the legacy notices route. It **does** end
with a catch-all — `page_fallback` on `/{path:path}` for `GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS`
(`app/gateway_management.py:315-321`) — which is exactly why the exclusion list matters:
`v1`, `admin`, `health`, `sso`, `cn/v1`, `intl/v1`, and any path carrying a suffix answer `404` JSON,
and only suffix-free unknown pages redirect `302` to `/dashboard`. Verified against the real `dist`:

```
404  /sso/login   /sso/nope   /sso   /admin   /admin/nope   /health   /v1/x   /whatever.js   /cn/v1/models
302  /whatever
200  /openapi.json        (FastAPI's own route wins over the fallback)
```

(`/sso/login` is `404` in that probe only because the probe installs the page routes without the SSO
router; in the real app the `/sso/*` routes are registered first and win. The point of the probe is
that the fallback no longer redirects or returns HTML for the `sso` prefix — the `sso` entry in the
exclusion set is the fix.)

Page whitelist `{"", models, credentials, logs, settings, storage, login}` matches the UI router
exactly (`web/src/App.tsx:402-413`), unknown pages redirect only when suffix-free, `assets`/`licenses`
prefixes never fall back to the shell, and `contained_static` rejects NUL, backslash, `..`,
directory indexes and empty names. Verified live against the real `dist` (`/dashboard/`,
`/dashboard/storage` → 200; `/dashboard/assets/missing.js` → 404).

### 3.3 Compose defaults and auto-update scope

Covered by §0 (35/35 assertions) plus `tests/test_deployment.py` (16 OK, 1 skip). Default render is
pull-only, `init: true`, `restart: unless-stopped`, json-file `10m×3`, loopback port, `/data/auth`
bind mount, `container_name: codebuddy2api`. Auto-update is profile-gated, label-scoped
(`WATCHTOWER_LABEL_ENABLE`), pinned to `nickfedor/watchtower:1.23.2`, never updates itself, and
`${COMPOSE_PROJECT_NAME:-codebuddy2api}` demonstrably resolves to the effective project name
(`-p alpha` → scope `alpha`), so two stacks cannot cross-select.

### 3.4 Image vs release contract

* Release archive built from the current tree (`python scripts/package.py --output <temp> --tag
  v1.3.5`, 164 files) contains every input the Dockerfile needs: `requirements.txt`, `VERSION`,
  `converter.py`, `app/*.py`, `app/adapters/*.py`, `web/package.json`, `web/pnpm-lock.yaml`,
  `web/src` (47), `web/e2e` (12), `web/scripts`, `web/vite.config.ts`, `web/tsconfig.json`,
  `web/LICENSE.upstream`, `web/THIRD_PARTY_NOTICES.md`, `web/dist` (6, the compiled console),
  `docs/nginx.example.conf`, both compose files and `.env.example`; no `node_modules`, no `.tmp-*`.
* `.dockerignore` re-includes exactly `app/*.py`, `app/adapters/*.py`, `!web/**` (minus
  `node_modules`, `dist`, `test-results`, `.tmp-*`), and `app/` holds no other module directory — so
  `COPY app/` cannot miss a module, and the notice sources the frontend stage needs are present.
* `web/dist` is in the archive but excluded from the build context, so the image rebuilds the console
  instead of shipping a stale bundle. One normal build path, no source-missing bypass.
* Registry/tag derivation is platform-driven (`scripts/release_tags.py`): `ghcr.io/<lowercased
  github.repository>` and `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}`; no upstream author
  string remains in Docker/CI/product files (`grep maiphucgiang` → 0 hits). Workflows publish
  `linux/amd64,linux/arm64`; `check_version.py --check-compose` accepts the `:latest` default.

### 3.5 Lost functionality

None found. The UI router exposes the same six management pages plus `storage`; every pre-existing
component is still imported (`Buddy`, `Travel`, `Trial`, `OAuth` via `Credentials.tsx`;
`UsageOverview`, `Trend` via `Dashboard.tsx`), so no panel was dropped. API surface used by the
console (`/admin`, `/sso` axios bases) matches the backend routes.

### 3.6 Test evidence (this host, `PYTHONUTF8=1`)

| Suite | Result |
|---|---|
| `scripts/run_backend_tests.py` | **74/80** scripts pass |
| `tests/test_deployment.py` | 16 OK (1 skip: needs a `docker` binary) |
| `tests/test_environment_config.py` | 18 OK (2 skip: need `docker`) |
| `tests/test_version.py` / `test_build_lock.py` | 9 OK / 5 OK |
| `tests/test_sso_static.py` / `test_sso_auth.py` / `test_sso_oidc.py` | 10 / 19 / 18 OK |
| `tests/test_release_package.py` / `_pipeline` / `_tags` | 17 / 24 / 16 OK |
| `web`: `pnpm run test` | 18 files, 179 tests pass |
| `web`: `pnpm run build` | succeeds (`dist/index.html`, 106 modules) |
| `web`: `pnpm run check` | passes — F1 resolved |
| `check-compose-assert.py` | 35/35 assertions, 0 failures |
| `check-doc-links.py` | 12 files, 92 links, 0 broken |

The 6 failing backend scripts (`test_audit_store`, `test_control_store`, `test_model_site_blocks`,
`test_realtime_streaming`, `test_trial_integration`, `test_trial_rewards`) are **pre-existing
Windows-only failures**, not regressions: each was re-run against a pristine `git archive HEAD` tree
in a temp directory and produced the identical failure set — `0o600 != 0o666` mode assertions,
`WinError 32` on unlinking an open SQLite file, and a directory-fsync `OSError` that Windows cannot
raise. They pass on Linux CI.

One `test_release_package` failure appeared once in a long batch and never reproduced in 7 later
runs; it coincided with `pnpm run test`/`build` rewriting `web/dist` and `web/public` in parallel.
Practical rule: do not run the frontend build concurrently with the backend suite.

---

## 4. Not verifiable here

* Image build, `HEALTHCHECK` behaviour, `init`, and multi-arch publication — no Docker engine on this
  host. Everything about the image is static review plus `compose config` only.
* Real OIDC round trip against a live IdP (mock-IdP coverage exists in `test_sso_*`).
* Whether `ghcr.io/azurekiln2333/codebuddy2api:latest` is public (F10).

## 5. Open items for the owners

1. ~~**UI**: fix the `App.tsx` formatting so `vp check` passes (unblocks the image build, F1).~~
   **Closed** — `pnpm run check` exits 0.
2. ~~**UI + backend**: agree on the notice/licence asset contract and make the real build satisfy it
   (F2); strengthen `test_sso_static.py` so it uses real build output.~~ **Closed** — routes serve the
   three emitted `.txt` documents, the footer links them, and `test_sso_static.py` now has a
   real-dist class.
3. **Main**: confirm the final `CODEBUDDY2API_*` env list; any new name must appear in
   `.env.example` or `test_environment_config` fails.
4. **Main/user**: publish the fork image publicly (or document mandatory authentication) before
   advertising `docker compose pull` with the template default (F10).

---

## 6. Final status (closing review)

Narrow re-check requested by the main controller: F1/F2 plus the cross items they imply. No full
suite re-run, no edits to other owners' files.

| Item | Status | Evidence |
|---|---|---|
| F1 image build gate | **RESOLVED** | `pnpm run check` → `EXIT=0`, "All 70 files are correctly formatted", "no warnings, lint errors, or type errors in 63 files" |
| F2 notices/licences | **RESOLVED** | real-dist probe: three `.txt` documents `200`; backend registers exactly those names (`gateway_management.py:284-291`); footer links them (`App.tsx:320-321`); `test_sso_static` 10 tests OK incl. the real-dist class |
| `sso` prefix in the page fallback | **RESOLVED** | `/sso`, `/sso/nope`, `/sso/login` (pages-only probe) all `404`, no redirect, no shell; `page_fallback` excludes `v1/admin/health/sso` + `cn/v1`/`intl/v1` + suffixed paths |
| SSO origin tightening vs my docs | **CONSISTENT** | `sso_auth.py:170-172,349-352`: only exact `PUBLIC_ORIGIN` (+ same-origin `Referer`, Fetch Metadata refused); the legacy `admin_allowed_origins` list is never consulted — matches the corrected reverse-proxy wording |
| Compose renders (main's own run) | **PASSED** | default without build/updater, profile with both services, build opt-out, `-p alpha` scope — independently reproduced by the main controller |
| Native SSO browser tests | **PASSED** | run independently by the main controller |
| My deploy files | **UNCHANGED** | `git diff --stat`: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `.env.example`, both `docs/deployment*`, `tests/test_deployment.py` (+539/−59) plus untracked `docker-compose.build.yaml`, `docs/nginx.example.conf`; nobody else touched them |

Correction to this document: the earlier §3.2 claim "there is no catch-all" was factually wrong.
`page_fallback` is a catch-all over `/{path:path}` for all methods; the security property comes from
its exclusion list (`v1`, `admin`, `health`, `sso`, `cn/v1`, `intl/v1`, any suffixed path), not from
its absence. §3.2 now describes the real mechanism and the probe output that proves it.

Remaining, all informational or owned elsewhere — none blocking:

* `/dashboard/licenses/{asset_path}` is a mount with no source directory in the real build (always
  404, harmless); `LICENSE.upstream.txt` is served but not footer-linked.
* F10: the template default image is not anonymously resolvable yet (GHCR 403 / CNB 401) until the
  fork's first public publication.
* F11: the stale "gateway does not whitelist `/dashboard/storage`" copy — the main controller reports
  the UI owner finished the footer/storage wording in the last pass; not re-verified here.
* Image build, `HEALTHCHECK` behaviour, `init` and multi-arch publication remain unverifiable on this
  host (no Docker engine).

**Conclusion: no blocking findings remain in the areas this review owned.** The only pending input is
the main controller's final lint result; if that comes back clean, this review can be closed and the
task archived. I made no further changes in this round beyond this document.

Main-controller closure (2026-10-26): the exact Docker frontend `vp check` gate passed;
179 unit tests, 44 default browser tests and 2 native browser tests passed. Final
archive checksum/content and the extracted application's native login/write/logout
smoke also passed. Review closed; see `acceptance.md` for counts and engine/remote
execution limits.
