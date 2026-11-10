# codebuddy2api

Use your **WorkBuddy / CodeBuddy (Tencent)** subscription as local **OpenAI- and Anthropic-compatible APIs**. This fork includes a console with key and optional native OAuth2/OIDC login, and image delivery in one repository.

[中文文档](README.zh-CN.md)

- Chat Completions, Responses and Anthropic Messages, with tool calling and streaming.
- Compatible tool-schema and channel handling across all three inference protocols.
- Built-in **WebUI** with key or organization SSO login, models, credentials, logs and settings — no separate UI or authentication-gateway deployment.
- Automatic multi-account routing across domestic and international sites, with credential refresh.
- Per-account automation: domestic personal accounts check in and dispatch Buddy travel by default, with independent switches; international check-in is opt-in. The growth center is personal-only: finished tasks are claimed automatically, with per-task switches for behavior chains; enterprise accounts are excluded.

Development includes a simulated upstream without real credentials; the console is tested with a native OIDC fixture. See [development and tests](docs/development.md).

## Quick start

Requires Git and Docker Compose. Publish this fork using its GitHub or CNB workflow, then deploy that repository's image. The application image contains the backend and compiled console.

```bash
git clone https://github.com/azurekiln2333/codebuddy2api.git
cd codebuddy2api
cp .env.example .env
```

Edit `.env`: choose your published image, set a random inference API key, and set the panel key that logs into the console. Everything else is configured in the console itself. Preserve an existing `.env` on upgrades:

```dotenv
CODEBUDDY2API_IMAGE=ghcr.io/azurekiln2333/codebuddy2api:latest
CODEBUDDY2API_KEY=replace-with-a-random-inference-key
PANEL_ADMIN_KEY=replace-with-a-random-panel-key
```

Sign in with `PANEL_ADMIN_KEY`. SSO is optional: open **Settings → Authentication**, fill in the provider and the admission allow-list, and the change applies without a restart. In a unified deployment the same `PANEL_ADMIN_KEY` is what the panel uses as its management bearer.

```bash
docker compose pull
docker compose up -d --no-build
```

Compose pulls `latest` by default (`CODEBUDDY2API_IMAGE=ghcr.io/azurekiln2333/codebuddy2api:latest`); images also publish the release version (for example `1.5.8`) and `edge` for `main`. Pin a version tag for reproducible deployments; image features belong to that version, not to unmerged source branches.

First use:

1. Open **`<PUBLIC_ORIGIN>/dashboard/`** and sign in through your organization identity provider with an authorized administrator account.
2. In **Credentials**, add a domestic or international account through browser login, import an `.info` file, or paste refresh tokens for a chosen endpoint.
3. In **Keys**, create an inference key for each client and assign its model, IP, expiry and rate limits.
4. In **Models**, find an available model and use its public ID in your client.

The template binds to localhost. Serve the configured public origin over HTTPS using your reverse proxy, and keep the complete `auth/` data directory. The [deployment guide](docs/deployment.md) covers CNB images, local builds, scoped automatic updates and version rollback.

For automatic image checks and updates, enable the included updater profile:

```bash
docker compose --profile auto-update up -d --no-build
```

It selects this application's labeled containers. Follow `latest` for stable updates, or pin a version for controlled upgrades. Back up persistent data before upgrading across schema versions.

## Client setup

| Protocol | Base URL |
|----------|----------|
| OpenAI Chat / Responses | `http://127.0.0.1:8787/v1` |
| Anthropic Messages | `http://127.0.0.1:8787` |
| MCP (web_search + web_fetch) | `http://127.0.0.1:8787/v1/mcp` |
| REST web search / fetch | `POST http://127.0.0.1:8787/v1/search` / `POST http://127.0.0.1:8787/v1/fetch` |
| Image & video generation | `POST http://127.0.0.1:8787/v1/images/generations` / `POST /v1/images/edits` / `POST /v1/videos` |

