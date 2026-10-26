# Unified application design

## Change boundary

The behavior gap is that the backend, replacement UI and OIDC gateway currently require separate repositories and runtime composition. The target is one backend repository, one application process, one image and one public listener. Product changes belong to `D:/My2KProjects/codebuddy2api`. The current UI repository holds coordination artifacts and remains a migration source.

The user's consolidation request supersedes the older frontend spec's restriction that the original backend is read-only. Existing inference, credential enrollment, data schemas and management operations remain authoritative. Do not copy local secrets, data, archives, build directories or agent configuration between repositories.

## Application architecture

Use FastAPI as the sole runtime. Build the replacement React UI in `web/` and serve it from the existing static-page integration. Port the Node gateway's OIDC contracts into Python modules; do not ship a second application server or internal admin proxy.

| Public surface | Owner | Contract |
| --- | --- | --- |
| `/sso/login`, `/sso/callback` | New native SSO modules | Confidential authorization code + S256 PKCE, browser-bound one-use state and nonce, verified ID token, safe dashboard return target. |
| `/sso/session`, `/sso/logout` | New native SSO modules | Existing UI response shapes; opaque HttpOnly session cookie, in-memory CSRF, POST logout, anonymous 401 versus authorization-denied 403. |
| `/admin/*` | Existing admin routes plus SSO-aware authentication boundary | Require a current authorized SSO identity in SSO mode. Preserve per-request live UserInfo checks, CSRF on mutations and enrollment polling, and exact full-log-clear confirmation. No public API-key fallback in SSO mode. |
| `/v1/*` | Existing inference middleware | Preserve caller API-key authorization and streaming. Console cookies do not authorize inference. |
| `/dashboard/*` | Existing page installer, updated for new UI assets/routes | Same-origin SPA, including storage and legal notices; APIs never fall back to HTML; static files remain contained. |
| `/health` | Existing backend | Cheap application liveness for the image health check. |

### OIDC and session details

Keep `PUBLIC_ORIGIN`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REFRESH`, and explicit loopback-development opt-in recognizable from the existing deployment. Centralize parsing in a native config module. Production Compose explicitly selects SSO mode and requires complete configuration. Native legacy API operation may retain its existing non-SSO behavior for regression compatibility; it must not become a bypass once SSO mode is enabled.

Use a maintained JOSE library (`PyJWT[crypto]`) for RS256 cryptography and the existing `httpx` transport for bounded discovery, JWKS, token and UserInfo requests. Pin the resolved dependencies in the existing lock/export workflow. Avoid library-owned unbounded network fetches. Validate exact issuer, audience, authorized party, expiration, issued-at, nonce, and subject; restrict discovered endpoints to the issuer origin and never follow redirects with credentials.

Authorization follows the existing gateway's live UserInfo contract: subject matches the login identity, `role` is `admin`, and `isAdmin` is true. Refresh is opt-in and serialized per session. Every asynchronous completion rechecks session liveness so logout/revocation wins races. Stores are bounded and in-memory, with absolute and idle expiry; restart requires a new login, matching the gateway's existing behavior. Keep a single Uvicorn worker.

Use a distinct root-path SSO cookie, preserving secure/HttpOnly/SameSite behavior. Do not expose the legacy admin-session cookie to browsers in SSO mode. Port raw-request-path protections where they remain relevant at the ASGI boundary, preserving legal slash/colon/@ model IDs. Return fixed secret-free errors.

## UI migration and reference fidelity

Replace the old tracked `web/` UI with the current replacement application's source, tests, configuration and notice-build support. The reference is the panel's observable design; implement it in React/SCSS using this project's own components.

Adopt the reference's two-column login composition, brand placement, restrained network illustration, SSO primary action, theme control, responsive stacking, and branded horizontal connecting screen with the exact Chinese text `正在连接控制台`. Preserve i18n, accessible names, status announcements, reduced motion and retry/forbidden/logout behavior.

Apply the reference console shell geometry, navigation grouping, colors, borders, spacing and surface treatment to the existing management pages. Reference targets include a 52px header, 180px expanded sidebar, 64px collapsed sidebar, blue `#3169df` accent and a 12px control-radius scale. Treat older New API-derived geometry as superseded by the user's current reference request. Keep Chinese-capable system fonts and existing component/icon infrastructure unless rendered comparison proves a missing asset is necessary. Preserve all six management pages and their real data flows. Do not replace features with static mock data.

Retain upstream MIT notices and complete dependency licenses. Do not import Vue business components, the panel's key-login flow, or the entire panel stylesheet. Record design provenance and keep the resulting implementation/attribution consistent.

