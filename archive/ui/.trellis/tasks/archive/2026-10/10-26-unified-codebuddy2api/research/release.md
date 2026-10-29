# GitHub / CNB 发布设计研究（release）

> 角色：GitHub/CNB 发布负责人。只读研究结论，不含产品代码改动。
> 目标仓库：`D:/My2KProjects/codebuddy2api`（唯一长期维护仓）。
> 参考实现：`D:/My2KProjects/cnb2api-panel`。
> 官方文档已核对：`docs.cnb.cool`（`build/grammar`、`build/trigger-rule`、`build/build-in-env`、
> `build/file-reference`、`build/configuration`、`build/internal-steps/git/release`、
> `build/internal-steps/cnb/read-file`、`artifact/docker`）与 GitHub Actions/GH CLI 官方手册。
> 对应 PRD 条目：R4、AC4（并间接约束 R5/AC5 的 pull-only 形态）。

---

## 0. 结论摘要（TL;DR）

1. **版本源**：`VERSION` 已是被运行时消费的权威版本（`converter.py:95` → FastAPI `version`），
   但版本值同时存在于 **`pyproject.toml:3` 与 `docker-compose.yml:8`**。必须把 `VERSION` 定为唯一权威，
   其余位置改为「校验一致」或「不再写死」。**预发布需要放宽 `VERSION` 语法与 `tests/test_version.py` 契约**（需协调批准）。
2. **镜像标签**：稳定 `vX.Y.Z` 打 `vX.Y.Z / X.Y.Z / X.Y / X / sha-<12> / latest`；预发布只打
   `vX.Y.Z-pre / sha-<12>`，**永不移动 `latest`**；`main` 打 `edge`；PR 不推送。
   两平台必须产出**同一标签集合**，用测试固化。
3. **权限/凭证**：GitHub 用 `GITHUB_TOKEN`（`contents: write` 仅 release job，`packages: write` 仅 image job，
   其余 `contents: read`）；CNB 用内置 `CNB_TOKEN`（`docker login docker.cnb.cool -u cnb`）。
   **PR 流水线一律不登录、不推送**（CNB 对不可信事件本来就限权到当前仓）。
4. **仓库路径**：必须自动推导 —— GitHub `ghcr.io/${GITHUB_REPOSITORY,,}`，CNB
   `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}`。当前有 **6 处硬编码 `maiphucgiang`**，其中一处是回归测试断言。
5. **发布包**：白名单打包 + 生成 `.dockerignore`（必须满足 `tests/test_deployment.py` 既有契约）；
   打包后**自检 denylist**（`.env`、`auth/`、`*.sqlite3*`、`*.info`、`*.token`、`converter.log*`、agent 运行态目录）命中即失败。
6. **幂等 Release**：GitHub `gh release view` → `upload --clobber` / `create --verify-tag`（参考实现已如此）；
   CNB `git:release` **必须 `overlying: true`**（默认 `false` 是先删后建，会丢资产），附件用 `cnbcool/attachments`。
7. **门禁**：两平台同序：版本校验 → 后端 tests → 前端 check/test/build → 浏览器 e2e → 打包+自检 →（tag 才）发布。
   新增 `tests/test_release_pipeline.py` 解析两份 CI 文件，把「`latest` 仅稳定、PR 不发布、标签集合一致」变成测试而不是文档承诺。

**当前最大缺口**：`codebuddy2api` **没有 `release` job、没有 `.cnb.yml`、没有打包脚本**。
`docker-compose.yml` 仍是 `build: .` + 带版本上游镜像的混合形态（违反 R5 pull-only）。

---

## 1. 现状证据

### 1.1 `codebuddy2api`（fork 落点，`main` @ `fc95b04`, VERSION `1.3.5`）

