# 项目计划

**当前只建立项目框架，尚未实现任何执行计划分析能力。**本文件记录已确认决策、当前阶段任务与路线约束。

## 1. 已确认决策

1. 首批支持 PostgreSQL + MySQL。
2. PostgreSQL 优先跑通完整 pipeline。
3. MySQL 紧随其后，用于验证跨数据库抽象。
4. Estimated Plan 和 Actual Plan 都需要兼容。
5. 默认使用 Estimated。
6. Actual 必须显式触发，并考虑安全、timeout、cancel。
7. 当前不依赖 AI。
8. AI 未来只能作为 Explain / Rewrite 辅助层，不能成为 Rule Engine 的真相来源。
9. DBX 已有能力尽量复用。
10. 当前不重新实现 DBX 已有 Explain 基础设施。
11. 第一阶段先做 Host Capability Audit。
12. 确认缺少公开 Host API 后，再考虑向 `t8y2/dbx` 提 Issue / PR。

## 2. Phase 0：Host Capability Audit

**这是当前唯一的活动阶段。**在清单未取得证据前，不开始实现 Parser、Metrics 或 Rule Engine。

### 审计清单

- [ ] 插件能否获得当前 connectionId
- [ ] 插件能否获得 database / schema
- [ ] 插件能否获得当前 SQL
- [ ] 插件能否通过公开 Host API 请求执行计划
- [ ] 是否能获取 Raw Plan
- [ ] 是否支持 Estimated Plan
- [ ] 是否支持 Actual Plan
- [ ] 是否能使用 DBX timeout
- [ ] 是否能使用 DBX cancel
- [ ] 是否能获得数据库类型
- [ ] 是否能获得数据库版本
- [ ] PostgreSQL 能力现状
- [ ] MySQL 能力现状

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

### 已获得的文档级线索

以下为公开文档取证（`t8y2/dbx` `main` 分支），用作审计起点，**不能替代现场验证**：

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

- 至少完成 connection 上下文、数据库类型/版本、执行计划获取三项的**明确结论**（支持 / 未公开）。
- 明确记录 Estimated 与 Actual 两条路径各自是否可行。
- 若关键能力未公开：形成 Issue 并暂停相关实现，不自行设计替代架构。

## 3. 后续阶段（暂不启动）

| 阶段 | 内容 | 前置条件 |
| --- | --- | --- |
| Phase 1 | Raw Plan → Normalized Plan（PostgreSQL 优先） | Phase 0 出口条件满足 |
| Phase 2 | Metrics Engine + Findings/Evidence | Phase 1 模型稳定 |
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

- Rule Engine
- Metrics Engine
- Plan Diff
- SQL Rewrite
- AI
- 自动调优
- 自动建索引
- 自动执行 SQL
- PostgreSQL parser
- MySQL parser
- 自定义 Plan Canvas
- 数据库连接层

## 6. 依赖约束

当前阶段不得引入：PostgreSQL driver、MySQL driver、sqlx、JDBC、自定义数据库连接池、Credential 管理、SSH Tunnel、自定义数据库执行层、AI SDK、LLM、Rust backend、Go backend。

当前依赖仅限官方 `svelte` 模板自带的 Svelte + Vite 构建链。
