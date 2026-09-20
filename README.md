# DBX Plan Detective

DBX Plan Detective 是一个 DBX 插件，用于 SQL 执行计划的解析、性能诊断与 Plan Diff 分析。

| 项目 | 值 |
| --- | --- |
| 插件 ID | `io.github.0verme.plan-detective` |
| Publisher | `0verme` |
| 当前版本 | `0.2.0` |
| Host API | `^1.2`（`host.plans:read`） |
| 模板 | DBX 官方 `svelte`（Svelte + Vite，`universal`，frontend-only） |

## 项目定位

> **DBX provides the database capabilities.**
> **Plan Detective provides the execution-plan intelligence.**

DBX 负责数据库连接、Credential、驱动、SQL 执行和 Host 能力；
Plan Detective 负责理解和分析执行计划。

## 目标能力

- Host Estimated Plan 接入 ✅（`window.dbxPlugin.getPlanCapabilities` / `explainPlan`，`mode: "estimated"`）
- Execution Plan Parsing ✅（结构化：PostgreSQL；其余方言 raw-only）
- Plan Normalization ✅（PostgreSQL）
- Performance Metrics ✅（确定性基础指标，不含综合评分）
- Hotspot Analysis ⛔
- Rule-based Diagnosis ✅（3 条确定性规则）
- Findings + Evidence ✅
- Plan Tree / Raw Plan viewer ✅
- Plan Diff ⛔

> ✅ 为**当前已实现**；⛔ 为未实现。Actual Plan / `EXPLAIN ANALYZE` 明确不在范围内。
> 实际完成度以 [STATUS.md](STATUS.md) 与 [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md) 为准。

## 上游契约

Host Plan API 的 canonical contract 为 **[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)**，
实现 PR **[t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692) 已合并进 `t8y2/dbx/main`**（merge `f909f85`）。
本插件以该已合并实现为唯一正式契约，不设计兼容层：

```ts
window.dbxPlugin.getPlanCapabilities(connectionId)
window.dbxPlugin.explainPlan({ connectionId, database?, schema?, sql, mode: "estimated", timeoutMs? })
```

- 权限：manifest 声明 `host.plans:read`；`engines.host_api: ^1.2` 是兼容下限，运行时以 `dbxPlugin.capabilities.planApi` 为准。
- 只读 Estimated Plan：EXPLAIN 由宿主构造；插件不能传 EXPLAIN 语句、不能执行用户 SQL、不能请求 Actual Plan。
- 连接必须已由用户在 DBX 中打开；插件不能建立连接、拿不到 credential / connection string。
- `getPlanCapabilities` 返回 `{ dbType, dbVersion?, supports: { estimatedPlan }, limits: { maxTimeoutMs, maxPlanBytes } }`。
- `explainPlan` 返回 `{ dbType, dbVersion?, format: "json" | "xml" | "text", rawPlan, truncated, warnings }`。

DBX 支持的 estimated-plan 方言（`supports_explain_plan`）：PostgreSQL、MySQL、SQL Server、Oracle、
OceanBase Oracle、Doris、Dameng、QuestDB。**本插件当前只有 PostgreSQL 的结构化 parser**；其余方言
展示 Raw Plan 并明确标注 `structured parser not implemented`。

## 数据链路

```text
DBX 当前连接
    ↓
SQL 输入
    ↓
getPlanCapabilities(connectionId)        # 只在 supports.estimatedPlan === true 时继续
    ↓
explainPlan({ connectionId, sql, mode: "estimated" })
    ↓
Raw Estimated Plan（宿主返回，未修改）
    ↓
DBX response adapter → RawPlanInput
    ↓
parser registry（PostgreSQL 结构化；其余 raw-only）
    ↓
NormalizedPlan（Plan IR）
    ↓
deterministic rules
    ↓
Findings + Plan Tree + Raw Plan
```

分层目录：

```text
src/host/                    Host Adapter：window.dbxPlugin → HostPlanError / PluginPlanResult
src/core/adapter/            DBX response → RawPlanInput（纯函数，fail-closed）
src/core/parsers/            parser registry：database family → structured parser
src/core/postgres/           PostgreSQL JSON parser
src/core/normalize/          NormalizedPlan（Plan IR）
src/core/metrics/            deterministic metrics
src/core/rules/              deterministic findings
src/lib/analysis-session.js  Host → Parser → IR → Rules 编排（可注入 fake bridge 测试）
src/components/              UI（ConnectionContext / SqlInput / PlanTree / Findings / RawPlan …）
```