| 关注点 | 现状 | 证据 |
|---|---|---|
| 版本权威源 | `VERSION` → `APP_VERSION` → FastAPI/OpenAPI | `converter.py:95`、`converter.py:1912`；`tests/test_version.py:20-24` 断言三者相等 |
| 版本重复定义 | `pyproject.toml` `version = "1.3.5"` | `pyproject.toml:3` |
| 版本重复定义 | `docker-compose.yml` 默认镜像带 `:1.3.5` | `docker-compose.yml:8` |
| 版本重复定义 | `web/package.json` `version: 0.0.0`（私有、不参与） | `web/package.json:3` |
| 版本校验脚本 | 只读 `GITHUB_REF`，只接受稳定版（拒绝 `1.0.0-rc.1`） | `scripts/check_version.py`；`tests/test_version.py:41-48` |
| GitHub CI | `test` / `web` / `image` 三个 job；**无 release job** | `.github/workflows/docker.yml` |
| GitHub 触发 | `push: main`、`tags: v*.*.*`、PR、`workflow_dispatch` | 同上 |
| GitHub 镜像 | GHCR + `metadata-action`（`edge` / `semver` / `sha`），**无 `latest` 规则** | 同上 `Image metadata` step |
| GitHub 权限 | 顶层 `contents: read`；image job `packages: write`；action 全 SHA pin | 同上 |
| 其他 workflow | `codeql.yml` | `.github/workflows/codeql.yml` |
| CNB | **完全缺失** | 无 `.cnb.yml` |
| 打包脚本 | **缺失**（`scripts/` 仅 `check_version.py`、`export_requirements.py`、`herdr-auto-yes.ps1`） | 目录列表 |
| Dockerfile | 3 阶段；frontend 阶段**强制** `vp install --frozen-lockfile` | `Dockerfile:12-25` |
| Compose | `image:` + `build: .` 并存；默认 `127.0.0.1:8787`；数据卷 `./auth:/data/auth` | `docker-compose.yml:7-13` |
| `.dockerignore` | 第 1 行注释、第 2 行 `**`、逐项 `!` 白名单 | `.dockerignore` |
| 回归契约 | 解析 Dockerfile 的 runtime `COPY`，要求每个源都在 `.dockerignore` 有 `!` | `tests/test_deployment.py:26-45, 96-126` |
| 回归契约 | 断言 README 含 `ghcr.io/maiphucgiang/codebuddy2api:latest`、`docker compose pull`、`up -d --no-build`，且**不含** `docker compose build` | `tests/test_deployment.py:159-174` |
| 硬编码 owner | README×2 (`:17`,`:25`)、`docs/deployment*.md:29/30`、`docker-compose.yml:8` | grep |
| 许可证 | MIT | `LICENSE:1` |

### 1.2 `cnb2api-panel`（参考实现，Node/Vue 形态）

- `.cnb.yml`：
  - `main.push` / `main.api_trigger` / `main.pull_request` → 复用锚点 `verify-build`（**单 pipeline 内含** `check-runtime / npm ci / npm test / format:check / package / playwright / e2e`，并 `cnb:read-file` 取 `dist/build-manifest.json` 导出 `RELEASE_ARCHIVE`，再 `cnbcool/attachments` 上传）。
  - `"v*".tag_push` → `publish-release`（tag 校验 → 复用验证 → `prepare-release-notes` 生成 `dist/cnb-release-options.json` → `type: git:release` `optionsFrom` → 上传附件）与 **并行** 的 `publish-image`（`docker.image: cnbcool/default-dev-env:latest` + `services: [docker]`，`CNB_REGISTRY/CNB_REGISTRY_USER/CNB_REGISTRY_PASSWORD/CNB_IMAGE` 可被仓库设置覆盖，稳定版才补 `latest`）。
- `.github/workflows/build-and-release.yml`：`test` / `console`（打包+`upload-artifact`）/ `release`（`gh release view` 存在则 `upload --clobber`，否则 `create --verify-tag --generate-notes [--prerelease]`）/ `image`（GHCR，小写 `GITHUB_REPOSITORY`，预发布跳过 `latest`）。
- `scripts/package.mjs`：白名单复制、**生成 release 专用 `.dockerignore`**、`tar -czf`、`sha256`、写 `dist/build-manifest.json`。
- `Dockerfile:4-9`：`if web/package-lock.json then npm ci+build else test -f web/dist/index.html` —— **发布包可只带 `web/dist`**。
- `docker-compose.yaml`：`image: ${PANEL_IMAGE:-...:latest}`、`restart: unless-stopped`、`init: true`、`logging` 轮转、watchtower（`WATCHTOWER_LABEL_ENABLE` + `WATCHTOWER_SCOPE` + `POLL_INTERVAL`）。
- 许可证 AGPL-3.0（见 §6 风险 6）。

---

## 2. 平台语法核对结果（官方文档）

### 2.1 CNB（`.cnb.yml`）

