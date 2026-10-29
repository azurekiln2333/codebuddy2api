# UI 迁移调研：cnb2api-panel 设计 → codebuddy2api/web

只读调研结论。本轮未改产品代码、未提交、未创建任务。证据来自 `cnb2api-panel/web`、`codebuddy2api/web`、`codebuddy2api-ui` 三处源码，以及 `codebuddy2api-ui/docs/design-system.md`、`AGENTS.md`、`THIRD_PARTY_NOTICES.md`、`LICENSE.upstream`。

## 1. 三处代码的实际关系

| 仓库/目录 | 角色 | 技术栈 | 许可 |
| --- | --- | --- | --- |
| `codebuddy2api-ui` | 当前 React UI（SSO 版） | React 19 + react-router 7 + zustand + axios + SCSS modules，base `/dashboard/`，dev 5174，代理 `/admin`、`/sso` | MIT（`LICENSE.upstream`，上游 codebuddy2api，Copyright (c) 2026 墨菊） |
| `codebuddy2api/web` | 待替换的旧 UI | 依赖版本与 `codebuddy2api-ui` 完全一致（同一 `package.json` 依赖表、同一 vite-plus），是当前 UI 的分叉源 | 仓库根 `LICENSE`：MIT，Copyright (c) 2026 墨菊 |
| `cnb2api-panel/web` | 设计参考实现 | Vue 3.5 + `@lucide/vue` + `@fontsource-variable/dm-sans`、`jetbrains-mono`，base 为站点根 `/`，dev 5173，代理 `/api` | **AGPL-3.0-only** |

结论：`codebuddy2api/web` 不是独立旧项目，而是 `codebuddy2api-ui` 的上游快照。迁移方向是反向回填，不需要重写业务代码。

### 旧 `web/` 与本 UI 的代码差异（逐文件哈希比对）

`codebuddy2api/web/src` 与 `codebuddy2api-ui/src` 文件集合相同，仅当前 UI 多 3 个文件：

- `dashboard.module.scss`
- `management.module.scss`
- `sso.test.tsx`

其余 51 个同名文件全部内容不同。差异规模（字节）：

| 文件 | 旧 web | 当前 UI | 性质 |
| --- | --- | --- | --- |
| `App.tsx` | 8292 | 10196 | 登录从 API Key 改为 SSO，导航分组重写 |
| `api.ts` | 12089 | 14700 | 新增 `sso` 实例、`establishSession`、403/401 失效、CSRF 拦截 |
| `i18n.tsx` | 28164 | 36826 | 中英双语文案扩充 |
| `ui.module.scss` | 57152 | 50974 | 外壳改为 New API 内嵌面板结构 |
| `theme.scss` | 1999 | 2245 | 语义 token 重排 |
| `pages/Settings.tsx` | 10859 | 17276 | 分类导航 + 来源视图 |
| `pages/Storage.tsx` | 8121 | 9786 | 存储巡检扩展 |
| 其余 pages / tests | — | — | 小幅对齐 |

旧 `App.tsx` 特征（说明替换范围）：`Login` 渲染 `API key` 输入框与「进入工作台」按钮，`Guard` 只有 `s.center` 纯文字提示，折叠偏好键为 `codebuddy.sidebar.collapsed`。当前 UI 已改为 SSO 单入口、`azurekiln.sidebar.collapsed`、`guard` 区分 401/403。**这部分是现有契约，替换时必须保留。**

## 2. 参考设计的具体参数（cnb2api-panel）

### 2.1 加载画面「正在连接控制台」

参考实现（`App.vue` 模板首分支 + `styles.css` `.boot-screen`）：

- 结构：`品牌图标 → 旋转 loader → 文案`，三者横排。
- 尺寸：`min-height: 100dvh`，`display:flex`，`align-items:center`，`justify-content:center`，`gap:15px`，`color: var(--muted)`，`font-size:14px`。
- 品牌图标 `.brand-icon`：30×30，`border-radius: 8px`，背景纯 `#3169df`（暗色也不变），白色图形，`box-shadow: 0 3px 6px #3169df1c`，右侧额外 `margin-right: 10px`。
- loader：Lucide `LoaderCircle` 20px，`.spin` 关键帧 `to { transform: rotate(360deg) }`，`1.2s linear infinite`。
- 文案：`正在连接控制台`（硬编码中文，无 i18n）。

