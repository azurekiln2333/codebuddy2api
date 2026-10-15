# AzureKiln 设计规范（通用，可移植）

本规范用于把 AzureKiln 的视觉语言统一到**其他 Tailwind 站点**。事实来源是本仓库源码：

- `src/theme.scss` —— 语义 token 与明暗两套取值（`:root` / `@mixin dark`）。
- `src/ui.module.scss` —— token 的**实际用法**（间距、字型、圆角、控件、表格、状态、断点）。

原则：**移植 token 与规则，不移植业务代码**。本文档不引入任何组件库或新依赖。

---

## 1. 语义 tokens（直接复制，不要改名字）

token 以「用途」命名而非「颜色」命名，因此换配色时只改值、不改引用点。浅色定义在 `:root`，深色定义在 `@mixin dark`（显式深色由 `[data-theme="dark"]` 触发；未设 `data-theme` 时才由 `prefers-color-scheme` 兜底）。

### 1.1 品牌主色与中性色

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--accent` | `#005ab7` | `#78b4f1` | 品牌蓝：链接、选中态、focus、图表主色 |
| `--strong` | `#19232e` | `#f1f4f8` | 最强文字（大数字、标题强调） |
| `--text` | `#242b33` | `#d3dce6` | 正文 |
| `--muted` | `#657180` | `#9ba7b5` | 次级说明、表头、标签 |
| `--subtle` | `#75818e` | `#96a2b0` | 更弱的三级文字 |
| `--line` | `#e2e7ed` | `#303a46` | 常规边框/分隔线 |
| `--line-strong` | `#cbd3dd` | `#465261` | 控件边框、需要更明显时 |

### 1.2 表面与背景（蓝灰层次，这是 AzureKiln 的辨识度）

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--page` | `#f7f9fb` | `#151a20` | 页面底色（**冷灰蓝，不是纯白**） |
| `--surface` | `#fff` | `#1c222a` | 面板/卡片/表体 |
| `--surface-tint` | `#f0f3f6` | `#252d37` | 次级表面 |
| `--soft` | `#f5f7f9` | `#222a34` | 表头底、行 hover、弱填充 |
| `--selected` | `#edf4fc` | `#24364b` | 选中背景（导航选中、tab 选中） |
| `--primary-line` | `#cddff3` | `#345377` | 主色描边（选中卡片的边） |
| `--card` | `var(--soft)` | 同 | 卡片底色别名 |

### 1.3 主色动作

| Token | 浅色 | 深色 | 说明 |
| --- | --- | --- | --- |
| `--primary` | `#005ab7` | `#78b4f1` | 主按钮背景 |
| `--primary-hover` | `#004c9b` | `#9bc8f7` | hover 加深/提亮 |
| `--on-primary` | `#fff` | `#0d2842` | 主按钮文字（深色模式反转为深底字） |

### 1.4 状态色（背景+前景成对，不要单独用色值）

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--good` / `--good-bg` | `#227558` / `#edf6f0` | `#81cba8` / `#243b32` | 成功、健康、启用 |
| `--warning` / `--warning-bg` | `#875b0f` / `#fff7e9` | `#e1bb72` / `#3b3326` | 警告、外部锁定、降级 |
| `--error` / `--error-bg` | `#b3363b` / `#fdf0f0` | `#f09598` / `#402b30` | 错误、危险动作、失败 |

状态元素的边框统一用 `color-mix(in srgb, var(--good|warning|error) 30%, var(--line))`，避免额外定义描边色。

### 1.5 图表系列色

`--series-requests: #005ab7`、`--series-tokens: #227558`、`--series-credit: #946313`（深色：`#78b4f1` / `#81cba8` / `#e1bb72`）。系列色只用于数据可视化，不用于 UI 装饰。

### 1.6 阴影与遮罩

`--shadow: #142c481a`（浅）/ `#00000040`（深）；`--veil: #182a424d`（浅）/ `#050b14a6`（深）。遮罩用于抽屉/弹窗背景。

