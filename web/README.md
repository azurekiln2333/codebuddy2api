# CodeBuddy2Api 管理控制台（web/）

CodeBuddy2Api 的浏览器管理控制台。它是构建到 `/dashboard/` 的静态 React SPA，
由本仓库的 FastAPI 应用同源托管：`/sso/*` 负责统一身份登录会话，`/admin/*`
提供管理接口。

- **品牌：** CodeBuddy2Api
- **形态：** 静态 SPA（无独立服务端、无内置密钥、无生产环境假数据）
- **基础路径：** `/dashboard/`
- **认证：** 仅统一身份（SSO）。浏览器不接触、不保存管理密钥

## 功能

- 概览：请求、成功率、Token 用量、凭证健康与存储状态。
- 模型路由：启停、对外/上游 ID、凭证或区域绑定、能力预检。
- 凭证管理：导入导出、上游 OAuth 账号登记、自动任务。
- 媒体生成：图像与视频任务、本地资源查看和管理。
- 密钥管理：创建、限制、禁用和轮换推理 API key，使用当前 SSO 管理会话授权。
- 日志审计：请求、运行事件与管理操作，支持分范围清理。
- 存储管理：归档、清理与压缩指引。
- 系统设置：可修改 / 外部锁定 / 系统只读三类来源视图。
- 版本更新：检查本 fork 发布、校验并安装发布包，支持更新备份。
- 明暗/跟随系统外观、中文优先的双语界面、手机自适应布局。

## 本地开发

```bash
pnpm install --frozen-lockfile
AZUREKILN_GATEWAY_URL=http://127.0.0.1:8788 pnpm dev
```

开发服务器监听 `http://127.0.0.1:5174`，打开
`http://127.0.0.1:5174/dashboard/`。`AZUREKILN_GATEWAY_URL` 是 `/sso` 与
`/admin` 的代理目标；未设置时接口调用会失败（没有 mock 回退）。

## 构建与校验

```bash
pnpm install --frozen-lockfile
pnpm check          # 格式 + lint + 类型检查
pnpm test           # jsdom 单元/组件回归
pnpm build          # 生产构建 → dist/（含许可证汇总）
pnpm exec playwright test   # 浏览器契约与几何回归
```

`pnpm build`（等价于 `vp build`）会在构建开始时自动执行许可证汇总，把
`LICENSE.upstream`、`THIRD_PARTY_NOTICES.md` 与完整运行期依赖许可证文本复制到
`dist/`（源码在 `scripts/prepare-notices.mjs`，由 `vite.config.ts` 的构建钩子调用，
因此容器镜像里直接运行 `vp build` 也会产出这些文件）。
构建产物 `dist/` 由应用在 `/dashboard` 下同源托管；SPA 兜底不得接管
`/sso` 与 `/admin`。

## 认证工作方式

1. SPA 调用 `GET /sso/session`。
2. 只有 `{ authenticated: true, csrf_token, user: { …, role: "admin" } }` 才会渲染控制台。
3. 写请求携带 `X-CSRF-Token`，令牌只保存在内存。
4. `401` 清除会话回到登录页；`403` 显示无管理权限/权限已撤回。
5. 登录链接为 `/sso/login?return_to=/dashboard/`；`/sso/callback` 由服务端处理；
   `POST /sso/logout` 同样携带 CSRF 头。

## 目录结构

```
src/              React/TypeScript SPA 源码
  api.ts          /sso 与 /admin 客户端、会话 store、响应校验
  App.tsx         外壳、登录、加载屏、守卫、路由
  pages/          概览、模型路由、凭证、日志、存储、设置
  theme.scss      语义 token（颜色/圆角/尺寸）
  ui.module.scss  外壳与共享组件样式
e2e/              Playwright 浏览器契约与几何回归
scripts/          构建前的许可证汇总脚本
public/           构建期生成的许可证文本（不提交）
dist/             构建产物（不提交）
```

设计规范见仓库根 [`docs/design-system.md`](../docs/design-system.md)。
部署与集成说明见仓库根 `docs/` 下的部署文档。

## 许可与来源

本目录是 CodeBuddy2Api 仓库自身的控制台实现，按 MIT 许可分发
（Copyright (c) 2026 墨菊，见仓库根 `LICENSE`）。

它源自原始 **codebuddy2api** 的 web 控制台（MIT），其许可全文以
[`LICENSE.upstream`](LICENSE.upstream) 原样保留并随构建产物分发。
本次修改包括品牌统一为 CodeBuddy2Api、改为统一身份（SSO）登录并移除浏览器端
管理密钥，以及按参考控制台重做加载屏、登录页与控制台外壳。

第三方依赖清单与完整许可文本见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)；构建时汇总的全文在
`dist/THIRD_PARTY_LICENSES.txt`。

视觉规格参考了另一套管理面板的可观察设计（尺寸、间距、颜色、布局关系），
在 React/SCSS 中独立实现；未复制其源码，该参考项目不是本项目的依赖。
