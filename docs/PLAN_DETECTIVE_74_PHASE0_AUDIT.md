# Plan Detective #74 · Phase 0：布局根因审计

审计日期：2026-10-13
仓库基线：`0a0e378677eb78bd4b516a0fb535f27030e2e373`（`origin/main`，PR #75 merge commit）
范围：只记录证据、复现步骤和修复方向；本阶段未改 CSS、分析逻辑或 fixture。

## 结论摘要

1. **Tree 与 Inspector 的远距离访问有源码可证实的结构原因。** `PlanAnalysisLayout.svelte` 的 Workspace DOM 顺序是 Findings → Hotspots → Plan Tree，Inspector 是另一个网格列。在宽屏下 Inspector 从整个分析区顶部开始，而 Tree 位于 Workspace 的后部；中等和窄屏下 Inspector 被排在整个 Workspace 后面。该结构会让“查看所选 Tree 节点详情”需要跨过诊断区或向下滚动，但**不能据此断言实际 DBX viewport 中的像素距离**。
2. **`select 1` 单节点的大块留白根因仍未定位。** 当前 NAS 没有 DBX Desktop、可运行浏览器或浏览器自动化，无法取得真实插件 content viewport、DOM `getBoundingClientRect()` / computed style、`clientHeight` / `scrollHeight` 或截图。源码中 Plan Tree 只有 `max-height: 52vh`（上限，不是固定高度），`.app` 没有固定高度，现有证据不足以将留白归因于 Tree 高度、Grid 拉伸或 Host 外壳；不得猜测性地大幅调整布局。
3. **目前 fixture 不足以视觉验收复杂计划。** 离线分析所有已提交 fixture 时最大是 14 个 operator 节点（MySQL `complex-mixed.synthetic`），没有 50+ 节点计划；也没有原样 `SELECT 1` 的单节点 fixture。普通单节点 `seq-scan` fixture 不是 `SELECT 1`，不能冒充该场景。
4. 有效修复方向是先将 **Plan Tree 与 Node Inspector 组成相邻的核心阅读区**，再按证据安排 Summary / Findings / Hotspots；断点应基于实际可用内容宽度评估，不能只把浏览器 viewport 当成 DBX 插件容器宽度。单节点高度和复杂树滚动仍需分别实测。

## 启动检查与可复现环境证据

- `git fetch origin main` 后 `git rev-parse origin/main`：`0a0e378677eb78bd4b516a0fb535f27030e2e373`。
- `gh pr list --state open`：无 Open PR。`gh pr view 75`：PR #75 状态 `MERGED`，merge commit `0a0e378677eb78bd4b516a0fb535f27030e2e373`。#75 插件中心首次使用引导属于当前基线，本轮不重复开发。
- Open issues 检查到 #66、#72、#73，分别是 AI Tool、计划快照、Plan Diff，与 #74 UI 布局目标不重复。
- 启动时 Main Workspace `/vol5/1000/ai-workspace/dbx-plugin-plan-detective` 工作树无文件修改，但本地 `main` 为 `ahead 1, behind 39`；只 fetch，不使用其本地 HEAD 开发、不 reset、不清理。Phase 0 worktree 是从当时最新 `origin/main` 创建。
- 环境：Node `v22.23.2`、npm `10.9.8`、git `2.39.5`、gh `2.23.0`；GitHub CLI 已认证。`gh api repos/.../branches/main/protection` 返回 404 `Branch not protected`；基线 commit 的 `check-runs` 为空。每个未来 PR 仍须单独核实当时适用的 checks、review 和 head SHA。
- `command -v dbx-plugin dbx chromium chromium-browser google-chrome firefox playwright` 均无可执行结果；全局 npm 包中无 Playwright/Puppeteer，项目 `package.json` 也无浏览器自动化依赖。**因此没有启动真实 UI/浏览器，也没有进行视觉或宿主验收。**
- 仓库内旧 `docs/evidence/phase0-host-capability-audit-runtime.json` 来自 DBX v0.6.16 browser-static、插件 v0.1.0（2026-09-18），只记旧 Host API 探测，不含当前 UI 几何数据；不能证明当前版本的布局。
- 当前跟踪的 `docs/screenshots/02-plan-analysis.png` 是 2026-09-21 添加的 1506×1031 图片；`docs/screenshots/README.md` 明确称仓库没有可直接复用的真实 DBX UI 截图。该图没有足够的当前版本 / 宿主 / viewport 测量 provenance，本审计不把它当作 DBX 实测或 `select 1` 证据，也不制作对比截图。

