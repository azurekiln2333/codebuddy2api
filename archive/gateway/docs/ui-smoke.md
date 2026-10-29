# Real UI browser smoke (temporary harness)

High-level end-to-end browser smoke combining four real components into one
origin:

```
browser ──> gateway (Node, ephemeral port) ──> private FastAPI (original codebuddy2api, ephemeral port)
                   │                                    ▲
                   ├── serves codebuddy2api-ui/dist      │
                   └── talks to the local mock OIDC provider
```

- **Gateway**: this repository's `createGateway(config)`.
- **UI**: the real build at `D:/My2KProjects/codebuddy2api-ui/dist`.
- **OAuth**: `tests/fixtures/mock-oauth.ts` (synthetic RS256/S256 local IdP).
- **Backend**: the **original** `D:/My2KProjects/codebuddy2api` FastAPI app, booted
  read-only from `tests/backend/server_fixture.py` with all writable state
  (`CODEBUDDY_AUTH_DIR`, control/audit SQLite) and bytecode
  (`PYTHONDONTWRITEBYTECODE` + `PYTHONPYCACHEPREFIX`) redirected into a temp dir.

**No real IdP, real client credential, public TLS, or production deployment is
used.** These results are local-fixture only and are **not** a real-domain
acceptance result.

## Harness location (temporary, not committed)

The harness lives under `.tmp/ui-smoke/` and is intentionally excluded from git
(`.tmp/` is ignored). It contains no machine-path dependency that is required by
the committed test suite; the machine-specific values are local constants.

- `.tmp/ui-smoke/run.mts` — boots the stack, performs the real OAuth handshake,
  drives Chromium, writes `artifacts/report.json` + screenshots.
- `.tmp/ui-smoke/probe.mts` — helper that printed rendered page text while the
  assertions were being authored.
- `.tmp/ui-smoke/artifacts/` — `report.json` and the PNG screenshots.

