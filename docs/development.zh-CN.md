# 统一应用开发

[首页](../README.zh-CN.md) · [English](development.md)

本仓库包含完整二开应用。`converter.py` 与 `app/` 提供推理网关、原生 OIDC 控制台登录与管理 API；`web/` 是自改 React 控制台。Dockerfile 构建前端并交付单一 Python 运行时。`archive/` 中的旧 UI 与 OAuth 网关只用于历史参考，构建和运行不依赖它们。

## 认证边界

控制台默认以 key 登录启动、SSO 关闭；无需任何 OIDC 配置，OIDC 配置不完整也不再是启动错误。身份提供方配置与准入规则见[部署指南](deployment.zh-CN.md)。

`PANEL_ADMIN_KEY` 即面板密钥：既可登录控制台（换取 HttpOnly 会话 Cookie），也作为 `/admin/*` 的 `Authorization: Bearer` 凭据，后者无需 Cookie 与 CSRF 令牌，因为统一面板是服务端代理。两种用途相互独立：关闭浏览器 key 登录不影响 Bearer 通道。`PLATFORM_TOKEN` 与 `PANEL_KEY` 仍作为别名接受。

原生 SSO 提供 `/sso/config`、`/sso/login`、`/sso/callback`、`/sso/session` 和 `/sso/logout`。采用机密 OIDC 客户端、PKCE S256、与浏览器绑定的一次性 state/nonce 和 RS256 校验。浏览器 Cookie 只有不透明会话 ID，token 与客户端密钥留在后端。每次管理请求通过实时 UserInfo 校验准入白名单：subject 命中 `allowedSubjects`，或邮箱命中 `allowedEmails` 且提供方标记该邮箱已验证。角色与分组声明仅作参考，不再授予访问权；白名单为空则无人被准入。控制台设置为唯一生效来源，保存后对下一次请求生效；环境变量只用于给从未保存过设置的控制台播种。`/v1/*` 独立校验推理密钥，控制台 Cookie 不能授权推理。

控制台只在内存保留身份与 CSRF token。写操作和凭证授权轮询携带 `X-CSRF-Token`，后端校验公开来源；旧 CSRF 开关不能关闭这些检查。清空全部日志必须输入完整的 `清空全部日志与统计`。凭证入库授权是独立于控制台登录的 OAuth 流程。
使用单个 Uvicorn worker。会话和待完成登录有数量上限，保存在内存中，重启即失效。凭证、配置与审计保存在完整的 `auth/` 目录；不同运行实例不得共享该目录。

## 本地检查

在隔离环境中使用 `uv sync --locked` 或带哈希的 `requirements.txt` 安装 Python 依赖，再安装前端锁定依赖：

```bash
python -m pip install --require-hashes --only-binary=:all: -r requirements.txt
pnpm --dir web install --frozen-lockfile
python scripts/check_version.py --check-pyproject --check-compose
python scripts/run_backend_tests.py
pnpm --dir web check
pnpm --dir web test
pnpm --dir web build
pnpm --dir web exec playwright install chromium-headless-shell
pnpm --dir web exec playwright test
pnpm --dir web exec playwright test -c playwright.native.config.ts
```

原生浏览器集成可用 `WEBUI_PYTHON` 指定隔离环境 Python，用 `WEBUI_CHROMIUM` 指定 Chromium。原生套件在回环 TCP 上启动合成 OIDC 提供方和实际后端，使用临时数据验证登录、回调、真实管理请求、CSRF 与退出。默认浏览器套件通过路由模拟独立验证客户端；旧外部集成配置需要专门夹具，不作为 CI 入口。

构建产物包含上游 MIT 许可与依赖许可证全文。检查桌面／移动、浅色／深色截图。自改控制台保留 52px 顶栏、180/64px 侧栏与「正在连接控制台」启动页，详见[设计规范](design-system.md)。

## 发布与部署

`VERSION` 是版本唯一来源；打 `v<VERSION>` tag 前同步 `pyproject.toml`。GitHub Actions 与 CNB 验证应用并生成包含已构建 UI、可重建源码和锁文件的发布包：

```bash
python scripts/package.py
python scripts/package.py --verify dist/<archive>.tar.gz
```

发布包附 SHA-256 sidecar 和供更新器读取的 `SHA256SUMS` 资产，排除本地凭据、环境文件、数据库与 agent 状态。同一 Dockerfile 可构建源码或解压的发布包。稳定版更新 `latest`，览发布版不修改稳定别名；镜像路径来自 fork 仓库上下文。PR 只校验，不登录或推送 registry。

服务器使用 `docker compose pull` 和 `docker compose up -d --no-build`。可选 `auto-update` 只处理本部署启用更新的应用容器；本地构建覆盖文件关闭自动镜像更新。私有 registry 登录、备份与回退见[部署指南](deployment.zh-CN.md)。

