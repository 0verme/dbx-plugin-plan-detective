# 架构

本文件记录 DBX Plan Detective 的架构边界与职责划分。
当前仓库已实现 **Host 分析闭环**（DBX Host Plan API → adapter → parser → IR → rules → UI）与
**Offline / Fixture 开发模式**。实际完成度见 [../STATUS.md](../STATUS.md)。

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
| DBX Host | 连接、EXPLAIN 生成、Timeout、Cancel，产出原始执行计划 | DBX |
| Raw Execution Plan | 数据库原生计划结构 / 文本（PG JSON、MySQL JSON、SQL Server ShowPlanXML、文本计划） | DBX 产出 |
| Plan Adapter | 校验 Host response 并映射为 `RawPlanInput` | Plan Detective |
| Parser Registry | 按 database family 选择结构化 parser；无 parser 的方言 raw-only | Plan Detective |
| Normalized Plan | 数据库无关的计划模型（节点、代价、行数、过滤等） | Plan Detective |
| Metrics Engine | 计算指标（节点数、深度、scan/join/sort 计数、最大行数、最高增量代价等） | Plan Detective |
| Rule Engine | 基于指标与计划结构产出确定性结论 | Plan Detective |
| Findings | 结论 + Evidence（observation 语义，不是命令） | Plan Detective |
| Plan Diff / UI | 计划对比、历史与呈现 | Plan Detective |

### 当前实现状态（2026-09-20）

```text
已实现：DBX Host Plan API 接入（getPlanCapabilities / explainPlan，mode = estimated）
已实现：DBX Host response → RawPlanInput adapter（fail-closed）
已实现：parser registry + PostgreSQL / MySQL 结构化 parser；其余 6 个方言 raw-only
已实现：RawPlanInput → Parser → NormalizedPlan → Metrics → Rules → Findings
已实现：Host 分析 UI（Connection Context / SQL Input / Plan Tree / Findings / Raw Plan）
已实现：Fixture-driven 开发 UI（离线，不进入 Host 生产路径）
未实现：Actual Plan / EXPLAIN ANALYZE、Plan Diff / History / Plan Canvas、AI
```

### 真实 Host 数据链路

```text
DBX connection（必须已打开）
   ↓ window.dbxPlugin.getPlanCapabilities(connectionId)
   ↓ 仅当 supports.estimatedPlan === true
window.dbxPlugin.explainPlan({ connectionId, sql, mode: "estimated" })
   ↓ PluginPlanResult（rawPlan 原样保留）
src/host/dbx-plan-host.js（结构校验 + 稳定错误码）
   ↓
src/core/adapter/dbx-plan-response.js（dbType → database family，format → RawPlanInput）
   ↓
src/core/parsers/index.js（registry：postgres / mysql structured，其余 raw-only）
   ↓
src/core/normalize → metrics → rules
   ↓
src/lib/analysis-session.js（编排，可注入 fake bridge 测试）
   ↓
Svelte components
```

- `src/host/**` 是唯一接触 `window.dbxPlugin` 的模块，位于 `src/core` 之外，
  由 `tests/core-isolation.test.js` 保证 Core 不反向依赖它。
- `src/core/**` 只接受 `RawPlanInput`，不感知 connectionId / credential / Host API。
- `src/core/adapter/dbx-plan-response.js` 是唯一 DBX response 感知层（纯函数，fail-closed）：
  映射已合并的 #9692 `{ dbType, dbVersion?, format, rawPlan, truncated, warnings }`；
  截断计划抛 `PLAN_TRUNCATED`，UI 保留原始 payload 仅做展示。
- Parser 负责引擎原生字段映射（引擎专有），Normalizer 负责数据库无关语义 + `engineSpecific`。

### Offline / Fixture 数据链路（开发用）

```text
fixture（fixtures/postgres/**；MySQL fixture 由核心测试直接加载）
   ↓ 构建期嵌入为 Fixture Catalog（原样保留 RawPlanInput + provenance）
RawPlanInput
   ↓ analyzePlan()
parsed / normalized / metrics / findings
   ↓ src/lib/view-model.js（纯映射，不重算 Core 结果）
Svelte components
```

Fixture / mock 只服务测试、离线 UI 开发与 golden sample，**不进入 Host 生产路径**。

## 2. 数据库支持范围

