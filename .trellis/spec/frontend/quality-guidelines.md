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
Desktop sidebar and workspace share --sidebar-width (208px open, 72px collapsed).
Do not animate sidebar width or workspace margin independently: earlier captures
showed content covered by the sidebar. Geometry tests must assert positions and
elementFromPoint visibility, not merely computed width. The visible title block
is the hit target because Dashboard's semantic h1 is visually hidden.

Check light/dark at 1440px and mobile at 375px. Assert document scroll width
does not exceed the viewport; horizontal table scrolling stays in its wrapper.
Review the generated screenshots. See docs/design-system.md for transferable
tokens, spacing, components and Tailwind examples.

## Scope and attribution

Retain MIT upstream attribution in LICENSE.upstream. scripts/prepare-notices.mjs
copies the upstream license and complete runtime dependency licenses into dist/.
Do not copy New API implementation, branding or unrelated user data.
