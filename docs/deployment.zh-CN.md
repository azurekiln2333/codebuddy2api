# 部署指南

[首页](../README.zh-CN.md) · [English](deployment.md)

日常账号、模型与日志管理优先使用 [WebUI](webui.zh-CN.md)。以下命令均在仓库根目录执行。

Docker 部署需要 **Docker Compose v2**（`docker compose`）。已废弃的 `version:` 键已移除，可选更新服务使用 profile，因此不再支持 Compose v1 / `docker-compose`。

## 配置与数据

首次部署运行 `cp .env.example .env`，并将 `CODEBUDDY2API_KEY` 设置为自己的随机密钥。它用于推理；控制台通过下方配置的 OIDC/SSO 登录。已有 `.env` 请保留，只按需追加配置。

| 配置 | 作用 |
|------|------|
| `CODEBUDDY2API_IMAGE` | 要拉取的 Compose 镜像；模板指向本 fork，不得使用上游作者仓库 |
| `CODEBUDDY2API_SSO_ENABLED` / `PUBLIC_ORIGIN` / `OIDC_*` / `ALLOW_INSECURE_LOCALHOST` | 控制台登录，见[控制台登录](#控制台登录oidc) |
| `WATCHTOWER_POLL_INTERVAL` | 自动检查镜像的间隔秒数；默认 `600` |
| `CODEBUDDY2API_BIND` / `CODEBUDDY2API_PORT` | 本地监听与 Compose 宿主机映射；默认 `127.0.0.1:8787` |
| `CODEBUDDY2API_AUTH_PATH` | Compose 宿主机数据目录；默认 `./auth`，挂载到容器 `/data/auth` |
| `TZ` | 容器时区；每日任务按它跨天，未设置时保持 UTC |
| `CODEBUDDY2API_ENV_FILE` | 可选的 Compose 覆盖项，指定 env 文件路径；默认 `.env` |
| `CODEBUDDY2API_ALLOW_OPEN_NOAUTH` | 镜像与 Compose 的兼容选项，在其中固定为 `true`。仅当没有任何外部或数据库密钥时，无论是否携带占位 token，都会匿名开放推理**及账号池 billing**；存在任意密钥记录即失效 |
| `CODEBUDDY2API_TRUSTED_PROXIES` | 可信代理 IP/CIDR（逗号分隔）；直连地址命中时审计改记 `X-Forwarded-For`/`X-Real-IP` 里的真实客户端地址，而不是代理地址 |
| `CODEBUDDY_AUTH_DIR` | 本地 Python 数据目录；默认仓库内 `auth/`。Compose 在容器内固定为 `/data/auth` |
| `CODEBUDDY_IMPORT_DIR` | 可选导入目录；默认数据目录下的 `imports/`。Compose 中请使用容器路径 |

`.env.example` 列出了全部生效的运行时变量及其默认值。Compose 会整体加载该文件，注释掉的键仍可在 WebUI 配置（工具元数据、Responses 投影、来源白名单、故障转移等）。取零表示关闭聚合/并发限制、Responses 单项裁剪或额外重试，而入站上限必须为正值。

Compose 会把 `.env` 加载进容器；镜像、宿主机映射与数据路径仍以 shell 变量优先。默认宿主机映射仅回环。开放远程访问前请设置随机密钥、HTTPS 与访问限制。容器内监听保持 `0.0.0.0:8787`；调整对外暴露用 `BIND/PORT`，不要改容器监听参数。

数据目录需整体挂载在可写本地存储，不要只挂载单个 SQLite 文件，也不要在多个实例间共享。升级前停止网关并备份整个目录，见[数据与备份](webui.zh-CN.md#数据与备份)。

## 控制台登录与准入

首次 `docker compose up` 之前无需配置任何 SSO 值。控制台默认以 key 登录启动、SSO 关闭；OIDC 配置不完整不再是启动错误。

`PANEL_ADMIN_KEY` 是部署唯一必须提供的凭据（12 位以上），有两种用途且相互独立：

- **控制台登录**：登录页填写该 key，换取 HttpOnly 会话 Cookie；写操作还需会话接口返回的 CSRF 令牌。
- **面板 Bearer**：携带 `Authorization: Bearer <PANEL_ADMIN_KEY>` 的 `/admin/*` 请求无需 Cookie 与 CSRF 令牌，因为统一面板是服务端代理而非浏览器。关闭浏览器 key 登录不会撤销此通道。

`PLATFORM_TOKEN` 与 `PANEL_KEY` 仍作为别名接受，但两者同时存在时 `PANEL_ADMIN_KEY` 优先。长度不足 12 位的值按未设置处理，而不是降级成弱凭据。统一部署中所有控制台使用同一个值。

### 在控制台配置 SSO

SSO 在浏览器「设置」里管理，不在环境变量里。保存后立即对下一次请求生效：无需重启、无需重建容器。设置文档保存提供方名称、签发方、客户端 ID 与 secret（只写；接口只返回 `hasClientSecret`）、scope、回调地址与准入名单。

| 字段 | 作用 |
|------|------|
| 提供方名称 | 登录页按钮文字，默认 `SSO` |
| 签发方 | HTTPS discovery 与 JWKS 地址；保存前会校验 discovery |
| 客户端 ID / 客户端 secret | 机密客户端凭证；浏览器不会拿到 secret。需登记回调地址 `<PUBLIC_ORIGIN>/sso/callback` 并授予 `openid profile email` |
| Scope | 必须包含 `openid` |
| 回调地址 | 覆盖跳转基址；留空则由 `PUBLIC_ORIGIN` 或当前请求推导 |
| 允许的 subject / 允许的邮箱 | 准入白名单，见下节 |

关闭浏览器 key 登录需要一条在同一配置下建立的活跃 SSO 会话，因此不会把自己锁在外面。两种方式可同时开启，但至少要保留一种。

### 准入改为白名单

只有 subject 出现在 `allowedSubjects`，或邮箱出现在 `allowedEmails` **且**提供方标记该邮箱已验证时，SSO 身份才被准入。角色与分组声明不再授予访问权——声明不是本服务能审计的运维决定。白名单为空则无人被准入，因此启用 SSO 至少需要一条记录。

### 环境变量只是一次性种子

`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、`CODEBUDDY2API_SSO_ENABLED`、`CODEBUDDY2API_SSO_ALLOWED_SUBJECTS` 与 `CODEBUDDY2API_SSO_ALLOWED_EMAILS` 只用于给从未保存过设置的控制台播种。数据目录里一旦有设置，这些变量即被忽略。`PUBLIC_ORIGIN` 不是种子，每次启动都会读取：控制台换域名只需改这个值，除非控制台里另填了回调地址。没有白名单的种子只会带入提供方参数，SSO 仍保持关闭。请独立于其他密钥生成 `PANEL_ADMIN_KEY`；`CODEBUDDY2API_KEY` 仍是推理凭证，控制台不会使用它。

| 配置 | 作用 |
|------|------|
| `PANEL_ADMIN_KEY` | 控制台登录 key 与 `/admin/*` Bearer；带控制台的部署必须设置 |
| `CODEBUDDY2API_SSO_ENABLED` | 仅播种：`true` 播种为开启（仍需白名单），默认 `false` |
| `PUBLIC_ORIGIN` | 浏览器访问的公网 HTTPS 源，末尾不带斜杠；Origin 白名单与跳转基址 |
| `OIDC_ISSUER` | 仅播种：提供 HTTPS discovery 与 JWKS 的签发方 |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | 仅播种：机密客户端凭证 |
| `CODEBUDDY2API_SSO_ALLOWED_SUBJECTS` / `CODEBUDDY2API_SSO_ALLOWED_EMAILS` | 仅播种：逗号分隔的准入名单 |
| `OIDC_REFRESH` | 设为 `true` 时申请 `offline_access` 并启用轮换刷新令牌 |
| `ALLOW_INSECURE_LOCALHOST` | 仅回环开发用的明文 HTTP 逃生门（含签发方）；生产必须保持 `false` |
| `SESSION_TTL_MS` / `SESSION_IDLE_MS` / `TRANSACTION_TTL_MS` / `MAX_SESSIONS` / `OAUTH_TIMEOUT_MS` | 可选会话调优（留空则用默认值）；`SESSION_IDLE_MS` 大于 `SESSION_TTL_MS` 时启动失败 |

不再需要为「不带控制台运行」设置 `CODEBUDDY2API_SSO_ENABLED=false`，在「设置」里保持 SSO 关闭即可。
## Docker Compose

### 使用已发布镜像

在 `.env` 中将 `CODEBUDDY2API_IMAGE` 设为自己的 fork 已发布镜像。模板默认指向本 fork 的 GHCR 路径；部署到别处时替换其中的 owner 即可。两个平台发布的发行版标签集合相同：

```dotenv
# GitHub fork
CODEBUDDY2API_IMAGE=ghcr.io/<github-owner>/codebuddy2api:latest
# CNB fork（仓库 slug 本身已包含仓库名）
CODEBUDDY2API_IMAGE=docker.cnb.cool/<cnb-repo-slug>:latest
```

随后直接拉取并启动，宿主机不做任何构建：

```bash
docker compose pull
docker compose up -d --no-build
```

工作流面向 `linux/amd64` 与 `linux/arm64`。`latest` 只跟随稳定发行版，`X.Y.Z` 选择稳定发行版，`vX.Y.Z-<pre>` 选择预发布版。GitHub 还从 main 发布 `edge`；CNB 的 main 执行校验与打包，版本标签触发镜像发布。功能以所选版本为准。首次使用拉取命令前须先发布本 fork 镜像，此前可使用本地构建覆盖配置。

镜像内置基于 `/health` 的存活健康检查。用 `docker compose ps`（状态应变为 `healthy`）或 `docker inspect --format '{{.State.Health.Status}}' codebuddy2api` 确认。

### Registry 认证

公开的 GHCR 包可直接匿名拉取。私有包或其它 registry 需在宿主机先登录一次：

```bash
# GHCR：使用带 read:packages 的 classic PAT
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

# CNB：使用仓库或平台设置里的 CNB_TOKEN
echo "$CNB_TOKEN" | docker login docker.cnb.cool -u cnb --password-stdin
```

凭证不要写进 `.env` 或 Compose 文件，交由宿主机 Docker 凭证存储管理。

宿主机登录**不会**被更新服务看到：`docker login` 写的是宿主机的 `~/.docker/config.json`，而更新器在自己的容器里运行、有自己的文件系统，因此默认 Compose 文件不挂载任何凭证。镜像仓库需要认证、同时又要自动更新时，增加一份本地覆盖文件。把它保存为与 `docker-compose.yml` 同目录的 `docker-compose.registry.yaml`（不要提交），并用两个文件启动：

```yaml
services:
  watchtower:
    volumes:
      # 未设置 DOCKER_CONFIG 时，更新器从 /config.json 读取配置。
      - ${HOME}/.docker/config.json:/config.json:ro
```

```bash
docker compose -f docker-compose.yml -f docker-compose.registry.yaml --profile auto-update up -d
```

仅在宿主机文件确实存在时加这份覆盖：绑定挂载源不存在时 Docker 会创建目录，更新器将无法读取配置。Windows 不展开 `${HOME}`，请写绝对路径，或用 `DOCKER_CONFIG` 指向存放该文件的目录。

宿主机的 `config.json` 若依赖凭证助手（`credsStore` / `credHelpers`），助手二进制必须存在于更新器容器内，因为镜像本身不包含任何助手。可以挂载助手并调整 `HOME`/`PATH`，或改用一份只含该 registry 凭证的最小 `config.json` 挂进去：

```json
{ "auths": { "ghcr.io": { "auth": "<base64 user:token>" } } }
```

这份文件不要放进仓库。不加覆盖文件时，更新服务无法拉取私有镜像，但应用容器从手动拉取的镜像启动仍然正常。

### 构建当前源码

独立覆盖文件让 `build:` 不进入默认文件，纯拉取部署不可能被静默改成本机编译：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yaml up -d --build
```

构建包含控制台，宿主机无需 Node.js 与 Python。打开 `http://127.0.0.1:8787/dashboard` 通过身份提供方登录。本地构建的镜像被标记为不参与更新服务，因为重新构建才是该镜像更新的唯一方式。

### 自动镜像更新

更新服务默认不启动，只有显式请求其 profile 时才运行：

```bash
docker compose --profile auto-update up -d
```

它每 `WATCHTOWER_POLL_INTERVAL` 秒（默认 `600`）检查一次 registry，且只处理带本项目更新标签的容器。更新器不会更新自身；不同部署目录或 `-p` 项目名对应不同 scope，因此同一台机器上的两套部署不会互相选中对方的容器。

只有当镜像 digest 变化时它才重建容器。重建后健康检查通过仅说明应用存活，不代表账号或模型可用，也没有自动回滚应用的能力。

停用自动更新：不启用 profile，或停掉正在运行的更新器：

```bash
docker compose --profile auto-update stop watchtower
docker compose --profile auto-update rm -f watchtower
```

使用固定的发行版标签（`:X.Y.Z`）只是缩小影响范围，并不等于冻结镜像：标签是可变的，重新发布同一标签会用新 digest 覆盖它，更新器照旧会部署新 digest。需要绝对固定时请改用 digest：用 `docker inspect --format '{{index .RepoDigests 0}}' codebuddy2api` 或发行说明取得 digest，把 `CODEBUDDY2API_IMAGE` 设为 `<registry>/codebuddy2api@sha256:<digest>`。digest 引用不会改变，对它的检查始终是空操作；推荐的冻结做法是冻结单个部署，而项目其它地方继续跟随 `latest`。

### 升级与重建

修改 `.env` 后重新执行 `docker compose up -d` 以重建配置发生变化的容器。仅执行 `docker compose restart` 不会应用新的环境变量。数据目录会跨重建保留账号、凭证与数据库；控制台登录会话只存在内存中，因此重建、重启或自动更新后所有人都需重新登录。

使用发布镜像时，手动升级永远两步：

```bash
docker compose pull
docker compose up -d --no-build
```

### 回退

固定上一个发行版并重建：

```bash
# 1. 先停应用，再动数据。
docker compose down
# 2. 把 .env 里的镜像改回上一个稳定版。
#    CODEBUDDY2API_IMAGE=<registry>/codebuddy2api:X.Y.Z
docker compose pull
docker compose up -d --no-build
```

控制库只能向前迁移：旧镜像无法读取新版写过的数据库。回退跨过 schema 变更时，必须停机、用升级前的整份 `auth/` 备份覆盖、再启动旧镜像。不要在运行中的实例下回滚数据库，也不要用过期备份覆盖升级后产生的领取、派遣或会话撤销。若开着更新 profile，先固定目标 —— digest 引用不会移动，而重新发布的版本标签会 —— 否则更新器会把新镜像再拉回来。

控制台「更新」页也能安装本 fork 的发布包，详见[更新](webui.zh-CN.md#版本更新)。容器内安装写入容器可写层；重新创建容器后恢复镜像版本。生产部署仍建议使用上面的镜像拉取与重建流程。

## 反向代理与 HTTPS

默认的回环映射是唯一无需额外工作的安全暴露方式。将应用放到域名反代之后时，[`nginx.example.conf`](nginx.example.conf) 是现成示例：TLS 终结、不缓冲不压缩的流式转发，以及绝不记录 `/sso/callback` 查询串的访问日志格式。

- 在反代终止 TLS，并转发原始 Host 与协议（nginx 配置 `proxy_set_header Host $http_host` 与 `X-Forwarded-Proto $scheme`）。
- `PUBLIC_ORIGIN` 必须等于浏览器实际使用的源，且反代必须原样转发原始 Host 与协议（nginx 配置 `proxy_set_header Host $http_host` 与 `X-Forwarded-Proto $scheme`）。反代改写它们时（例如域名 HTTPS 访问而容器内看到 HTTP），控制台登录会报 Origin 校验失败。此时应修正转发的头部，而不是放宽校验：开启控制台登录后，`PUBLIC_ORIGIN` 是唯一被接受的管理来源，额外来源设置不再适用。
- 任何非回环暴露都必须配置外部推理凭证（`CODEBUDDY2API_KEY`）或数据库密钥；控制台登录不能代替它在 `/v1/*` 上的作用。

## 本地 Python 运行

需要 Python 3.12+ 与 uv。仅在发行包未自带界面时才需构建：Node.js 24 与 `web/package.json` 中 `vite-plus` 锁定的 vp CLI。

```bash
uv sync --locked --no-build --python 3.12
(cd web && vp install --frozen-lockfile && vp build)
uv run --locked --no-build converter.py --host 127.0.0.1 --port 8787
```

`uv.lock` 过期时 `--locked` 会直接失败而不是重新解析，因此源码启动不会升级依赖。当前工作目录的 `.env` 会被自动读取，`uv run` 无需 `--env-file`。发行包已包含 WebUI，可跳过界面构建。

这种零配置模式只是 API 兼容模式，控制台无需任何 SSO 配置即可使用：设置 `PANEL_ADMIN_KEY` 并用它登录，本机回环也一样。想在本机用 SSO，则在「设置 → 认证」里启用，或导出 `CODEBUDDY2API_SSO_ENABLED=true`、`PUBLIC_ORIGIN=http://127.0.0.1:8787`、`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_CLIENT_SECRET`、白名单（`CODEBUDDY2API_SSO_ALLOWED_SUBJECTS` 或 `CODEBUDDY2API_SSO_ALLOWED_EMAILS`）与 `ALLOW_INSECURE_LOCALHOST=true`，并在身份提供方注册回调 `http://127.0.0.1:8787/sso/callback`。`ALLOW_INSECURE_LOCALHOST` 仅对回环来源放宽明文 HTTP，其它环境必须保持 `false`。

SSO 关闭时，后端兼容模式同样保留独立的本地管理账号作为内层边界；外部密钥可作为初始密码，未配置时启动会显示随机初始密码（无控制终端时写入启动输出）。控制台优先使用 `PANEL_ADMIN_KEY`，不把该密码作为登录方式提供。推理密钥不会自动创建，需预先配置外部密钥或通过管理 API 创建。

旧版保存的默认 key 会在首次启动时迁移为初始管理密码和数据库管理密钥；数据库密钥不会提升为 `CODEBUDDY2API_KEY`。修改管理密码后，后续登录不再跟随外部密钥变化，并撤销已有会话。密码只保存 scrypt 哈希。

密码先输出再提交账户；输出失败会停止启动且不写账户，提交失败则下次启动重试初始化。终端或容器日志的保留不受网关控制，首次登录后请尽快修改初始密码。

没有 uv 时，用虚拟环境安装同一份带哈希的依赖：

```bash
python3 -m venv .venv
. .venv/bin/activate          # Windows：.venv\Scripts\activate
python3 -m pip install --require-hashes --only-binary=:all: -r requirements.txt
python3 converter.py --host 127.0.0.1 --port 8787
```

两种启动方式都会读取当前工作目录的 `.env`（若存在），不搜索父目录。优先级：显式 CLI > 进程环境变量 > `.env` > SQLite 保存值 > 默认值。数据库密钥不会提升为外部密钥；空白外部值按未设置处理。修改监听需重启，`CODEBUDDY2API_IMAGE/AUTH_PATH` 只作用于 Compose。

### 管理密码恢复

此命令仅用于 SSO 关闭时的后端兼容账号，不会更改身份提供方账号。使用与网关相同的数据目录执行交互式恢复命令：

```bash
uv run --locked --no-build converter.py admin reset-password
uv run --locked --no-build converter.py admin reset-password --username admin
```

命令在 TTY 中要求输入两次密码，不接受密码参数。服务运行时也可执行；下一次管理请求即使用新的账户 epoch，并撤销所有已有会话。Docker 中执行 `docker compose exec codebuddy2api python3 converter.py admin reset-password`。

### 配置迁移

`.env` 中的值仍然优先，因此任何写在里面的运行参数都会占住 WebUI 的对应项。要统一到配置库，先停止服务，再执行离线命令；命令不会改动 `.env` 本身：

```bash
python3 converter.py config migrate            # 当前目录 .env -> ./auth/control.sqlite3
python3 converter.py config migrate --env-file /srv/app/.env --data-dir /srv/app/auth
python3 converter.py config status --db /srv/app/auth/control.sqlite3   # 只读
```

两条命令都先解析 env 文件，再采用其中声明的数据目录（`CODEBUDDY_AUTH_DIR`），`--data-dir`/`--db` 只覆盖解析结果。写入前 `migrate` 会验证目标确实是本项目的控制库（SQLite 魔数、`user_version=3`、`control`/`runtime_state`/`gateway_secrets`/`api_keys`、可解析的 payload、`quick_check`），并在检测到运行中实例的租约或写锁时拒绝；`--force` 只跳过租约提示。部署类键（密钥、监听地址、数据路径）不会迁移。容器内没有 `.env` 文件，改用进程环境变量：

v2 控制库必须先由新版服务启动一次并完成 v3 升级，才能执行 `config migrate`。

```bash
docker compose stop
docker compose run --rm --no-deps -e CODEBUDDY_AUTH_DIR=/data/auth \
  codebuddy2api python3 converter.py config migrate --no-env --data-dir /data/auth
```

成功时值写入与“关闭 Dashboard 提醒”在同一次 revision 内提交；按提示删除 `.env` 中对应行后，这些项改由配置库提供、可在 WebUI 修改。旧版本启动的实例不写租约，升级后首次迁移前请自行确认服务已停止。`config status` 不写库。`--lang zh|en|auto` 决定 CLI 输出语言，并在 `serve`、`login`、`config migrate` 时把界面语言一并保存；见[配置与 CLI](advanced.zh-CN.md#配置与-cli)。

> 审计库为单写者设计：升级新版本前先停止旧实例，不要让两个版本的网关共用同一 auth 目录。

### 升级与数据迁移

发布包安装与 Git 工作区可在 WebUI「版本更新」页一键更新或回滚：校验发布包、备份配置库后原地替换程序文件，并按原启动参数重启；见[版本更新](webui.zh-CN.md#版本更新)。手动升级时，先停止网关并备份整个数据目录。首次启动将旧 JSON 会话、冷却、积分/领取、目录和用量状态一次性导入 `control.sqlite3`；原文件保留作备份，不再参与读写。关键数据损坏或迁移失败会阻止启动，请修复或恢复备份，不要删除账本绕过检查。

SQLite 状态读取或校验失败会阻止启动，不删除会话、不回退为空状态；修复控制库后再启动。仅可重建缓存的写入失败允许保留当前内存数据并告警。

所有运行日志使用 `logs.sqlite3`；旧 `--log` / `CODEBUDDY2API_LOG` 仅提示弃用，不再输出文本文件。初始密码只进入终端或启动输出，审计只保存密钥 ID 而非明文。限制数据目录访问权限；Windows 应使用当前用户的私有目录。

启动会把控制库 schema v2 升级为 v3，并迁移旧默认 key。旧版本无法读取 v3 控制库；降级须在停机后从升级前备份恢复，不能只切代码后复用旧 JSON。升级后发生的领取、派遣或会话撤销不能用过期备份覆盖。

## 依赖锁定

`pyproject.toml` 声明直接依赖；`uv.lock` 锁定全部解析版本。带哈希的 `requirements.txt` 是供 pip、Docker 与 CI 使用的生成文件：

```bash
uv lock
python3 scripts/export_requirements.py
```

有意调整依赖时使用 `uv add`/`uv remove`，然后导出并核对锁定文件。日常启动使用 `--locked`，不会升级任何包。元数据与当前 `VERSION` 保持一致；发版必须同时更新两处版本字段。pip/Docker 仍要求哈希匹配与二进制 wheel，不要关闭这些校验。

Docker 构建所用的前端、Node 与 Python 镜像均按多平台摘要锁定。刷新它们时保留 `linux/amd64` 与 `linux/arm64` 支持并验证构建。锁定只能防止漂移，不能免疫未来漏洞；安全更新仍需评审后刷新。

## 命令行登录

WebUI 不可用时不启动服务也能完成浏览器登录：

```bash
uv run --locked --no-build converter.py login
uv run --locked --no-build converter.py login --site intl --no-browser
uv run --locked --no-build converter.py login --site intl-codebuddy --no-browser
```

第一条使用国内站。`--site intl` 选择国际 WorkBuddy（`www.workbuddy.ai`）；`--site intl-codebuddy` 选择国际 CodeBuddy（`www.codebuddy.ai`）。`--no-browser` 打印授权链接，可在其他设备打开。即使浏览器显示成功，也要等终端确认凭证已保存。链接 10 分钟过期；按 `Ctrl+C` 取消。

Docker 中使用 `docker compose exec codebuddy2api python3 converter.py login --no-browser`；按所选国际产品追加 `--site intl` 或 `--site intl-codebuddy`。镜像版本需包含对应登录选项。

登录与服务必须使用同一个 `CODEBUDDY_AUTH_DIR`。默认目录扫描会自动加载新账号；重复登录会更新同一身份。以 `--auth-file` 启动的服务只使用指定文件。

在默认本地模式且未设置 `CODEBUDDY_AUTH_DIR` 时，启动会从已登录的桌面客户端导入缺失凭证。也可以直接向管理目录放入 `.info` 文件。桌面端与网关各自的独立刷新可能互相挤掉 token；建议使用独立的浏览器登录。

## 不使用 Compose

直接运行已发布镜像：

```bash
docker run -d --name codebuddy2api --init --restart unless-stopped \
  -p 127.0.0.1:8787:8787 --env-file .env \
  -v "$PWD/auth:/data/auth" \
  -e CODEBUDDY_AUTH_DIR=/data/auth <registry>/codebuddy2api:latest
```

想跑源码就先用 `docker build -t codebuddy2api:local .` 构建。该命令显式使用默认端口与目录，不依赖 Compose 的端口映射。在控制台添加账号，或运行 `docker exec -it codebuddy2api python3 converter.py login --no-browser`。

## 验证

`curl http://127.0.0.1:8787/health` 应返回 `{"status":"ok"}`。它与镜像健康检查用的是同一个探针：仅代表存活，不代表账号或模型可用；请在控制台查看。Compose 把它作为容器健康状态，所以 `docker compose ps` 即可看出一次 pull 或重启后应用是否真的起来了。API 接入见[客户端配置](clients.zh-CN.md)，错误与重试边界见[进阶参考](advanced.zh-CN.md)。