- Media generation is billed per upstream credit and only routes to verified account products; see [Media generation](docs/clients.md#media-generation).

- **API key:** use a key created in **Keys**, or the externally configured admin key. The WebUI management Cookie cannot call `/v1/*`. The browser console signs in independently with `PANEL_ADMIN_KEY` or, when enabled, SSO.
- **Model:** a public ID from the WebUI or `GET /v1/models`.
- All accounts share these URLs; no region parameter is needed. Anthropic SDKs append `/v1/messages` themselves, so leave it out of the Base URL.
- The search and fetch endpoints never call a model. Declaring Anthropic `web_search_*` / `web_fetch_*` or OpenAI `web_search` server tools makes the gateway execute them itself. See [Web search and fetch](docs/clients.md#web-search-and-fetch).
- Tool parameters: across all three inference protocols, an empty parameter root becomes an object schema. Legacy field maps with boolean `required` flags are wrapped in `properties`, with required names collected at the root. A schema keyword such as `pattern` still counts as a field name when it holds a field. Standard schemas, roots with `$`/`x-` extensions, and nested schemas are left untouched.

[Codex CLI, Claude Code / CC Switch and other client examples →](docs/clients.md)

## Project structure

```
.
├── converter.py         # Gateway entry: protocol adaptation, routing, scheduling
├── app/                 # Management API, credentials, catalogs, audit and policy modules
├── web/                 # WebUI frontend (React/TypeScript; build output served by the gateway)
├── tests/               # Offline regression suites
├── preview/             # Development preview: real gateway, simulated upstream, synthetic accounts
├── docs/                # User guides, English and Chinese
├── examples/            # Client configuration examples
├── scripts/             # Version checks, release packaging and dependency-lock tooling
├── Dockerfile           # Multi-stage image: frontend build + Python runtime
├── docker-compose.yml   # Published image deployment and scoped update profile
├── docker-compose.build.yaml # Local image build override
├── .env.example         # Every runtime environment variable, annotated
├── .cnb.yml             # CNB validation, release archives and image publication
└── .github/workflows/   # GitHub validation, releases, images and CodeQL
```

## Documentation

| Guide | Contents |
|-------|----------|
| [WebUI guide](docs/webui.md) | Accounts, model routing, audit logs, settings and backups |
| [Deployment](docs/deployment.md) | Published images, upgrades, reverse proxy/HTTPS, local setup and CLI login |
| [Client configuration](docs/clients.md) | Codex CLI, Claude Code, CC Switch and generic clients |
| [Advanced reference](docs/advanced.md) | Options, APIs, model scheduling, request limits and troubleshooting |
| [Development](docs/development.md) | Unified architecture, local checks, native SSO integration and releases |

## FAQ

- **Console sign-in fails behind a reverse proxy?** Check `PUBLIC_ORIGIN`, the identity provider's exact `/sso/callback` redirect URI and HTTPS. If SSO refuses you, confirm your subject or verified e-mail is in the allow-list under **Settings → Authentication**. See the [deployment guide](docs/deployment.md).
- **No Docker?** Build `web/`, install the locked Python dependencies and run `converter.py` with the same `PANEL_ADMIN_KEY`. See [Local Python setup](docs/deployment.md#local-python-setup).
- **Where is my data?** Everything lives in `auth/` (or `/data/auth` in Docker): credentials, settings and log databases — see [Data and backups](docs/webui.md#data-and-backups).
- **Which image tag should I use?** `latest` follows stable releases, GitHub's `edge` follows main, and version tags select a release — see [Published images](docs/deployment.md#use-published-images).
- **Responses tool output/arguments compressed or need verbatim passthrough?** Set `responses_projection_mode` (default `balanced`, or `passthrough` to disable projection) and `responses_projection_max_bytes` (default `40000`, `0` disables per-item trimming). Balanced trimming keeps the head/tail and reports original bytes, estimated tokens and total lines; client addresses stay unchanged — see [Responses projection](docs/clients.md#responses-projection) and [details](docs/advanced.md#responses-projection).

## Disclaimer

For personal learning only — no commercial use. Not affiliated with Tencent, WorkBuddy, CodeBuddy, OpenAI, or Anthropic. This project only calls official APIs of accounts you are logged into; use it solely with subscriptions you legally own. You are solely responsible for your account, credentials, and all associated risks.

## License

[MIT](LICENSE)

Derived from the original [codebuddy2api](https://github.com/maiphucgiang/codebuddy2api). The upstream license is retained. The console's visual design follows the local cnb2api-panel reference through a React implementation; dependency notices accompany the built console.

## Community

Thanks to the [LINUX DO](https://linux.do) community for providing an open and friendly platform for technical discussions.
