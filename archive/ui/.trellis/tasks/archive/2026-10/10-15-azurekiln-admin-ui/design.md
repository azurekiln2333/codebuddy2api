# Design

> 2026-10-16: [correction.md](./correction.md) supersedes the original visual
> reference and file ownership. New API Base UI/Tailwind 4 is the primary
> structural reference; implementation is independent. Dashboard screenshots
> require coordinating root review before the unified commit.

## Boundary and evidence
Original web source at fc95b046104ef74e9685066f8338ce01bf9d396b (MIT, copyright 2026 墨菊). Copy only web source/config/tests and license; no node_modules, output, backend or user data. Retain React 19, TS, Zustand, axios, vite-plus and business components. Extract design from the four user-designated study files.

## Data flow
Separate same-origin /sso session client. Only an admin session with nonempty gateway CSRF enters the app. Session memory stores identity/CSRF, never original admin secrets. Both clients send cookies. Admin writes carry X-CSRF-Token. 401 clears identity and returns to SSO sign-in; 403 shows denied/revoked access. Gateway owns provider callback, upstream secrets and static serving. Browser never creates /admin/session.

Pages retain existing /admin axios client and response validation. Log clear confirms destruction, sends scope/kind without api_key. Credential/upstream tokens are business data and remain supported. /admin/settings retains original service configuration semantics.

## UI
Rewrite shell/login in App.tsx. Preserve /dashboard routes, functional components and selectors. Replace theme.scss and ui.module.scss with consistent AzureKiln tokens. System Chinese font stack, visible focus, responsive navigation, contained table overflow. Ship source license and third-party notice in source/build output.

## File ownership
- Root coordinator: migration, package/build/deployment files, docs/tasks/spec, integration fixes, all commits.
- Auth implement agent: src/api.ts, src/App.tsx and auth tests only.
- Visual implement agent: src/theme.scss, src/ui.module.scss, src/appearance.tsx, src/i18n.tsx, index.html only.
- Workflow implement agent: src/components.tsx and log-clear/workflow tests; audit preserved operations.
Agents share workspace, preserve others' edits, never commit/push. Review begins after file owners finish.

## Deployment and rollback
Build static dist for gateway /dashboard/. /sso and /admin stay outside SPA fallback. Atomic dist replacement/previous-artifact rollback; no production deployment in this task. No production mock data. Browser-only fixtures validate contracts. Live acceptance requires configured gateway/provider/admin account.