## 当前组件与布局证据

### 页面结构

Host 模式（`src/App.svelte`）当前主要顺序：

```text
App header / 语言切换
→ ConnectionContext + SqlInput / AnalysisNotice
→ PlanAnalysisLayout（有 structured result 时）
→ RawPlanViewer
```

`PlanAnalysisLayout` 当前 DOM：

```text
.analysis-grid
├─ .summary-column: PlanSummary
├─ .workspace-column: FindingsList → HotspotsList → PlanTree
└─ .inspector-column: NodeInspector
```

关键源码：`src/App.svelte:443-480`；`src/components/PlanAnalysisLayout.svelte:34-56`。

### Grid / Flex / viewport 依赖（源码推演，不是尺寸实测）

| 浏览器 viewport 条件 | 源码布局推演 | DBX 内容区尺寸 / 实测 |
| --- | --- | --- |
| `>=1280px`（例如 1440） | `300px minmax(0,1fr) 340px` 三列，`align-items:start`；Inspector 与 Summary / Workspace 顶部对齐，但 Tree 在 Workspace 的 Findings、Hotspots 之后 | **NOT VERIFIED** |
| `900–1279px`（例如 1024） | `280px minmax(0,1fr)` 两列；Inspector 移至第 2 列新行，在完整 Workspace（包括 Tree）之后 | **NOT VERIFIED** |
| `<=899px`（例如 768、更窄） | Summary、Workspace、Inspector 单列；Workspace 内仍是 Findings → Hotspots → Tree；Tree 行中的 Rows / Cost 次级列隐藏 | **NOT VERIFIED** |

依据：`src/components/PlanAnalysisLayout.svelte:60-97`。断点用 viewport `@media`，没有 container query / host 可用宽度测量。顶部输入区另有 `300px minmax(0,1fr)`，在 `<=899px` 单列，见 `src/App.svelte:719-756`。`.app` 只有 `max-width:1680px`、水平 padding 和 `min-width:0`，没有设置分析页面高度，见 `src/App.svelte:487-496`；全局 `body` 有 `min-height:100vh`，它本身不能证明分析面板内部被撑高，见 `src/app.css:60-66`。

上述推演能解释 **Tree / Inspector 空间关系不佳**，但不能量化实际空白或确认宿主 content viewport 与 `window.innerWidth` 的关系。

## 单节点留白与信息密度

- 当前无原样 `SELECT 1` 的 plan fixture。`fixtures/postgres/estimated/seq-scan.plan.json` 是一个 `Seq Scan` operator 的计划，元数据记载 SQL 为 `SELECT * FROM pd_fix_orders WHERE total > 2500;`，不是 `SELECT 1`。可以将它作为“单 operator 树”的离线数据，不将它描述为目标 SQL 的真实复现。
- `src/components/PlanTree.svelte:110-115` 的 `.tree` 使用 `max-height:52vh; overflow-y:auto`，没有固定 `height` / `min-height`；单节点时高度由内容决定，复杂树超过上限时才在 Tree 内滚动。因此这条规则目前不是大面积空白的已证根因。
- `src/app.css:60-66` 的 `body min-height:100vh` 只建立页面最小高度；`.app` 无 `height:100%`，`.analysis-grid` `align-items:start`。单靠源码无法判定 Host 父级高度、插件 iframe / WebView 布局、viewport 单位或滚动容器对真实 `select 1` 截图的影响。
- `SUMMARY_ROWS` 固定映射 11 个指标；现有 `tests/ui/view-model.test.js` 明确断言 `summary.rows.length === 11`。空 Findings 和空 Hotspots 仍分别显示 panel header、说明 hint、计数以及 `.empty` 段落（公共 `.empty` padding 为 `14px 12px`，见 `src/app.css:101-110`、`FindingsList.svelte:14-30`、`HotspotsList.svelte:14-35`）。Hotspots 的 `costNote` 与空态分别判断，无命中时仍可能保留该说明。这些源码确实增加简单计划下的纵向内容，但没有实测证据说它们解释了用户报告的“巨大”空白。零命中语义和 Estimated-only 风险说明不得删去。

