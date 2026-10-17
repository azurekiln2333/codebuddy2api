# p9 令牌管理调研：后端是否支持多 API key

结论：**不支持**。后端只有一把单一全局 key，无任何令牌 CRUD 接口。按 PRD「不支持」分支处理：不建页面、不改后端。

## 依据（后端仓库 D:/My2KProjects/codebuddy2api，只读）

- `app/settings.py:83` — `api_key` 为 `mode="startup"` + `sensitive=True`，来源 `CODEBUDDY2API_KEY` / `--api-key` / 保存的默认 key；设置 PATCH 不允许写入。
- `app/state_store.py:259-277` — `default_key()` 写死 `WHERE name='default_api_key'`，并校验格式 `cb-[0-9a-f]{32}`（单值）；`claim_announcement()` 也只处理这一行。`gateway_secrets` 表本身是多行结构（`control_store.py:136`），但代码只用一个固定名。
- `app/inference_auth.py:12-22` — `require_api_key()` 用 `secrets.compare_digest` 与单个 key 相比；`InferenceAuthMiddleware` 同样只用 `config["api_key"]`。`/v1/*` 与管理共用同一 key。
- `app/admin_auth.py:_key()` / `check_key()` / `header_identity()` — key 即会话 epoch：key 变化会清空并落盘撤销全部管理会话；管理员身份由该 key 派生。
- `app/admin_api.py` 全部 20 条路由（`/admin/session|settings|models|credentials|logs|storage|dashboard`）中无 key 的增删改查。
- `docs/advanced.md:9,16`、`docs/webui.md:9` — 文档明确「WebUI 不暴露 API key」「更换生效 key 后需重新登录并重启未完成的 OAuth」。

## 为何不能前端单独实现

伪造列表/创建交互会让人以为已能签发多 key，实际仍只有一把；真正的多 key 必须改变 epoch、身份派生与鉴权比对，属于本轮明确禁改的「API/SSO/CSRF/权限语义」。

## 建议的后端接口设计（供后端先行）

- 存储：`gateway_secrets` 增加 `kind`（`root`/`inference`）、`prefix8`、`enabled`、`created_at`、`last_used_at`、`expires_at`；只存 hash + 前缀，不存明文；`root` 复用现有 `default_api_key` 且不可删除。
- 接口：`GET /admin/keys` → `{keys:[{id,name,prefix,kind,enabled,created_at,last_used_at,expires_at}]}`；`POST /admin/keys {name, scope}` → `{id, key}`（明文仅返回一次，复用 `claim_announcement` 的一次性披露语义）；`PATCH /admin/keys/{id} {enabled}`；`DELETE /admin/keys/{id}`。
- 鉴权：`require_api_key` 改为「root ∪ 已启用 inference key」的常量时间比对；管理登录只认 `root`，避免推理 key 提权为管理员。
- 一致性：写操作走现有 CSRF 校验与 audit `event()`；启停/删除立即生效（不依赖重启），旧 key 立刻 401；返回 `last_used_at` 便于判断是否可安全删除。
- 前端落地（后端就绪后）：`src/api.ts` 加 4 个函数，新建 `src/pages/Tokens.tsx` 复用 `management.module.scss`，`src/App.tsx` 加最小路由与侧栏条目，`src/i18n.tsx` 末尾追加中英词条。

## 本轮交付

- 前端改动文件：无（后端不支持）。基线验证：`npm run check` 全绿；`npm test` 18 文件 / 176 用例全通过。
