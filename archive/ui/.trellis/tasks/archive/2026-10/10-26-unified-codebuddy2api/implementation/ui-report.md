# UI implementation report (web/)

Task: `10-26-unified-codebuddy2api` · Owner: Pi `w1F:pD` (UI) ·
Product root: `D:/My2KProjects/codebuddy2api` (branch `feat/unified-codebuddy2api`).
No commits, no branch switches, no changes outside the assigned paths.

## 1. Migration (R2 / AC2, UI half)

Replaced the backend's old tracked `web/` with the current replacement UI source,
excluding `node_modules/`, `dist/`, `public/` build artifacts, `.env*`, proxy
config and local agent directories.

Source → target (`codebuddy2api/web/`): `src/**`, `e2e/**`,
`scripts/prepare-notices.mjs`, `index.html`, `package.json`, `pnpm-lock.yaml`,
`tsconfig.json`, `vite.config.ts`, `playwright.config.ts`,
`playwright.integration.config.ts`, `.gitignore`, `README.md`,
`LICENSE.upstream`, `THIRD_PARTY_NOTICES.md`.

- No tracked file was deleted; the migrated set is a strict superset of the old
  `web/` (`git status -- web` shows only `M` and `??`).
- `web/package.json` name changed `azurekiln-admin-ui` → `codebuddy2api-web`.
  `pnpm install --frozen-lockfile` still passes (root name is not in the lockfile).
- The standalone UI repo was used read-only as the migration source; its `src`
  was not modified.

## 2. Design rework (R1 / AC1)

Reference-derived visual specifications implemented independently in React/SCSS.
No Vue component, panel stylesheet or key-login flow was copied; the reference is
AGPL-3.0-only and is not a dependency. This repo stays MIT.