| 结论 | 依据 |
|---|---|
| 顶层键是**分支/Tag 名 glob**；`$` 为兜底；同一事件下多条 pipeline **并发**执行 | `build/trigger-rule.md#触发分支`、`build/configuration.md` |
| 精确 Tag 用 `v1.0.0:`，glob 用 `"v*":`，兜底 `$:`；`CNB_BRANCH` = 分支名 **或 Tag 名** | `build/trigger-rule.md#Tag 事件`、`build/build-in-env.md` |
| 事件名：`push`、`commit.add`、`pull_request`（及 `.update/.target/.mergeable/.merged/.approved/...`）、`tag_push`、`api_trigger`、`web_trigger`、`crontab` | `build/trigger-rule.md#触发事件` |
| Pipeline 级配置项含 `docker`（构建环境镜像）、`services`（`docker`/`vscode`）、`env`、`imports`、`runner`（`tags`/`cpus`）、`failStages`、`allowFailure` | `build/grammar.md:160-180` |
| Job 任务类型：`script` / `image`+`settings`（插件）/ `type`（内置任务）+ `options`；`exports` 导出为环境变量；`optionsFrom`、`settingsFrom` 引参 | `build/grammar.md:1710-1830` |
| `git:release` 参数：`overlying`（**默认 `false`＝先删后建**）、`tag`（`tag_push` 免填）、`title`、`description`/`descriptionFromFile`（互斥）、`preRelease`、`latest`；**不支持附件** | `build/internal-steps/git/release.md` |
| `cnb:read-file`：`options.filePath`，`.json` 解析为对象，`exports` 支持多级 key；全程不入日志 | `build/internal-steps/cnb/read-file.md` |
| Docker 制品库：`docker login docker.cnb.cool -u cnb -p $CNB_TOKEN`；路径 `${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}[/<name>]` | `artifact/docker.md` |
| 内置变量：`CNB_TOKEN`、`CNB_BRANCH`、`CNB_IS_TAG`、`CNB_REPO_SLUG_LOWERCASE`、`CNB_DOCKER_REGISTRY`、`CNB_BUILD_ID` 等 | `build/build-in-env.md` |
| **不可信事件**（`pull_request`、`issue.*`）：`CNB_TOKEN` 以触发者身份签发、**范围限当前仓库**；被引用的外部文件必须显式声明 `allow_events`（插件引用需 `allow_images`） | `build/trigger-rule.md#不可信事件`、`build/file-reference.md#权限检查` |
| Fork 仓库默认不自动触发；需仓库「设置 → 云原生构建」开启 | `build/trigger-rule.md#Fork 仓库触发限制` |

> 已验证可用（来自参考实现的真实 `.cnb.yml`）：锚点 `&verify-build` / `*verify-build`、`&validation-jobs`、
> `&read-build-manifest`、`&upload-build-assets`，`type: cnb:read-file` + `exports.archive`，
> `image: cnbcool/attachments:latest` + `settings.attachments: [...]`，`type: git:release` + `optionsFrom`。

### 2.2 GitHub Actions

| 结论 | 依据 |
|---|---|
| 顶层最小权限 `permissions: contents: read`；job 级覆盖 | 现有 `.github/workflows/docker.yml:10-11, 88-91` |
| 推 GHCR：`packages: write` + `secrets.GITHUB_TOKEN` + `username: ${{ github.actor }}`，**同仓可匿名拉取仅当 package 公开** | 现有 docker.yml `Log in to GHCR` / `Build and publish` |
| 镜像名小写化：`ghcr.io/${GITHUB_REPOSITORY,,}` | 参考实现 `build-and-release.yml` `image` job |
| Release 幂等：`gh release view` 存在→`upload --clobber`；否则 `create --verify-tag` | 参考实现 `release` job |
| PR 不发布：`github.event_name != 'pull_request'` 门控 `push:` | 现有 docker.yml |
| 第三方 action 应以 commit SHA 固定（仓库既有规范），并 `persist-credentials: false` | 现有 docker.yml 全部 step |

> 说明：本环境无外部网络自由度受限，GitHub 文档页面为 JS 渲染，故以**本仓已跑通的 workflow 与参考实现**作为语法事实来源；
> 新增 action（`upload-artifact`/`download-artifact`）沿用参考实现所用 major 版本，并按本仓规范改为 SHA 固定后落地。

---

## 3. 设计决策

### D1 统一版本源

**权威源：`VERSION` 文件**（已被 `converter.py` 在运行时读取，且 `tests/test_version.py` 已固化为契约）。

派生规则：

