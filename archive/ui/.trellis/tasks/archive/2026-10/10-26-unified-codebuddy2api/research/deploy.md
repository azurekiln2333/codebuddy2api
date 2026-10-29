# Research: single-image delivery, pull-only Compose, scoped auto-update

Owner: Docker / auto-update (this doc). Read-only research; no product code changed.
Upstream coordination (backend merge, gateway code) belongs to the main coordinator.

Status: evidence-backed where marked **[verified]**; everything else is **[proposal]** or **[unverified]**.

---

## 1. What exists today

### 1.1 Target repo `D:\My2KProjects\codebuddy2api` (Python FastAPI gateway + own WebUI)

**[verified]** by reading `Dockerfile`, `docker-compose.yml`, `.env.example`, `docs/deployment.zh-CN.md`,
`.github/workflows/docker.yml`, `.dockerignore`, `VERSION` (=1.3.5), `app/`, `web/`.

| Area | Current state |
|---|---|
| Image build | Multi-stage: `node:24.21.0-bookworm-slim` + pinned `vp` (vite-plus 0.3.1) builds `web/` -> `dist`, then `python:3.12-slim` runtime. Digest-pinned base images, `pip --require-hashes --only-binary`. amd64+arm64 via buildx. |
| Registry | `ghcr.io/maiphucgiang/codebuddy2api`. Tags from metadata-action: `edge` (main), `sha-<sha>`, semver `X.Y.Z` / `X.Y` / `X`, plus `latest=auto` (metadata-action default `latest=auto` flips `latest` only on non-prerelease semver, `=== false` on main pushes). |
| CI | `.github/workflows/docker.yml`: `test` (pytest via `tests/test_*.py`) -> `web` (vp check/test/build + Playwright) -> `image` (buildx multi-arch, gha cache, provenance min, sbom). `check_version.py` gates VERSION vs tag. |
| Compose | Single service `codebuddy2api`, **both** `image:` and `build: .` present, `container_name: codebuddy2api`, `restart: unless-stopped`, host bind `${CODEBUDDY2API_BIND:-127.0.0.1}:${CODEBUDDY2API_PORT:-8787}:8787`, single bind mount `./auth:/data/auth`, `command:` overrides CMD with `--desensitize`. No `healthcheck`, no `labels`, no `init`, no logging limits, no `pull_policy`. |
| Container listener | Always `0.0.0.0:8787` (Dockerfile ENV `CODEBUDDY2API_ALLOW_OPEN_NOAUTH=true` lets the 0.0.0.0 guard pass). Host exposure is only the port mapping. |
| Health | `GET /health` -> `{"status":"ok"}` (liveness only, documented as not meaning accounts/models work). No Dockerfile `HEALTHCHECK`. |
| Data | Everything under `CODEBUDDY_AUTH_DIR` (`/data/auth`): credentials + `control.sqlite3` + `logs.sqlite3` (+ `imports/`). Docs: mount the whole dir, single writer, never share between instances, back up before upgrade. Old versions cannot read a newer control DB -> **downgrade needs stopping + restoring a matching backup**. |
| Image-readiness of the tree | `.dockerignore` allow-list already excludes `tests/`, `docs/`, `examples/`, `scripts/`, `.env`, git metadata. |

### 1.2 UI repo `D:\My2KProjects\codebuddy2api-ui` (this repo)

**[verified]** No `Dockerfile`, no compose, no image, no CI workflow. Pure static SPA (`vp build` -> `dist/`, base path `/dashboard/`), served by a same-origin gateway that owns `/sso/*` and `/admin/*`. `dist/` exists locally (index.html + assets + license notices). Its `docs/deployment.md` describes host-side serving only.

### 1.3 OAuth2 gateway `D:\My2KProjects\codebuddy2api-oauth-gateway`

**[verified]** Node 22 + `jose`, own `Dockerfile` (non-root uid 10001, `HEALTHCHECK` on `/healthz`), own `compose.yaml` with 3 services (`upstream` + `gateway` + `nginx`), 3 networks (`private` `internal: true`, `edge`, `egress`), no published port for 8787/8788, `upstream-auth` named volume. UI is mounted read-only from an **external** build (`UI_DIST` -> `/opt/ui/dist`, `UI_STATIC_DIR`).
This 3-service, 3-network, external-UI-artifact topology is exactly what "one 二开 project" must collapse.

