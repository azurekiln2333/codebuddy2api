# AzureKiln 设计规范

> 迁移说明（2026-10-26）：本文件记录独立 UI 的历史设计。当前产品已整合到
> `../codebuddy2api/web/`，最新的 panel 风格、52px 顶栏和 180/64px 侧栏规范见
> 同工作区 `codebuddy2api/docs/design-system.md`。下文不再作为新版产品的实现依据。

本规范用于本控制台及后续 Tailwind 站点统一视觉。2026-10-16 用户纠偏后，以新版 New API（Base UI / Tailwind 4）的实际 shell、dashboard 和 UI 层为主要结构参考，独立实现 AzureKiln 品牌。旧样板只保留品牌蓝与克制的管理工具气质，旧 6px/10px 圆角、全高品牌侧栏和手机横向导航已被替代。

事实来源：`src/theme.scss`（语义 token）、`src/ui.module.scss`（共享组件与 shell）、`src/dashboard.module.scss`（首页）、`src/management.module.scss`（表格与设置）。New API 源码仅供只读视觉研究，未复制其组件实现或品牌。本仓库原 web 来源与 MIT 版权见 `LICENSE.upstream`、`THIRD_PARTY_NOTICES.md`。

## 1. 语义 token

颜色只在 theme.scss 中维护，组件使用 var()。显式主题由根元素 data-theme 切换；未指定时由系统色彩偏好兜底。

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| --accent / --primary | #005ab7 | #78b4f1 | 品牌、选中、主操作、焦点 |
| --primary-hover | #004c9b | #9bc8f7 | 主操作 hover |
| --on-primary | #fff | #0d2842 | 主操作文字 |
| --strong | #19232e | #f1f4f8 | 标题、大数字 |
| --text | #242b33 | #d3dce6 | 正文 |
| --muted | #657180 | #9ba7b5 | 次级文字 |
| --subtle | #75818e | #96a2b0 | 辅助说明 |
| --page | #f7f9fb | #14181e | 外壳底色 |
| --surface | #fff | #1b2027 | 内容面板 |
| --surface-tint | #f0f3f6 | #242b35 | 次级表面 |
| --soft | #f5f7f9 | #222831 | 弱填充、表头 |
| --selected | #edf4fc | #24364b | 选中背景 |
| --line | #e5e9ef | #303a46 | 细边框 |
| --line-strong | #d8dee7 | #465261 | 控件边框 |
| --primary-line | #cddff3 | #345377 | 选中边框 |
| --shadow | #142c480a | #00000040 | 极轻阴影 |
| --veil | #182a424d | #050b14a6 | 弹层遮罩 |

状态色始终以前景/背景成对使用：good 为 #227558 / #edf6f0（深色 #81cba8 / #243b32）；warning 为 #875b0f / #fff7e9（深色 #e1bb72 / #3b3326）；error 为 #b3363b / #fdf0f0（深色 #f09598 / #402b30）。图表系列分别使用 requests 蓝、tokens 绿、credit 棕黄，语义不随页面改变。

## 2. 尺寸、字型与层次

| 角色 | 规则 |
| --- | --- |
| 常规控件 | --radius: 8px（对齐 New API 的 0.5rem 档）；--control-height: 32px |
| 常规面板 | --panel-radius: var(--radius) |
| 外层内容面板 | --workspace-radius: calc(var(--radius) * 1.4) |
| 圆角阶梯 | --radius-sm 0.6x / --radius-md 0.8x / --radius-lg 1x / --radius-xl 1.4x |
| 导航项 / 顶栏图标按钮 | var(--radius)；导航 36px 高，图标按钮 32px |
| 图标 | 16px，品牌标记 24px |
| 表头 / 数据行 | 40px / 60px；复杂内容可自然增高 |
| 页面内距 | 桌面 20px 24px 28px；手机 16px 16px 24px，窄屏14px |
| 常用间距 | 4 / 8 / 12 / 16 / 20 / 24px |
| 页面标题 | 可见 h1，24px/1.4、650 字重；手机22px |
| 面板标题 | 15px、650 字重 |
| 正文 / 控件 / 说明 | 14px / 13px / 11–12px |
| 指标 | 主指标27px，Token明细22px，tabular-nums |

字体变量：

