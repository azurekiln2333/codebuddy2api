# 2026-10-16 用户视觉纠偏

用户明确否决首版视觉并恢复原任务。原验收和提交保留为历史，不能用旧截图验收本次。

## PRD 补充

以只读 `D:/My2KProjects/new-api/web` 新版 Base UI/Tailwind 4 的实际 shell、dashboard、UI 组件为主要结构参考。AzureKiln 蓝色与品牌保留，独立实现；不复制 New API 源码或品牌。所有真实 API、SSO、CSRF、管理员权限、上游 OAuth 和危险操作确认保留。

## 设计补充

已阅读新版 authenticated-layout.tsx、app-header.tsx、summary-cards.tsx。采用 48px 全宽顶栏，品牌和导航开关移到顶栏；侧栏在顶栏下方，展开 208px、折叠 44px。主内容面板 inset 8px、约 22px 圆角和极轻阴影。按用途分组导航；首页可见 h1、独立指标面板、清晰图表层次；表格工具栏和设置布局统一。控件 32px、图标 16px，控件圆角 12px、面板 16px，舍弃装饰渐变。中文字体须在浏览器确认实际无衬线回退。

手机导航使用现有 Drawer/原生 dialog、lockPage 和焦点恢复能力。触发按钮名称“打开导航菜单”，dialog 名称“主导航”；桌面为“折叠侧栏 / 展开侧栏”。Escape 关闭后焦点返回触发按钮。

## 实施与边界

- 首批 shell、共享组件和首页，输出新版 light/dark/mobile 截图供根协调者审阅。
- 再统一 credentials/models/logs/settings 等其余页面；Storage.tsx 归根协调者，不改。
- 布局测试及 experience/admin 中导航断言由根协调者的独立 worker 负责，本 agent 不写。
- 本 agent 负责其余源码、docs/design-system.md 和本纠偏记录。
- check/unit/build 和浏览器回归；原 API/SSO/CSRF 语义不得改变。
- 不碰 zip、审批助手、无关 scaffold；不 push、不部署；根协调者审阅后统一 commit。

用户已明确授权本次规划、实施和验证，无需重新征询。根协调者 pane 为 wY:p1，会主动轮询本工作区；不要猜测其他 pane。

## 首轮审阅反馈与修复

- 根协调者已独立看桌面明暗图，确认 shell 与首页明显改善；桌面48px顶栏、208px侧栏、可见h1命中已通过浏览器。
- 根发现概览未选中，已修正首页 NavLink 对 `/dashboard` 与 `/dashboard/` 的精确匹配；浏览器回归归根测试worker。
- 按约定将中文“收起侧栏”改为“折叠侧栏”；新增 shell/管理页/设置分类与分区文案纳入中英 i18n。
- 只读 check 发现导航 Drawer 左对齐与296px宽度被后置基础规则覆盖；提高导航选择器 specificity 修复，继续复用原生dialog，无手写focus trap。
- 末轮 check/build 已通过；unit中的2个旧名称断言由check agent对齐后，2026-10-16 07:33:15全量重跑18文件176项全部通过。

## 最终验收与交接

- check：65文件格式通过，58文件lint/type通过，无警告或错误。
- unit：18文件176项全部通过；interaction.test.tsx仅同步“折叠侧栏”按钮名，持久化、折叠和存储受阻断言保留。
- build：106模块通过，上游MIT与35项运行时依赖许可证完整保留。
- browser：根全量35/36通过；唯一失败是新测试fixture缺少revision，补齐fixture后定向1/1通过，共36个场景均已验证，无需生产修正。
- 根亲自看最终明暗桌面、手机和手机抽屉，认可；CDP实际中文字形均为YaHei；5174无残留服务。
- 独立checker未发现新增真实数据、API/SSO/CSRF、设置草稿问题；其确认的导航Drawer级联覆盖已修复。额外“更多菜单裁切”仅静态疑点，根已要求终止扩展调查，未纳入生产更改或宣称新增浏览器验收。
- 截图与诊断保存在 `D:/AppData/Local/Temp/azurekiln-ui-newapi-review/`，具体文件见 docs/validation.md。
- 产物：`D:/AppData/Local/Temp/azurekiln-ui-artifacts/azurekiln-ui-newapi-dist-20261016-073031.zip`，不加入Git。
- 用户已冻结生产源码；本会话不再新增源码审查、测试、截图、提交或归档。current pointer由根处理，根负责明确路径提交和journal。

待提交范围：src/App.tsx、src/UsageOverview.tsx、src/components.tsx、src/i18n.tsx、src/interaction.test.tsx、src/pages/{Credentials,Dashboard,Logs,Models,Settings}.tsx、src/theme.scss、src/ui.module.scss、新src/dashboard.module.scss与src/management.module.scss；根worker的e2e/layout.spec.ts与e2e/experience.spec.ts；docs/design-system.md、docs/validation.md；frontend/quality-guidelines.md与本任务原有记录及新增correction.md。未改Storage.tsx和api.ts。

审批辅助文件、用户zip、dist、test-results、各平台初始化目录与无关scaffold全部排除。不得git add .；本会话没有stage、commit、push或部署。