**定位留白必须补采的数据：** 在真实 DBX Desktop 和 `SELECT 1` 下记录 DBX/插件版本、宿主可用 content viewport（非仅窗口外框）、`.app`、`.analysis-grid`、summary/workspace/tree/inspector 的 `getBoundingClientRect()`、computed `height/min-height/align-self/overflow`、tree `clientHeight/scrollHeight`、document/host scroll container 的 scroll/client 尺寸、选中节点位置与截图。若窗口可缩放，至少比较 Issue 要求的 1440 / 1024 / 768 和更窄插件容器；在数据取得前根因状态保持 **UNLOCATED / NOT VERIFIED**。

## 计划复杂度与 fixture 证据

以下为在当前 worktree 对所有 fixture 调用 `analyzePlan()` 的离线探测结果；计数是 Plan Core 输出，不是 UI 截图或宿主尺寸：

| Fixture family | fixture 数 | 最大 operator 节点数 |
| --- | ---: | ---: |
| PostgreSQL（estimated + actual） | 20 | 6 |
| MySQL | 14 | 14 (`complex-mixed.synthetic`，depth 9) |
| SQL Server | 14 | 4 |
| OceanBase Oracle | 12 | 6 |
| OceanBase MySQL | 1 | 1 |
| Oracle | 5 | 4 |
| Dameng | 7 | 5 |
| QuestDB | 6 | 9 |
| Doris | 5 | 5 |

复现方法（只读取现有 fixture，不生成或冒充真实数据库数据）：

```js
import { analyzePlan } from "./src/core/analyze.js";
import { FIXTURE_DATABASES, listFixtures, loadFixture } from "./tests/helpers/fixtures.js";
for (const database of FIXTURE_DATABASES) {
  const counts = [];
  for (const fixture of await listFixtures(database)) {
    const { input } = await loadFixture(fixture);
    const analysis = analyzePlan(input);
    counts.push({ name: fixture.name, nodes: analysis.metrics.nodeCount, depth: analysis.metrics.maxDepth });
  }
  console.log(database, counts.length, Math.max(...counts.map((entry) => entry.nodes)));
}
```

结论：现有 tests 覆盖单节点、若干多节点 parser/view-model 数据以及中英文纯函数映射，但没有 10–20 的标准跨数据库 layout 测试矩阵，也没有 50+ 节点视觉样本。后续若添加 50+ 测试输入，必须是明确标注 `synthetic` 的离线 fixture / builder，不可伪装成 DBX 捕获结果。Tree `max-height` 能由代码推断出长列表采用内部纵向滚动；其在 50+ 节点、窄屏与键盘聚焦下的实际表现仍未验证。

## 溢出、滚动、焦点与联动

### 已有防护（源码可证）

- 多个布局容器和 `.panel` 使用 `min-width:0`；Tree label、Inspector 字段、Findings / Hotspots 证据和 Raw Plan 使用 `overflow-wrap:anywhere`。`RawPlanViewer` 的 `<pre>` `max-height:420px; overflow:auto; white-space:pre-wrap`，并说明截断状态。
- Tree 在 `<=899px` 隐藏 Rows / Cost 列以给节点名留空间；tree label 会换行。Tree 外没有设置独立固定高度。
- Tree row 有 `:focus-visible`，SQL textarea 有 `:focus` 样式，语言 / view switch 与空态入口按钮定义显式焦点样式。其他操作控件没有统一的项目级 `:focus-visible` 规则；浏览器默认焦点表现未实测。

### 联动与键盘（代码路径）