| 数据库 | 阶段 | 说明 |
| --- | --- | --- |
| PostgreSQL | 结构化 | `EXPLAIN (FORMAT JSON)`（`src/core/postgres/**`） |
| MySQL | 结构化 | `EXPLAIN FORMAT=JSON`（`src/core/mysql/**`；只解析 Estimated JSON，不含 `FORMAT=TRADITIONAL` / `FORMAT=TREE` / MariaDB 方言） |
| SQL Server | raw only | 宿主返回 ShowPlanXML（format `xml`） |
| Oracle / OceanBase Oracle | raw only | 宿主返回文本计划（format `text`） |
| Doris / Dameng / QuestDB | raw only | 宿主返回文本计划（format `text`） |

registry 对每个 family 显式声明支持状态；新增 parser 只需新增一个 parser 模块并注册，
UI / rules / metrics 不变。

## 3. 职责边界

### 属于 DBX（一律复用，不重新实现）

- Connection / Credential / Driver
- Query Context / SQL Execution
- Timeout / Cancel
- Database Type / Version
- EXPLAIN 生成与只读安全门
- 计划获取（Estimated only）与 payload 上限

### 属于 Plan Detective

- Host response 校验与 `RawPlanInput` 映射
- Plan semantic normalization（Plan IR）
- Metrics
- Rule Engine / Findings / Evidence
- Raw Plan viewer、Plan Tree、Node Inspector
- （Future）Plan Diff / History / Tuning workflow

## 4. Host Plan API 契约（已合并）

Canonical contract：[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)；
实现 PR [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692) 已合并进 `t8y2/dbx/main`（merge `f909f85`）。

```ts
getPlanCapabilities(connectionId) -> {
  dbType: string, dbVersion?: string,
  supports: { estimatedPlan: boolean },
  limits: { maxTimeoutMs: number, maxPlanBytes: number },
}

explainPlan({ connectionId, database?, schema?, sql, mode: "estimated", timeoutMs? }) -> {
  dbType: string, dbVersion?: string,
  format: "json" | "xml" | "text",
  rawPlan: unknown,
  truncated: boolean,
  warnings: string[],
}
```

- 权限 `host.plans:read`；`engines.host_api: ^1.2` 是兼容下限，运行时 gate 以 `capabilities.planApi` 为准：
  必须 `planApi === true` 且两个方法都存在才调用；`false` / 缺失一律 fail closed，不用请求探测宿主。
  init 到达前为 `initializing`（`ready` / `onInit` 之后重估），此阶段不调用 Host。
- `mode` 必须显式为 `"estimated"`；宿主拒绝其他值。插件不能传 EXPLAIN 语句。
- 连接必须已打开；宿主不会为插件建立连接。插件拿不到 credential / connection string。
- 截断 / 非 JSON 警告由宿主在 `warnings` 中给出，插件不得假装计划完整。
- 历史 Phase 0 审计（capability gap）见
  [HOST_CAPABILITY_AUDIT.md](HOST_CAPABILITY_AUDIT.md) 与
  [DBX_HOST_API_GAP_PROPOSAL.md](DBX_HOST_API_GAP_PROPOSAL.md)；结论已由 #9692 关闭。

## 5. 错误模型

Host Adapter 把宿主字符串错误映射为稳定错误码（`src/host/host-plan-errors.js`），
UI 为每个错误码渲染独立标题与提示，不使用通用 “Analysis failed”。

```text
PLAN_API_UNAVAILABLE / PERMISSION_NOT_DECLARED
CONNECTION_NOT_OPEN / CONNECTION_NOT_FOUND
UNSUPPORTED_DIALECT / UNSUPPORTED_MODE
EMPTY_SQL / SQL_TOO_LARGE / UNSAFE_SQL
PLAN_TOO_LARGE / EMPTY_PLAN / TIMEOUT
INVALID_REQUEST / INVALID_RESPONSE
UNSUPPORTED_DB_TYPE / UNSUPPORTED_PLAN_FORMAT / PLAN_TRUNCATED
HOST_ERROR
```

`src/lib/analysis-session.js` 将失败归一为 `{ status: "error", error: { code, causeCode, message, hostMessage } }`，
不向组件抛异常；`src/lib/host-view-model.js` 负责文案。

## 6. 前端结构约定