### 1.4 Reference panel `D:\My2KProjects\cnb2api-panel` (the Compose pattern to port)

**[verified]** by reading `docker-compose.yaml`, `docker-compose.build.yaml`, `.env.example`, `Dockerfile`, `.cnb.yml`, `nginx.conf`.

- Base `docker-compose.yaml`: `image: "${PANEL_IMAGE:-docker.cnb.cool/azurekiln/cnb2api-panel:latest}"`, **no `build:`**, `init: true`, `env_file: .env`, `restart: unless-stopped`, loopback-only port `${PANEL_BIND_HOST:-127.0.0.1}:${PANEL_PORT:-9002}:9002`, `./data` + `./logs` bind mounts, `logging: json-file` with `max-size: 10m`/`max-file: "3"`, labels `com.centurylinklabs.watchtower.enable: "true"` and `.scope: "${COMPOSE_PROJECT_NAME:-cnb2api-panel}"`.
- Override `docker-compose.build.yaml`: `image: cnb2api-panel:local`, `pull_policy: build`, `build:` block, **and `com.centurylinklabs.watchtower.enable: "false"`** so a locally built image is never auto-replaced; `watchtower` gets `profiles: [auto-update]`.
- Watchtower service in the base file: `nickfedor/watchtower:1.23.2` (pinned), `WATCHTOWER_LABEL_ENABLE=true`, `WATCHTOWER_SCOPE=${COMPOSE_PROJECT_NAME:-cnb2api-panel}`, `WATCHTOWER_POLL_INTERVAL=600`, `WATCHTOWER_CLEANUP=true`, docker socket mount, and **self-label `enable: "false"`** so it never updates itself.
- Dockerfile has a real `HEALTHCHECK` (`fetch` on `/` with `AbortSignal.timeout`).
- `.cnb.yml` publishes `docker.cnb.cool/azurekiln/cnb2api-panel:<vX.Y.Z>` + `:latest` (prerelease skips `latest`).

---

## 2. Official-source check: Watchtower and Docker today

**[verified via GitHub API, 2026-10-26]**

| Fact | Evidence |
|---|---|
| `containrrr/watchtower` is **archived** (`archived: true`, last push 2025-12-17). Last Docker Hub image `1.7.1` (2023-11-11). | GitHub API + Docker Hub tags |
| Live fork: **`nicholas-fedor/watchtower`** (4.7k stars, pushed 2026-10-25). Images on Docker Hub as **`nickfedor/watchtower`**. | GitHub API, Docker Hub `nickfedor/watchtower` |
| Latest stable release **v1.23.2** (2026-10-22); Docker Hub `nickfedor/watchtower:1.23.2` exists (digest `sha256:62fb9113…a6` for the amd64-ish index tag list). Multi-arch: amd64, i386, armhf, arm64v8, riscv64. | GitHub releases + Docker Hub |
| Upstream's own README: *"We do **not** recommend using Watchtower in a commercial or production environment"*, recommends Kubernetes+CI/CD for that. Tested against Docker >= 1.43, auto-negotiates API version. | README `main` |
| **Label namespace is unchanged from the original project**: `com.centurylinklabs.watchtower` prefix, including `.enable`, `.scope`, `.monitor-only`, `.no-pull`, `.depends-on`, `.container-chain`, plus lifecycle labels `.lifecycle.pre-check`, `.post-check`, `.pre-update`, `.post-update`, `.pre-update-timeout`, `.post-update-timeout`, `.uid`, `.gid`, and `.cooldown-delay`. | `internal/container/labels/labels.go` |
| Docs site is `https://watchtower.nickfedor.com/` (TLS handshake failed from this host today; **not** re-verified here). Env vars `WATCHTOWER_LABEL_ENABLE`, `WATCHTOWER_SCOPE`, `WATCHTOWER_POLL_INTERVAL`, `WATCHTOWER_CLEANUP`, `WATCHTOWER_ROLLING_RESTART`, `WATCHTOWER_NOTIFICATIONS*` are the long-standing names and are proven in `cnb2api-panel`, but I could not re-read the env-var reference page in this session — confirm the exact spelling at implementation time. | partially unverified |