## 连接上下文与入口

- **查询结果页入口（推荐）**：在 DBX 查询结果工具栏选择 Plan Detective。宿主会带入
  `connectionId`、`database`、`sql` 与结果快照；插件用这些上下文预填 SQL。
- **Sidebar workbench 入口**：宿主不传连接上下文；插件提供 Connection ID 输入框，只引用已打开的
  连接，不创建连接、不测试连接、不读取凭据。

连接未打开时，宿主返回 `Connection is not open`，UI 会明确展示该错误，不会尝试自动连接。

## 错误状态

插件不会用一个通用 `Analysis failed` 吞掉错误。Host Adapter 将宿主错误映射为稳定错误码
（`src/host/host-plan-errors.js`），UI 为每个错误码给出独立文案：

| code | 触发条件 |
| --- | --- |
| `PLAN_API_UNAVAILABLE` | 宿主没有 Plan API（DBX < Host API 1.2 / 非 DBX 宿主） |
| `PERMISSION_NOT_DECLARED` | manifest 未声明 `host.plans:read` |
| `CONNECTION_NOT_OPEN` | 连接已保存但未打开 |
| `CONNECTION_NOT_FOUND` | connectionId 不存在 |
| `UNSUPPORTED_DIALECT` | 该方言没有 estimated plan 路径 |
| `EMPTY_SQL` / `SQL_TOO_LARGE` | SQL 为空 / 超过 200,000 字符 |
| `UNSAFE_SQL` | 宿主只读计划门拒绝（多语句 / DDL / DML / 危险关键字） |
| `PLAN_TOO_LARGE` | 计划超过 4 MiB 宿主上限 |
| `EMPTY_PLAN` | 数据库返回空计划 |
| `TIMEOUT` | 宿主超时或 UI 侧 guard 超时 |
| `INVALID_REQUEST` / `INVALID_RESPONSE` | 请求 / 宿主响应不符合契约 |
| `UNSUPPORTED_DB_TYPE` / `UNSUPPORTED_PLAN_FORMAT` | 契约外的 dbType / format |
| `PLAN_TRUNCATED` | 计划被宿主截断（仅展示 Raw Plan，不做结构化解析） |

## 数据库支持

```text
PostgreSQL: structured
MySQL: raw only
SQL Server: raw only
Oracle: raw only
OceanBase Oracle: raw only
Doris: raw only
Dameng: raw only
QuestDB: raw only
```

## 当前不依赖 AI

当前项目不依赖 AI：仓库中不存在 AI SDK、LLM 调用或任何模型凭据。

未来 AI 只能作为 Explain / Rewrite 辅助层，不能成为 Rule Engine 的真相来源。

## 架构原则

1. **Thin Plugin** —— 只提供执行计划智能，不重复实现 DBX 已有基础设施。
2. **DBX 已有能力优先复用** —— Connection、Credential、驱动、SQL 执行、Timeout、Cancel 均属于 DBX。
3. **frontend-only** —— 不引入 Rust / Go sidecar，也不修改 DBX Core。
4. **不提前架构** —— 只有确认 Host API 无法满足需求后，才讨论 native backend 或 DBX Core 变更。

明确不引入：PostgreSQL driver、MySQL driver、sqlx、JDBC、自定义连接池、Credential 管理、SSH Tunnel、
自定义数据库执行层、AI SDK、LLM、自动 SQL Rewrite、Rust backend、Go backend。

完整边界说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

安装依赖并启动独立浏览器开发主机（Node.js 22+）：

```bash
npm install
dbx-plugin dev --path . --port 5190
```

离线验证（无需 DBX、无需数据库）：

```bash
npm test                                  # 契约 / Host adapter / parser / rules / golden / UI view-model
npm run build                             # 构建 ui/ 发布产物
npm run analyze -- estimated/seq-scan     # 对单个 fixture 跑完整 pipeline
```