| Area | Result |
| --- | --- |
| Loading screen | New `BootScreen`: brand mark (30×30, `--brand` #3169df, white glyph) + 20px spinning loader + exact copy `正在连接控制台`, horizontal, `min-height:100dvh`, `role="status"`. Replaces the old plain-text guard. |
| Login | Two-column `.loginShell` `1.08fr / 1fr`: story column (brand + `CONSOLE` tag, eyebrow with blue dot, two-line `h1`, 240px network art with dashed SVG edges, centre card, three 140px nodes rotated −3°/0°/3°, footer line) and form column (48px lock tile, eyebrow, `h2 登录 CodeBuddy2Api`, hint, full-width 42px SSO primary action, inline `role="alert"` + recheck on error). **No `<form>`, no input.** |
| Theme control | Existing `Appearance` drawer retained (a11y + i18n), trigger restyled as an icon button; repositioned in the login column and the top bar. |
| Console shell | 52px full-width sticky top bar on `--sidebar`; 180px / 64px sidebar below it; `控制台 › 当前页` breadcrumb moved into the top bar; account menu (avatar + chevron popover with identity and red-hover 退出登录); two nav captions (`控制台 / CONSOLE`, `管理与接入`); inset `--surface` panel with 16px radius and 8px gutters; page footer. |
| Tokens | `theme.scss` rewritten: `--primary #3169df` (dark `#78a2ff`), `--sidebar`, `--nav-active-bg/-border/-text`, `--primary-soft`, `--surface-subtle`, `--brand`, `--shadow-raised`, radius scale 4/8/12/16/20/999 with `--radius: 12px`, `--control-height: 36px`, `--header-height: 52px`, `--sidebar-width: 180px`, `--collapsed-sidebar-width: 64px`. |
| Responsive | ≤800px keeps two login columns with reduced type sizes; ≤600px collapses the login to one column keeping only the brand row (grid, narrative and footer removed) and moves the theme button; ≤800px hides the desktop sidebar and uses the existing native `Drawer` (`打开导航菜单` → dialog `主导航`, lockPage, focus restore, Escape/route close). |
| Dark mode | Only tokens change; verified by browser test that the story column width is identical in light/dark while the page background changes. |

Preserved contracts: six management pages and their real data flows, `/sso`
client contract (`GET /sso/session`, in-memory CSRF, `X-CSRF-Token`, `POST
/sso/logout`, `401`→anonymous, `403`→forbidden, stale-response generation guards,
retry), i18n (zh/en keys for every new string), accessible names, `role="status"`
/`role="alert"`, reduced-motion, mobile drawer, log-clear confirmation.

Sidebar collapse behaviour was kept (labels stay mounted and fade, icons keep
their column) because it is an existing accessibility/quality contract; only the
track width changed (180 → 64). Reference geometry, colours and grouping are
applied, not just the login page.

## 3. Build/artifact fix (affects release + deployment)

The repository `Dockerfile` runs `vp check && vp test run && vp build` in `/web`,
which bypasses the former `node scripts/prepare-notices.mjs && vp build` wrapper,
so the image would have shipped without attribution files. Fixed inside the UI
ownership:

- `scripts/prepare-notices.mjs` now exports `prepareNotices()` and still runs as a
  CLI; `scripts/prepare-notices.d.mts` provides types.
- `vite.config.ts` registers a `buildStart` plugin that calls it, so bare
  `vp build` (the container command) produces
  `dist/LICENSE.upstream.txt`, `dist/THIRD_PARTY_NOTICES.txt`,
  `dist/THIRD_PARTY_LICENSES.txt`.
- Added markdown files are formatter-clean so the Dockerfile's bare `vp check`
  (which also formats web markdown) passes.
- Verified by deleting `public/` and `dist/`, then running `vp build` alone.

## 4. Documentation and attribution

- `docs/design-system.md` (repository root, UI-owned): rewritten for the new
  shell geometry, tokens, boot/login/shell structure, responsive rules,
  accessibility, Tailwind mapping, provenance and validation. States explicitly
  that only visual specifications were used from an AGPL-3.0-only reference and
  that no source was copied.
- `web/THIRD_PARTY_NOTICES.md`: reframed for the unified repository (the console
  is this repo's own UI under MIT, `LICENSE.upstream` kept verbatim), added a
  design-provenance section, kept runtime/dev dependency tables, noted no webfont
  dependency. **No new root `THIRD_PARTY_NOTICES.md` was created** — notices stay
  in `web/` because the build reads them from there.
- `web/README.md`: rewritten for CodeBuddy2Api (`web/` console), commands, auth,
  layout, license/attribution.
- `web/LICENSE.upstream`: unchanged (verbatim MIT; byte-identical to the repo
  root `LICENSE`).
- `index.html`: theme colour `#3169df`.

## 5. Test changes (assertions corrected, not suppressed)

- `e2e/layout.spec.ts`: constants updated to the reviewed geometry
  `SIDEBAR = 180`, `COLLAPSED_SIDEBAR = 64`, `HEADER_HEIGHT = 52`; all geometry,
  hit-testing, reduced-motion and drawer assertions kept.
- `e2e/admin.spec.ts`: desktop sidebar width assertion 208 → 180.
- `e2e/experience.spec.ts`: collapsed width 44 → 64 (2 places).
- `e2e/sso.spec.ts`: sign-out now opens the account menu (`账号菜单`) before
  clicking `退出登录` (reference puts sign-out in the user panel); all
  contract/CSRF/401/403/malformed-session assertions unchanged.
- New `e2e/design.spec.ts` (6 tests): first painted frame (brand + loader + exact
  `正在连接控制台` while `/sso/session` is still pending), desktop login two-column
  geometry + single SSO action + `--primary`/`--radius` tokens + light/dark
  layout stability, mobile single-column login with no page overflow, console
  geometry per theme (52px header, 180px sidebar starting at header bottom,
  16px workspace radius, no horizontal overflow), and collapsed 64px sidebar
  without icon shift.
- Unit tests were not weakened; all 179 still pass unchanged.

## 6. Test evidence (local, this session)

Run in `D:/My2KProjects/codebuddy2api/web`.

| Gate | Command | Result |
| --- | --- | --- |
| Format/lint/type (script) | `pnpm check` | Pass — 67 files formatted, 60 files lint/type clean |
| Format/lint/type (bare, as Dockerfile) | `pnpm exec vp check` | Pass — 69 files formatted, 60 files lint/type clean |
| Install | `pnpm install --frozen-lockfile` | Pass |
| Unit/component | `pnpm test` | **179 passed / 18 files** |
| Build | `pnpm build` (= `vp build`) | Pass — 106 modules; `dist/index.html`, CSS 67.68 kB, JS 477.18 kB; notices emitted |
| Bare build (Docker path) | `pnpm exec vp build` | Pass — notices written by the `buildStart` plugin |
| Browser | `pnpm exec playwright test` | **44 passed** (incl. 6 new design tests) |

Recorded painted geometry (from `e2e/layout.spec.ts` attachments):

- 1440×1050 light/dark: `header {x:0, top:0, w:1440, h:52}`,
  `aside {x:0, top:52, w:180}`, `main {x:189, top:61, right:1431}`,
  heading hit-test `insideHeading: true`, `document.scrollWidth 1440`.
- 1440×1050 collapsed: `aside {w:64}`, `main {x:73}`; icon x shift ≤1px (test).
- 375×812: `header h:52`, `main {x:7, right:368}`, no horizontal overflow,
  desktop nav not rendered, drawer opens as native modal with focus restore.
- `e2e/design.spec.ts` also asserts `--primary === "#3169df"`,
  `--radius === "12px"`, workspace `borderTopLeftRadius === "16px"`, and dark
  background differs from light with identical column widths.

Screenshots produced for coordinated review in `web/test-results/`
(gitignored): `design-login-desktop-light.png`,
`design-login-desktop-dark.png`, `design-login-mobile-light.png`,
`design-console-light.png`, `design-console-dark.png`,
`design-console-collapsed.png`, plus the existing `azurekiln-*`,
`glass-*`, `dashboard-*`, `automation-*`, `model-capabilities-*`,
`settings-locked-mobile.png`, `trend-mobile.png`, `appearance-dark.png`.

## 7. Ownership / coordination notes

- Changed only `web/**` and `docs/design-system.md`. No backend app, Dockerfile,
  Compose, workflow, release script or another owner's docs were edited.
- Concurrent untracked work from other owners was present in the tree
  (`app/sso_*.py`, `app/request_target.py`, `.cnb.yml`, `scripts/package.py`,
  `scripts/release_tags.py`, `scripts/run_backend_tests.py`,
  `tests/test_release_*.py`, `docker-compose.build.yaml`, `docs/nginx.example.conf`,
  modified `docs/deployment*.md`/`webui*.md`). None of it was touched or reverted.
- UI package commands for CI are in
  `.trellis/tasks/10-26-unified-codebuddy2api/implementation/ui-contract.md`
  (`pnpm --dir web install --frozen-lockfile`, `check`, `test`, `build`,
  `pnpm --dir web exec playwright test`).
- For the deployment owner: the container stage needs no extra notice step —
  bare `vp build` now emits them; `web/public/` and `web/dist/` stay excluded
  from the build context (already in `.dockerignore`).
- For the coordinator (`/sso` + real IdP): the browser suite still mocks
  `/sso/session`/`/sso/logout`. Native-backend SSO with a mock IdP and a real
  browser session remains the coordinator's combined acceptance.
- Spec follow-up for the coordinator: `.trellis/spec/frontend/quality-guidelines.md`
  still describes the superseded geometry (48px header, 208/44px sidebar, 22px
  workspace radius). `design.md` supersedes it; the spec text and
  `web/e2e/*` constants now disagree until that spec section is updated in Phase
  3.3. I did not edit specs (coordinator-owned).

## 8. Known limits

- `docker`, `uv`, `gh` are not on PATH here; no container/image execution was
  attempted. The Dockerfile contract was validated by running its exact web
  commands (`vp check`, `vp test run`, `vp build`) locally.
- Visual review of the rendered screenshots is left to the coordinator's combined
  acceptance; this report provides the screenshots plus the programmatic
  geometry/colour assertions above instead of claiming visual sign-off.

## 9. Review round 2 — mobile control defect fixed, final gates

Triggered by the coordinator's screenshot review (desktop accepted; 375x812
login showed the top-right theme button clipped at `y=0`). This round fixed
defects only — no further beautification.

### 9.1 Reported defect: mobile theme control clipped at y=0

- **Root cause.** `@media (max-width: 600px)` positioned `.loginTheme` with
  `top: -62px` while its containing block is `.loginMain` (`position: relative`),
  whose top edge sits *below* the brand row. The brand row measures 54px
  (24px padding + 30px mark), so the 32px control was painted at `y = 54 - 62 =
  -8`: the upper part was outside the viewport and the hit area was truncated.
  It was not a screenshot artifact — the click target was genuinely reduced.
- **Fix (CSS only, `src/ui.module.scss`).** At `<=600px` the control now anchors
  to the shell, not to the login column:
  `.loginShell { position: relative }`, `.loginMain { position: static }`,
  `.loginTheme { top: 12px; right: 16px }` → painted box `y 12..44`, x `327..359`
  at 375px wide. It sits inside the brand band (bottom 44 ≤ row height 54), keeps
  its full 32x32 hit area, and no longer depends on the brand row's height.
- **Regression guard.** New `expectFullyVisible()` helper in `e2e/design.spec.ts`
  asserts the painted `boundingBox` is fully inside the viewport on all four
  edges, the hit area is at least 28x28, and `document.elementFromPoint()` at the
  control's centre returns the control itself (so a clipped/covered control
  cannot pass). The mobile test additionally asserts the control's bottom edge
  stays within the brand row band and above the sign-in card. It runs in light
  **and** dark mode.
