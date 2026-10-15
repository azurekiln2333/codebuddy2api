# Third-Party Notices

This project (**AzureKiln Administration UI**) bundles and/or depends on the
third-party software listed below. Versions are pinned in `package.json` and
`pnpm-lock.yaml`.

This file records attribution and license information for distributed build
output. For any dependency not listed here, refer to the license text shipped
inside that package in `node_modules` and to the lockfile. If you redistribute
the production build, retain this file.

---

## Upstream derivative work

This project is a derivative of the **codebuddy2api** web administration UI.

- Source: `codebuddy2api` web UI
- Commit: `fc95b046104ef74e9685066f8338ce01bf9d396b`
- License: MIT
- Copyright: Copyright (c) 2026 墨菊
- Full text: [`LICENSE.upstream`](LICENSE.upstream) (verbatim, repository root)

The original project is not modified by this repository. AzureKiln branding,
styling, and the gateway SSO authentication migration are modifications made here.

---

## Runtime dependencies

| Package | Version | License | Use |
| --- | --- | --- | --- |
| axios | 1.20.0 | MIT | HTTP client for `/sso` and `/admin`. |
| fflate | 0.8.3 | MIT | ZIP decompression for credential import/export. |
| react | 19.2.4 | MIT | UI runtime. |
| react-dom | 19.2.4 | MIT | DOM renderer. |
| react-router | 7.18.2 | MIT | Client-side routing. |
| zustand | 5.0.15 | MIT | Lightweight state stores (session, appearance, etc.). |

## Development dependencies

These are used to build and test the project. They are not intended to be
redistributed as part of the static application bundle, but they may appear in
development tooling output (for example source maps). Licenses are as published
by each project.

| Package | Version | License | Use |
| --- | --- | --- | --- |
| @playwright/test | 1.63.0 | Apache-2.0 | Browser contract tests. |
| @testing-library/react | 16.3.3 | MIT | Component tests. |
| @types/node | 22.20.2 | MIT | TypeScript types. |
| @types/react | 19.3.0 | MIT | TypeScript types. |
| @types/react-dom | 19.3.0 | MIT | TypeScript types. |
| jsdom | 30.0.1 | MIT | Test DOM environment. |
| sass | 1.104.1 | MIT | SCSS compilation. |
| typescript | 6.0.2 | Apache-2.0 | Type checking. |
| vite-plus | 0.3.1 | MIT | Build/dev/test tooling. |

> License identifiers above reflect the licenses declared by each package at the
> pinned version. Verify against the installed package's `LICENSE` file when
> producing a formal distribution notice; package metadata can change between
> versions.

---

## Notes on bundled output

- The production build inlines application code and CSS only. Third-party
  runtime code is bundled by the build tool.
- `LICENSE.upstream` and this file are attribution documents for the derivative
  work. Ensure both accompany any redistribution of source or build output.
- No New API code or branding is included in this project.