| 位置 | 处理 |
|---|---|
| `VERSION` | 唯一权威，人工只改这里 |
| `pyproject.toml [project].version` | 保留但**由 CI 校验必须等于 `VERSION`**（当前值 `1.3.5` 已一致） |
| `docker-compose.yml` 默认镜像 | **去掉版本号**，改为 `:latest`（版本只来自标签/VERSION），消除第三处漂移 |
| `web/package.json version` | 保持 `0.0.0` 私有，不参与；`private: true` 已阻止误发布 |
| 发布包名 | `codebuddy2api-v<VER>-<YYYYMMDD>.tar.gz`（UTC 日期，构建时生成） |
| OCI label | `org.opencontainers.image.version=<VER>`、`.revision=<sha>`、`.source=<repo url>` |
| Release 标题 | `codebuddy2api v<VER>` |

`scripts/check_version.py` 扩展为单一校验入口（保持可被 `tests/` 直接 import）：

```text
python scripts/check_version.py [--ref <git-ref>] [--github-output] [--check-pyproject] [--check-compose]
# 兼容：--ref 缺省时依次读 GITHUB_REF、refs/tags/v$CNB_BRANCH(当 CNB_IS_TAG=true)、否则 refs/heads/$CNB_BRANCH
```

校验项：
1. `VERSION` 匹配 `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$`
2. `ref` 为 `refs/tags/v*` ⇒ 必须等于 `v<VERSION>`（拒绝 `v1.0.0` 缺 `v`、`1.0.0`、`v1.0.1` 之类）
3. `pyproject.toml` 的 `version` == `VERSION`
4. `docker-compose.yml` 默认镜像标签 ∈ {`latest`, `v<VERSION>`, `<VERSION>`}，且不得出现其它具体版本
5. 输出 `version`、`prerelease=true|false`、`tag=v<VERSION>`

**需要经协调批准的连带改动**：`tests/test_version.py:41-48` 目前断言 `1.0.0-rc.1` 非法。
若 R4/AC4 要求「预发布不更新 latest」，则必须允许预发布版本存在，该断言需改为「接受 `1.0.0-rc.1`，并断言 `prerelease=True`」。
若决定**本期只发稳定版**，则保留现语法，预发布分支留待后续（此时 AC4 的预发布条款降级为「标签规则已就绪」）。

### D2 稳定 / 预发布镜像标签

| 触发 | `VERSION` | 镜像标签 | Release |
|---|---|---|---|
| tag `vX.Y.Z`（稳定） | `X.Y.Z` | `vX.Y.Z`, `X.Y.Z`, `X.Y`, `X`, `sha-<12>`, **`latest`** | 正式 Release，`latest=true` |
| tag `vX.Y.Z-<pre>` | `X.Y.Z-<pre>` | `vX.Y.Z-<pre>`, `sha-<12>`（**无 `latest`，无 `X.Y`/`X`**） | `preRelease=true`、`latest=false` |
| push `main` | 不变 | `edge`, `sha-<12>` | 不发布 |
| PR | — | 只 `build`，`push: false` | 不发布 |

硬规则：
- `latest` **只能**由稳定 tag 移动；这是「服务器只 pull」的唯一可跟随指针。
- 预发布**不得**生成 `X.Y` / `X` 这类可被 `latest=auto` 推断出的浮动标签（`flavor: latest=auto` 需移除或显式禁用）。
- 两平台标签集合必须相同；`sha-` 前缀统一 12 位短 SHA，来源 `github.sha` / `CNB_COMMIT_SHORT`。
- 回滚语义：`CODEBUDDY2API_IMAGE=<registry>/<path>:vX.Y.Z` 固定即可，文档需给出。

### D3 两平台权限与凭证

**GitHub**

| Job | `permissions` | 凭证 | 网络写 |
|---|---|---|---|
| `test` / `web` | 继承顶层 `contents: read` | 无 | 无 |
| `package` | `contents: read` | 无 | 无 |
| `release` | `contents: write` | `secrets.GITHUB_TOKEN` → `GH_TOKEN` | Release + 资产 |
| `image` | `contents: read` + `packages: write` | `secrets.GITHUB_TOKEN`（`docker/login-action`，`github.actor`） | GHCR |

- 不使用 `pull_request_target`；PR 事件不登录、不推送（`push:` 已由 `github.event_name != 'pull_request'` 门控）。
- 不需要 `id-token: write`（不涉及云 OIDC）。
- 所有第三方 action：commit SHA 固定 + `persist-credentials: false`（保持仓库既有规范）。
- Secret 需求：**零新增 secret**（`GITHUB_TOKEN` 足够）。

**CNB**

