# CodeBuddy2Api console design

[简体中文](design-system.zh-CN.md)

This contract covers `web/`. The local `cnb2api-panel` reference was checked
against rendered screenshots on November 7, 2026. Implementation lives in
`theme.scss`, `ui.module.scss`, `dashboard.module.scss`, and `management.module.scss`.

## Provenance and fonts

Reference dimensions, spacing, colors, and layout relationships are implemented
independently in React and SCSS Modules. No Vue source or reference authentication
protocol was transplanted. Keep the CodeBuddy2Api name and cube mark.
Existing MIT attribution is retained in `web/LICENSE.upstream` and
`web/THIRD_PARTY_NOTICES.md`.

DM Sans Variable is the interface font; JetBrains Mono Variable is the code font.
Pinned Fontsource packages serve both locally, without external font requests.
Chinese text uses system fallbacks including Segoe UI, Microsoft YaHei, and
PingFang SC. The build includes both OFL texts in `THIRD_PARTY_LICENSES.txt`.

## Tokens and controls

Components consume semantic variables from `theme.scss`. Theme changes preserve layout.

| Role | Light | Dark |
| --- | --- | --- |
| Primary | `#3169df` | `#78a2ff` |
| Page / sidebar | `#f8f9fb` / `#f2f4f7` | `#14181f` |
| Surface | `#fff` | `#1b2029` |
| Text | `#232b3a` | `#e1e7f0` |
| Secondary / muted | `#596477` / `#7d8798` | `#abb5c5` / `#8590a1` |
| Border | `#e9edf2` | `#2a313e` |
| Selected navigation | `#cfddf2` | `#b8cceb` |
| Selected outline | `#9fb5d6` | `#829dc6` |

Selected navigation uses black text and a 3px inset `#1e40af` marker in both themes.
The brand square stays `#3169df`. Statuses combine text and paired status colors.

The radius scale is 4 / 8 / 12 / 16 / 28 / 999px: 8px controls, 12px cards,
16px desktop workspace. Normal buttons are at least 36px high with 14px text and
8px 13px padding. Title actions use compact 32px controls; mobile actions remain
at least 40px high except the compact title actions. Table headers are at least 36px and rows 48px; multiline
content expands naturally.

Page titles use 24px/650 text, an 11px English eyebrow with a blue dash, and a
14px description. Static cards use a light shadow without hover lift. Raised
shadows belong to menus and dialogs.

## Loading and sign-in

Session checks show a centered brand mark, 20px loader, and
“正在连接控制台” / “Connecting to console”, with `role="status"`.
Reduced-motion preferences disable animation.

Desktop sign-in uses `1.08fr 1fr` columns. The story has 42px 50px 28px padding,
a subtle dot pattern, branding, a two-line 38px heading, and a gateway diagram.
The centered sign-in card is at most 320px wide, with a 48px shield, eyebrow,
25px heading, description, and outlined SSO link. The link is 42px high on
desktop and at least 44px on mobile. The reference renders its button at 39px;
this console retains a larger pointer target.

Below 1050px, reduce story padding and heading size. Below 600px, use one column:
26px 25px brand padding and a 23px brand. Hide the auxiliary CONSOLE tag to fit
the longer product name. Hide the narrative and diagram, center the card
vertically, and cap its width at 330px. Keep the theme control fully visible
without colliding with branding at 320px.

The sole login entry is `/sso/login?return_to=/dashboard/`. Do not collect an
administrative password or API key. Errors and insufficient permission retain
status and recheck actions. The moon/sun appearance icon still opens the drawer
with theme, system preference, and language controls.

## Shell and scrolling

The shell is 100dvh high. The full-width top bar is 52px high with desktop padding
0 16px. It contains collapse, brand, breadcrumb, appearance, and account controls.
The account menu retains identity and logout, with Escape and outside dismissal.

Desktop navigation is 180px wide, or 64px collapsed. The two groups use entries
at least 36px high. Copy fades while staying mounted; icon positions and the
top-bar brand remain stable during collapse.

The workspace starts at x=180, y=60, with 8px top, right, and bottom margins.
Collapsed x is 64. The panel has a 1px border, 16px radius, and internal scrolling.
It must establish `position: relative` so absolute chart accessibility text
cannot escape and enlarge the document. Main content is at most 1600px wide with
20px 22px 18px padding; horizontal padding becomes 18px below 1250px.
Route changes reset workspace scrollTop. The footer scrolls with content and
keeps both plain-anchor license links reachable.

Below 800px, hide desktop navigation and use 8px workspace margins and a 12px
radius. Mobile navigation uses a native modal `dialog` at x=0, y=52, width 208px;
its backdrop starts beneath the header. Preserve close, scroll lock, focus
isolation, and focus restoration. Route selection and Escape close it.
Mobile content uses 16px horizontal padding, reduced to 14px below 440px.

## Business pages

Overview, credentials, models, media, keys, logs, storage, settings, and updates
share heading and control styles. Media and update cards use 12px radii and light shadows.

Overview contains Token/Credit summaries, four compact metrics, token detail,
official account balance, trend and credential health columns, model rankings,
and product distribution. Summary top borders are blue and amber, with 30px
values. Metric values are 24px, or 22px on phones, with 10px gaps and
12px 14px 11px padding. Use this gateway's actual API fields; do not introduce
the reference's CNB quota or workspace semantics. Missing values remain unknown.

Tables scroll inside their containers. Long identifiers must not widen the page.
The key table keeps name cells at least 120px wide and scrolls inside its wrapper.
KPI icon dimensions apply only to SVG containers, never to numbers or retention copy.
Settings preserve editable, externally locked, and read-only states plus unsaved
drafts across category switches. Loading, retry, permission revocation, explicit
confirmation, and CSRF contracts remain intact.

## Validation

```bash
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright test
pnpm --dir web exec playwright test -c playwright.native.config.ts
```

Browser checks measure painted geometry, internal scrolling, dark selection,
loaded fonts, mobile focus, and overflow. Wait for `document.fonts.ready` before
comparing screenshots at the same viewport and theme. Native SSO tests use an
isolated backend and synthetic OIDC to cover sign-in, CSRF, and logout.