- **Mutation proof (not just refreshed screenshots).** I temporarily restored
  `top: -62px` / `padding: 35px 20px` and re-ran the mobile test: it failed with
  `mobile theme control (light): top edge inside viewport` at
  `expect(box.y).toBeGreaterThanOrEqual(0)`. Restoring the fix turned it green, so
  the assertion demonstrably catches this class of defect.
- **New screenshots** (`web/test-results/`): `design-boot-light.png`,
  `design-boot-mobile-light.png`, `design-login-mobile-dark.png`, alongside the
  existing `design-login-mobile-light.png` / `design-login-desktop-{light,dark}.png`
  / `design-console-{light,dark,collapsed}.png`. The loading screen is now captured
  on both a desktop and a phone viewport while the session request is still gated,
  so the first painted frame is what is recorded.

### 9.2 Further defects found by the new fidelity assertions

While pinning the reference metrics I hit four real defects; all are fixed:

1. **Login primary action painted 43px, not 42px.** `min-height: 42px` plus
   `padding: 10px 15px` plus the 1px border exceeded the intended control height.
   Now `height: 42px; padding: 0 15px` (exactly 42px, asserted).
2. **Login eyebrow's 8px gap never painted.** The eyebrow is a `<span>` and
   `margin-bottom` does not apply to inline boxes. Now `display: block`
   (`margin-bottom: 8px` asserted).
