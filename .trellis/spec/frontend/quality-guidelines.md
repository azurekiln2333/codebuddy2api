# Quality guidelines

## Executable gates

- `pnpm check`: formatting, lint and type checks for src/e2e/scripts/config.
- `pnpm test`: unit/component regressions using jsdom.
- `pnpm build`: production assets under /dashboard/ plus complete license text.
- `pnpm exec playwright test`: browser contracts and layout regressions.

Keep generated dist/, node_modules/, test-results/, and local automation helpers
out of commits. Stage deliberate task paths; platform initialization files are
not application changes.

## Authentication assertions

Follow [gateway-session.md](./gateway-session.md). Cover non-admin and malformed
sessions, missing CSRF, 401/403 distinction, mutating account GET polling,
logout, and stale responses racing a newer session. Mock fixtures remain in
tests; there is no production mock fallback or API-key login form.

## Visual assertions

Keep semantic tokens in src/theme.scss; components consume CSS variables.
The 2026-10-16 correction uses a full-width 48px header and a sidebar below it.
Desktop sidebar and workspace share --sidebar-width (208px open, 44px collapsed).
The workspace has an 8px inset and a 22px radius; controls/panels use 12px/16px.
Do not animate sidebar width or workspace margin independently: earlier captures
showed content covered by the sidebar. Geometry tests must assert positions and
elementFromPoint visibility, not merely computed width. Every page has a visible
h1, whose centre must remain unobstructed. Verify the first painted frame too.

At <=800px, use the existing native dialog Drawer for navigation. The trigger
is named 打开导航菜单 and the dialog 主导航. Escape and selecting a route close it;
focus returns to the trigger. Do not replace it with cramped horizontal navigation.
Record actual rendered platform fonts for Chinese text, not only font-family.

Use selectors specific enough for navigation Drawer overrides: `.drawer.navigationDrawer`
and `.modalOverlay[open]:has(.navigationDrawer)` must win over the later generic
`.drawer` and `.modalOverlay[open]` rules. Verify width and alignment in the browser.
The overview NavLink must set `aria-current="page"` for both `/dashboard` and
`/dashboard/`, and clear it on other routes; test current-page state through the
navigation landmark rather than the brand link.

Check light/dark at 1440px and mobile at 375px. Assert document scroll width
does not exceed the viewport; horizontal table scrolling stays in its wrapper.
Review the generated screenshots. See docs/design-system.md for transferable
tokens, spacing, components and Tailwind examples.

## Scope and attribution

Retain MIT upstream attribution in LICENSE.upstream. scripts/prepare-notices.mjs
copies the upstream license and complete runtime dependency licenses into dist/.
Do not copy New API implementation, branding or unrelated user data.
