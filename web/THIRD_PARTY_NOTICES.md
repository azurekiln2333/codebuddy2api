# Third-Party Notices

This file covers the CodeBuddy2Api management console in `web/`. That console is
part of the CodeBuddy2Api repository and is distributed with it. Versions are
pinned in `web/package.json` and `web/pnpm-lock.yaml`.

It records attribution and license information for distributed build output. For
any dependency not listed here, refer to the license text shipped inside that
package in `node_modules` and to the lockfile. The build step
(`scripts/prepare-notices.mjs`) collects the complete runtime dependency license
text into `dist/THIRD_PARTY_LICENSES.txt`. If you redistribute the production
build, retain that file together with this one.

---

## Original web console provenance

The console descends from the original **codebuddy2api** web administration UI.

- Source: `codebuddy2api` web UI
- Commit: `fc95b046104ef74e9685066f8338ce01bf9d396b`
- License: MIT
- Copyright: Copyright (c) 2026 墨菊
- Full text: [`LICENSE.upstream`](LICENSE.upstream) (verbatim, kept with this UI)

Modifications made in this repository: unified CodeBuddy2Api branding, migration
from browser administrative-key login to same-origin gateway SSO, removal of the
browser-supplied administrative key from log clearing, and a redesigned loading
screen, sign-in page and console shell. The current repository is the product; no
separate upstream checkout is required to build or run it.

---

## Design provenance

The visual specifications (top-bar and sidebar geometry, two-column sign-in
composition, restrained network diagram, colour and radius scale) were derived
from the observable design of a separate administration panel. Only dimensions,
spacing, colour values and layout relationships were used as a design brief; no
source code, stylesheet or business component from that project was copied, and it
is not a dependency. That reference project is distributed under AGPL-3.0-only;
this project remains MIT and does not include AGPL code.

---

## Runtime dependencies

| Package      | Version | License | Use                                                   |
| ------------ | ------- | ------- | ----------------------------------------------------- |
| axios        | 1.20.0  | MIT     | HTTP client for `/sso` and `/admin`.                  |
| fflate       | 0.8.3   | MIT     | ZIP decompression for credential import/export.       |
| react        | 19.2.4  | MIT     | UI runtime.                                           |
| react-dom    | 19.2.4  | MIT     | DOM renderer.                                         |
| react-router | 7.18.2  | MIT     | Client-side routing.                                  |
| zustand      | 5.0.15  | MIT     | Lightweight state stores (session, appearance, etc.). |
| @fontsource-variable/dm-sans | 5.3.0 | OFL-1.1 | Locally served interface font. |
| @fontsource-variable/jetbrains-mono | 5.3.0 | OFL-1.1 | Locally served code and identifier font. |

DM Sans and JetBrains Mono are bundled and served from the gateway, with no
external font request. Chinese text uses the system fallback families. Their
complete OFL license texts are included in `THIRD_PARTY_LICENSES.txt`.

## Development dependencies

Used to build and test the console. They are not intended to be redistributed as
part of the static application bundle, but they may appear in development tooling
output (for example source maps). Licenses are as published by each project.

| Package                | Version | License    | Use                     |
| ---------------------- | ------- | ---------- | ----------------------- |
| @playwright/test       | 1.63.0  | Apache-2.0 | Browser contract tests. |
| @testing-library/react | 16.3.3  | MIT        | Component tests.        |
| @types/node            | 22.20.2 | MIT        | TypeScript types.       |
| @types/react           | 19.3.0  | MIT        | TypeScript types.       |
| @types/react-dom       | 19.3.0  | MIT        | TypeScript types.       |
| jsdom                  | 30.0.1  | MIT        | Test DOM environment.   |
| sass                   | 1.104.1 | MIT        | SCSS compilation.       |
| typescript             | 6.0.2   | Apache-2.0 | Type checking.          |
| vite-plus              | 0.3.1   | MIT        | Build/dev/test tooling. |

> License identifiers above reflect the licenses declared by each package at the
> pinned version. Verify against the installed package's `LICENSE` file when
> producing a formal distribution notice; package metadata can change between
> versions.

---

## Notes on bundled output

- The production build inlines application code and CSS only. Third-party
  runtime code is bundled by the build tool.
- `LICENSE.upstream`, this file and the generated `THIRD_PARTY_LICENSES.txt` are
  the attribution documents for the console. Ensure they accompany any
  redistribution of source or build output.
- No New API code or branding and no AGPL reference-panel code is included.