```text
src/
├── host/                       # DBX Host Plan API adapter（唯一接触 window.dbxPlugin）
│   ├── dbx-plan-host.js        # getPlanCapabilities / explainPlan / 响应结构校验 / timeout guard
│   └── host-plan-errors.js     # HostPlanError + 错误分类
├── core/                       # Plan Core：RawPlanInput → Parser → Normalize → Metrics → Rules → Findings
│   ├── adapter/                # DBX response → RawPlanInput（纯函数，fail-closed）
│   └── parsers/                # parser registry + postgres parser 声明
├── App.svelte                  # Host 分析 + Fixtures（开发）+ 宿主审计（开发）
├── app.css                     # 设计 tokens 与共享基础样式
├── components/                 # 按业务责任拆分的 Svelte 组件
│   ├── ConnectionContext.svelte# 连接上下文 + Plan Capabilities（不管理连接）
│   ├── SqlInput.svelte         # SQL 输入 + Analyze Plan
│   ├── AnalysisNotice.svelte   # loading / success / warning / error 状态
│   ├── PlanSummary.svelte      # Core Metrics 展示（不评分）
│   ├── FindingsList.svelte     # rule findings + evidence
│   ├── PlanTree.svelte         # 嵌套行计划树
│   ├── NodeInspector.svelte    # 选中节点字段
│   ├── RawPlanViewer.svelte    # 宿主原始计划（默认折叠，仅展示层截断）
│   ├── FixtureSelector.svelte  # 开发用 fixture 选择
│   └── HostAudit.svelte        # Phase 0 Host Capability Audit（开发视图）
└── lib/                        # 纯 UI 逻辑，可在 Node 中测试
    ├── analysis-session.js     # Host → Parser → IR → Rules 编排（注入 bridge）
    ├── host-view-model.js      # 连接上下文 / 能力 / 错误文案 / Raw Plan 格式化
    ├── fixture-catalog.js      # fixture catalog / 筛选 / analyzeFixture()
    ├── view-model.js           # summary / tree / findings / inspector 映射
    └── format.js               # 展示格式化
```

- UI 只消费 `analysis-session` 与 `view-model` 的输出；不解析计划、不重算 Metrics、不重跑规则。
- `window.dbxPlugin` 只在 `src/host/**` 与开发用 HostAudit 视图中出现。
- UI 从 `src/` 编译到 `ui/`（`vite.config.js` 的 `outDir`）。
- `manifest.json` 的 `entrypoints.ui` 指向 `ui/index.html`；`localizations` 负责多语言文案。

## 7. 打包边界

```toml
[package]
include = ["assets", "ui"]
```

只有 `assets/` 与 `ui/` 进入 `.dbxp`；`docs/`、`fixtures/`、`src/`、`node_modules/` 不会被打包。

## 8. 非目标（当前阶段）

以下需独立 Issue，不允许顺手实现：

- Actual Plan 获取（`EXPLAIN ANALYZE` 执行）、`SET STATISTICS XML`
- SQL Rewrite / 自动调优 / 自动建索引 / 自动执行 SQL / SQL Benchmark
- 数据库连接层 / Driver / 连接池 / 凭据 / SSH Tunnel / sidecar DB access
- 通用 Query API / 多 SQL 对比 / Plan 历史库 / 云同步 / telemetry
- Plan Diff / History / 自定义 Plan Canvas / 大型可视化（当前只做嵌套行计划树）
- AI / LLM
- SQL Server / Oracle / Doris / Dameng / QuestDB 的结构化 parser（需要真实 sample 后再实现）
- MariaDB / OceanBase MySQL / ADB MySQL 等 MySQL 兼容方言的自动归入（没有 contract 证据，不自动兼容）
- MySQL `EXPLAIN ANALYZE` / `FORMAT=TREE` / `FORMAT=TRADITIONAL` 文本计划 parser

## 9. UI 模式

`src/App.svelte` 有三个视图：

1. **Host 分析（生产路径）**：Connection Context（连接上下文 + Plan Capabilities）→ SQL Input →
   Analyze Plan → Findings / Plan Summary / Plan Tree / Node Inspector / Raw Plan。
   数据只来自 DBX Host Plan API；插件不建立连接、不执行 SQL、不读取凭据。
2. **Fixtures（开发）**：仓库内 fixture 经 Offline Core 分析，不访问 DBX / 数据库 / 网络。
3. **宿主审计（开发）**：只打印 `window.dbxPlugin` 桥接面、`init` 消息与 `host.getContext`，
   探测候选方法名；不含解析器、指标、规则，也不建立连接。

Host gate 生命周期：`src/App.svelte` 在 `onMount` 监听 `bridge.ready` / `onInit`，init 后按
`capabilities.planApi` 重估；`initializing` / `available` / `unavailable` 三态驱动 UI，
`initializing` 不调用 Host、也不报 unavailable。视图 2 / 3 仅在 development 构建
（`import.meta.env.DEV`）出现，生产构建只渲染视图 1。