**Consequences for us**

1. Do **not** use `containrrr/watchtower` (dead since 2023, 1.7.1 has no lifecycle hooks, no modern Docker compat). Use the fork, pinned by version.
2. The **legacy `com.centurylinklabs.watchtower.*` labels still work** on the fork — so the panel's label contract can be copied verbatim; no new label namespace to learn or migrate.
3. Because labels default-on semantics are dangerous (`LABEL_ENABLE=true` = *only* labeled containers, which is what we want), pin both `enable` and `scope` on every service, **including the updater itself**.
4. Watchtower is explicitly "not for production". This is a single-operator homelab-style deployment, which matches, but it means: keep it opt-in (a profile), never the only upgrade path, and always document the manual `pull`/rollback path.
5. Lifecycle labels (`lifecycle.pre-check`, `cooldown-delay`) and `WATCHTOWER_ROLLING_RESTART` are the levers we need for "restart health check" and "don't flap". Details to be confirmed during implementation.

Docker/Compose side **[verified from Compose spec usage already in this repo family]**: `pull_policy` accepts `always|never|missing|build`, `depends_on: condition: service_healthy` requires a `healthcheck`, `profiles` hides a service unless its profile is requested, `init: true` for PID-1 reaping, `logging` driver limits, per-service `labels`. `version:` in `docker-compose.yml` is obsolete in Compose v2 and should be dropped when we touch the file.

---

## 3. Proposal — one application image, one project

### 3.1 Collapse OAuth2 into the Python app (hand-off, not mine to implement)

The merged app must expose, from **one process on one port**:
`/dashboard/` (UI static), `/sso/*`, `/admin/*`, `/v1/*`, `/health`.
Today the UI in this repo talks to `/sso/*` + `/admin/*` (see `docs/gateway-contract.md`) and the Python app already serves `web/dist` + `/admin/*` + `/v1/*`.
**Dependency for deploy work:** the merged app must (a) serve the UI at `/dashboard/` with SPA fallback excluding `/sso` and `/admin`, (b) expose a `GET /health` that stays cheap and returns 200 only when the app is accepting requests, and (c) keep `/v1/*` streaming unbuffered. Everything below assumes that; the gateway code merge and OIDC config names are the backend/gateway owner's call.

Until that lands, the deploy artifacts must not regress: keep the current `docker-compose.yml` working on the current image.

### 3.2 Image: one tag set, two registries, both from the same CI run

