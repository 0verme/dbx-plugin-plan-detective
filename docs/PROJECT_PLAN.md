# 项目计划

**当前只建立项目框架，尚未实现任何执行计划分析能力。**本文件记录已确认决策、当前阶段任务与路线约束。

> 状态（2026-09-20）：Phase 0 已完成；上游 Estimated Plan Host API 需求已正式提交并认领（[t8y2/dbx#9675](https://github.com/t8y2/dbx/issues/9675)），当前处于 `Phase 0 completed · Upstream implementation in progress`。一期只做 Estimated Plan；Actual Plan 属于 Future。

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

## 2.1 当前一期目标与 Future 边界

**当前一期（Estimated Plan only）**：

```text
DBX Host Adapter          ← 依赖上游 #9675 实现；接入前不可用
→ Estimated Raw Plan（EXPLAIN ...）
→ Parser
→ Normalization
→ Metrics
→ Rules
→ Findings
```

- 只请求 `host.plans:read`、`host.getPlanCapabilities`、`host.explainPlan`，且 `mode=estimated`。
- `DBX Host Adapter` 之外的下游链路可以基于 fixture 独立开发与验证，不阻塞于上游实现进度。

**Future（不属于一期，不属于 #9675）**：

```text
Actual Plan / EXPLAIN ANALYZE
→ Actual 专用指标 / 运行时统计
```

- **不是 Phase 1 blocker**；
- **不属于 #9675**；
- 未来需要**独立 upstream proposal**，重新评估授权模型与安全边界（会真正执行用户语句）。

## 3. 后续阶段（Phase 1 离线部分进行中，真实 Host 接入暂不启动）

| 阶段 | 内容 | 前置条件 |
| --- | --- | --- |
| Phase 1 | Raw Plan → Normalized Plan（PostgreSQL 优先） | **进行中（离线部分）**：fixture 驱动的 parser / normalization 可独立开发；真实 Host 接入需等待 #9675 实现、合并并进入 release |
| Phase 2 | Metrics Engine + Findings/Evidence | Phase 1 模型稳定（离线部分可先行） |
| Phase 3 | Rule Engine | Phase 2 指标可复现 |
| Phase 4 | Plan Diff / History | 上述阶段通过 |
| Phase 5 | MySQL Adapter | 验证跨数据库抽象 |

> 以上阶段仅为方向约定，具体范围在启动时另开 Issue 确定。

## 4. Fixture 策略

从项目初始化开始，把**离线 Plan Sample 当成一等开发能力**。

```text
raw plan → normalized plan → metrics → findings
```

目标：即使没有真实 PostgreSQL / MySQL 环境，大部分 Parser、Metrics、Rule Engine 和 UI 也能基于 fixture 开发和测试。

约定：

- `fixtures/postgres/`、`fixtures/mysql/` 按数据库分目录。
- fixture 必须是**真实采集**的计划样本，或明确标注为人工构造的最小样本；不得用伪造样本冒充真实数据。
- 每个样本记录来源（数据库版本、是否实际执行、是否裁剪）与预期分析结论。
- 后续引入 Golden Fixture 测试：解析与指标输出与预期快照比对。

**本次初始化不放入执行计划样本**，仅建立目录与说明。

## 5. 当前阶段禁止顺手实现

以下能力属于后续阶段或 Future，除当前任务明确启动的模块外不得顺手实现（需要单独 Issue / 任务）：

- Rule Engine
- Metrics Engine
- Plan Diff
- SQL Rewrite
- AI
- 自动调优
- 自动建索引
- 自动执行 SQL
- Actual Plan / `EXPLAIN ANALYZE` / `host.plans:execute`（属于 Future，需独立 upstream proposal）
- PostgreSQL parser（仅在任务明确启动离线 parser / normalization 时进行，PostgreSQL 优先）
- MySQL parser（PostgreSQL 优先，不属于一期前置）
- 自定义 Plan Canvas
- 数据库连接层

## 6. 依赖约束

当前阶段不得引入：PostgreSQL driver、MySQL driver、sqlx、JDBC、自定义数据库连接池、Credential 管理、SSH Tunnel、自定义数据库执行层、AI SDK、LLM、Rust backend、Go backend。

当前依赖仅限官方 `svelte` 模板自带的 Svelte + Vite 构建链。