---

## 2. 间距、字型与圆角

### 2.1 圆角（常规控件 / 容器推荐规则）

```css
--radius: 6px;        /* 常规控件：按钮、输入框、下拉、导航项、图标按钮 */
--panel-radius: 10px; /* 常规容器：面板、卡片、抽屉 */
```

辅助层级还有一个 **badge 4px**（`border-radius: 4px`），适合极小的行内标记。

推荐规则：**常规控件用 6px、常规容器用 10px**；不要用 8px / 12px 这类既非控件也非容器的中间值，也不要把方角大容器做成「全圆 pill」。

例外：开关轨道使用 16px / 18px 圆角以形成胶囊形；图表细条使用 2px / 3px 辅助圆角。**本身是圆形的状态元素可以且应该用 `border-radius: 50%`**，例如会话状态点（6px）、图表数据点（7px）、loading spinner（16px）、开关滑块（12px）。判断标准是「元素语义上就是个圆」，而不是「给方形容器做大圆角」。

### 2.2 字型

```css
--font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
--mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

- 正文：`font: 14px/1.55 var(--font)`，全局开启 `-webkit-font-smoothing: antialiased`。
- 常用字号：12px（表头、说明、badge、eyebrow）、13px（按钮、表单标签、页面描述）、14px（正文）、26px（KPI 大数字）。
- 大数字用 `font-weight: 550` + `font-variant-numeric: tabular-nums`，保证等宽对齐。
- 中文站点保留 `"Microsoft YaHei" / "PingFang SC"`，不要换成仅西文字体栈。

### 2.3 间距节奏

| 场景 | 值 |
| --- | --- |
| 控件高度 | `--control-height: 36px`；行内小按钮（`.error button`、`.statusPills button`、`.viewSwitch button`）为 `min-height: 30px` |
| 控件内边距 | `padding: 6px 12px`（按钮）；`padding: 7px 10px`（输入框） |
| 页面主内距 | `padding: 28px 30px 36px`（≤1100px 收为 24px） |
| 顶栏 | `min-height: 66px; padding: 12px 30px` |
| 导航项 | `min-height: 42px; padding: 10px 12px; margin-bottom: 4px` |
| 面板内距 | 表头/表体单元格 `padding: 10px 16px` |
| 字段（label+控件） | `gap: 7px; margin: 18px 0` |
| 页面标题区 | `gap: 16px; margin-bottom: 24px` |
| 常用小间距 | 4 / 6 / 7 / 8 / 10 / 12 px |

---

## 3. 控制台导航（208px 契约）

```css
.app            { --sidebar-width: 208px; min-height: 100dvh; background: var(--page); }
.app.collapsed  { --sidebar-width: 72px; }
.sidebar        { position: fixed; inset: 0 auto 0 0; width: var(--sidebar-width);
                  z-index: 20; padding: 20px 14px 16px;
                  border-right: 1px solid var(--line); background: var(--surface); }