| Pipeline | 事件 | 凭证 | 用途 |
|---|---|---|---|
| `verify` | `push`(main) / `pull_request` / `api_trigger` | `CNB_TOKEN` 只读用于拉依赖 | 校验 + 打包（PR 不发布） |
| `publish-release` | `tag_push` | `CNB_TOKEN`（含当前仓写） | `git:release` + `cnbcool/attachments` |
| `publish-image` | `tag_push` | `CNB_TOKEN` 作为 registry 密码 | 推 `docker.cnb.cool` |

- 登录方式（默认无需任何配置）：`echo "$CNB_TOKEN" | docker login "${CNB_REGISTRY:-docker.cnb.cool}" -u "${CNB_REGISTRY_USER:-cnb}" --password-stdin`。
- 可覆盖变量（仓库环境变量）：`CNB_REGISTRY`、`CNB_REGISTRY_USER`、`CNB_REGISTRY_PASSWORD`、`CNB_IMAGE`（与参考实现一致）。
- 镜像路径**默认自动推导**：`${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}`，`CNB_IMAGE` 仅用于覆盖。
- 长期凭证（如需推外部 registry）：放**密钥仓库**，用 `imports:` 引用；该文件必须声明 `allow_events`/`allow_slugs`。**禁止**把 token 写进 `.cnb.yml`。
- PR 流水线纪律：不 `docker login`、不 `git:release`、不 `attachments`。
- 参考实现里 `CNB_TOKEN` 直接作 registry 密码；本设计保持该默认以做到「零配置」，但**显式写明**它是流水线临时令牌、会随构建销毁。

### D4 仓库路径自动推导

现状 6 处硬编码（必须一次性清掉，否则 fork 后发布到上游命名空间）：

| 文件 | 位置 | 处置 |
|---|---|---|
| `docker-compose.yml` | `:8` `ghcr.io/maiphucgiang/codebuddy2api:1.3.5` | 改为 `${CODEBUDDY2API_IMAGE:-codebuddy2api:latest}`，`build:` 移出（见 R5/D7） |
| `README.md` | `:17` clone URL、`:25` `CODEBUDDY2API_IMAGE` | 用 `<owner>` 占位 + 两条 registry 示例（GHCR / CNB） |
| `README.zh-CN.md` | `:17`、`:25` | 同上 |
| `docs/deployment.md` | `:29` | 同上 |
| `docs/deployment.zh-CN.md` | `:30` | 同上 |
| `tests/test_deployment.py` | `:169` 断言字面 `ghcr.io/maiphucgiang/...` | 改为**模式断言**：`^ghcr\.io/[a-z0-9_.-]+/codebuddy2api:(latest\|v?\d+\.\d+\.\d+.*)$` |

推导实现：

```bash
# GitHub
IMAGE="ghcr.io/${GITHUB_REPOSITORY,,}"
# CNB
IMAGE="${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}"
```

- Compose 无法插值 CI 变量 ⇒ 默认值保持中性 `codebuddy2api:latest`，由 `.env` 的 `CODEBUDDY2API_IMAGE` 指定 registry；
  文档给两条可直接复制的一行命令，不写死任何 owner。
- 允许用户覆盖为任意 registry（含自建 Harbor），因此**不**在 compose 里写 GHCR/CNB 域名。
- Release notes 与 `build-manifest.json` 记录 `source` = 当前仓库 URL（GH: `${{ github.server_url }}/${{ github.repository }}`；CNB: `$CNB_REPO_URL_HTTPS`）。

### D5 发布包：排除密钥与数据

沿用参考实现「白名单 + 生成 `.dockerignore`」策略，改写成 Python（`scripts/package.py`），
但**必须**满足 `tests/test_deployment.py:96-126` 的既有契约（`.dockerignore` 第 2 行 `**`、每个 runtime `COPY` 源都有 `!`）。

**白名单（进包）**

```text
Dockerfile  .dockerignore(生成)  VERSION  converter.py  app/**  requirements.txt
docs/**  README.md  README.zh-CN.md  LICENSE  THIRD_PARTY_NOTICES.md(如需)
docker-compose.yaml  docker-compose.build.yaml  .env.example
scripts/check_version.py  scripts/package.py
web/dist/**  web/package.json  web/pnpm-lock.yaml(可选)
tests/**(可选，用于包内自检)
build-info.json  build-manifest.json  release-notes.md  *.sha256
```

**denylist（打包后逐个 tar 条目断言不存在，命中即 exit≠0）**