当前 UI 实现（`App.tsx` 的 `Guard`）：

- `<div className={s.center} role="status">{t("app.verifying")}</div>`，文案「正在验证登录状态…」。
- `.center`：`display:grid`、`place-content:center`、`gap:18px`、`min-height:100dvh`、`padding:24px`。

差异与必须保留项：

- 参考页**没有品牌标记、没有 spinner、没有 `role="status"`**。移植时保留当前 `role="status"` 与 i18n（`app.connecting` 新键），否则失去朗读播报并破坏 `sso.test.tsx`。
- 参考页整页底色用 `:root` 的 `--bg`；当前 UI 用 `--page`。以现有 token 为准。

### 2.2 登录页

参考实现是「左叙事 + 右表单」两栏：

- 外层 `.login-shell`：`grid-template-columns: 1.08fr 1fr`，`min-height:100dvh`，背景 `--surface`。
- 左栏 `.login-story`：`padding: 42px 50px 28px`，背景 `--surface-subtle`，`border-right:1px solid var(--line)`；伪元素铺 21px 网格点阵（`radial-gradient(var(--line-strong) 0.65px, transparent 0.65px)`，`opacity:.45`）。
  - 品牌行：`.brand` 18px/750、字距 -0.6px；`.brand-two` 把品牌名中的「2」染成主色；`.brand-tag` 为 `CONSOLE`（11px、字距 1.4px、左边框分隔）。
  - `.login-story-content`：`max-width:450px`，垂直居中。
  - eyebrow：大写、`color: var(--primary)`、11px、字距 1.8px，前置 `.blue-dot` 5px 圆点。
  - 主标题 `h1`：38px / 600 / 行高 1.65 / 字距 -1.5px，两行断句，句末用中文句号。
  - 网络示意图 `.network-art`：高 240px；SVG 440×200 虚线路径（`stroke-dasharray: 4 4`）；中心卡 `.network-center` 104px 宽、`--radius-md` 12px、主色 20% 混色边框；三张 `.network-node` 卡 140px 宽，`rotate(-3deg)` / `0` / `rotate(3deg)` 错落，卡内绿点表示在线。
  - 页脚：11px、字距 1px 的说明文案。
- 右栏 `.login-main`：`padding:65px 30px`，居中；主题切换按钮 `.login-theme` 绝对定位 `right:32px; top:35px`。
  - `.login-lock`：48×48，`--primary-soft` 底、10% 主色边框、`--radius-lg` 圆角。
  - eyebrow 11px → `h2` 25px/600/字距 -0.5px → 说明段 14px muted、`margin-bottom:33px`。
  - 输入项：`label` 内嵌 `input`，`min-height:42px`，全宽。
  - 主按钮 `.login-submit`：全宽、42px、图标左 + 文案居中（`flex:1`）+ 箭头右。
  - 分隔 `.login-divider`：两侧 1px 线 + 居中「或」。
  - SSO 按钮 `.login-sso`：全宽 42px、`justify-content:center`、间距 8px。
- 响应式：≤800px 仍保持两栏（`1fr 1fr`），标题降到 27px，节点卡 116px；≤600px 塌成单栏——左栏只保留品牌行（隐藏点阵、叙事正文、页脚），`.login-main` 改 `padding:35px 30px 100px`，主题按钮移到 `top:-57px`。
- 参考页登录**含管理密钥输入框与 `form` 提交**。

当前 UI 登录：单栏居中，`.loginIntro`（品牌 + h1 + 说明）+ `.loginCard`（`panel-radius` 卡片、shield 图标、h2、说明、SSO 链接）各 `min(440px,100%)`，背景 `--page`，主题抽屉按钮绝对定位 `top:20px; right:24px`；**没有 `form`、没有 `input`**，只有 `/sso/login?return_to=/dashboard/` 链接。

迁移约束（硬性）：

- 只移植视觉结构，**不得移植密钥输入框与 `form`**。`src/sso.test.tsx:271` 断言 `container.querySelector("form, input")` 为 `null`，`e2e/sso.spec.ts:85-87` 断言无 `input[type=password]`、无「进入工作台」按钮。若新登录页引入 `<form>`，两处测试都会失败。
- 参考页的「或」分隔与 SSO 按钮在 SSO-only 场景退化为单个主操作：把 `.login-submit` 的样式套到现有 SSO 链接上，`.login-divider`、`.login-sso` 不需要。
- 参考页文案全部硬编码；本项目必须走 `i18n.tsx` 双语键。