.workspace      { margin-left: var(--sidebar-width); min-width: 0; }
.header         { position: sticky; top: 0; z-index: 10; background: var(--surface); }
.main           { max-width: 1480px; margin: 0 auto; }
```

要点：

- **208px 展开 / 72px 收起**，两个状态都只通过 `--sidebar-width` 表达，侧栏与内容区共用同一个变量，不会错位。
- 侧栏 `fixed` + 内容区 `margin-left` 是分层关键：**不要把 `margin-left` 换成 `padding` 加在 `main` 上**，否则 sticky header 会跟着偏。
- 导航项选中态：`background: var(--selected); color: var(--accent); font-weight: 600`，左侧 3px `var(--accent)` 竖条（`::before`，`border-radius: 0 2px 2px 0`）。
- 侧栏/内容区的 `width`、`margin-left` **不要加 transition 过渡**：历史上宽度动画与 margin 动画不同步，截图里出现过侧栏压住内容区。宁可瞬时切换。
- 断点：`≤1100px` 收窄内距 → `≤980px` 缩放品牌 → **`≤800px` 侧栏改为顶部横向导航**（`position: relative; width: 100%`，导航横向可滚动）→ `≤440px` 隐藏面包屑、内距 14px。
- 移动端最窄支持 `min-width: 320px`，`html` 上加 `scrollbar-gutter: stable` 防止滚动条导致抖动。

---

## 4. 明暗模式

- 只在 `theme.scss` 里维护两份值：`:root`（浅色）与 `@mixin dark`。切换由 `document.documentElement.dataset.theme = "dark" | "light"` 驱动，同时 `@media (prefers-color-scheme: dark)` 兜底。
- 组件里**只写 `var(--x)`**，不写 `@media` 分支、不写 `[data-theme]` 选择器。
- 深色不是简单反色：主色从 `#005ab7` 提亮为 `#78b4f1`，`--on-primary` 变成深蓝 `#0d2842`，表面从白变为 `#1c222a`，页面底为 `#151a20`。
- 焦点环使用 `outline: 2px solid var(--accent); outline-offset: 3px`；输入框、下拉框和文本域收为 1px 偏移。深浅色都需可见。
- 明暗差异只影响**颜色 token**，不改圆角、间距、字号、断点。

---

## 5. 组件规范

### 5.1 按钮

| 类型 | 规范 |
| --- | --- |
| 基础 | `min-height: var(--control-height); padding: 6px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--surface); font-size: 13px; font-weight: 500` |
| 主按钮 `.primary` | `background/border: var(--primary); color: var(--on-primary)`；hover → `--primary-hover` |
| 危险 `.danger` | `background/border: var(--error); color: var(--surface)`；hover 用 `filter: brightness(0.92)`，**不要**再定一个新红色 |
| 文字危险 | 只改 `color: var(--error)`，不加底色 |
| 图标按钮 | 36×36，`padding: 7px`，`border-color: transparent`，`border-radius: var(--radius)` |
| 禁用 | 降透明度 + `cursor: not-allowed`，**保持尺寸不变** |

图标与文字间距 `gap: 7px`；文字链接按钮 `.linkButton` 与按钮共用同一形状规范。

### 5.2 表格

- 全局：`width: 100%; border-collapse: collapse; text-align: left; font-size: 12px`。
- `th`：`padding: 10px 16px; background: var(--soft); color: var(--muted); font-weight: 500; white-space: nowrap; border-block: 1px solid var(--line)`。
- `td`：`padding: 10px 16px; border-bottom: 1px solid var(--line); vertical-align: middle`。
- 最后一行去底边（`tbody tr:last-child td { border-bottom: 0 }`），行 hover 用 `var(--soft)`。
- `td small`：块级、`color: var(--muted)`、`max-width: 320px`、`overflow-wrap: anywhere`（长 URL/token 不撑破表格）。
- 表格容器必须 `overflow: auto` + `max-width: 100%` + `overscroll-behavior-inline: contain`，让横向滚动留在容器内，不带动页面。

### 5.3 表单

- 字段结构：`display: flex; flex-direction: column; gap: 7px; margin: 18px 0; font-size: 13px`，label 与控件垂直排列。
- 输入框/下拉：`min-height: var(--control-height)`，`border: 1px solid var(--line-strong)`，`border-radius: var(--radius)`，背景 `var(--surface)`。
- 校验失败：`border-color: var(--error)` + 提示文字用 `var(--error)`，**彩色 only，不加抖动动画**。
- `checkbox` / `switch` 用 `accent` 系；开关滑块 `transition: background 140ms, transform 140ms`。
- 只读/外部锁定：**不渲染禁用控件**，改为展示「当前生效值」文本 + 一句说明，避免灰色控件让人以为可改。

### 5.4 状态表达