3. **Two elements claimed `aria-current="page"`.** The header brand was a
   `NavLink` to `/dashboard/`, so React Router also marked it as the current page;
   the shell exposed two current-page markers and screen readers announced the
   brand as "current page". It is a home shortcut, not the current page: changed
   to `Link`. The suite now asserts exactly one `aria-current="page"` and that it
   lives in the sidebar, and the active-item query is scoped to
   `aside [aria-current="page"]` so it can no longer silently read the brand.
4. **Account popover mis-declared its role.** `aria-haspopup="true"` announces a
   menu, but the panel is `role="group"`. Replaced with `aria-expanded` +
   `aria-controls` (via `useId`); Escape and outside-click closing are unchanged.

### 9.3 Reference fidelity now asserted (light + dark)

Painted values (not declared CSS) checked in `e2e/design.spec.ts`: header
`padding 0 16px` with the same background as the sidebar; sidebar
`padding 8px 12px 12px`; workspace `margin 8px 8px 0 188px`, `1px` border, `16px`
radius; main `padding 20px 22px 18px`; footer `12px`; nav item `min-height 36px`,
`8px` radius, `14px`/`500`, `padding 7px 9px`; nav caption `11px`/`0.5px`; active
entry uses an `inset` shadow; login story `padding 42px 50px 28px` with a `1px`
rule, `h1` `38px/600`, network art `240px`, column `padding 65px 30px`, theme
control `35/32`, lock tile `48px`/`16px` radius, `h2` `25px`, primary action `42px`
and full card width.