### 2.3 全局外壳

| 维度 | 参考（cnb2api-panel） | 当前 UI |
| --- | --- | --- |
| 布局模型 | `display:grid`，`grid-template-areas: 'header header' 'sidebar content'`，`height/ min-height:100dvh`，`overflow:hidden` | 顶栏 `position:sticky` + 侧栏 `position:fixed`，页面滚动，`min-height:100dvh` |
| 顶栏 | 52px 高，`padding:0 16px`，整宽，背景与 `--sidebar` 同色（`#f2f4f7`） | 48px 高，`padding:0 12px 0 6px`，背景 `--page` |
| 侧栏 | 180px（折叠 64px），背景 `--sidebar`，`padding:8px 12px 12px`，`transition: grid-template-columns` | 208px（折叠 44px），背景 `--page`，`padding:12px 8px`，宽度过渡 + 文案淡出 |
| 内容面板 | `.main-shell` `margin:8px 8px 8px 0`，`border:1px solid --line`，**16px** 圆角，`overflow:auto`，自身滚动 | `.workspace` `margin:8px 8px 0 calc(sidebar+8px)`，**11.2px** 圆角（`radius × 1.4`），页面级滚动 |
| 导航项 | 36px 高、`--radius-sm` 8px、14px/500；选中态 `--nav-active-bg #cfddf2` + `inset 3px 0 0 #1e40af` + `inset 0 0 0 1px` 内描边、文字 `#000` | 36px 高、`--radius` 8px、13px；选中态 `--selected` 底 + `--primary-line` 边框 + `--accent` 文字 |
| 导航分组 | 两组 caption：「控制台 / CONSOLE」「管理与接入」，右侧英文小字 | 三组 `navLabel`：工作台 / 资源管理 / 系统 |
| 顶栏面包屑 | 顶栏内 `控制台 › 当前页`（`ChevronRight` 13px） | 内容面板内 `工作台 / 当前页`，11px |
| 用户区 | 头像是 26px 圆形 + `ChevronDown` 的胶囊按钮 → 弹出面板（34px 头像 + 名称 + 邮箱/身份 + 分隔线 + 红底 hover 的「退出登录」） | `.session` 绿点 + 名称文本 + 独立「退出登录」按钮 |
| 侧栏底部 | 「项目与文档」外链（自带 `margin-top:auto`） | 无 |
| 页脚 | `.page-footer` 12px：网关标识 · 产品名 + 版本 · 策略，右侧「每15秒刷新 · 时间」按钮 | 无页脚 |
| 提示 | 右下 `.toast-stack`（`border-radius 12px`、`box-shadow 0 8px 30px`） | 无 toast，只有 `ErrorNotice` 内联条 |
| 折叠行为 | 隐藏 caption / 文字 / 徽标，图标居中 | 保持布局槽位，`max-height` + `opacity` 过渡，图标不位移 |

当前 `e2e/layout.spec.ts` 把这些几何写死：`SIDEBAR = 208`、`COLLAPSED_SIDEBAR = 44`、`HEADER_HEIGHT = 48`，并断言「图标折叠前后位移 ≤1px」「折叠只过渡 `width`」「隐藏桌面侧栏的断点为 ≤800px」。迁移后必须同步改这些常量，或保留原几何。

### 2.4 token 与字体

| 项 | 参考 | 当前 UI |
| --- | --- | --- |
| 主色 | `--primary #3169df`（暗色 `#78a2ff`） | `--accent/--primary #005ab7`（暗色 `#78b4f1`） |
| 页面底 | `--bg #f8f9fb` | `--page #f7f9fb` |
| 侧栏底 | 独立 `--sidebar`（`#f2f4f7` / 暗 `#14181f`） | 复用 `--page` |
| 圆角阶梯 | `4 / 8 / 12 / 16 / 28 / 999`，`--radius: 12px` | `8 / 4.8 / 6.4 / 8 / 11.2`，`--radius: 8px` |
| 字体 | DM Sans（拉丁）+ JetBrains Mono（等宽），`@fontsource-variable` 自托管，`font-size:14px` | `Microsoft YaHei / PingFang SC / Noto Sans CJK` 系统栈，无 webfont |
| 状态色 | green `#209d77`、amber `#b88125`、red `#d35454`、violet `#8a71c9` | good `#227558`、warning `#875b0f`、error `#b3363b`，成对 good-bg/warning-bg/error-bg |

