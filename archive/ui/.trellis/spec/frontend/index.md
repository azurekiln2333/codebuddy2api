# Frontend contracts

As of 2026-10-26, the maintained product is the sibling `codebuddy2api`
repository. Its React/TypeScript console lives in `web/` under `/dashboard/`;
native FastAPI serves SSO, management and inference in one process. This UI
repository retains migration history and Trellis coordination records.
The unified task explicitly authorizes edits to the backend product repository;
the earlier backend-read-only restriction is superseded for this work.

## Pre-development checklist

- Read the active task artifacts and [session contract](./gateway-session.md).
- Run product commands in `../codebuddy2api/web`, not this historical SPA.
- For visual work, read `codebuddy2api/docs/design-system.md` in the product.
- Preserve the existing /admin workflows and API response validation.

## Guidelines

- [Quality guidelines](./quality-guidelines.md)
- [Gateway session and CSRF contract](./gateway-session.md)
- [Historical browser contract](../../../docs/gateway-contract.md)
- Product deployment: `codebuddy2api/docs/deployment.md`.

## Quality check

Run `pnpm check`, `pnpm test`, and `pnpm build`. For authentication, routing,
layout, theme or interactive browser behavior changes, also run
`pnpm exec playwright test`. Follow the assertions in the quality guidelines.
