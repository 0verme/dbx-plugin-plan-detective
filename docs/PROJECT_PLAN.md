# 项目计划

**Host Plan API 已合并（[t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692)，merge `f909f85`）；本仓库已完成 Phase 1 MVP 真实闭环（Issue [#11](https://github.com/0verme/dbx-plugin-plan-detective/issues/11)）。**本文件记录已确认决策、当前阶段任务与路线约束。

> 状态（2026-09-22）：Phase 0 已完成；上游 Estimated Plan Host API 需求（[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)）已由实现 PR [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692) 合并进 `t8y2/dbx/main`。当前处于 `Offline Core implemented · Host MVP implemented（PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle structured；其余 3 个方言 raw-only）· Plan Diff / Actual Plan / AI are Future`。一期只做 Estimated Plan；Actual Plan 属于 Future。

## 1. 已确认决策

1. 首批支持 PostgreSQL + MySQL。
2. PostgreSQL 优先跑通完整 pipeline。
3. MySQL 紧随其后，用于验证跨数据库抽象。
4. 当前一期只做 **Estimated Plan**（`EXPLAIN ...`）。Actual Plan / `EXPLAIN ANALYZE` 属于 Future：不是 Phase 1 blocker，不属于 #9675，未来需要独立 upstream proposal 重新评估授权模型与安全边界。
5. 默认使用 Estimated。
6. Actual 若未来推进，必须显式触发，并重新评估安全、timeout、cancel（不属于当前一期）。
7. 当前不依赖 AI。
8. AI 未来只能作为 Explain / Rewrite 辅助层，不能成为 Rule Engine 的真相来源。
9. DBX 已有能力尽量复用。
10. 当前不重新实现 DBX 已有 Explain 基础设施。
11. 第一阶段先做 Host Capability Audit。
12. 确认缺少公开 Host API 后向 `t8y2/dbx` 提交 Feature Issue —— ✅ 已完成：[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)（2026-09-20，OPEN，已由 `0verme` `/claim`，当前唯一 canonical upstream contract）。

## 2. Phase 0：Host Capability Audit

Phase 0 已于 2026-09-18 完成，**不再是当前唯一的活动阶段**。当前状态为 `Phase 0 completed · Upstream implementation in progress`：

- 上游：等待 [t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)（Estimated Plan Host API）实现 / 合并，当前 blocker 是**实现与合并进度**，不再是"能力是否存在未知"。
- 下游：fixture / 离线 parser、normalization core 等不依赖 Host API 的部分可以独立开发；真实 Host 接入继续等待 #9675 落地。

> 审计结论（历史，2026-09-18）：**BLOCKED — DBX internal capability exists, Plugin Host API does not expose it.**
> 完整证据、矩阵与运行时实测记录见 [HOST_CAPABILITY_AUDIT.md](HOST_CAPABILITY_AUDIT.md)，上游反馈材料与一期 API 提案见 [DBX_HOST_API_GAP_PROPOSAL.md](DBX_HOST_API_GAP_PROPOSAL.md)，downstream design note 见 [docs/upstream/PLUGIN_HOST_PLAN_API_ISSUE.md](upstream/PLUGIN_HOST_PLAN_API_ISSUE.md)。

### 审计清单（已完成）

状态取值：`SUPPORTED`（公开 API 可用）/ `INTERNAL_ONLY`（DBX 内部存在但未公开）/ `NOT_AVAILABLE` / `UNKNOWN`。

- [x] 插件能否获得当前 connectionId —— `INTERNAL_ONLY`
- [x] 插件能否获得 database / schema —— `INTERNAL_ONLY`（`schema` 在 bridge 类型中声明但无任何生产者）
- [x] 插件能否获得当前 SQL —— `INTERNAL_ONLY`（`result-view` 设计路径存在，但当前版本无法打开）
- [x] 插件能否通过公开 Host API 请求执行计划 —— `INTERNAL_ONLY`（宿主方法注册表无入口）
- [x] 是否能获取 Raw Plan —— `INTERNAL_ONLY`
- [x] 是否支持 Estimated Plan —— `INTERNAL_ONLY`（PG/MySQL 等内部可用）
- [x] 是否支持 Actual Plan —— `INTERNAL_ONLY`（PG/SQL Server 内部可用）/ `NOT_AVAILABLE`（MySQL 无 analyze 路径）
- [x] 是否能使用 DBX timeout —— `INTERNAL_ONLY`
- [x] 是否能使用 DBX cancel —— `INTERNAL_ONLY`
- [x] 是否能获得数据库类型 —— `INTERNAL_ONLY`
- [x] 是否能获得数据库版本 —— `INTERNAL_ONLY`
- [x] PostgreSQL 能力现状 —— 内部 Estimated + Actual 可用，插件不可达
- [x] MySQL 能力现状 —— 内部 Estimated 可用、Actual 不存在，插件不可达；本机无 MySQL，仅源码级证据

**插件侧可达项：0 / 14。**

### 审计纪律

> **"DBX 内部已经存在某能力" ≠ "插件 Host API 已经公开该能力"。**

必须区分：

```text
DBX internal capability
和
Plugin Host public capability
```

- 不得调用 DBX 未公开的内部接口来绕过插件边界。
- 每个勾选项必须附带可复现证据：调用方法名、参数、返回样例、来源文档链接，或真实宿主中的实测输出。
- 结论分三档记录：**已公开 API 支持** / **内部存在但未公开** / **不存在或未知**。

### 已获得的文档级线索（已现场验证）

以下为公开文档取证（`t8y2/dbx` `main` 分支），已完成真实 DBX `v0.6.16` 宿主实测确认（详见 [HOST_CAPABILITY_AUDIT.md](HOST_CAPABILITY_AUDIT.md) 第 6 节）：

- 前端沙箱公开桥接方法不包含 SQL 执行或 EXPLAIN 相关入口（详见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 5 节）。
- 公开的插件可回调宿主方法仅有 `host/requestUserInput`（Host API 1.1）。
- 公开 manifest 权限中未见与数据库执行相关的能力名。
- `dbx-plugin dev` 独立开发主机明确不模拟 native connection actions 与 query-result contributions。

### 审计手段（不写业务代码）

1. 使用官方 `svelte` 模板自带示例中的 `window.dbxPlugin.request("host.getContext")` 在 **真实 DBX 宿主**中打印上下文，确认其中是否包含 connectionId、dbType、database、schema 等字段。
2. 枚举 `window.dbxPlugin.context` 的实际结构与可用方法。
3. 记录宿主 `host.hostApiVersion` 与 `host.features`。
4. 若发现能力缺失，整理为 Issue 材料提交到 `t8y2/dbx`（仅限插件宿主/SDK/CLI/schema 类变更）。

### Phase 0 出口条件

- 至少完成 connection 上下文、数据库类型/版本、执行计划获取三项的**明确结论**（支持 / 未公开）。—— ✅ 已完成
- 明确记录 Estimated 与 Actual 两条路径各自是否可行。—— ✅ 已完成（两条路径插件侧均不可行；DBX 内部可行）
- 若关键能力未公开：形成 Issue 并暂停相关实现，不自行设计替代架构。—— ✅ 已形成
  [DBX_HOST_API_GAP_PROPOSAL.md](DBX_HOST_API_GAP_PROPOSAL.md)（2026-09-20 更新：上游 Issue 已正式提交为 [#9675](https://github.com/t8y2/dbx/issues/9675) 并已认领）。

### Phase 0 结论（2026-09-18）

```text
Phase 0: BLOCKED — DBX internal capability exists, Plugin Host API does not expose it.
```

- 出口条件中的「至少三项明确结论」已满足，但**关键能力未公开**，因此不能判定 Phase 0 PASS。
- 按纪律：不实现插件侧数据库执行层、不引入 Driver、不绕过沙箱、不调用 DBX 内部接口。
- 下一步只有两条路：等待 / 推动上游公开 `host.plans:*` 一类只读计划 API（见 Gap Proposal），或由项目方决定改变产品边界（需新的架构决策与 Issue）。—— 上游路径已推进：需求已正式提交为 [#9675](https://github.com/t8y2/dbx/issues/9675) 并已认领，当前等待实现 / 合并。
- 附带上游缺陷：`result-view` 贡献在 `v0.6.16` 中无法打开工作台；已提交为 [t8y2/dbx#9597](https://github.com/t8y2/dbx/issues/9597) 并由 [PR #9599](https://github.com/t8y2/dbx/pull/9599) 修复、合入上游 `main`（尚未进入 release），见 Gap Proposal 附录 B。

### Phase 0B：Offline Core（2026-09-20 启动，已实现）

Phase 0 判定 BLOCKED 的是 **Host 接入**，不是全部内核工作。经项目方明确授权，先以 fixture-first 方式落地与
DBX 完全解耦的离线分析内核（不等待、不依赖 t8y2/dbx#9675）：

```text
PostgreSQL fixture → RawPlanInput → Parser → NormalizedPlan → Metrics → Rules → Findings
```

- 契约与实现：`src/core/**`、`tests/**`、`fixtures/postgres/**`、`scripts/**`；
  唯一真相来源为 [PLAN_INPUT_AND_FIXTURES.md](PLAN_INPUT_AND_FIXTURES.md)。
- 已实现：RawPlanInput 契约、PostgreSQL JSON parser（含未知节点/未知字段保留）、NormalizedPlan、
  确定性 Metrics、3 条确定性规则与 Findings/Evidence、19 个 fixture（17 真实采集 + 2 synthetic）
  与四 stage golden test。
- 未实现也不允许顺手实现：`dbx-adapter`、Host API 调用、数据库 Driver / 连接池 / 凭据、
  Actual Plan 获取、MySQL parser、Plan Diff、AI、SQL Rewrite。
- 退出条件：本阶段不产出 Host 能力结论；Host 接入仍等待 #9675，落地后只需新增 adapter 将 `rawPlan`
  映射为 `RawPlanInput`。

### Phase 0C：Fixture-driven MVP UI（2026-09-20，已实现）

在 Offline Core 之上落地第一版可用 UI（Issue [#7](https://github.com/0verme/dbx-plugin-plan-detective/issues/7)）：Fixture Selector、
Plan Summary、Findings、Plan Tree、Node Inspector。数据链路严格为：

```text
fixture → RawPlanInput → analyzePlan()（现有 Offline Core）→ View Model → Svelte UI
```

- 已实现：`src/components/**`（按业务责任拆分）、`src/lib/**`（纯 fixture catalog / view model，
  不重算 Core 指标与规则）、`scripts/vite-plugin-fixtures.mjs`（构建期从 `fixtures/postgres/**`
  读入 `.plan.json` + 展示字段，不含 golden / `setup.sql`）。
- UI 明确标注 `Offline / Fixture Mode`；synthetic fixture 保持 synthetic 标识。
- 不调用 Host API、不修改 `engines.host_api`、不新增 `host.plans:read`、不引入数据库 Driver。
- 退出条件：Fixture 与 Host 两条数据入口都只需产出 `RawPlanInput`；#9692 落地后只新增 `dbx-adapter`，
  Core / View Model / 组件不重写。
- 不在本轮范围：Plan Diff、Plan Canvas / DAG 编辑器、MySQL parser、综合评分、SQL Rewrite、AI。

### Phase 0D：DBX Response Adapter Contract（2026-09-20，已随 PR #10 合入）

在上游 #9692 的 response contract 冻结后，先把 `DBX Host Response → RawPlanInput` 的转换规则钉死
（Issue [#9](https://github.com/0verme/dbx-plugin-plan-detective/issues/9)）：

```text
#9692 Response → adaptDbxEstimatedPlanResponse() → RawPlanInput → 现有 Offline Core
```

- 实现：`src/core/adapter/dbx-plan-response.js`（纯函数，唯一的 DBX 感知层）；
  测试：`tests/core/dbx-plan-response.test.js`（含全部 estimated fixture 的 response 等价性断言）。
- 映射：`dbType` → Plan Core database family（8 个方言）；响应无 `mode` → `mode: "estimated"`；
  `format` 接受 `json` / `text` / `xml`；`rawPlan` → `plan` 原引用直传；`dbVersion?` → `databaseVersion?`。
- Fail-closed：契约外的 dbType / format、结构不符、`truncated` / `plan_truncated` /
  `plan_rows_truncated` 全部拒绝，错误码稳定（`DbxPlanAdapterError`）。
- 契约细节见 [PLAN_INPUT_AND_FIXTURES.md](PLAN_INPUT_AND_FIXTURES.md) 第 2.1 节。

### Phase 1：Host Plan API MVP 闭环（2026-09-20，Issue #11）

#9692 合并后，正式把真实 Host 接入生产路径：

```text
DBX connection → getPlanCapabilities → explainPlan(mode: "estimated")
→ RawPlanInput → parser registry → NormalizedPlan → Metrics → Rules → Findings → UI
```

- 实现：`src/host/**`（Host adapter + 错误码）、`src/core/parsers/**`（registry）、
  `src/lib/analysis-session.js`（编排）、`src/lib/host-view-model.js`（纯 view model）、
  新组件（ConnectionContext / SqlInput / AnalysisNotice / RawPlanViewer）。
- 结构化支持：PostgreSQL；其余 7 个方言 raw-only，明确标注 `structured parser not implemented`（这是 Phase 1 当时的范围；MySQL 已在 Phase 1.1、SQL Server 已在 Phase 3.1、OceanBase Oracle 已在 Phase 3.2 接入）。
- 连接上下文：result-view 入口带入 `connectionId` / `database` / `sql`；standalone workbench 提供
  Connection ID 输入（仅引用已打开连接，不创建连接、不读凭据）。
- 错误状态：宿主错误映射为稳定错误码，逐项 UI 文案；不使用通用 `Analysis failed`。
- mock / fixture 只服务测试与开发，退出生产路径。
- 不在本轮范围：Actual Plan、MySQL 等 parser、Plan Diff、AI、SQL Rewrite、自建连接。

## 2.1 当前一期目标与 Future 边界

**当前一期（Estimated Plan only）**：

```text
DBX Host Adapter          ← 已接入（Host API 1.2，权限 host.plans:read）
→ Estimated Raw Plan（EXPLAIN ...，宿主构造）
→ Parser（PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle structured；其余 3 个方言 raw-only）
→ Normalization
→ Metrics
→ Rules
→ Findings
```

- 只请求 `host.plans:read`、`host.getPlanCapabilities`、`host.explainPlan`，且 `mode=estimated`。
- `DBX Host Adapter` 已按 #9692 已合并实现接入；下游链路与离线 fixture 模式共用同一 Core。

**Future（不属于一期，不属于 #9675）**：

```text
Actual Plan / EXPLAIN ANALYZE
→ Actual 专用指标 / 运行时统计
```

- **不是 Phase 1 blocker**；
- **不属于 #9675**；
- 未来需要**独立 upstream proposal**，重新评估授权模型与安全边界（会真正执行用户语句）。

## 3. 后续阶段（Phase 1 Host MVP 已完成）

| 阶段 | 内容 | 状态 / 前置条件 |
| --- | --- | --- |
| Phase 0B | Raw Plan → NormalizedPlan → Metrics → Rules → Findings（**离线**，fixture-first） | ✅ 已实现（2026-09-20，PR #6） |
| Phase 0C | Fixture-driven MVP UI（Fixture Selector / Plan Summary / Findings / Plan Tree / Node Inspector，**离线**） | ✅ 已实现（2026-09-20，Issue [#7](https://github.com/0verme/dbx-plugin-plan-detective/issues/7)）；继续作为开发模式保留 |
| Phase 0D | DBX Estimated Plan Response → RawPlanInput Adapter Contract（**离线**，纯函数、fail-closed） | ✅ 已实现并合入（Issue [#9](https://github.com/0verme/dbx-plugin-plan-detective/issues/9)，PR #10） |
| Phase 1 | Host Plan API 真实接入 + MVP 闭环（PostgreSQL structured，其余 raw-only） | ✅ 已实现（Issue [#11](https://github.com/0verme/dbx-plugin-plan-detective/issues/11)） |
| Phase 1.1 | MySQL Estimated Plan 结构化（`EXPLAIN FORMAT=JSON` → 现有 IR / metrics / rules） | ✅ 已实现（Issue [#15](https://github.com/0verme/dbx-plugin-plan-detective/issues/15)） |
| Phase 2 | Metrics Engine + Findings/Evidence 扩展（Hotspot / Estimate Error 等） | Hotspot Analysis ✅ 已实现（Issue [#19](https://github.com/0verme/dbx-plugin-plan-detective/issues/19)）；Estimate Error 等扩展属后续 Issue |
| Phase 3 | Rule Engine 扩展与规则分级 | 3 条确定性规则已实现；更多规则属后续 Issue |
| Phase 3.1 | SQL Server ShowPlanXML 结构化（ShowPlanXML → 现有 IR / metrics / hotspots） | ✅ 已实现（2026-09-21）；14 个 synthetic fixture + golden；代价不映射到 PostgreSQL 语义 |
| Phase 3.2 | OceanBase Oracle JSON Estimated Plan 结构化（`EXPLAIN FORMAT=JSON` → 现有 IR / metrics / hotspots） | ✅ 已实现（2026-09-22）；12 个 fixture（1 official + 11 synthetic）+ golden；`EST.TIME(us)` / `COST` 不映射到 PostgreSQL 语义，不新增专属 hotspot 规则 |
| Phase 3.3 | Oracle DBMS_XPLAN Estimated Plan 文本结构化（`TYPICAL +PREDICATE` → 现有 IR / metrics / hotspots） | ✅ 已实现；5 个 synthetic text fixture + golden；`Rows` 进入 `estimatedRows`，Oracle `Cost` 保留在 `engineSpecific.oracle` |
| Phase 4 | Plan Diff / History | 后续 Issue |
| Phase 5 | Doris / Dameng / QuestDB 结构化 parser | 需要真实 sample / contract 后再实现（MySQL 已在 Phase 1.1、SQL Server 已在 Phase 3.1、OceanBase Oracle 已在 Phase 3.2、Oracle 已在 Phase 3.3 完成） |

> 以上阶段仅为方向约定，具体范围在启动时另开 Issue 确定。

## 4. Fixture 策略

从项目初始化开始，把**离线 Plan Sample 当成一等开发能力**。

```text
raw plan → normalized plan → metrics → findings
```

目标：即使没有真实 PostgreSQL / MySQL 环境，大部分 Parser、Metrics、Rule Engine 和 UI 也能基于 fixture 开发和测试。

约定：

- `fixtures/postgres/`、`fixtures/mysql/`、`fixtures/sqlserver/`、`fixtures/oceanbase-oracle/`、`fixtures/oracle/` 按数据库分目录。
- fixture 必须是**真实采集**的计划样本，或明确标注为人工构造的最小样本；不得用伪造样本冒充真实数据。
- 每个样本记录来源（数据库版本、是否实际执行、是否裁剪）与预期分析结论。
- Golden Fixture 测试：`parsed` / `normalized` / `metrics` / `findings` 四 stage 与预期快照比对；
  约定见 [PLAN_INPUT_AND_FIXTURES.md](PLAN_INPUT_AND_FIXTURES.md)。

PostgreSQL 样本已落地（Phase 0B：20 个）；MySQL 样本已落地
（Phase 1.1：13 个，全部为 shape-verified synthetic，覆盖 table scan / index access / nested loop /
sort / group / union / subquery；本机无 MySQL 实例，来源见 `fixtures/mysql/README.md`）；
SQL Server 样本已落地（Phase 3.1：14 个，全部为 synthetic ShowPlanXML，覆盖 scan / seek / join /
sort / aggregate / spool 类算子 / unknown operator / 缺失字段；本机无 SQL Server 实例，
形状对照公开 schema 与文档，见 `fixtures/sqlserver/README.md`）；
OceanBase Oracle 样本已落地（Phase 3.2：12 个 = 1 个官方 Oracle 模式 `EXPLAIN` 文档 JSON 示例 + 11 个 synthetic，
覆盖 table full scan / index access / table get / nested-loop / hash join / sort / aggregate / multi-level tree /
unknown operator / unknown fields / missing optional fields / `CHILD_<n>` 数字排序；本机无 OceanBase 实例，
键名与算子名对照官方文档与引擎 JSON plan writer，见 `fixtures/oceanbase-oracle/README.md`）。
Oracle DBMS_XPLAN 样本已落地（Phase 3.3：5 个 synthetic text fixture + golden，覆盖可变列宽、缺失字段、predicate marker、
CRLF、未知 Operation 子树与缩进建树；见 `fixtures/oracle/README.md`）。

## 5. Host 接入与其它阶段仍禁止顺手实现

以下能力属于后续阶段或 Future，除当前任务明确启动的模块外不得顺手实现（需要单独 Issue / 任务）：

- Host / Adapter 接入（`dbx-adapter`、Host API 调用、Execution Plan 扩展点集成）
- Plan Diff
- SQL Rewrite / 自动调优 / 自动建索引 / 自动执行 SQL
- AI / LLM
- Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute`（属于 Future，需独立 upstream proposal）
- Doris / Dameng / QuestDB parser（MySQL 已由 Issue #15、SQL Server 已由 Phase 3.1、OceanBase Oracle 已由 Phase 3.2、Oracle 已由 Phase 3.3 显式启动并完成）
- 自定义 Plan Canvas / Plan Diff UI
- 数据库连接层

例外：**离线 Plan Core**（PostgreSQL parser、NormalizedPlan、Metrics、Rule Engine、Findings）已由项目方
在 Phase 0B 中明确授权实现，范围限于 `src/core/**`，且不得依赖任何 DBX Host API。详见
[PLAN_INPUT_AND_FIXTURES.md](PLAN_INPUT_AND_FIXTURES.md)。

例外：**Fixture-driven MVP UI**（Fixture Selector / Plan Summary / Findings / Plan Tree / Node Inspector）
已由 Issue [#7](https://github.com/0verme/dbx-plugin-plan-detective/issues/7) 明确授权实现，范围限于
`src/components/**`、`src/lib/**`、`src/App.svelte`、构建期 fixture 虚拟模块；只消费 `RawPlanInput`
与 `analyzePlan()` 输出，不构成 Host 接入，不引入数据库连接能力。

例外：**DBX Response Adapter Contract**（DBX Estimated Plan Response → RawPlanInput）已由 Issue
[#9](https://github.com/0verme/dbx-plugin-plan-detective/issues/9) 明确授权实现，范围限于 `src/core/adapter/**`，
必须保持纯函数、fail-closed、离线可测。

例外：**Host Plan API MVP 闭环**（`src/host/**`、`src/core/parsers/**`、`src/lib/analysis-session.js`、
`src/lib/host-view-model.js`、新组件、`manifest.json` 的 `host_api ^1.2` / `host.plans:read`）已由 Issue
[#11](https://github.com/0verme/dbx-plugin-plan-detective/issues/11) 明确授权实现；仅接入已合并的 #9692 契约，
不请求 Actual Plan、不建立数据库连接、不引入 Driver / 凭据。

## 6. 依赖约束

当前阶段不得引入：PostgreSQL driver、MySQL driver、sqlx、JDBC、自定义数据库连接池、Credential 管理、SSH Tunnel、自定义数据库执行层、AI SDK、LLM、Rust backend、Go backend。

当前依赖仅限官方 `svelte` 模板自带的 Svelte + Vite 构建链。