- 统一用三类语义：`good`（成功/健康）、`warn`（警告/锁定）、`bad`（错误/失败），加 `neutral`（中性）。
- badge：`inline-flex; gap:4px; padding: 2px 7px; border-radius: 4px; font-size: 12px; font-weight: 500`，底色用对应 `-bg`，文字用对应前景色。
- 提示条：`padding: 12px 14px; gap: 10px; border-width: 1px`，底色 `-bg`、文字对应前景、描边 `color-mix(... 30%, var(--line))`。
- 面板：`background: var(--surface); border: 1px solid var(--line); border-radius: var(--panel-radius); overflow: hidden`（标题栏与内容共用一个圆角容器）。
- tab：底边 1px `var(--line)`，选项 `min-height: 44px`、`border-bottom: 2px solid transparent`，选中 → `border-bottom-color: var(--accent); color: var(--accent); font-weight: 600`。
- 加载/空/失败三态必须都实现，失败给可点的「重试」，不要用「0 数据」冒充成功。

### 5.5 动效与可达性约束

- 使用短过渡：`background 140ms`、`transform 140ms`、`border-color 140ms`、`color 140ms`；现有进度细条另有 `width 160ms ease`。不用弹性/回弹曲线。
- 禁止：渐变（gradient）、发光（glow/box-shadow 光晕）、营销式大 hero、装饰性插画。
- `@media (prefers-reduced-motion: reduce)` 下动画置 `none`。
- 焦点必须可见（见第 4 节 focus-visible）；交互元素需有可访问名称（纯图标按钮使用 `aria-label`）；表格滚动容器要可键盘聚焦。

---

## 6. Tailwind 接入示例

思路：**把 CSS 变量直接挂到 Tailwind theme 上**，这样 `bg-surface` / `text-muted` / `rounded-panel` 全是 token 驱动，明暗模式零改动。

### 6.1 引入 token

把 `src/theme.scss` 的 `:root` 与 `@mixin dark`（或等价的 `[data-theme="dark"]` 块）原样放进站点的基础样式：

```css
/* app.css */
@import "./azurekiln-tokens.css"; /* 即 theme.scss 的 :root + [data-theme="dark"] 两份变量 */
```

### 6.2 映射到 Tailwind（Tailwind v3，`tailwind.config.js`）

```js
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class", '[data-theme="dark"]'], // 与本项目的 data-theme 切换方式对齐
  theme: {
    extend: {
      colors: {
        // 本项目的 token 是完整 hex（如 --accent: #005ab7），不是 RGB 通道，
        // 因此只能直接写 var()，切勿写成 rgb(var(--x))（会解析失败）。
        // 副作用：border-good/30、bg-error/10 这类透明度修饰符不会被生成。
        accent: "var(--accent)",
        strong: "var(--strong)",
        text: "var(--text)",
        muted: "var(--muted)",
        subtle: "var(--subtle)",
        line: "var(--line)",
        "line-strong": "var(--line-strong)",
        page: "var(--page)",
        surface: "var(--surface)",
        "surface-tint": "var(--surface-tint)",
        soft: "var(--soft)",
        selected: "var(--selected)",
        primary: { DEFAULT: "var(--primary)", hover: "var(--primary-hover)" },
        "on-primary": "var(--on-primary)",
        good: { DEFAULT: "var(--good)", bg: "var(--good-bg)" },
        warning: { DEFAULT: "var(--warning)", bg: "var(--warning-bg)" },
        error: { DEFAULT: "var(--error)", bg: "var(--error-bg)" },
      },
      borderColor: { DEFAULT: "var(--line)" },
      fontFamily: { sans: ["var(--font)"], mono: ["var(--mono)"] },
      borderRadius: {
        DEFAULT: "var(--radius)", // 控件 6px
        control: "var(--radius)", // 与 DEFAULT 同值，显式名字更自描述，推荐统一用 rounded-control
        panel: "var(--panel-radius)", // 容器 10px
        badge: "4px",
      },
      height: { control: "var(--control-height)" },
      minHeight: { control: "var(--control-height)" },
      spacing: { sidebar: "var(--sidebar-width)", header: "66px" },
      maxWidth: { shell: "1480px" },
      transitionDuration: { ui: "140ms" },
    },
  },
  plugins: [],
};
```