真实 Host 集成测试请使用真实 DBX 宿主：在已打开连接的查询结果页打开 Plan Detective，输入 SQL，
点击 **Analyze Plan / 分析执行计划**。

UI 从 `src/` 编译到 `ui/`。默认进入 **Host 分析** 模式；无宿主时自动回退到
**Fixtures（开发）** 模式。Fixture 数据来自 `fixtures/postgres/**`，经构建期 Vite 虚拟模块
（`scripts/vite-plugin-fixtures.mjs`）嵌入，只包含 `.plan.json` 与展示所需 `.meta.json` 字段。
mock / fixture 只服务测试与离线开发，不进入 Host 生产路径。

> `ui/` 是**必须入库的发布产物**：DBX 官方 release workflow 不执行 `npm install` / `npm run build`，直接运行 `dbx-plugin package .`，因此修改 `src/` 后需要重新构建并提交 `ui/` 变更。`.gitignore` 只忽略 `dist/`、`.dbx-dev/`、`node_modules/` 等本地生成物，不忽略 `ui/`。详见 [AGENTS.md](AGENTS.md) 的 Git 规则。

构建未签名的 universal 候选包：

```bash
dbx-plugin package .
```

产物为 `dist/` 下的 `.dbxp` 与对应 artifact metadata。

## 目录结构

```text
.
├── .github/workflows/     # 官方模板生成的发布工作流
├── assets/                # 插件图标等静态资源
├── docs/                  # 架构 / 计划 / 契约 / Phase 0 审计
├── fixtures/              # 离线执行计划样本（postgres 已建立 / mysql 占位）
├── scripts/               # 开发与测试脚本（golden 生成、fixture 分析、UI fixture 虚拟模块）
├── src/                   # Svelte 前端源码
│   ├── components/        # ConnectionContext / SqlInput / PlanSummary / FindingsList / PlanTree / NodeInspector / RawPlanViewer / HostAudit
│   ├── core/              # Plan Core：无 UI / 无 DBX / 无数据库依赖（adapter / parsers / normalize / metrics / rules）
│   ├── host/              # DBX Host Plan API adapter（唯一接触 window.dbxPlugin 的模块）
│   ├── lib/               # 纯 UI 逻辑：analysis session、view model、fixture catalog、格式化
│   └── App.svelte         # Host 分析 + Fixtures（开发）+ 宿主审计（开发）
├── tests/                 # node:test，离线运行（core / host / lib / ui / postgres）
├── manifest.json          # DBX 插件清单（host_api ^1.2、host.plans:read）
├── dbx-plugin.toml        # 打包与开发配置
└── STATUS.md              # 当前状态与已知问题
```

`fixtures/` 与 `docs/` 不参与打包：`dbx-plugin.toml` 的 `[package] include` 只包含 `assets` 与 `ui`。

## 发布

发布未签名候选包供审核。若本仓库已注册 `autoUpdate: true`，DBX Store 会自动创建或更新候选 PR；否则向 `t8y2/dbx-store:main` 提交一个候选 PR，附带 release 与 artifact metadata。

不要向 `t8y2/dbx` 提交普通插件源码：该仓库只接受插件宿主、SDK、CLI、schema、文档与官方示例的变更。

## 文档

- [STATUS.md](STATUS.md) —— 当前状态、上游 #9692 契约核验、已验证项与已知问题
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构边界与职责划分
- [docs/PLAN_INPUT_AND_FIXTURES.md](docs/PLAN_INPUT_AND_FIXTURES.md) —— RawPlanInput / parser registry / NormalizedPlan / Metrics / Rules / Findings 契约与 Fixture 约定
- [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) —— 已确认决策、阶段划分、一期 / Future 边界
- [docs/HOST_CAPABILITY_AUDIT.md](docs/HOST_CAPABILITY_AUDIT.md) —— Phase 0 Host Capability Matrix（历史审计）
- [docs/DBX_HOST_API_GAP_PROPOSAL.md](docs/DBX_HOST_API_GAP_PROPOSAL.md) —— 上游能力缺口与提案（历史记录）
- [docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md) —— downstream design note
- 上游插件开发指南：<https://dbxio.com/en/docs/plugin-development>