## 模拟上游接口

```bash
uv run --locked --no-build python -B -m preview                   # http://127.0.0.1:8790，密钥 preview
uv run --locked --no-build python -B -m preview --port 8790 --data-dir /tmp/cb-preview
```

| 参数 | 默认值 | 作用 |
|------|--------|------|
| `--host` / `--port` | `127.0.0.1` / `8790` | 监听地址 |
| `--api-key` | `preview` | 外部管理推理密钥；也作为兼容模式的初始管理密码 |
| `--data-dir` | 每次新建临时目录 | 跨重启保留览览数据；目录必须为空或由览览服务创建 |
| `--public` | 关闭 | 拒绝不适合共享演示的操作，见[共享接口演示](#共享接口演示与隔离) |
| `--reset-hours` | `0`（不重置） | 运行指定小时后退出，由进程管理器用全新数据重启 |
| 其他参数 | — | 原样传给网关，例如 `--admin-allowed-origins` |

API 地址为 `http://127.0.0.1:8790/v1`，推理密钥为 `preview`（或 `--api-key` 指定值）。览览还览置了展示有效期、IP 和模型限制的普通密钥。

览览沙箱禁止外部网络，后端使用关闭 SSO 的兼容模式，因此不会为本 fork 控制台提供 OIDC 登录。不要在新版 UI 使用本地 `admin` / `preview` 密码。验证控制台请使用上文原生 SSO 集成夹具；开发热更新则运行 `pnpm --dir web dev`，将 `AZUREKILN_GATEWAY_URL` 指向已配置 SSO 的本地网关。

### 模拟范围

网关之下全部是模拟的，网关本身全部是真实代码：请求、故障转移、冷却、计费、审计记录和后台自动化都与正式运行一致。

| 方面 | 表现 |
|------|------|
| 账号 | 8 个合成账号：国内与国际、CodeBuddy 与 WorkBuddy、不限额与按额度计的企业租户，以及一个刷新令牌已失效的掉线账号 |
| 历史 | 一个月的请求记录，概览、日志和统计打开即有数据 |
| 余额 | 不同到期时间的积分包；请求会消耗，签到、旅行、任务和体验积分会增加 |
| 模型 | 按区域区分的模型目录，包含倍率、能力和上限 |
| 媒体 | 览置图片和视频，支持模拟生成；公开模式的媒体与模型写操作受览览保护层限制 |
| 推理 | Chat Completions、Responses 和 Anthropic Messages 都会流式返回引用你消息的模拟回复，支持推理的模型带推理内容 |
| 自动化 | 签到、Buddy 旅行（一趟 3 分钟）、成长任务、体验积分和国际站活跃打卡 |
| 登录 | 添加账号会在 4 秒后自动登录一个新的合成账号；界面上显示的官方登录链接无需打开 |
| 搜索、抓取与 MCP | `/v1/search`、`/v1/fetch` 及 MCP 的 `web_search`／`web_fetch` 工具返回 `example.com` 上的模拟结果 |
| 更新 | 发布列表只有当前版本，镜像测速下载的是模拟发布包，安装已停用 |

上游状态保存在内存里，每次启动都会重置；网关自己的数据保存在数据目录中。

### 消息指令

在最后一条用户消息里任意位置写入指令，可以控制模拟模型的行为：

| 指令 | 效果 |
|------|------|
| `[preview:tool]` / `[preview:tool=Name]` | 用占位参数调用第一个或指定名称的工具。没有这条指令时绝不调用工具，因为客户端可能会执行收到的任何工具调用 |
| `[preview:429]` | 返回带额度恢复时间的 429，触发冷却和故障转移 |
| `[preview:500]` | 返回上游服务错误 |
| `[preview:slow]` | 慢速流式输出，便于观察实时流 |
| `[preview:long]` | 追加一段很长的编号列表 |

### 共享接口演示与隔离

`--public` 限制管理写操作、凭证导入导出、日志清理、归档与更新。`--reset-hours` 让进程按时退出，由进程管理器用全新数据重启。这些选项作用于模拟 API 服务，不会新增 SSO 登录或可公开访问的浏览器演示。公开的 `preview` 密钥不可用于真实部署。

- 览览服务从不读取仓库的 `.env` 或 `auth/`：它会清除环境中所有 `CODEBUDDY*` 变量，只在自己的数据目录中运行，并拒绝使用 `auth/`。
- 所有 httpx 请求都由模拟上游应答；其他对外连接和域名解析一律拒绝，绕过 httpx 的活跃打卡通道也被替换。未模拟的接口返回 501，并在日志中记录一次 `[preview] 未模拟的上游接口`。
- 一键更新已停用，工作区文件不会被替换。
