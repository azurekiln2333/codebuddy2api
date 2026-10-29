# UI contract (web/)

Owner: Pi `w1F:pD` (UI). Target product path: `D:/My2KProjects/codebuddy2api/web`.
This file is the integration contract for the release and deployment owners. It
reflects the migrated and redesigned UI as delivered in task
`10-26-unified-codebuddy2api`.

## Package scripts (authoritative)

Run from the product root `D:/My2KProjects/codebuddy2api`.

| Purpose | Command |
| --- | --- |
| Install (CI, reproducible) | `pnpm --dir web install --frozen-lockfile` |
| Format + lint + type check | `pnpm --dir web check` |
| Unit / component tests (jsdom) | `pnpm --dir web test` |
| Production build + notices | `pnpm --dir web build` |
| Browser tests (Playwright) | `pnpm --dir web exec playwright test` |
| Dev server | `pnpm --dir web dev` |
| Local preview | `pnpm --dir web preview` |

Equivalent from inside `web/`: `pnpm install --frozen-lockfile`, `pnpm check`,
`pnpm test`, `pnpm build`, `pnpm exec playwright test`.

`pnpm test:browser` is an alias for `pnpm exec playwright test`.

## Build output

- `pnpm build` = `vp build`. The notices are produced **by the build itself**
  (`vite.config.ts` runs `scripts/prepare-notices.mjs` in `buildStart`), so the
  container stage command `vp build` yields a complete artifact too.
- Output: `web/dist/` with `index.html` and `assets/*` under the `/dashboard/`
  base path. The backend serves this directory at `/dashboard`.
- `scripts/prepare-notices.mjs` also supports manual runs
  (`node scripts/prepare-notices.mjs`). It writes into `web/public/`:
  `LICENSE.upstream` → `public/LICENSE.upstream.txt`, `THIRD_PARTY_NOTICES.md` →
  `public/THIRD_PARTY_NOTICES.txt`, and the complete runtime dependency license
  text to `public/THIRD_PARTY_LICENSES.txt`; Vite copies `public/` into `dist/`.
- These files must exist next to `web/package.json` for the build to succeed:
  `LICENSE.upstream`, `THIRD_PARTY_NOTICES.md`, `package.json`, and the
  `node_modules` dependency closure.
- The Dockerfile must build this directory from the repository root context so
  the web sources and lockfile are available.
- The container stage runs bare `vp check`, which also formats/lints the web
  markdown (`README.md`, `THIRD_PARTY_NOTICES.md`). Keep them formatter-clean.
- Package name: `codebuddy2api-web` (renamed from the standalone UI repo).

## Base path and routing contract

- Vite `base` is `/dashboard/`; the SPA fallback must not take over `/sso/*` or
  `/admin/*`.
- Client routes: `/dashboard`, `/dashboard/login`,
  `/dashboard/{models,credentials,logs,settings,storage}`.
- Session/CSRF/401/403/logout contract is unchanged; see
  `.trellis/spec/frontend/gateway-session.md`.

## Browser test environment

- Playwright config starts `node e2e/serve.mjs` on `127.0.0.1:5174`.
- `WEBUI_CHROMIUM` may pin a Chromium executable; otherwise Playwright's managed
  browser is used.
- `e2e/backend.integration.ts` is excluded from the default run and needs
  `AZUREKILN_INTEGRATION_URL` (dedicated synthetic gateway fixture only).
- Screenshots and geometry attachments are written to `web/test-results/`
  (gitignored).

## Files other owners must not re-implement

- `web/src/**`, `web/e2e/**`, `web/scripts/**`, `web/public/**`,
  `web/*.config.ts`, `web/index.html`, `web/package.json`,
  `web/pnpm-lock.yaml`, `web/tsconfig.json`, `web/.gitignore`.
- Notices/attribution: `web/LICENSE.upstream`, `web/THIRD_PARTY_NOTICES.md`.
- The UI design documentation at the repository root: `docs/design-system.md`.

## Design facts for release/design docs

- 52px top bar, 180px expanded sidebar, 64px collapsed sidebar.
- Brand blue `#3169df` (dark `#78a2ff`), radius scale 4/8/12/16/20/999 with the
  12px base step; workspace surface radius 16px.
- Loading screen copy is the exact string `正在连接控制台`.
- Six management pages and their data flows are preserved; only the shell,
  login and loading presentation changed.