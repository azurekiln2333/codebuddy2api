# CodeBuddy2Api 控制台设计规范

本规范描述 `web/` 管理控制台的视觉与交互契约。事实来源为 `web/src/theme.scss`
（语义 token）、`web/src/ui.module.scss`（外壳与共享组件）、
`web/src/dashboard.module.scss`（首页）与 `web/src/management.module.scss`
（表格与设置）。

外观按用户当前要求重做：两栏登录、品牌化加载屏、参考控制台外壳几何与配色。
2026-10 之前基于 New API 的 48px 顶栏 / 208px 侧栏 / 8px 圆角几何已被取代。

## 1. 设计来源与许可

- 视觉规格参考了 `cnb2api-panel` 的可观察设计（顶栏与侧栏几何、登录页两栏构图、
  网络示意图、色彩与圆角刻度）。该参考项目为 AGPL-3.0-only，**没有复制其源码**：
  布局关系、尺寸、间距和颜色值作为设计规格，在 React + SCSS Modules 中独立实现。
- 本项目自身仍是 MIT（`LICENSE`，Copyright (c) 2026 墨菊）；`web/LICENSE.upstream`
  保留原 web 上游的 MIT 全文。
- 运行期依赖许可证全文由 `web/scripts/prepare-notices.mjs` 在构建时汇总到
  `web/dist/THIRD_PARTY_LICENSES.txt`；清单见 `web/THIRD_PARTY_NOTICES.md`。
- 未引入 `@fontsource` 等 webfont：继续使用可命中中文的系统字体栈，避免新增许可负担。

## 2. 语义 token

颜色只在 `theme.scss` 维护，组件只使用 `var()`。显式主题由根元素 `data-theme`
切换；未指定时由系统色彩偏好兜底。

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--primary` / `--accent` | `#3169df` | `#78a2ff` | 品牌、选中、主操作、焦点 |
| `--primary-hover` | `#2459ca` | `#97b7ff` | 主操作 hover |
| `--primary-soft` | `#edf3ff` | `#263653` | 图标底、弱品牌填充 |
| `--on-primary` | `#fff` | `#0b1a33` | 主操作文字 |
| `--brand` | `#3169df` | `#3169df` | 品牌方块，暗色不变 |
| `--strong` | `#1b2430` | `#e7edf6` | 标题、大数字 |
| `--text` | `#232b3a` | `#e1e7f0` | 正文、导航文字 |
| `--secondary` | `#596477` | `#abb5c5` | 面包屑当前页、次级强调 |
| `--muted` | `#7d8798` | `#8590a1` | 次级文字 |
| `--line` / `--line-strong` | `#e9edf2` / `#dce2eb` | `#2a313e` / `#3b4455` | 细边框 / 控件边框 |
| `--page` | `#f8f9fb` | `#14181f` | 页面底色 |
| `--sidebar` | `#f2f4f7` | `#14181f` | 顶栏与侧栏底色、外壳留白 |
| `--surface` | `#fff` | `#1b2029` | 内容面板、卡片 |
| `--surface-subtle` | `#fafbfd` | `#1e242e` | 登录叙事区、hover 表面 |
| `--soft` | `#f6f8fa` | `#20262f` | 弱填充、表头 |
| `--selected` | `#e8eefc` | `#263653` | 选中背景 |
| `--nav-active-bg` | `#cfddf2` | `#24344f` | 导航选中底色 |
| `--nav-active-border` | `#9fb5d6` | `#3f5d8c` | 导航选中内描边 |
| `--shadow` / `--shadow-raised` | 极轻 / 弹层阴影 | `none` / 深色弹层 | 面板与浮层 |
| `--veil` | `#12203560` | `#05080fa6` | 弹层遮罩 |

状态色成对使用：`good` `#209d77`/`#edf9f3`（暗色 `#68c5a4`/`#233c34`）、
`warning` `#b88125`/`#fff8eb`（暗色 `#dbb16d`/`#3a3224`）、
`error` `#d35454`/`#fff2f2`（暗色 `#f58b8b`/`#3e2a2e`）。
图表系列固定为 requests 蓝、tokens 绿、credit 棕黄。

## 3. 圆角、尺寸与字型

| 角色 | 规则 |
| --- | --- |
| 圆角基数 | `--radius: 12px` |
| 圆角阶梯 | `--radius-xs 4px` / `--radius-sm 8px` / `--radius` 12px / `--radius-lg 16px` / `--radius-xl 20px` / `--radius-full 999px` |
| 控件圆角 | `--radius-sm`（8px，与参考按钮一致） |
| 常规面板 / 卡片 | `--panel-radius` = `--radius`（12px） |
| 外层内容面板 | `--workspace-radius` = `--radius-lg`（16px） |
| 控件高度 | `--control-height: 36px` |
| 顶栏 / 侧栏 | `--header-height: 52px`；`--sidebar-width: 180px`；`--collapsed-sidebar-width: 64px` |
| 图标 | 16px；导航图标 17px；品牌标记 20px（方块 30px） |
| 表头 / 数据行 | 40px / 60px，长内容自然增高 |
| 页面内距 | 桌面 `20px 22px 18px`；≤800px `16px`；≤440px 左右 14px |
| 常用间距 | 4 / 8 / 12 / 16 / 20 / 24px |
| 页面标题 | 可见 `h1`，24px/1.4、650 字重；手机 22px |
| 登录主标题 | 叙事 `h1` 38px/600/1.65；表单 `h2` 25px/600 |

