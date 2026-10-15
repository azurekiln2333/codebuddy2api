# AzureKiln administration UI

## Goal and authorization
Deliver a standalone deployable administration UI. The user explicitly authorized task creation, planning, immediate implementation, parallel Codex agents/herdr panes, and Conventional Commits after each verified batch. Additional planning/implementation approval is unnecessary. Never push. The original codebuddy2api repository is read-only.

## Requirements
- Preserve real dashboard, credentials/import, models/routing, settings, logs, storage, and upstream account OAuth workflows from the original React/TypeScript web.
- Apply AzureKiln branding and the supplied study: blue #005ab7, background #f7f9fb, white panels, thin borders, 6px controls/10px panels, compact tables, Chinese system fonts. Complete light/dark and phone layouts without gradients/glows/marketing heroes.
- Same-origin gateway SSO only: /dashboard/ UI; / redirects there. GET /sso/session returns authenticated, csrf_token, user (sub, optional username/name, role admin); GET /sso/login?return_to=/dashboard/; gateway owns /sso/callback; POST /sso/logout with X-CSRF-Token.
- Preserve /admin/* contracts. Include credentials; write requests carry gateway nonempty CSRF. Distinguish unauthenticated 401 from denied/revoked 403.
- Browser never requests, accepts or retains the original administrative API Key. /admin/oauth remains account enrollment. Confirm scope=all log deletion; gateway supplies original api_key server-side.
- Preserve loading, empty, failure, retry and real mutation feedback. Publish license/source attribution and deployment instructions.

## Acceptance
- Standalone install, check, tests and production build pass; assets under /dashboard/.
- Automated SSO contract/denial coverage; no API Key sign-in form.
- Core workflow regression tests pass after auth migration; browser checks cover desktop/mobile, themes and gateway requests.
- Deployment docs cover same-origin static hosting, SPA fallback, gateway dependencies and honest live validation limits.
- Only task files committed; original repository untouched; no push.

## Out of scope
Gateway implementation, identity-provider configuration, original repository changes, user data copies, and New API code/branding.