| Item | Proposal |
|---|---|
| Name | `ghcr.io/maiphucgiang/codebuddy2api` (existing) + mirror `docker.cnb.cool/azurekiln/codebuddy2api` (CNB, mirroring `cnb2api-panel`'s `.cnb.yml`). Same digests, both published from the same commit. |
| Tags | `X.Y.Z` (immutable, the recommended default), `X.Y`, `X`, `latest` (stable only), `edge` (main only). Exactly the current semantics — do not invent a new scheme. |
| Default for the Compose template | **`ghcr.io/maiphucgiang/codebuddy2api:latest`** (pull-only). It is the registry that already has multi-arch + SBOM and is referenced by the current README. CNB becomes the mirror for mainland/CNB users, documented as `CODEBUDDY2API_IMAGE=docker.cnb.cool/azurekiln/codebuddy2api:latest`. |
| What `latest` means for auto-update | Must be safe to follow blindly. Today `latest` is stable-only, good. Keep the rule: never publish `latest` from a prerelease/multi-arch-less build. |
| UI inside the image | UI is compiled **inside** the image (already true: `frontend` stage copies `web/`). No runtime mount, no external `UI_DIST`. This is the single biggest simplification vs the gateway's 3-service compose. |
| Healthcheck in image | Add `HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3` hitting `/health` with a Python one-liner (no curl in slim image, no new package). `start-period` must cover SQLite migration on first boot. |
| Non-root | Optional follow-up: `useradd` + `chown /data/auth`, mirroring the gateway image. **Risk:** existing bind mount `./auth` is root-owned on the host; switching users would break upgrades. Treat as separate decision, not bundled with the delivery change. |

### 3.3 `docker-compose.yml` — pull-only default (no `build:`)

Delete `build: .` from the base file. `build:` is what silently turns `docker compose up` into "compile here" and what makes Watchtower's baseline meaningless. Consequences and mitigations:

- Base file: `image:` only, `pull_policy: always` **not** set (leave default `missing` so a stopped host does not need the network; Watchtower does the polling).
- Add `init: true`, `logging` limits (10m x3), `labels` (`enable` + `scope`), `healthcheck` inherited from image (`depends_on`-free single service anyway).
- Keep `container_name: codebuddy2api` (operator-facing docs and `docker exec … login` depend on it) but note it blocks `scale:`/rolling restart; a rename is a separate decision.
- Add `env_file: .env` **or** keep the explicit `environment:` block. Keep the explicit block: it documents every supported knob and `.env` only interpolates. Add nothing that changes existing behaviour.
- Keep `command:` override? Currently the base overrides CMD to add `--desensitize`. Prefer moving that into the image CMD/ENV so the compose file stops encoding app flags; until then, keep the override to avoid a behaviour change.
- Add a `watchtower` service **gated behind a profile** (`profiles: [auto-update]`) with the 1.23.2 pin, `LABEL_ENABLE`, `SCOPE=${COMPOSE_PROJECT_NAME:-codebuddy2api}`, `POLL_INTERVAL`, `CLEANUP`, socket mount, `enable: "false"` self-label, and its own logging limits. Default `docker compose up -d` then starts **only** the app.
- Structured `deploy/nginx.conf` example (port of the gateway's, single upstream `127.0.0.1:8787`, unbuffered `/v1/*`, `$request_method $uri` log format that drops `code`/`state` from `/sso/callback`) — keep it out of the required path.

### 3.4 `docker-compose.build.yaml` — local build override (never auto-updated)

Port the panel's pattern exactly:

```yaml
services:
  codebuddy2api:
    image: codebuddy2api:local
    pull_policy: build
    build:
      context: .
      dockerfile: Dockerfile
    labels:
      com.centurylinklabs.watchtower.enable: "false"
  watchtower:
    profiles: [auto-update, never]   # effectively: no auto-update for local builds
```

Usage `docker compose -f docker-compose.yml -f docker-compose.build.yaml up -d --build`. Note `pull_policy: build` is Compose v2 syntax and requires the `build:` block, which is why the override file exists at all.

### 3.5 Data, restart health, rollback

| Concern | Proposal |
|---|---|
| Persistence | Keep the single bind mount `${CODEBUDDY2API_AUTH_PATH:-./auth}:/data/auth`. **Do not** introduce a named volume by default: the documented workflow is "back up the directory", and a named volume hides it from operators. Keep docs saying "mount the whole dir, one writer only". |
| Pre-update backup | Documented, not automated in v1: `docker compose stop && tar czf auth-$(date +%F).tgz auth`. Optionally a `lifecycle.pre-check`/pre-update hook later — needs verification before commitment. |
| Restart health | Image `HEALTHCHECK` + `restart: unless-stopped` + `start-period` covering first-boot migration. Watchtower recreates the container, it does not run the healthcheck for us. |
| Auto-update safety rail | `WATCHTOWER_ROLLING_RESTART` is meaningless for 1 replica. The real rail is **pin `X.Y.Z` in `.env` for anyone who cares**, and keep `latest` stable-only. Document that pinning the tag turns auto-update into "notify-only" behaviour. |
| Rollback | Documented procedure: set `CODEBUDDY2API_IMAGE=…:X.Y.Z` (previous), `docker compose pull && docker compose up -d --no-build`. **Schema caveat:** the control DB migrates forward; a downgrade needs a matching pre-upgrade backup and a stopped instance (already stated in `docs/deployment.zh-CN.md`). Auto-update must therefore never be enabled silently on a host with no backup. |
| Platform note | amd64 + arm64 both published -> keep buildx platforms in CI; Watchtower pulls the host arch automatically. |

### 3.6 Risks / open questions

1. **Watchtower is "not recommended for production" by its own upstream**, and the successor is a community fork with a single primary maintainer. Mitigation: profile-gated, version-pinned, label-scoped, plus the documented manual pull path. Alternative to evaluate if that risk is unacceptable: `cron`/systemd-timer `docker compose pull && up -d` with a Smoketest, or a notify-only agent (Diun/WUD). Do not decide this unilaterally.
2. **Scope/label correctness is the whole safety story.** If `scope` mismatches, the updater either does nothing or (without `LABEL_ENABLE`) touches everything on the host including other panels. Must be verified on a `docker compose config` render before merging, and by checking `docker inspect` labels after `up`.
3. **`COMPOSE_PROJECT_NAME` dependency.** Both files key `scope` off it; a user running `-p something` silently changes the scope. Prefer a **fixed literal scope** `codebuddy2api` and not an interpolated project name — divergence from the panel is deliberate and should be called out in the doc.
4. **Docker socket mount = root-equivalent on the host.** Unavoidable for the updater. Must be explicit in README and must never be reachable from the app port.
5. **`container_name` + Watchtower** is fine, but it prevents any future rolling/scaled deploy; and `--no-build` behaviour of `docker compose up` changes for anyone with a stale local image — the README/upgrade docs must switch to `pull` then `up -d --no-build`.
6. **Same auth dir shared across versions is forbidden** (docs already say so). A Watchtower update while a second instance runs elsewhere on the same dir corrupts state. Nothing in Compose can prevent this; docs + `container_name` are the guard.
7. **CI/registry still unset for the merged repo**: the merge target's `docker.yml` is `ghcr.io/maiphucgiang/...`. If the 二开 fork moves to a different GitHub org **and** a CNB repo, both `metadata-action images:` and `.cnb.yml`'s `CNB_IMAGE` must change in the same PR. Also `scripts/check_version.py` must keep gating `VERSION` ↔ tag.
8. **UI removal ordering.** Dropping the separate UI repo/image is only safe once the merged image serves `/dashboard/` from its own build stage. Sequence: merged image builds UI in-stage -> CI publishes `X.Y.Z` -> base compose switches to pull-only -> only then archive `codebuddy2api-ui` and the gateway repo.
9. **Unverified today**: the fork's exact env-var reference page (TLS failure) and whether `WATCHTOWER_ROLLING_RESTART` / lifecycle timeouts are spelled exactly as I listed. Verify before writing them into a shipped compose file.
10. **Healthcheck semantics**: `/health` is liveness only. Nothing in the deploy layer can assert "accounts/models work". Do not let auto-update be sold as "verified healthy after restart" — it is "container came back".

---

## 4. Concrete file-level diff plan (for the implement phase, after main coordinator's go-ahead)

| File | Change |
|---|---|
| `Dockerfile` | add `HEALTHCHECK` against `/health`; consider moving `--desensitize` into CMD; (separately) non-root. |
| `docker-compose.yml` | drop `version:` and `build:`; add `image` default pointing at the registry tag; add `init`, `logging`, `labels` (`enable`, fixed-`scope`), propagate `healthcheck`; add `watchtower` service under `profiles: [auto-update]`. |
| `docker-compose.build.yaml` | new; local-build override with `pull_policy: build` and `watchtower.enable: "false"`. |
| `.env.example` | add `CODEBUDDY2API_IMAGE=<registry>:<version>`, `CODEBUDDY2API_BIND_HOST`, `WATCHTOWER_POLL_INTERVAL`; keep everything else. |
| `docs/deployment*.md` | pull-only quick start, auto-update opt-in, pin-to-disable, rollback with schema caveat, backup-first rule. |
| `.github/workflows/docker.yml` / `.cnb.yml` | second registry + prerelease `latest` guard (verify `latest=auto` behaviour), keep multi-arch. |
| `deploy/nginx.conf` (+ example) | single-upstream, unbuffered `/v1/*`, log format without `$request_uri` for `/sso/`. |

No changes made in this research phase.