字体变量（不加载 webfont，保证中文命中）：

```css
--font: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC",
        -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

## 4. 加载屏

`Guard` 在 `checking` 状态渲染品牌化加载屏，而不是纯文字提示：

- 结构：品牌方块（30×30，`--brand` 底、白色图形）→ 旋转 loader（20px，
  `1.2s linear infinite`）→ 文案。三者横排，`gap: 15px`，`min-height: 100dvh`，
  居中，`color: var(--muted)`，14px。
- 文案是精确中文字符串 `正在连接控制台`（英文界面为 `Connecting to console`）。
- 容器带 `role="status"`，保留读屏播报；`prefers-reduced-motion` 时关闭旋转。

## 5. 登录页

两栏：左叙事、右表单。不引入 `<form>` 或任何输入框——唯一的操作是统一身份登录链接。

- 外层 `.loginShell`：`grid-template-columns: 1.08fr 1fr`，`min-height: 100dvh`，
  底色 `--surface`。
- 左栏 `.loginStory`：`padding: 42px 50px 28px`，底色 `--surface-subtle`，
  右侧 1px 分隔线；伪元素 21px 网格点阵（`radial-gradient`，`opacity: .45`）。
  - 品牌行：品牌方块 + 品牌名（其中 `2` 用 `--primary` 染色）+ `CONSOLE` 标签
    （11px、`letter-spacing: 1.4px`、左边框分隔）。
  - 叙事：`eyebrow`（11px、主色、前置 5px 圆点）→ `h1` 两行 → 网络示意图。
  - 网络示意图：高 240px；SVG 虚线路径（`stroke-dasharray: 4 4`）；中心卡 104px
    宽 12px 圆角；三张 140px 宽节点卡，`rotate(-3deg)` / `0` / `rotate(3deg)`，
    节点内绿点表示在线。
  - 页脚：12px、`letter-spacing: 0.3px` 的说明文案。
- 右栏 `.loginMain`：居中，`padding: 65px 30px`；主题按钮绝对定位
  `right: 32px; top: 35px`（复用现有外观抽屉，名称仍为“外观设置”）。
  - 48×48 锁形图标（`--primary-soft` 底、12% 主色边框、16px 圆角）→
    `eyebrow` → `h2` → 说明段（`margin-bottom: 33px`）。
  - 主操作：全宽 42px、左侧盾牌图标 + 居中文案 + 右侧箭头，指向
    `/sso/login?return_to=/dashboard/`。
  - 错误/403 时显示内联 `role="alert"` 与“重新检查登录状态”。
- 响应式：≤800px 仍两栏（标题 27px、节点卡 116px）；≤600px 单栏——左栏只保留
  品牌行（隐藏点阵、叙事正文与页脚），主题按钮锚定到外壳顶栏右侧
  （`top: 12px; right: 16px`，完整 32px 点击区，不依赖品牌行高度）。
- 文案全部走 `i18n.tsx` 双语键；不引入参考站点的密钥输入与 `form`。

## 6. 控制台外壳

- 顶栏：全宽 `sticky`，高 52px，底色 `--sidebar`，`padding: 0 16px`。左侧是
  折叠/导航按钮、品牌、面包屑（`控制台 › 当前页`，13px 箭头、当前页用
  `--secondary`）；右侧是外观按钮、1px 分隔和账号菜单。
- 账号菜单：26px 圆形头像（首字母，`--primary-soft` 底）+ 下箭头胶囊按钮，展开
  面板显示 34px 头像、名称与主体标识，分隔线下方是红底 hover 的“退出登录”。
  Escape 或点击外部关闭；按钮带 `aria-expanded` / `aria-controls`（面板为
  `role="group"`，不使用 `aria-haspopup`）。
- 侧栏：从顶栏下方 52px 开始，展开 180px、折叠 64px，底色 `--sidebar`，
  `padding: 8px 12px 12px`。两组 caption：“控制台 / CONSOLE”与“管理与接入”；
  导航项 36px 高、8px 圆角、14px/500，选中态 `--nav-active-bg` + `inset 3px 0 0
  var(--primary)` + 1px 内描边。
- 折叠：只过渡侧栏 `width`，文字与 caption 淡出但保持挂载，图标左列位置不变
  （回归断言要求折叠前后图标横向位移 ≤1px）。折叠态隐藏底部网关标识文字。
- 内容面板：`margin: 8px 8px 0 calc(sidebar + 8px)`，1px 边框、16px 圆角、
  `--surface` 底、极轻阴影；内部依次是页面标题、业务内容和页脚（网关标识 ·
  产品名，右侧是“开源声明”/“依赖许可”链接，指向 `/dashboard/THIRD_PARTY_NOTICES.txt`
  与 `/dashboard/THIRD_PARTY_LICENSES.txt`；用普通 `<a>` 而非 router `Link`，
  因为这些文档由网关以 `text/plain` 直接返回）。外壳留白色使用 `--sidebar`，与参考一致。
- 面包屑已从内容面板移到顶栏；≤980px 隐藏面包屑，≤800px 隐藏桌面侧栏。

## 7. 手机导航

≤800px 隐藏桌面侧栏，顶栏开关名称“打开导航菜单”，打开现有 `Drawer` 原生
`dialog`，名称“主导航”。使用原生模态行为、`lockPage` 滚动锁与触发按钮焦点恢复；
Escape、关闭按钮、选择路由后关闭；焦点不会进入背景页面。面板宽度
`min(296px, calc(100vw - 32px))`，从左侧打开并保留遮罩。手机不能把导航项挤成
横向滚动条。≤440px 内距收至 14px；手机主内容按钮、输入框、选择框至少 40px，
登录主操作 44px。

## 8. 业务页与状态

首页、凭证、模型路由、媒体生成、密钥、日志、存储、设置、版本更新共九个页面共享
外壳与表面样式。保留未知值、加载、失败可重试、权限撤销、CSRF 写入、日志清空精确
确认等既有契约。数据表横向滚动限制在 `tableWrap` 内，长标识不撑宽页面。设置页仍是
可修改 / 外部锁定 / 系统只读三种来源视图，切换分类不丢未保存 draft。

## 9. 交互、可访问性与动效

- 焦点：2px `--primary` outline，偏移 3px；输入框偏移 1px。
- 按钮有常规、主操作、危险操作三态；禁用态保留尺寸。
- 弹层均有可访问名称与关闭操作；小图标按钮必须有 `aria-label`；状态同时用文案
  和颜色表达。
- 明暗只切换 token，不改变布局。允许 140–180ms 的颜色/背景/宽度过渡；
  `prefers-reduced-motion` 时关闭动画与过渡。
- 不使用大渐变、发光、营销 hero 或装饰插画；不使用 Vue 业务组件。

## 10. Tailwind 4 映射（供其他站点复用）

本项目仍使用 SCSS Modules；其他站点可复用 token 与规则，无需迁移业务组件。

```css
@import "tailwindcss";
@import "./codebuddy-tokens.css";