```text
.env  .env.*(保留 .env.example)  auth/  *.info  *.sqlite3  *.sqlite3-wal  *.sqlite3-shm
*.token  *.key  secrets.*  converter.log*  *.log  .tmp-*.log
.trellis/  .agents/  .claude/  .codex/  .cursor/  .codebuddy/  .pi/  .qoder/  .trae/  .dsh/  .zcode/
.herdr-*  docs/plans/  node_modules/  web/node_modules/  __pycache__/  .git/  .gitattributes?
test-results/  dist/  *.zip  *.tar.gz(除自身)
```

要点：
- denylist 里 agent 运行态目录是**本仓独有风险**（`.trellis/`、`.agents/` 等未被 `.gitignore` 覆盖但不应交付）。
- `build-manifest.json` 字段：`name`、`version`、`prerelease`、`archive`、`sha256`、`builtAt`(UTC)、`commit`、`source`、`image`；供 `cnb:read-file`/GH output 双平台复用。
- 包内**必须**包含 `VERSION`（`converter.py` 运行时读取）与 `web/dist/index.html`。
- **前置产品改动（需协调）**：现 `Dockerfile:12-25` 无条件 `vp install --frozen-lockfile`。
  发布包若只带 `web/dist`（不含完整 `web/src` + lockfile），包内 `docker build` 会失败。
  需改为参考实现的条件分支：`if [ -f web/pnpm-lock.yaml ]; then vp install && vp build; else test -f web/dist/index.html; fi`。
  该改动不会被 `tests/test_deployment.py` 的 Dockerfile 解析破坏（`--from=` 行本就被跳过；新增分支仍在 frontend 阶段）。

### D6 幂等 Release

**GitHub**（沿用参考实现，已验证的 `gh` 语义）：

```bash
cd dist && sha256sum --check "$ARCHIVE.sha256"
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$ARCHIVE" "$ARCHIVE.sha256" --clobber
  gh release edit   "$TAG" --notes-file release-notes.md \
      $( [ "$PRERELEASE" = false ] && echo --latest )
else
  gh release create "$TAG" "$ARCHIVE" "$ARCHIVE.sha256" --verify-tag \
      --title "codebuddy2api v$VERSION" --notes-file release-notes.md \
      $( [ "$PRERELEASE" = true ] && echo --prerelease )
fi
```

- `--verify-tag`：tag 必须已存在，防止误建。
- 重跑三条路径都幂等：`upload --clobber`（资产覆盖）、`edit --notes-file`（描述覆盖）、`create`（首次）。
- 统一使用 `release-notes.md`（两平台同源模板），**不用** `--generate-notes`，否则 GH/CNB 描述不一致。

**CNB**：

```yaml
"v*":
  tag_push:
    - name: publish-release
      docker: &verify-image
        image: cnbcool/default-dev-env:latest
      stages: [ ...校验/测试/打包..., 生成 dist/release-notes.md 与 dist/release-options.json,
               { name: create-release, type: git:release, optionsFrom: dist/release-options.json },
               { name: upload-assets, image: cnbcool/attachments:latest,
                 settings: { attachments: ["dist/$RELEASE_ARCHIVE", "dist/$RELEASE_ARCHIVE.sha256"] } } ]
```

`dist/release-options.json`：

```json
{ "overlying": true, "title": "codebuddy2api v<VER>",
  "descriptionFromFile": "dist/release-notes.md",
  "preRelease": false, "latest": true }
```

- **`overlying: true` 是幂等关键**：默认 `false` = 先删后建，会重置 Release ID 并丢掉既有资产/评论。
- `preRelease`/`latest` 由脚本按 `prerelease` 计算，不写在 YAML 里。
- 附件：`git:release` 不支持附件，必须 `cnbcool/attachments`（官方文档已明确）。
- **待实测风险**：`attachments` 插件在重跑同一 tag 时是否重复创建同名附件。若会重复，退路是
  「先用 OpenAPI 删除同名资产，再上传」或「固定文件名 + 覆盖」。**必须在 CNB 上做一次同 tag 重跑 dry-run 验证**，此项未验证不得宣称幂等。

### D7 校验 / 测试门禁

统一顺序（两平台一致，任一失败即阻断发布）：