- `App.svelte:310-318` 的 `selectNode()` 会对目标节点调用 `expandAncestors()`，然后更新 `selectedNodeId`；`tests/ui/view-model.test.js` 覆盖 ancestor expansion 和折叠集合不变性。Inspector 和 Findings / Hotspots 当前选中态由同一 ID 派生。
- `PlanTree.svelte:28-39` 的键盘处理支持 Enter / Space 选择、Left / Right 折叠或展开当前有子节点的行；每行都有 `tabindex="0"`。未见 Up / Down 行间移动或 roving tabindex 实现。
- Finding / Hotspot 的按钮调用相同 `onSelectNode`；App 的 `selectNode()` 没有显式对目标 Tree row 调用 `scrollIntoView()` 或转移 focus。祖先展开和 Inspector 更新有纯函数 / 状态路径证据；从诊断入口选择一个已折叠且位于长树滚动区外的节点后，Tree 是否自动滚到可视区属于需真实交互回归的行为，不能预设通过。

## 修复与验收建议（分阶段）

1. **Phase 1 — 核心布局：** 基于当前 DOM 结构将 Tree 与对应 Inspector 放入同一个就近的核心分析区；Summary / Findings / Hotspots 按可读顺序组织。桌面 / 中宽可并列，窄容器可堆叠；短树自然收缩，复杂树沿用或经测量调整 Tree 内滚动，不用全局固定高度或隐藏内容。用现有纯 helper 覆盖选中、祖先展开、折叠与联动状态。
2. **Phase 2 — 信息密度：** 把一级指标与 Scan / Join / Sort / Depth 等次级统计分层；零命中 Findings / Hotspots 收紧冗余空间，同时保留 caveat、Cost 口径和命中证据。11 项数据的语义先核对，不能因为数字多就误删有用指标。
3. **Phase 3 — 响应式 / i18n：** 在目标实际内容宽度和 viewport 1440 / 1024 / 768 / 更窄场景检查中英文、长 SQL / 名称 / 属性和正常 / 空 / 错误态。现有断点是 viewport-based；是否可改用容器约束需先确认 DBX WebView 支持与真实容器尺寸。语言切换保持 SQL、分析结果、节点选择和折叠状态。
4. **Phase 4 — 回归：** 复测 #75 的首次进入 / 部分上下文状态及 Issue 所列 Host / Tree / Inspector / Finding / Hotspot / Raw Plan / 复制 / Capability Refresh / Ctrl(Cmd)+Enter / i18n 操作。离线测试与构建不能代替 DBX Desktop 验收；未运行的宿主场景明确报告 NOT VERIFIED。

### 不可改变的 UI 行为边界

- 保持选中节点状态、祖先展开、tree 折叠、Finding / Hotspot 到节点的联动；发现没有自动滚动的情况时，先明确行为契约与焦点方案并加回归，不因重新排 DOM 引入静默回归。
- 不更改 Plan Core、cost / rows 语义、Host API 获取路径或 Estimated-only 安全边界。Estimated Cost 不是运行时耗时；零 Findings 不等于 SQL 没有性能风险。
- 不引入重型组件库 / 布局引擎，不新增 Actual Plan、`EXPLAIN ANALYZE`、数据库连接管理、模型调用或 Plan Diff。

## 审计结果状态

- **VERIFIED（静态源码 / fixture / 测试）：** 当前 Grid / DOM 顺序、viewport media query、11 项 Summary、空状态内容、Tree max-height / scroll 样式、node selection / ancestor expansion 代码、现有 fixture 的节点数上限、#75 已合并。
- **NOT VERIFIED（真实 UI / Host）：** `SELECT 1` 的真实留白根因与尺寸；DBX 插件实际 content viewport；1440 / 1024 / 768 / 窄容器 DOM 位置与横向溢出；长内容实测；50+ 节点滚动和 focus 可达；Tree / Inspector 的真实键盘 / 诊断定位；当前 Windows DBX Desktop 上 #75 的实际引导与 result-view 流程。
- **阶段建议：** Phase 0 审计记录已能支持先实施 Tree / Inspector 空间关系和紧凑空态；单节点留白的大范围尺寸修复在拿到 Host 实测前保持未决，避免猜测性 CSS 重写。