Run (from the gateway repo root, using the gateway's `tsx`):

```powershell
node --import tsx .tmp/ui-smoke/run.mts
```

Prerequisites (see `docs/validation.md` for the full list): the isolated backend
venv at `.tmp/backend-venv`, the UI build at the path above, and the Playwright
Chromium binary (the UI repo's Playwright dependency resolves it).

## Result — all 32 steps pass

`report.json` → `ok: true`, `failures: []`.

### Origin, session and real routes

| Check | Result |
| --- | --- |
| backend started (isolated state) | ✔ `http://127.0.0.1:<ephemeral>` |
| gateway started serving `dist` | ✔ `http://127.0.0.1:<ephemeral>` |
| real OAuth handshake → session cookie | ✔ |
| `GET /sso/session` (HTTP) | 200 `{authenticated:true, csrf_token, user.role:"admin"}` |
| seed credential via real bridge (`POST /admin/credentials/upload`) | 200 `[{name:"smoke-fixture.info", ok:true}]` |

Real admin routes the dashboard pages call, all **200** through the gateway:

`/admin/credentials`, `/admin/models`, `/admin/settings`,
`/admin/logs?kind=request&limit=20`, `/admin/storage`, `/admin/dashboard?days=7`.

### Real UI pages (app shell + page heading + signed-in nav)

| Page | Heading rendered | Signed-in nav | Screenshot |
| --- | --- | --- | --- |
| `/dashboard/` | 运行概览 | ✔ | `artifacts/dashboard-dashboard.png` |
| `/dashboard/credentials` | 凭证管理 | ✔ | `artifacts/dashboard-credentials.png` |
| `/dashboard/models` | 模型路由 | ✔ | `artifacts/dashboard-models.png` |
| `/dashboard/settings` | 系统设置 | ✔ | `artifacts/dashboard-settings.png` |
| `/dashboard/logs` | 日志审计 | ✔ | `artifacts/dashboard-logs.png` |
| `/dashboard/storage` | 存储管理 | ✔ | `artifacts/dashboard-storage.png` |

Rendered content is real backend data: the signed-in identity shows as
"Gateway Admin", the model catalog lists the full upstream catalogue (tens of
real model ids), settings lists 26 mutable items, storage reports real SQLite
sizes, and the nav renders
概览/模型路由/凭证管理/日志审计/存储管理/系统设置.

### Rendering modes

| Check | Result | Artifact |
| --- | --- | --- |
| light theme background | `rgb(247, 249, 251)` | `artifacts/theme-light.png` |
| dark theme background | `rgb(21, 26, 32)` | `artifacts/theme-dark.png` |
| themes differ | ✔ | — |
| mobile 390×844, no horizontal overflow | ✔ | `artifacts/mobile-dark.png` |

### Browser-issued contract calls (observed from real page traffic)

| Check | Result |
| --- | --- |
| `POST /admin/logs/clear` carries `X-CSRF-Token` | ✔ (scope=details, no `api_key`) |
| `GET /admin/oauth/poll` carries `X-CSRF-Token` | ✔ |
| all writes carry the gateway CSRF | ✔ 2 writes, 0 missing |
| no browser payload contains `api_key` | ✔ |

The logs-clear write and the OAuth poll were driven by real UI interactions.
For the OAuth poll specifically, the UI's **`POST /admin/oauth/start` was
intercepted in the browser** (fulfilled locally with an official-allowlisted
`verification_uri`) so no external navigation occurs; the subsequent
**`GET /admin/oauth/poll` is the UI's real code path** — the same 4-second poll
timer, real endpoint URL and real `X-CSRF-Token` header the UI sends in
production. Start and poll are therefore distinguished: start is stubbed, poll
is genuine.

### Browser model flow with encoded IDs (real create/update/delete)

The UI submits `encodeURIComponent(model.id)` for update/preview/delete, which
encodes `/`, `:` and `@`. This exercises the literal `/admin/models` request
target exception against the **original FastAPI** end to end:

| Browser action | Real request observed | Status |
| --- | --- | --- |
| 新增模型 (对外 ID `org/browser-model`, 上游 ID `org/model`) | `POST /admin/models` | **201** |
| 编辑规则 → 保存规则 on the created row | `PUT /admin/models/custom%3A<hex>` | **200** |
| 删除 on the created row | `DELETE /admin/models/custom%3A<hex>` | **200** |

The generated `custom:<hex>` id contains `:`, and the browser sent it
percent-encoded; the gateway forwarded it unchanged (no 400) and the real
FastAPI routed and applied the mutation. This confirms the landed fix at the
browser layer, complementing the checker's real-FastAPI integration suite
(15 tests total, of which 4 are model-lifecycle cases).

### Blocking behaviour

| Check | Result |
| --- | --- |
| ordinary user (`role=user`, `isAdmin=false`) → `GET /sso/session` | 403 `{error:"forbidden"}` |
| ordinary user → `GET /admin/dashboard` | 403 |
| revocation (`UserInfo` invalidated) → `GET /admin/dashboard` | 403 |
| browser `pageerror` count | 0 |

## Exact limits (not verified here)

1. **No production IdP login.** The OAuth handshake completes against the local
   mock provider only. A real client id/secret, real issuer/JWKS and real
   UserInfo are not exercised. No real-domain login is claimed.
2. **No public TLS / DNS.** The smoke runs over plain HTTP on loopback with
   `allowInsecureLocalhost`; cookies are therefore not `Secure`. Nginx TLS
   termination is not exercised.
3. **Model-ID percent-encoding paths are now exercised and pass.** The global
   path percent-escape ban previously rejected model IDs the UI
   `encodeURIComponent`-encodes (`org/model`, `vendor:model`, `@org/model`). The
   landed fix adds a strict literal `/admin/models` exception (PUT/DELETE and
   `POST <id>/preview`) that decodes exactly once and re-validates the id. The
   browser smoke drove a real create (`POST /admin/models` → 201), update
   (`PUT /admin/models/custom%3A<hex>` → 200) and delete (`DELETE …` → 200)
   against the original FastAPI. The checker independently reports 15
   real-FastAPI integration tests, of which 4 are model-lifecycle cases
   (`org/model`, `vendor:model`, `@org/model` read/update/preview/delete plus a
   create lifecycle). Not re-verified here:
   preview of an encoded id from the browser (covered by the checker at the
   HTTP layer).
4. **Static vs. backend fidelity.** The dashboard pages render against the
   original FastAPI with a single synthetic credential seeded over the real
   upload route; richer backend states (models, logs, credits) are empty-state
   because the fixture creates no history.
5. **Backend variants.** Only the base `codebuddy2api` app is booted, not the
   richer `webui_fixture.py` variant that the UI's own integration suite uses.
6. **Screenshots** are full-page PNGs on Windows Chromium; font rendering may
   differ from other platforms.