| # | 门禁 | 命令 | 说明 |
|---|---|---|---|
| 1 | 版本一致性 | `python scripts/check_version.py --ref <ref> --check-pyproject --check-compose` | tag 不匹配、`pyproject` 漂移、compose 写死版本都失败 |
| 2 | 后端回归 | `for f in tests/test_*.py; do python -B "$f"; done` | 仓库既有约定（纯 unittest，可直接执行） |
| 3 | 前端静态+单测+构建 | `cd web && vp install --frozen-lockfile && vp check && vp test run && vp build` | 用 `GOMAXPROCS=2 GOMEMLIMIT=512MiB RAYON_NUM_THREADS=2` 限流（既有约定） |
| 4 | 浏览器回归 | `vp exec playwright install --with-deps chromium-headless-shell && vp exec playwright test && vp exec playwright test -c playwright.integration.config.ts` | 见 `.github/workflows/docker.yml:74-83` |
| 5 | 打包 + 自检 | `python scripts/package.py` | 生成 tar.gz / `.sha256` / `build-manifest.json` / `release-notes.md`，并跑 denylist 断言 |
| 6 | 包内构建 smoke | 解包 → `docker build .` | **建议新增**：发布包是唯一交付物，必须能在无源码状态下构建（也验证 D5 的 Dockerfile 条件分支） |
| 7 | 校验和 | `sha256sum --check <archive>.sha256` | 发布前对资产本身校验 |
| 8 | 发布 | 仅 tag | `needs: [test, web, package]`；PR 恒不进入 |
| 9 | 发布后 smoke | `docker run --rm <image> python3 -c "import converter"`；`curl /health` | 只读、可失败即告警 |

并发与互斥：
- GitHub：`concurrency: { group: release-${{ github.ref }}, cancel-in-progress: false }`，避免同 tag 两次发布互相覆盖。
- CNB：同 tag 重推会再触发一次；依赖 D6 的 `overlying` 保证收敛。

**新增测试（把规则固化，而不是写在文档里）**：`tests/test_release_pipeline.py`
1. `.cnb.yml` 存在、`tag_push` 段含 `git:release` 且 `overlying: true`、含 `attachments`。
2. `.github/workflows/docker.yml` 含 `release` job，且 `if:` 限定 tag。
3. 两份 CI 中「`latest` 只在稳定版」的条件同时存在（正则匹配 `latest` 出现处附近有 prerelease/`-` 判断）。
4. 两份 CI 都调用 `scripts/check_version.py`，且入参包含 tag 校验。
5. `.github/workflows/*.yml` + `.cnb.yml` 中所有 registry 主机名不含硬编码 owner（正则黑名单 `maiphucgiang`）。
6. `scripts/package.py` 的 denylist 至少覆盖 `.env`、`auth/`、`*.sqlite3*`、`*.info`、`.trellis/`。
7. `docker-compose.yml` 默认不含 `build:`、不含具体版本号；`docker-compose.build.yaml` 存在且只用于本地构建。

---

## 4. 落地清单（文件级，供 design.md / implement.md 引用）

### `codebuddy2api`（唯一维护仓）

| 动作 | 文件 | 备注 |
|---|---|---|
| 新增 | `.cnb.yml` | `main.push` / `api_trigger` / `pull_request` → verify；`"v*".tag_push` → publish-release + publish-image |
| 新增 | `scripts/package.py` | 白名单打包、生成 `.dockerignore`、`sha256`、`build-manifest.json`、`release-notes.md`、denylist 自检 |
| 改 | `scripts/check_version.py` | 双平台 ref、semver 含预发布、`pyproject`/compose 一致性、输出 `prerelease` |
| 改 | `.github/workflows/docker.yml` | 新增 `package`/`release` job；`latest` 仅稳定；移除 `flavor: latest=auto` 的浮动副作用；`concurrency` |
| 改 | `Dockerfile` | frontend 阶段条件化（有 lockfile 才 `vp install`，否则要求 `web/dist/index.html`） |
| 改 | `docker-compose.yml` | 去 `build:`、去具体版本 → pull-only（R5） |
| 新增 | `docker-compose.build.yaml` | 本地构建 override |
| 新增 | `docker-compose.update.yaml` 或 watchtower 服务段 | 自动更新（R6，与 deploy 负责人对齐） |
| 改 | `.dockerignore` | 保持「第 2 行 `**` + 逐项 `!`」契约 |
| 改 | `pyproject.toml` | 版本由 CI 校验（不手工维护双写） |
| 改 | `tests/test_version.py` | 预发布接受 + `pyproject` 一致性断言 |
| 改 | `tests/test_deployment.py` | owner 改模式断言；compose pull-only 断言 |
| 新增 | `tests/test_release_pipeline.py` | 见 D7 |
| 改 | `README.md` / `README.zh-CN.md` | `<owner>` 占位、双 registry 示例、自动更新与回滚 |
| 改 | `docs/deployment.md` / `docs/deployment.zh-CN.md` | 同上 |
| 迁移 | `web/**` | 从 `codebuddy2api-ui` 合入（由 UI 负责人主导，发布侧只依赖 `web/dist` 产物与 `pnpm-lock.yaml`） |