Tailwind v4 用 CSS-first 配置，token 需要展开成实际值，所以用 `@theme inline`（不加 `inline` 时 Tailwind 会再包一层变量，导致 `var()` 间接引用不生效）：

```css
@import "tailwindcss";
@import "./azurekiln-tokens.css"; /* 先定义 --accent / --surface / --radius 等 */

@theme inline {
  --color-accent: var(--accent);
  --color-surface: var(--surface);
  --color-muted: var(--muted);
  --color-line: var(--line);
  /* 圆角：显式命名 control，与 v3 保持一致，示例统一用 rounded-control */
  --radius-control: var(--radius); /* 控件 6px */
  --radius-panel: var(--panel-radius); /* 容器 10px */
  --radius-badge: 4px;
  /* 间距 */
  --spacing-sidebar: var(--sidebar-width);
}
```

注意不要写 `--radius-DEFAULT` 这类没有依据的名字；v3 与 v4 都以显式 `control` 命名控件圆角，用法固定为 `rounded-control`。

### 6.3 用 Tailwind 重写同一套骨架

```html
<!-- 控制台骨架（**桌面示例**）：208px 定宽侧栏 + 内容区。
     下面只演示桌面几何，不等价于 ui.module.scss 的完整实现：
     ≤800px 侧栏要改为顶部横向导航、≤440px 隐藏面包屑并收窄内距，
     请按第 3 节的断点补齐响应式后再上生产。 -->
<div class="min-h-dvh bg-page [--sidebar-width:208px] data-[collapsed]:[--sidebar-width:72px]">
  <aside class="fixed inset-y-0 left-0 z-20 flex w-sidebar flex-col border-r border-line bg-surface px-[14px] pt-5 pb-4
                max-[800px]:static max-[800px]:w-full max-[800px]:border-r-0 max-[800px]:border-b max-[800px]:px-4 max-[800px]:pt-3">
    <nav class="mt-3 max-[800px]:flex max-[800px]:gap-1 max-[800px]:overflow-x-auto">
      <a class="mb-1 flex min-h-[42px] items-center gap-[10px] rounded-control px-3 py-[10px] text-muted
                hover:bg-soft aria-[current=page]:bg-selected aria-[current=page]:font-semibold aria-[current=page]:text-accent">
        概览
      </a>
    </nav>
  </aside>

  <div class="ml-sidebar min-w-0 max-[800px]:ml-0">
    <header class="sticky top-0 z-10 flex min-h-[66px] items-center justify-between gap-3 border-b border-line bg-surface px-[30px] py-3 max-[440px]:px-[14px]">
      <span class="text-[13px] text-muted max-[440px]:hidden">工作空间 / 概览</span>
      <button class="inline-flex min-h-control items-center gap-[7px] rounded-control border border-line-strong bg-surface px-3 py-[6px] text-[13px] font-medium hover:bg-soft">
        退出登录
      </button>
    </header>

    <main class="mx-auto max-w-shell px-[30px] pt-7 pb-9 max-[1100px]:p-6 max-[440px]:px-[14px]">
      <div class="mb-6 flex items-center justify-between gap-4">
        <h1 class="text-[26px] font-[550] text-strong tabular-nums">运行概览</h1>
      </div>

      <section class="overflow-hidden rounded-panel border border-line bg-surface">
        <div class="overflow-x-auto overscroll-x-contain">
          <table class="w-full border-collapse text-left text-[12px]">
            <thead>
              <tr>
                <th class="border-y border-line bg-soft px-4 py-[10px] font-medium whitespace-nowrap text-muted">账号</th>
                <th class="border-y border-line bg-soft px-4 py-[10px] font-medium whitespace-nowrap text-muted">状态</th>
              </tr>
            </thead>
            <tbody>
              <tr class="hover:bg-soft">
                <td class="border-b border-line px-4 py-[10px] align-middle">main.info</td>
                <td class="border-b border-line px-4 py-[10px] align-middle">
                  <!-- 状态色描边：用任意值写 color-mix，勿用 border-good/30（raw var 不支持透明度修饰符） -->
                  <span class="inline-flex items-center gap-1 rounded-badge border border-[color-mix(in_srgb,var(--good)_30%,var(--line))] bg-good-bg px-[7px] py-[2px] text-[12px] font-medium text-good">正常</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <p class="mt-[18px] flex flex-col gap-[7px] text-[13px]">
        <label for="retention">审计保留天数</label>
        <input id="retention" class="min-h-control rounded-control border border-line-strong bg-surface px-[10px] py-[7px]" />
      </p>
    </main>
  </div>
</div>
```

