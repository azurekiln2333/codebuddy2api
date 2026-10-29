# Quality guidelines

Run `npm ci`, `npm run check`, `npm run build`, `npm test` and
`npm run test:backend`. Use Node.js 22+, ESM `.js` relative imports,
TypeScript strict mode and `noUncheckedIndexedAccess`. Test scripts first
compile source/tests with `tsconfig.test.json` into ignored `.tmp/test-build`,
then execute emitted JavaScript with `node --test`. Final acceptance does not
use a runtime TypeScript loader; a previous Windows worker-exit libuv assertion
is recorded in `docs/validation.md`. `tsx` remains available for development. Typecheck covers source
and tests; `tsconfig.build.json` emits source only. No separate lint script
exists. Commit the lockfile; Docker builds need both TS configuration files.

Use `node:test`, ephemeral loopback HTTP servers and explicit development
config. Helpers are in `tests/helpers`, synthetic servers in `tests/fixtures`.
Use typed configs/sessions instead of `as never` fixture casts.

Path tests use raw `http.request` targets; `fetch` normalizes traversal before
sending. Assert upstream counters as well as status. SSE tests assert first
chunk before completion and actual unfinished upstream close on disconnect;
cover healthy GET and POST.

`backend.test.ts` starts original FastAPI via `tests/backend/server_fixture.py`
using `.tmp/backend-venv`. Mutable state, databases, bytecode and scratch files
stay outside the reference tree. Missing prerequisites fail with an actionable
message. Inspect original routes and UI callers together before tightening
encoding: model IDs legally contain slash/colon/@.

Review [gateway-security.md](./gateway-security.md), task artifacts and frozen
browser contract. Update validation docs from actual results. Keep mock IdP,
original backend, real UI browser and real provider/container evidence distinct.
Record intercepted browser actions as intercepted. Do not claim Docker,
`nginx -t`, public TLS or real IdP acceptance without running them.

Run affected checks after fixes and one final complete suite before committing.
Stage explicit task paths; exclude unrelated scaffolding, `.env`, `.tmp`,
generated `dist`, dependencies and other repositories' work.
