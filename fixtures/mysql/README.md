# MySQL Fixtures

本目录存放 MySQL 执行计划的**离线样本**，作为 Parser、Normalizer、Metrics、Rule Engine 与 UI 的
一等开发与测试输入。

> **当前状态：14 个 `estimated/` fixture + 对应 golden，已接入结构化 pipeline。**
> MySQL 的 Estimated Plan 来自 DBX Host 实际返回的 `EXPLAIN FORMAT=JSON`；V2 fixture 覆盖
> MySQL 9.5 / DBX v0.6.18 返回的 `query_plan` 形状；详见
> [docs/PLAN_INPUT_AND_FIXTURES.md](../../docs/PLAN_INPUT_AND_FIXTURES.md) 第 4.2 节。

目录、metadata sidecar、provenance 标记与 Golden Test 约定与 PostgreSQL 相同，见
[docs/PLAN_INPUT_AND_FIXTURES.md](../../docs/PLAN_INPUT_AND_FIXTURES.md) 第 7 节。

## Provenance（重要）

本仓库的审计环境没有 MySQL 实例（Debian bookworm 只有 MariaDB，且 MariaDB 的 JSON plan 形状不同）。
因此**所有 MySQL fixture 都是 synthetic**：人工构造、文件名带 `.synthetic`、`databaseVersion` /
`capturedAt` / `captureCommand` / `sql` 均为 `null`。

为了避免"凭记忆写 parser"，每个 fixture 的 JSON 结构都对照了真实 MySQL 输出：

- MySQL Server 8.0 `mysql-test` 期望输出
  [`explain_json_all.result`](https://raw.githubusercontent.com/mysql/mysql-server/8.0/mysql-test/r/explain_json_all.result)
  （`query_block` / `nested_loop` / `table` / `cost_info` / `ordering_operation` / `grouping_operation` /
  `duplicates_removal` / `union_result` / `unary_result` / `intersect_result` / `except_result` /
  `materialized_from_subquery` / `*_subqueries` 的真实形状与字段名）；
- DBX 自身的 MySQL JSON 消费者 `apps/desktop/src/lib/diagram/explainPlan.ts`
  （`query_block` / `nested_loop` / `table` / `access_type` / `rows_examined_per_scan` /
  `rows_produced_per_join` / `cost_info`）；
- DBX Host 契约 `crates/dbx-sql/src/query_execution_sql.rs` 与
  `crates/dbx-core/src/query/plugin_plan.rs`（MySQL 使用 `EXPLAIN FORMAT=JSON`，Host 固定
  `format: "json"` 且不设置 `analyze`）；
- MySQL 9.5 JSON Explain 文档中的 V2 `query_plan` / `inputs` / `json_schema_version: "2.0"`
  结构（[官方文档](https://dev.mysql.com/doc/refman/9.5/en/explain.html)）。

表名、行数与 cost 数值是合成测试数据，不是生产数据。`source.reference` 指向上述 MySQL Server 期望输出。

## Fixture 列表

| fixture | SQL 场景 | 覆盖点 | 触发规则 |
| --- | --- | --- | --- |
| `table-scan.synthetic` | `SELECT * FROM orders WHERE status = 'OPEN'` | `access_type: ALL`、`attached_condition`、单表 | — |
| `data-read-per-join-unit.synthetic` | 单表 `access_type: ALL`（Issue #38 regression） | `cost_info.data_read_per_join` 为 MySQL human-readable data size（`"167K"`），验证 1024 进制 byte 归一化 | — |
| `large-table-scan.synthetic` | `SELECT * FROM events` | 大估算行数、无 IR cost | `large-sequential-scan`（high） |
| `index-lookup.synthetic` | `SELECT ... FROM users WHERE email = ?` | `ref` + `possible_keys` / `key` / `used_key_parts` / `key_length` / `ref` | — |
| `const-lookup.synthetic` | `SELECT ... FROM settings WHERE id = 1` | `const` 单行查找 → `const_scan` | — |
| `nested-loop-join.synthetic` | `orders JOIN customers JOIN order_items` | 3 元素 `nested_loop` → 左深二叉链、`ref` + `eq_ref` | — |
| `nested-loop-large-inner.synthetic` | `orders JOIN events`，内层 50 000 行 | 大内层估算 | `large-sequential-scan`、`nested-loop-large-inner` |
| `ordering-filesort.synthetic` | `SELECT * FROM orders ORDER BY total DESC` | `ordering_operation` + `using_filesort` | — |
| `grouping-temporary.synthetic` | `GROUP BY created_at`（range 访问） | `grouping_operation` + `using_temporary_table` + `range` | — |
| `complex-mixed.synthetic` | 带派生表与标量子查询的分组排序 join | ordering + grouping + nested loop + `materialized_from_subquery` + `attached_subqueries`，深度 9 | — |
| `union-result.synthetic` | `orders UNION users JOIN orders` | `union_result` + `query_specifications`，分支内含 join | — |
| `future-shape.synthetic` | `SELECT id FROM orders`（未知结构） | 未知 `access_type` / 未知 block key / 未知 `cost_info` key → `unknownNodeTypes` + `extra` 保留 | — |
| `table-scan-v2.synthetic` | MySQL 9.5 JSON Explain V2 单表访问 | `json_schema_version: "2.0"`、`query_plan`、`schema_name`、`used_columns`、`estimated_rows` | `large-sequential-scan`（high） |
| `nested-inputs-v2.synthetic` | MySQL 9.5 JSON Explain V2 join | `inputs` 递归、hash join、filter、table scan 叶子、V2 engineSpecific 字段 | — |

`estimated/` 之外没有 `actual/`：Host API 不提供 MySQL actual plan，MySQL `EXPLAIN ANALYZE`
返回的是 TREE 文本而不是该 JSON 形状，`RawPlanInput` 契约也明确不接受 MySQL actual JSON
（声明 `mode: "actual"` 时 parser 抛 `MODE_MISMATCH`）。

## 边界条件

- V1 `estimatedRows` 取 `rows_examined_per_scan`（每次访问该表的估算行数）；join 节点的
  `estimatedRows` 取内层表的 `rows_produced_per_join`（join prefix 累计输出行数）。V2
  直接取节点的 numeric `estimated_rows`，并递归 `inputs` / `inputs_from_select_list`，不伪造
  `query_block`。
- V1 `query_block` 与 V2 `query_plan` 使用独立 parser 分支；缺版本、未知版本、混合 schema
  或不可信结构均 fail closed，未知但合法的字段进入 `extra`。
- `cost_info` 只进入 `engineSpecific.mysql`，**不**映射到 IR 的 `startupCost` / `totalCost`：
  MySQL cost 与 PostgreSQL cost 不可直接比较，`prefix_cost` 还是累计值。
- `cost_info` 中除 `data_read_per_join` 外的值都是 MySQL numeric string，严格解析；
  `data_read_per_join` 是 data size，由 MySQL `human_readable_num_bytes()` 输出为 1024 进制、
  整数加 `K` / `M` / `G` / `T` / `P` / `E` / `Z` / `Y` 后缀（如 `"167K"`），parser 用独立的
  `optionalDataSize()` 归一化为 byte 数值，不把单位后缀放宽到其他 cost 字段（Issue #38）。
- 一个样本一个文件；`.plan.json` 保持 JSON 合法（MySQL `end_markers_in_json=on` 的输出带
  `/* ... */` 注释、不是合法 JSON，本目录不采用）。
- 不放入任何包含真实生产数据、凭据或连接串的内容。