### 不引入

- 不使用 `pull_request_target`（GH）与不可信事件发布（CNB）。
- 不引入第三方 release action；GH 侧用 `gh` CLI（参考实现已验证）。
- 不在仓库内保存任何 registry 长期凭证。

---

## 5. 平台差异矩阵（必须在文档里讲清）

| 维度 | GitHub | CNB |
|---|---|---|
| 镜像地址 | `ghcr.io/<owner>/codebuddy2api` | `docker.cnb.cool/<slug>` |
| 匿名拉取 | 仅 package 公开时 | 制品库权限控制 |
| 私有拉取凭证 | PAT(`read:packages`) 或 `docker login ghcr.io -u <user> --password-stdin` | `docker login docker.cnb.cool -u cnb -p <CNB_TOKEN>` |
| 架构 | 现有 CI 产出 `linux/amd64,linux/arm64`（QEMU） | 默认节点 `amd64`；arm64 需 `runner.tags: cnb:arch:arm64-v8` |
| Release 描述 | `--notes-file` | `descriptionFromFile` |
| 附件 | `gh release upload` | `cnbcool/attachments` |
| 幂等开关 | `--clobber` | `overlying: true` |

---

## 6. 风险 / 待决项（需协调批准）

| # | 项 | 影响 | 建议 |
|---|---|---|---|
| 1 | **是否本期支持预发布** | 改 `VERSION` 语法 + `tests/test_version.py` + 文档，属产品代码改动 | 推荐支持（AC4 明确要求），否则 AC4 预发布条款需降级 |
| 2 | **目标 owner/org 未定**（GitHub owner、CNB 组织） | 决定镜像地址与文档示例 | 全部变量化，禁止硬编码；文档用 `<owner>` 占位 |
| 3 | **arm64 覆盖不对称** | CNB 默认 amd64，若服务器 arm64 则 CNB 镜像不可用 | 要么 CNB 增加 arm64 runner 与 buildx，要么文档声明「CNB 镜像仅 amd64、GHCR 双架构」 |
| 4 | **CNB `attachments` 重跑幂等** | 决定 D6 是否真的幂等 | 必须在 CNB 上做一次同 tag 重跑验证，未验证不得声称幂等 |
| 5 | **`docker build` 在发布包内** | 现 Dockerfile 无条件 `vp install`，包内缺 lockfile 会失败 | 采用参考实现的条件分支（需协调，属 Dockerfile 改动） |
| 6 | **许可证** | 本仓 MIT，参考面板 AGPL-3.0 | 只**复现设计/交互**，不复制其源码；若复制需整体 AGPL 化。发布侧需在 `THIRD_PARTY_NOTICES` 中声明 |
| 7 | **发布包是否含 `tests/`、`web/src`** | 影响包大小与包内可校验性 | 建议含 `tests/`（可自检）、**不含** `web/src`（只要 `dist`） |
| 8 | **`VERSION` 与 `pyproject.toml` 双写** | 长期漂移 | CI 强制相等；后续可改为 `pyproject` 动态读 `VERSION` |
| 9 | **CNB 同 tag 重推 / GH 同 ref 并发** | 可能产生竞态覆盖 | GH `concurrency`；CNB 靠 `overlying` + 人工纪律 |

---

## 7. 交付给 `design.md` 的最小契约（摘要）

```text
版本源   : VERSION（唯一权威）→ 校验 pyproject.toml / docker-compose.yml 一致
标签     : 稳定 latest + vX.Y.Z + X.Y.Z + X.Y + X + sha-12；预发布无 latest
路径     : GH ghcr.io/${GITHUB_REPOSITORY,,}；CNB ${CNB_DOCKER_REGISTRY}/${CNB_REPO_SLUG_LOWERCASE}
包       : codebuddy2api-v<VER>-<YYYYMMDD>.tar.gz + .sha256 + build-manifest.json + release-notes.md
包排除   : .env / auth/ / *.sqlite3* / *.info / *.token / *.log / .trellis 等 agent 运行态
幂等     : GH view→upload --clobber / create --verify-tag；CNB git:release overlying=true + attachments
门禁     : check_version → 后端 tests → web check/test/build → playwright → package+自检 → (tag) 发布
PR       : 只校验，不登录 registry，不发布
```