### 9.4 Six-page self-check (throwaway script, deleted afterwards)

Each page was opened authenticated at 1440x1050 and 375x812:

| page | h1 | header | workspace x | radius | overflow | current-page markers |
| --- | --- | --- | --- | --- | --- | --- |
| `/dashboard/` | 运行概览 | 52 | 188 / 6 | 16 / 12 | 0 | 1 (aside) / 0 |
| `/dashboard/credentials` | 凭证管理 | 52 | 188 / 6 | 16 / 12 | 0 | 1 (aside) / 0 |
| `/dashboard/models` | 模型路由 | 52 | 188 / 6 | 16 / 12 | 0 | 1 (aside) / 0 |
| `/dashboard/logs` | 日志审计 | 52 | 188 / 6 | 16 / 12 | 0 | 1 (aside) / 0 |
| `/dashboard/storage` | 存储管理 | 52 | 188 / 6 | 16 / 12 | 0 | 1 (aside) / 0 |
| `/dashboard/settings` | 系统设置 | 52 | 188 / 6 | 16 / 12 | 0 | 1 (aside) / 0 |

No page errors, one `h1` per page, no horizontal overflow. The paired numbers are
1440px / 375px: on phones the sidebar is a closed drawer, so the workspace keeps
only its 6px inset instead of clearing the 188px sidebar rail. At 375px there is
no current-page marker because no navigation landmark is rendered while the
drawer is closed (0 markers) — the breadcrumb names the page instead.

### 9.5 Final gate results (this round)

| gate | command | result |
| --- | --- | --- |
| lint/format/type | `pnpm check` | **pass** — 69 files formatted, 62 files with no warnings/lint/type errors |
| unit | `vp test run` | **179 passed / 18 files** |
| build | `pnpm build` | **pass** — 106 modules, `dist/` + notices emitted |
| browser | `pnpm exec playwright test` | **44 passed** |

`pnpm check` now includes `playwright.native.config.ts` (see 9.6), so the
`App.tsx` / `e2e/design.spec.ts` formatting failures from check-review are gone.

### 9.6 Coordination with the native-SSO owner (pC)

- `playwright.config.ts` (`testIgnore`) was generalised to `["**/*.integration.ts",
  "serve.mjs"]`. pC's `e2e/native-sso.integration.ts` needs a real backend and has
  its own config; without this it would have been picked up by the mocked
  default gate and broken the 44-test run. `playwright.native.config.ts` is
  untouched and still the only entry point for the native suite.
- `playwright.native.config.ts` was missing from the TypeScript project, which is
  why it reported 5x `TS2591: Cannot find name 'process'`. Fixed by adding it to
  `tsconfig.json` `include` **and** to the explicit file list of the `check`
  script in `package.json` — the file-list gap the coordinator flagged.
- I formatted pC's two native files once with `vp check --fix` (whitespace/
  formatting only; fixture logic and assertions were not touched). Since then I
  only run read-only `pnpm check` so I do not race pC while they keep editing
  those files.

### 9.7 Environment note (not a code regression)