`docs/design-system.md` 明确要求「颜色只在 theme.scss 维护，组件使用 var()」，并要求中英文字体命中支持中文的无衬线字体。若要采用 DM Sans，只应作用于拉丁字符，中文仍需回落到 CJK 字体栈——参考实现正是把 `Microsoft YaHei` 放在 DM Sans 之后回退。

## 3. 具体迁移文件清单

目标目录：`D:/My2KProjects/codebuddy2api/web`。

### 3.1 整包回填（从 `codebuddy2api-ui` 复制）

- `src/**`（51 个同名文件全部覆盖，含 `pages/**`）
- 新增文件：`src/dashboard.module.scss`、`src/management.module.scss`、`src/sso.test.tsx`
- `e2e/**`（覆盖 9 个同名文件，新增 `sso.spec.ts`、`sso.ts`、`layout.spec.ts`）
- `docs/**`（`design-system.md`、`gateway-contract.md`、`deployment.md`、`validation.md`）
- `index.html`、`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`vite.config.ts`、`playwright.config.ts`、`playwright.integration.config.ts`
- `scripts/prepare-notices.mjs`（构建前生成第三方声明，旧 `web/` 无此脚本）
- `README.md`

### 3.2 本次设计迁移真正要改写的文件

| 文件（目标 `codebuddy2api/web/`） | 改动内容 |
| --- | --- |
| `src/App.tsx` | ① 新增 `BootScreen` 组件替换 `Guard` 的 `s.center` 分支（品牌图标 + 旋转 loader + 文案，保留 `role="status"`）；② `Login` 改为两栏结构：`login-story`（品牌 + eyebrow + 大标题 + network-art + 页脚）+ `login-main`（lock 图标 + eyebrow + h2 + 说明 + SSO 主链接），**不引入 form/input**；③ `Shell` 顶栏拆分 `topbar-leading`（折叠按钮 + 品牌 + 面包屑）与 `topbar-actions`（外观 + 用户菜单），退出登录收进 `user-menu` 弹层；④ 侧栏加 `nav-caption` 双语组标题与 `sidebar-bottom` 帮助链接；⑤ 内容面板末尾加 `page-footer`。 |
| `src/ui.module.scss` | 新增/改写块：`.boot`、`.loginShell`、`.loginStory`、`.loginStoryContent`、`.networkArt`、`.networkCenter`、`.networkNode`（含 `node-1/2/3` 旋转）、`.loginMain`、`.loginLock`、`.loginTheme`、`.eyebrow`、`.brandTag`、`.topbar`、`.topbarLeading`、`.topbarActions`、`.breadcrumbs`、`.userMenu`、`.userTrigger`、`.userAvatar`、`.userPanel`、`.userIdentity`、`.userLogout`、`.navCaption`、`.sidebarBottom`、`.pageFooter`；同时补 ≤800px / ≤600px 覆盖（≤600px 塌成单栏并隐藏叙事区）。 |
| `src/theme.scss` | 决策项：是否加入 `--sidebar`、`--nav-active-bg`、`--nav-active-border`、`--primary-soft`、`--secondary`、`--surface-subtle`，以及是否把 `--radius` 从 8px 调到 12px。暗色对应值一并补齐。 |
| `src/i18n.tsx` | 新增双语键：`app.connecting`（正在连接控制台 / Connecting to console）、`login.story.eyebrow`、`login.story.headline`、`login.story.footer`、`login.form.eyebrow`、`nav.caption.console`、`nav.caption.manage`、`nav.consoleTag`、`app.projectDocs`、`footer.gateway`、`footer.strategy`、`footer.refresh`。品牌名保持 `app.brandName`，若要做「2」染色需拆成 `brandPrefix / brandAccent / brandSuffix` 三键，避免双语硬编码。 |
| `src/components.tsx` | `Icon` 路径表新增：`chevronDown`、`chevronRight`、`user`、`logout`、`cloud`、`loader`、`sun`/`moon` 已有。不引入 `@lucide/react` 依赖。 |
| `src/appearance.tsx` | 参考页是单按钮明暗切换；当前是含「跟随系统 / 语言」的抽屉。建议**保留抽屉**（可访问性与测试依赖），只把触发按钮换成参考页的圆形图标按钮样式。 |
| `e2e/layout.spec.ts` | 常量 `SIDEBAR` / `COLLAPSED_SIDEBAR` / `HEADER_HEIGHT` 按最终几何更新；`page-footer` 与 `user-menu` 会让 `expectVisibleContent` 的滚动宽度断言受益，但也可能触发新的溢出。 |
| `e2e/sso.spec.ts` | 断言的可见文案与角色需要跟着改：`heading 登录 CodeBuddy2Api`、`link 统一身份登录`、`button 退出登录`（迁移后位于用户菜单内，需先展开菜单）。`getByLabel("API key") === 0`、`input[type=password] === 0` 必须继续通过。 |
| `docs/design-system.md` | 事实来源变更后需同步 shell 几何（顶栏 52px、侧栏 180/64、面板 16px 圆角、`--sidebar`）与登录页结构描述。 |

### 3.3 明确不迁移的参考内容

- 参考页的 `api.ts` / `auth.ts` / `console.ts` / `quota.ts` / `types.ts`：管理模型完全不同（`/api`、面板管理密钥、`/auth/config`），与本项目 `/admin` + `/sso` 无关。
- 参考页的 `views/*.vue`（账号池、路由策略、审计、接入配置）：业务对象不同，只借视觉语言。
- 参考页的「管理密钥」登录、`PANEL_ADMIN_KEY` 文案、`/auth/config` 探测。
- 参考页的 `--violet`、`stats-grid`、`account-table` 等业务样式块。

## 4. 保留现有管理功能与 `/sso` 契约

必守契约（来自 `docs/gateway-contract.md` 与 `src/api.ts`）：

1. 启动调用 `GET /sso/session`，唯一身份来源；`role` 必须为 `admin`。
2. 响应必须是 `{ authenticated: true, csrf_token, user }` 或 `{ authenticated: false, csrf_token: null, user: null }`，否则抛契约错误。
3. CSRF 只存内存，写入请求带 `X-CSRF-Token`；`POST /sso/logout` 显式带同一头。
4. `401` → `anonymous`（回登录页）；`403` → `forbidden`（无管理权限页 + 「使用其他账号登录」链接）。
5. 登录链接固定 `/sso/login?return_to=/dashboard/`；浏览器永不持有管理 API Key，**无密钥输入框**。
6. 路由仍为 `/dashboard`、`/dashboard/login`、`/dashboard/{models,credentials,logs,settings,storage}`，`base: "/dashboard/"`，SPA 兜底不接管 `/sso`、`/admin`。

迁移后仍须保留的现有能力：六个管理页原样保留（只换外壳样式，不改数据流）；`establishSession` 的代际校验与 401/403 失效逻辑不动；`useResource` 的会话级缓存不动；日志清空确认文案 `CLEAR_CONFIRMATION` 不动；`Drawer` 的 `lockPage`、焦点恢复、Escape 关闭不动。

外壳改造带来的功能位移（必须显式确认）：

- 「退出登录」从顶栏按钮移入用户菜单 → `e2e/sso.spec.ts` 有 6 处直接 `getByRole("button", { name: "退出登录" })`，全部需要先点击用户菜单。若不想改测试，可保留顶栏直出按钮。
- 面包屑从内容面板移到顶栏 → 影响 `layout.spec.ts` 的 `heading.top` 断言余量。
- 新增页脚会占用内容面板底部空间 → 手机 375×812 下的可见内容断言需复测。

## 5. 许可证归属（关键风险）

- `cnb2api-panel` 是 **AGPL-3.0-only**（`web/package.json` 与根 `LICENSE`）。当前 UI 与 `codebuddy2api` 是 **MIT**。
- 因此**不能直接复制** `cnb2api-panel/web/src/styles.css`、`App.vue` 或任何 `.vue` 片段。逐字复制会让整个分发落入 AGPL-3.0 的传染范围，与 MIT 冲突。
- 允许的做法：把第 2 节记录的**视觉参数与结构**（尺寸、间距、圆角、颜色值、布局关系）当作设计规格，在 React/SCSS 中独立实现。颜色值与尺寸本身不构成可版权保护表达。
- 若后续确实要引用其代码：必须整体切到 AGPL-3.0-only，并在仓库根放 AGPL 全文、在 UI 暴露源码地址，同时接受网络分发条款。当前任务不应走这条路。
- 若采用 DM Sans / JetBrains Mono（均为 OFL-1.1），需要把许可文本放到 `web/public/licenses/` 并在 `THIRD_PARTY_NOTICES.md` 增列。参考仓库正是这样存放 `DM-Sans.txt`、`JetBrains-Mono.txt`、`Lucide.txt`。若沿用现有内联 `Icon`，则不需要 Lucide 的 ISC 声明。

### 文件归属建议

1. 替换后 `codebuddy2api/web/` 与仓库根同属 `codebuddy2api`（MIT，Copyright (c) 2026 墨菊）。**UI 不再是「外部上游的衍生作品」，而是本仓库自身产物**。
2. 因此 `LICENSE.upstream` 在 `codebuddy2api/` 内失去意义：上游即本仓库。建议不把它复制进 `codebuddy2api/`；`README.md` 的「License and source attribution」段落改为「本仓库 MIT」+ 修改说明（品牌、SSO 迁移、去掉浏览器 API Key）。
3. `THIRD_PARTY_NOTICES.md` 应落在仓库根 `codebuddy2api/THIRD_PARTY_NOTICES.md`（因为构建产物 `web/dist` 随镜像分发），内容删掉「derivative of codebuddy2api」语段，保留依赖清单；若新增字体，追加 OFL 条目与 `public/licenses/*.txt`。
4. 泛型声明「设计语言参考 cnb2api-panel 的既有实现」可以写进 `docs/design-system.md` 的事实来源，但**不得**声称代码衍生、不得复制其 AGPL 头注释。
5. `codebuddy2api-ui` 仓库本身在这次迁移后成为过渡产物。是否归档、是否保留其 `LICENSE.upstream`，由主协调决定，本轮不改。

## 6. 测试与验证影响

需要更新（会在迁移中失败）：

- `e2e/layout.spec.ts`：`SIDEBAR`、`COLLAPSED_SIDEBAR`、`HEADER_HEIGHT`、断点断言。
- `e2e/sso.spec.ts`：登录页可见标题/链接、退出登录入口位置。
- `src/sso.test.tsx`：`getByRole("link", { name: "使用统一身份登录" })`、403 文案、「无表单无输入」断言。**如果登录页只需换排版，这些可以全部不动。**
- `src/components.test.tsx`、`src/dashboard.test.tsx`：若 `Icon` 路径表或 `PageTitle` 结构调整会受影响。

不受影响：`src/api.ts` 及其测试、`logs.test.tsx`、`models.test.tsx`、`automation.test.tsx`、`storage.test.tsx`、`oauth.test.tsx`。

验收命令（沿用现有脚本）：`pnpm check`、`pnpm test`、`pnpm build`、`pnpm test:browser`。

## 7. 待主协调决策的开放项

1. 圆角与主色：切到参考页的 12px / `#3169df`，还是保留 AzureKiln 的 8px / `#005ab7`？（`docs/design-system.md` 目前锁死 8px 与 New API 结构，改动等于改规范。）
2. 布局模型：是否改成参考页的 `grid` + 面板内滚动（需同步改 `layout.spec.ts`），还是保留当前页面级滚动。
3. 侧栏宽度 208→180、折叠 44→64，是否接受？影响 3 处测试常量。
4. 是否引入 `@fontsource-variable` 两个字体包（新增依赖 + 许可文件）。
5. 「退出登录」是否收进用户菜单（美感更好，需改 6 处测试）。
6. 是否新增 toast 机制与页脚（参考页有，当前无）。
7. 顶栏高 48→52px 的取舍。

建议 MVP：只做加载画面 + 登录页两栏叙事 + 顶栏品牌/面包屑/用户菜单 + 侧栏分组标题与底部链接 + 页脚，先不换圆角刻度与字体包，这样 `layout.spec.ts` 只需改「退出登录」相关部分与页脚引入的溢出断言。

## 8. 一句话结论

`codebuddy2api/web` 是 `codebuddy2api-ui` 的上游快照，回填是纯复制加 UI 层改写。真正要动的只有 `App.tsx`、`ui.module.scss`、`theme.scss`、`i18n.tsx`、`components.tsx` 与 3 个测试文件。设计参考必须停在「视觉规格」层面，因为 `cnb2api-panel` 是 AGPL-3.0，直接复制代码会让 MIT 项目失去许可。
