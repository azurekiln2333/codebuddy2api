# Frontend contracts

This repository is a standalone React/TypeScript SPA under `/dashboard/`.
The original codebuddy2api backend is outside this repository and read-only.

## Pre-development checklist

- Read the active task artifacts and [session contract](./gateway-session.md).
- For visual work, read [design-system.md](../../../docs/design-system.md).
- Preserve the existing /admin workflows and API response validation.

## Guidelines

- [Quality guidelines](./quality-guidelines.md)
- [Gateway session and CSRF contract](./gateway-session.md)
- [Public gateway contract](../../../docs/gateway-contract.md)
- [Deployment and validation limits](../../../docs/deployment.md)

## Quality check

Run `pnpm check`, `pnpm test`, and `pnpm build`. For authentication, routing,
layout, theme or interactive browser behavior changes, also run
`pnpm exec playwright test`. Follow the assertions in the quality guidelines.