## Delivery contracts

Keep `VERSION` as the authoritative application version and synchronize existing package metadata through one validation helper. A `v<version>` tag triggers an automatic release, archive plus SHA-256, and container publication after validation. Stable releases advance `latest`; prereleases do not. Main-branch validation can retain `edge`. PRs validate without publication or publishing credentials.

GitHub publishes to a lowercased `ghcr.io/<current repository>` derived from workflow context. CNB derives its registry/repository from documented platform variables, with explicit override variables supported. Never default publication to the upstream author's repository. Both platforms call shared repository scripts for version validation, tests and packaging where feasible, rather than independently implementing package contents.

The release archive includes backend source, compiled new UI, UI source and lockfile, dependency manifests, deployment templates, documentation and notices. Including the web sources keeps the archive buildable by the same Dockerfile without a separate build branch. An explicit file allowlist excludes `.env`, credentials, SQLite files, local archives, `.git`, dependencies and agent/runtime state. Re-running a release must be safe; it must not mark incomplete artifacts as a successful release. Multi-architecture application images should preserve the existing amd64/arm64 support.

Use the same tested tag resolver on both platforms: stable releases publish `vX.Y.Z`, `X.Y.Z`, `X.Y`, `X`, an immutable commit tag and `latest`; prereleases publish their exact version and commit tags without moving stable aliases. `check_version.py` must accept and validate prereleases rather than silently reducing the requirement to stable-only. CNB's documented default image is `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}`. Keep validation before image/release publication inside the CNB pipeline; do not copy the reference's independent ungated image pipeline.

## Deployment contracts

The base `docker-compose.yml` contains an application `image`, never `build`. Use an explicit fork image setting in `.env.example` and document GHCR/CNB choices. Ship `docker-compose.build.yaml` for local builds, disabling automatic updates of that local image. Keep the application's existing host bind/port names and complete `/data/auth` bind mount to preserve credentials and SQLite/WAL data.

Add the image health check using Python's standard library, init, restart policy and bounded logs. The optional update service uses the maintained pinned Watchtower fork with both label-enable and matching project scope. Only the application is enabled; the updater cannot update itself. Enable automatic updates with the documented `auto-update` Compose profile; manual deployment remains `pull` then `up -d --no-build`. Use the resolved Compose project identity for scope so different deployments are isolated. Do not claim automatic application rollback from an image liveness check.

Document stable tracking versus version pinning, registry login when required, disabling the updater, backup/update and restoring a matching data backup when downgrading schemas. Keep reverse-proxy/TLS examples optional and preserve streaming and callback-query redaction.

## Ownership and integration

| Agent | Exclusive product ownership |
| --- | --- |
| Pi `w1F:pC` | Native SSO modules, backend auth/page/runtime integration, Python dependencies/lock exports, backend auth tests. |
| Pi `w1F:pD` | Replacement `web/` source/tests/config/public assets, UI notices and design documentation. |
| Pi `w1F:pB` | `.github/workflows`, `.cnb.yml`, version/release/package scripts and release tests. |
| Pi `w1F:pE` | Dockerfile, Compose files, Docker ignore rules, deployment env template and deployment documentation. |
| Main | Task/spec artifacts, root README/integration documentation, shared-contract decisions, conflict resolution, combined validation and final review. |

Backend owner provides environment names to deployment owner before env integration. UI owner provides the final web commands before release owner edits CI. Workers do not edit another owner's files, commit, reset, or revert concurrent work. Main creates the backend feature branch before product work and stages only deliberate paths.

## Validation and practical limits

Acceptance requires native-backend SSO with a mock IdP plus a real browser session, not browser interception alone. Run existing backend regression scripts, new SSO/security regressions, UI checks/unit/build/browser tests, archive-content/hash tests, workflow syntax/contract checks and Compose rendering. Inspect rendered desktop/mobile light/dark login, loading and authenticated pages.

At planning time `docker`, `uv`, and `gh` are not present on PATH; `pnpm` is available. Resolve local test tooling where possible, but report unavailable image execution or remote registry/provider acceptance precisely. Configuring workflows is distinct from executing them on a remote repository. No remote deployment or credential copying is part of local consolidation.

## Planning gate

The final planning summary was presented and all four research artifacts reviewed. After being told implementation awaited approval of this plan, the user explicitly replied `继续` on 2026-10-26. This approves proceeding with the reviewed design and the four-agent implementation assignments; no further planning approval is pending.