关键对应关系：`rounded-control`→6px（控件）、`rounded-panel`→10px（容器）、`rounded-badge`→4px、`ml-sidebar`→`margin-left: var(--sidebar-width)`、`bg-page`→`--page`、`bg-surface`→`--surface`。**深色模式不需要写 `dark:` 变体**，因为 token 本身已切换。

两个容易踩的坑：

- **透明度修饰符不可用**。token 是 raw `var()`，`border-good/30`、`bg-error/10` 不会生成有效颜色；需要混色时用任意值写全，例如 `border-[color-mix(in_srgb,var(--good)_30%,var(--line))]`，或者干脆退回 `border-line`。
- **骨架只是桌面几何**。上生产前按第 3 节补 `≤800px`（侧栏转顶部导航、`ml-0`）与 `≤440px`（隐藏面包屑、内距 14px）两档。

### 6.4 迁移时的顺序建议

1. 先落地 token（第 1、2 节），页面颜色立刻统一。
2. 再落骨架（第 3、4 节），确认 208px/72px 与断点行为。
3. 最后逐类替换组件（第 5 节），一次只换一类（按钮 → 表单 → 表格 → 状态）。

---

## 7. 可复用 / 不可复用清单

### 可以复用（推荐整站统一）

- **全部语义 token** 与明暗两套取值（第 1、4 节）。token 是完整 hex，移植时直接沿用 `var()`，不要改成 RGB 通道变量。
- 圆角推荐规则（控件 6px / 容器 10px / badge 4px，圆形状态元素可用 50% 例外）、字型字体栈、字号与间距节奏（第 2 节）。
- 控制台骨架规则：208px/72px 侧栏、sticky header、`max-width: 1480px` 内容列、320px 最小宽度、`scrollbar-gutter: stable`（第 3 节）。
- 组件外观规范：按钮三种变体、表格紧凑样式、表单字段、badge/提示条/面板/tab（第 5 节）。
- 断点策略（1100 / 980 / 800 / 440）与「不动画侧栏宽度」这条硬规则。
- 状态语义命名（good / warn / bad / neutral）。

### 不需要搬（业务专属，留在本仓库）

- `/admin/*`、`/sso/*` 接口调用与 CSRF、会话校验、401/403 分支逻辑（见 `docs/gateway-contract.md`）。
- OAuth 账号登记、凭证导入/导出、模型路由、日志清理、存储管理等页面与组件代码。
- 状态管理（Zustand store）、路由表、数据归一化与响应校验函数。
- 图表业务语义（`series-requests/tokens/credit` **色值**可复用，但具体图表、缩放、tooltip 逻辑属业务）。
- 数据文案、i18n 词条、表格列定义。
- 构建与部署配置（见 `docs/deployment.md`）。

一句话：**蓝色、灰底、6px/10px、208px、紧凑表格、明暗双份 token —— 这些搬过去；接口、鉴权、页面逻辑 —— 留在原仓库。**