One `pnpm test` run in this round died with `JavaScript heap out of memory`
(`Worker exited unexpectedly`, 7 unhandled errors) on a box that had **174**
concurrent `node` processes from other owners. Re-running the identical command
with `--maxWorkers=2` gave 179/179. No source change was involved; earlier runs of
the same tree also passed at default concurrency.

### 9.8 Remaining limits

- There is still no error boundary: an admin endpoint that returns a shape the
  client contract rejects throws during render and blanks the tree (observed
  while my throwaway audit used a wrong payload). This is pre-existing migrated
  behaviour, not introduced in this round, and I did not change it — flagged for
  the coordinator. The shipped specs cover the real shapes.
- Pixel-level sign-off stays with the coordinator; the coordinator has already
  compared the login/console screenshots against screenshots captured from a real
  `cnb2api-panel` instance (`.tmp-unified-visual/reference-login-light.png`,
  `reference-console-light.png`) and accepted the visual direction. This round
  only removed the clipped mobile control and the four defects in 9.2.

### 9.9 `App.tsx` formatting gate: resolved, plus one live pC file

The check-review failure was a formatting problem in `src/App.tsx` (left
unformatted when the top bar / account-menu work landed). It is fixed: `App.tsx`
is now included in the 69 correctly-formatted files, and `pnpm check` reported
**pass** with 69 files formatted and 62 files with no warnings, lint or type
errors.

After the native-SSO work started landing, a later `pnpm check` reports exactly
one formatting issue, in a file that is not mine and is still being written:

- `scripts/start-native-fixture.mjs` — newly added by pC, reported by
  `git status` as inside the untracked `web/scripts/` directory.

I did **not** reformat it, per the instruction not to format pC's files while they
are still being edited. Evidence that nothing else is pending: running the same
check with that one path excluded (`scripts/prepare-notices.mjs` and
`scripts/prepare-notices.d.mts` instead of the whole `scripts/` directory) passes —
`All 69 files are correctly formatted`, `no warnings, lint errors, or type errors
in 62 files`. So the outstanding item is pC's in-progress file only; once pC
finishes, a bare `pnpm check` should be green. My own scope (`src/`, `e2e/`,
`scripts/prepare-notices.*`, the three playwright configs, `tsconfig.json`,
`index.html`, `package.json`) is clean.

**Resolved.** pC has since formatted that file; the final `pnpm check` of this
round is green at 70 files formatted / 63 files with no warnings, lint or type
errors (see 10.4).

## 10. Review round 3 — F11 generalised, notices entry point added

Two last integration items from check-review. Both are in UI scope.

### 10.1 F11: storage-whitelist wording replaced by generic route/API guidance

The console and the admin API share one origin behind the gateway, so a route that
is not wired up in a deployment surfaces as a redirect back to the overview, a 404,
or an HTML document instead of JSON. The old code hardcoded the *storage* page
whitelist as the explanation, which is wrong now that the backend serves the route.

- `storageFailureMessage` → **`routeFailureMessage`** (`src/pages/Storage.tsx`), and
  the comment above it now describes the general case instead of
  `install_pages`/`storage`.
- New `apiPath` option (default `/admin/storage`) so the helper is not tied to one
  endpoint: the redirect test and the 404 message are built from it, and the 404
  text names the method and path (`GET /admin/logs`, …).
- Messages are now deployment/routing advice: redirect → "当前部署没有把该路由交给
  控制台…请确认网关已放行该页面与对应接口"; 404 → "当前部署没有提供 GET <path>…";
  HTML-instead-of-JSON → "网关没有把这个接口转发给后端". No whitelist wording
  anywhere.
- `storage.unavailableHint` (zh + en) rewritten generically: it now says the page or
  its API is not wired up in the current deployment and tells the operator to check
  the gateway route and the backend endpoint — no `/admin/storage`/whitelist text.
- `src/storage.test.tsx` updated with the new name and generalised assertions: the
  redirect message must mention the redirect and must **not** contain 白名单, the 404
  message names the path, the HTML case is generic, an arbitrary `apiPath`
  (`/admin/logs`) proves the helper is not storage-locked, and a plain transport
  error is still passed through unchanged.