@theme inline {
  --color-primary: var(--primary);
  --color-on-primary: var(--on-primary);
  --color-strong: var(--strong);
  --color-text: var(--text);
  --color-muted: var(--muted);
  --color-page: var(--page);
  --color-sidebar: var(--sidebar);
  --color-surface: var(--surface);
  --color-line: var(--line);
  --color-good: var(--good);
  --color-warning: var(--warning);
  --color-error: var(--error);
  --font-sans: var(--font);
  --font-mono: var(--mono);
  --radius-control: var(--radius-sm);
  --radius-panel: var(--panel-radius);
  --radius-workspace: var(--workspace-radius);
  --spacing-control: var(--control-height);
  --spacing-header: var(--header-height);
}
```

颜色变量是完整 CSS 颜色，不要写成 `rgb(var(--primary))`；需要透明度时使用
`color-mix()`。骨架映射：顶栏 `h-[52px] w-full bg-sidebar`；桌面侧栏
`top-[52px] w-[180px]`（折叠 64px）；内容面板 `mt-2 mr-2 ml-[188px]`
（折叠 `ml-[72px]`）、`rounded-workspace border border-line bg-surface`；
手机 `mx-[6px] mt-1` 并用原生 `dialog` 替代侧栏。

## 11. 验证

- `pnpm check`（格式、lint、类型）、`pnpm test`（jsdom 回归）、
  `pnpm build`（含许可证汇总）、`pnpm exec playwright test`。
- `web/e2e/design.spec.ts` 断言首帧品牌加载屏、登录两栏几何（桌面/手机）、
  52px 顶栏、180/64px 侧栏、16px 面板圆角、`#3169df` 主色、明暗 token 与折叠图标位移。
- `web/e2e/layout.spec.ts` 继续断言顶栏全宽、内容面板避让、标题可读无遮挡、
  手机无整页横向溢出、Drawer 焦点恢复与 reduced-motion 行为。
- 浏览器产物中的 `data-theme`、`--primary` 与几何值同时被断言，避免只校验声明值。