```css
--font: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC",
        -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

html、body、按钮、输入框、下拉、文本域均应用此字体栈，代码及数据标识单独使用 mono。只声明字体名不足以证明实际渲染，浏览器验收需记录中文节点的实际 platform font，确认命中支持中文的无衬线字体。

## 3. Shell 与手机导航

顶栏在外壳最上方，x=0、宽为视口、固定48px高，含导航开关、AzureKiln 品牌与会话/外观操作。侧栏从顶栏下方48px开始，展开208px、折叠44px，共享 --sidebar-width。品牌不再放在全高侧栏。导航按工作台、资源管理、系统分组。

内容面板与外壳各留8px，桌面左界为 sidebar-width + 8px，var(--workspace-radius)（= radius × 1.4）圆角、1px细边框、极轻阴影。面板内部依次是面包屑、可见标题与操作、业务内容；标题不能仅供读屏。不要对 sidebar width 与 workspace margin 分别动画，避免首帧遮挡。

≤800px 隐藏桌面侧栏，内容面板左右6px、顶部4px、圆角仍为 var(--workspace-radius)。导航开关名称为“打开导航菜单”，打开现有 Drawer 原生 dialog，名称“主导航”。使用原生模态行为、lockPage 滚动锁和触发按钮焦点恢复；Escape、关闭按钮、选择路由后关闭。手机不能把六个导航项挤成横向滚动条。≤440px 内距收至14px。手机主内容按钮、输入框及选择框至少40px；登录主操作44px；48px顶栏内仍为32px控件。

桌面开关名称“折叠侧栏 / 展开侧栏”。折叠偏好仅存本机界面设置，不存登录信息。几何回归同时检查主区域避让、标题命中、全页无横向溢出。

## 4. 首页、数据表与设置

首页使用独立“使用总览”面板：4项核心指标放在轻底内卡，Token 明细另分一组。保留真实数值、未知值和周期比较逻辑；sparkline 来自实际 series。趋势面板拥有完整绘图区与原有缩放/粒度/数据表交互，模型排行、账号分布、凭据健康和余额随后呈现。手机核心指标双列、次级面板单列。不把每个文字或数字都套入装饰卡。

数据页采用完整面板中的工具栏与表格：搜索与筛选在前，操作在后，16–20px内距；表头40px、行60px。横向滚动必须局限于 tableWrap，长模型名/账号名不撑宽页面。空、加载、失败、成功反馈必须保留，失败可重试，未知数据不伪装为0。

设置采用页内分类导航与内容分区两列结构。仍保留可修改、外部锁定、系统只读三种来源视图；分类导航不改变后端能力。内容有说明、字段、来源状态和保存 footer；切换分类不丢未保存 draft。手机分类横向可滚动，字段单列。服务端 api_key 不展示、不交给浏览器输入。

## 5. 交互与状态

按钮有常规、主操作、危险操作；禁用态保持尺寸。焦点使用2px accent outline，偏移3px；输入框偏移1px。弹层均有可访问名称与关闭操作；小图标按钮必须有 aria-label。状态同时用文案和颜色表达。全量清日志继续要求精确确认文案，服务端秘密仅网关补齐。

明暗只改变 token，不改变布局。允许140ms的颜色/背景小过渡；prefers-reduced-motion 时关闭动效。不使用大渐变、发光、营销 hero 或装饰插画。所有状态必须对应真实 API；仅测试使用 mock fixture，生产无假数据回退。

## 6. Tailwind 4 映射

本项目仍使用 SCSS modules；其他站点可复用规则和 token，无需迁移业务组件。

```css
@import "tailwindcss";
@import "./azurekiln-tokens.css";

@theme inline {
  --color-accent: var(--accent);
  --color-primary: var(--primary);
  --color-on-primary: var(--on-primary);
  --color-strong: var(--strong);
  --color-text: var(--text);
  --color-muted: var(--muted);
  --color-page: var(--page);
  --color-surface: var(--surface);
  --color-soft: var(--soft);
  --color-selected: var(--selected);
  --color-line: var(--line);
  --color-line-strong: var(--line-strong);
  --color-good: var(--good);
  --color-good-bg: var(--good-bg);
  --color-warning: var(--warning);
  --color-warning-bg: var(--warning-bg);
  --color-error: var(--error);
  --color-error-bg: var(--error-bg);
  --font-sans: var(--font);
  --font-mono: var(--mono);
  --radius-control: var(--radius);
  --radius-panel: var(--panel-radius);
  --radius-workspace: var(--workspace-radius);
  --spacing-control: var(--control-height);
}
```

颜色变量是完整 CSS 颜色，不要写成 rgb(var(--accent))。需要透明度时使用 color-mix 并检查所用 Tailwind 版本的生成结果。状态背景直接用 good-bg 等成对 token。主题切换由 token 驱动，组件无需重复 dark: 类。

骨架映射：顶栏 h-12 w-full；桌面侧栏 top-12 w-[208px]（折叠44px）；内容面板 mt-2 mr-2 ml-[216px]（折叠52px），rounded-workspace border border-line bg-surface；手机 mx-[6px] mt-1 rounded-[18px] 并用原生 dialog 替代侧栏。本文几何仅为映射说明，模态、焦点恢复与 responsive 行为应使用目标站点既有能力。

复用范围为语义颜色、圆角、字型、间距、shell结构和通用控件规则。API/SSO/CSRF、凭据/OAuth、模型路由、日志清理、存储管理、数据归一化与部署配置属于本仓库业务，不复制到其他站点。
