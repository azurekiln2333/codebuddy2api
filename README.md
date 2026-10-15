# CodeBuddy external OAuth gateway

Standalone administration gateway for an unchanged CodeBuddy FastAPI backend. The existing public domain serves `/dashboard/`, `/sso/*`, `/admin/*` and `/v1/*` through this gateway. Every protected request checks live OIDC UserInfo for the exact administrator role and flag.

Requires Node.js 22+, a separately registered confidential OAuth client, and a private backend. The upstream API key, SSO access/refresh tokens and native backend session cookies stay server-side. Inference requests keep their own original Bearer/X-Api-Key authentication.

```powershell
npm ci
Copy-Item .env.example .env
# Fill deployment-specific values in .env; never commit it.
npm run check
npm run build
npm start
```

UI is an independently built artifact configured with `UI_STATIC_DIR` (development: `D:/My2KProjects/codebuddy2api-ui/dist`). See [frozen UI contract](docs/ui-contract.md), [deployment, client registration and rollback](docs/deployment.md), and [validation evidence](docs/validation.md).

For verification, run `npm test` and `npm run test:backend` after preparing
the isolated Python backend fixture described in [validation evidence](docs/validation.md).
Tests compile to ignored `.tmp/test-build` and use Node's standard runner;
fixture dependencies are not needed to build or start the production gateway.

Sessions are bounded and held in memory in one process. Restart invalidates sessions; run one replica. Production requires HTTPS and Secure cookies. Local HTTP requires explicit loopback-only development opt-in. Real-domain OAuth acceptance requires real client credentials and deployment verification.