### 10.2 Packaged notices now have a reachable entry point

The build emits `LICENSE.upstream.txt`, `THIRD_PARTY_NOTICES.txt` and
`THIRD_PARTY_LICENSES.txt` at the `dist/` root (verified: 1084 / 4625 / 49264
bytes). Until now they shipped with no way to open them from the console.

- Footer (`src/App.tsx`, `Shell`) gained two links next to the gateway/brand text:
  `footer.notices` → `/dashboard/THIRD_PARTY_NOTICES.txt` and `footer.licenses` →
  `/dashboard/THIRD_PARTY_LICENSES.txt` (the latter carries `rel="license"`).
- They are **plain `<a href>` anchors, not router `Link`s** — the gateway serves
  those two documents as `text/plain`, so a real document navigation is required; a
  router transition would render nothing.
- i18n: `footer.notices` = 开源声明 / "Open-source notices", `footer.licenses` =
  依赖许可 / "Dependency licenses" (both dictionaries). Styling: `.pageFooter a`
  inherits the muted footer colour with a hairline underline, `:hover` switches to
  `--primary`; `.footerLinks` uses a 12px gap and wraps on phones.
- The routes exist on the backend (`app/gateway_management.py`: the three
  `dist`-root documents are registered at `/dashboard/<name>` with
  `text/plain; charset=utf-8`, plus a legacy `/dashboard/THIRD_PARTY_NOTICES.md`).
  That is pC's side and I did not touch it.
- Assertions added to `e2e/design.spec.ts` (light + dark, inside the existing shell
test so the suite stays at 44): both links visible with the exact `href`s, `rel`
on the licence link, exactly two anchors in the footer, and — the important one —
  clicking 开源声明 performs a **real document navigation** (`toHaveURL` matches
  `/THIRD_PARTY_NOTICES\.txt$/`), which fails if the SPA router swallows the click.
  The mocked dev server is a Vite app server, so it does not serve that body; the
  test asserts the navigation attempt, and body serving stays the gateway contract.

### 10.3 Files touched this round

`src/App.tsx`, `src/i18n.tsx`, `src/pages/Storage.tsx`, `src/storage.test.tsx`,
`src/ui.module.scss`, `e2e/design.spec.ts`. No backend, Docker, Compose or workflow
files; pC's `e2e/native-sso.integration.ts`, `playwright.native.config.ts` and
`scripts/start-native-fixture.mjs` were left alone.

### 10.4 Gates after the round-3 changes

| gate | command | result |
| --- | --- | --- |
| lint/format/type | `pnpm check` | **pass** — 70 files formatted, 63 files with no warnings/lint/type errors |
| unit | `vp test run` | **179 passed / 18 files** |
| build | `pnpm build` | **pass**, three notice documents emitted at `dist/` root |
| browser | `pnpm exec playwright test` | **44 passed** |

### 10.5 Final wrap-up (pC done)

- `e2e/native-sso.integration.ts` was formatted once with `vp check --fix` after pC
  finished (formatting only — no assertion, fixture or semantic change), so the file
  the coordinator extended with the real-`dist` notices-route check and the footer
  link check is now inside the green `pnpm check`.
- `docs/design-system.md` corrected in three places that had drifted from the code
  and now contradict the assertions: login footer type `12px`/`0.3px` (was
  `11px`/`1px`), the account-menu disclosure now documented as
  `aria-expanded`/`aria-controls` (no `aria-haspopup`), the mobile theme control
  documented as anchored to the shell (`top: 12px; right: 16px`, full 32px hit
  area), and the console footer now documents the 开源声明 / 依赖许可 entry points.
- Final gates after these edits: `pnpm check` **pass** (70 files formatted, 63
  files clean), unit **179 passed**, build **pass** with the three notice documents
  at the `dist/` root (1084 / 4625 / 49264 bytes), browser **44 passed**.
- Product editing stops here; final acceptance is the coordinator's.