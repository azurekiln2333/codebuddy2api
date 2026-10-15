# Backend Development Guidelines

> Node.js 22+ / TypeScript gateway contracts, backed by source and HTTP tests.

---

## Overview

The gateway authenticates administrators through OIDC and bridges to an unchanged,
private FastAPI backend. It serves an external UI build; this repository has no UI
source or database. Read the security contract before changing any request path.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Gateway Security](./gateway-security.md) | Live authorization, raw paths, CSRF, secret boundaries and streaming | Implemented |
| [Quality Guidelines](./quality-guidelines.md) | Commands, HTTP regressions, read-only integration fixtures | Implemented |

---

## Pre-Development Checklist

1. Read [Gateway Security](./gateway-security.md), `docs/internal-contract.md`, and
   `docs/ui-contract.md` before changing routes, auth, proxying, or configuration.
2. Read [Quality Guidelines](./quality-guidelines.md) before changing tests.
3. Inspect the original backend route and UI caller before changing encoding;
   model operations use `{id:path}`.
4. Reference repositories are read-only, including caches and runtime state:
   `D:/My2KProjects/codebuddy2api` and `D:/MyNewWebProjects/azurekiln-oauth2`.

## Quality Check

Run `npm run check`, `npm run build`, `npm test`, and `npm run test:backend`.
Use raw HTTP targets for path regressions and assert upstream counters. Review
`docs/validation.md` for coverage and environment limits. Mock IdP results do not
establish real-provider, public-TLS, or container acceptance.

---

**Language**: All documentation should be written in **English**.
