# 架构

本文件记录 DBX Plan Detective 的架构边界与职责划分。
**当前仓库已包含 Phase 0B 离线 Plan Core（`src/core/`，见 [PLAN_INPUT_AND_FIXTURES.md](PLAN_INPUT_AND_FIXTURES.md)），
其余部分（Host 接入、Plan Diff、UI）仍为目标架构。** 实际完成度见 [../STATUS.md](../STATUS.md)。

## 1. 目标链路

```text
DBX Host
   ↓
Raw Execution Plan
   ↓
Plan Adapter
   ↓
Normalized Plan
   ↓
Metrics Engine
   ↓
Rule Engine
   ↓
Findings
   ↓
Plan Diff / UI
```

各段职责：

| 阶段 | 职责 | 归属 |
| --- | --- | --- |
| DBX Host | 连接、执行、Timeout、Cancel，产出原始执行计划 | DBX |
| Raw Execution Plan | 数据库原生计划文本/结构（如 PG `EXPLAIN` 输出、MySQL `EXPLAIN FORMAT=JSON`） | DBX 产出 |
| Plan Adapter | 按数据库类型解析原始计划为统一结构 | Plan Detective |
| Normalized Plan | 数据库无关的计划模型（节点、代价、行数、循环、过滤等） | Plan Detective |
| Metrics Engine | 计算指标（Estimate Error、Loop Amplification、Filter Waste 等） | Plan Detective |
| Rule Engine | 基于指标与计划结构产出诊断规则结论 | Plan Detective |
| Findings | 结论 + Evidence Level | Plan Detective |
| Plan Diff / UI | 计划对比、历史与呈现 | Plan Detective |

### 当前实现状态（2026-09-20，Phase 0B Offline Core）

```text
已实现：RawPlanInput → Parser → NormalizedPlan → Metrics → Rules → Findings
未实现：DBX Host → Raw Execution Plan（等待 t8y2/dbx#9675）
未实现：Plan Diff / 业务 UI
```

- `src/core/**` 只接受 `RawPlanInput`，不感知 connectionId / credential / Host API；fixture 即可驱动全链路。
- Parser 负责 PostgreSQL 原生字段映射（引擎专有），Normalizer 负责数据库无关语义 + `engineSpecific`。
- 未来 Host 接入只新增一个极薄的 `dbx-adapter`，将 DBX `rawPlan` 映射为 `RawPlanInput`；
  Parser / Normalizer / Metrics / Rules 不需要修改。

## 2. 数据库目标

| 数据库 | 阶段 | 说明 |
| --- | --- | --- |
| PostgreSQL | 第一优先 | 先跑通完整 pipeline |
| MySQL | 紧随其后 | 用于验证跨数据库抽象是否成立 |
| DWS | 后续 | 视为 PostgreSQL-family 兼容目标，当前不作为第一阶段独立 Adapter |

## 3. 职责边界

### 属于 DBX（原则上一律复用，不重新实现）

- Connection
- Credential
- Database Driver
- Query Context
- SQL Execution
- Timeout
- Cancel
- Database Type
- Database Version
- Explain execution
- 基础安全控制

### 属于 Plan Detective

- Plan semantic normalization
- Metrics
- Estimate Error
- Loop Amplification
- Filter Waste
- Intermediate Result Analysis
- Hotspots
- Rule Engine
- Findings
- Evidence Level
- Fingerprint
- Plan Diff
- History
- Tuning workflow

## 4. 能力层级：内部能力 ≠ 公开插件能力

```text
DBX internal capability      ≠  Plugin Host public capability
```

"DBX 内部已经存在某能力"**不等于**"插件 Host API 已经公开该能力"。

Plugin 前端运行在 iframe 沙箱中（`sandbox="allow-scripts"`、严格 CSP、无 Tauri 对象、无父级 DOM 访问、无直接网络），需要的能力必须通过 **manifest 权限 + Host API** 明确暴露。

因此本项目的第一个工作阶段是 **Phase 0：Host Capability Audit**（见 [PROJECT_PLAN.md](PROJECT_PLAN.md)），而不是直接开发诊断功能。

### 禁止事项

- 不得调用 DBX 未公开的内部接口来绕过插件边界。
- 不得假定某个 DBX 内部功能可由插件直接使用。

## 5. 已知公开 Host API 现状（文档级证据）

取证时间：2026-02（`t8y2/dbx` 的 `main` 分支公开文档）。以下为**文档证据**，仍需在真实 DBX 宿主中现场验证。

前端 workbench 由宿主注入 `window.dbxPlugin`，公开方法：

```text
ready / context / locale
theme              —— { appearance, tokens }
onContext(listener)
request(method, params)          —— 官方中文文档与模板使用
invoke(method, params, options)  —— 调用插件自身 sidecar
notify(method, params)
sendBinary(channel, data)        —— 需要 host.binary
readAsset(path) / readAssetUrl(path)
openWorkbench(contributionId, context)  —— 需要 host.workbench
openFilesystem(providerId, context)     —— 需要 host.filesystem
onEvent(listener)                        —— 需要 host.events
onBinary(listener)                       —— 需要 host.binary
```

已声明的 manifest 权限/能力名称包括 `host.events`、`host.binary`、`host.workbench`、`host.filesystem`、`host.network:<https origin>`。

已知公开的插件可回调宿主方法与宿主 API 版本：

- `host/requestUserInput`（Host API 1.1）
- `host.hostApiVersion`、`host.features` 由 `plugin/initialize` 下发

**在这份公开 API 面中，没有出现 SQL 执行、EXPLAIN、执行计划获取相关的任何方法或权限。**同时 `dbx-plugin dev` 的独立开发运行时也明确说明：native connection actions、query-result contributions、DBX component kit 均未被模拟。

### 审计结论（2026-09-18，含真实 DBX `v0.6.16` 宿主实测）

上述文档级判断已被 Phase 0 审计确认，并补上了运行时证据：

- 在真实 DBX `v0.6.16`（browser-static）中安装插件并打开 workbench，`host.getContext` 返回 `{}`；
- 28 个候选查询/计划/上下文/cancel/timeout 方法名全部返回 `Unsupported plugin host method`；
- DBX 内部 EXPLAIN（Estimated）在同一宿主中实测可用，但插件不可达；
- 唯一设计上会向工作台投递 `sql / connectionId / database / result` 的 `result-view` 路径在 `v0.6.16` 与当前 `main` 上无法打开（工作台查找只匹配 `type === "workbench"`）。

完整矩阵、逐项证据与复现步骤见 [HOST_CAPABILITY_AUDIT.md](HOST_CAPABILITY_AUDIT.md)；上游能力缺口与最小 API 提案见 [DBX_HOST_API_GAP_PROPOSAL.md](DBX_HOST_API_GAP_PROPOSAL.md)。

结论：**“插件通过公开 Host API 请求执行计划”在当前 DBX 版本中不可行**。这是明确的 Host API capability gap，不是本插件的开发阻塞 bug，也不应用私有 API、DOM hack、Tauri 内部对象或自建数据库连接绕过。

详细清单与验证状态见 [PROJECT_PLAN.md](PROJECT_PLAN.md)。

## 6. 前端结构约定

```text
window.dbxPlugin.ready            → 等待宿主桥接初始化
window.dbxPlugin.locale           → 当前 DBX 界面语言
window.dbxPlugin.context          → 当前工作台允许访问的上下文
window.dbxPlugin.request(method)  → 调用宿主提供的方法
```

- UI 从 `src/` 编译到 `ui/`（`vite.config.js` 的 `outDir`）。
- `manifest.json` 的 `entrypoints.ui` 指向 `ui/index.html`。
- `manifest.json` 的 `localizations` 负责插件名、说明、贡献点文案的多语言。

## 7. 打包边界

```toml
[package]
include = ["assets", "ui"]
```

只有 `assets/` 与 `ui/` 进入 `.dbxp`；`docs/`、`fixtures/`、`src/`、`node_modules/` 不会被打包。

## 8. 非目标（Host 接入阶段）

已实现的离线部分（PostgreSQL parser / NormalizedPlan / Metrics / 3 条确定性 Rules / Findings）见
[PLAN_INPUT_AND_FIXTURES.md](PLAN_INPUT_AND_FIXTURES.md)。以下仍需独立 Issue，不允许顺手实现：

- DBX Host API 调用 / `dbx-adapter` / Execution Plan 扩展点集成
- Actual Plan 获取（`EXPLAIN ANALYZE` 执行）
- MySQL parser / DWS 适配 / 文本计划 parser
- Plan Diff / History
- 自定义 Plan Canvas / 大型可视化
- SQL Rewrite / 自动调优 / 自动建索引 / 自动执行 SQL
- AI / LLM
- 数据库连接层 / Driver / 连接池 / 凭据 / SSH Tunnel

## 9. Audit Harness（开发用）

`src/App.svelte` 当前是 **Phase 0 Host Capability Audit Harness**，页面顶部明确标注 `DEVELOPMENT / AUDIT ONLY`。它只做四件事：打印 `window.dbxPlugin` 的桥接面、打印宿主 `init` 消息、读取 `dbxPlugin.context` 与 `request("host.getContext")`、探测候选宿主方法名并按 `RESOLVED / REJECTED / UNSUPPORTED` 分类。

它**不**包含解析器、指标、规则、Diff、AI，也不建立任何数据库连接；Phase 1 开始时将被真实业务 UI 替换。
