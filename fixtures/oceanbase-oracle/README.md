# OceanBase Oracle Fixtures

本目录存放 OceanBase Oracle **Estimated Plan JSON**（`EXPLAIN FORMAT=JSON`）的离线样本，作为 Parser、
Normalizer、Metrics、Rule Engine 与 UI 的一等开发与测试输入。

> **当前状态：12 个 `estimated/` fixture（11 个 synthetic + 1 个 official）+ 对应 golden，已接入结构化 pipeline。**
> OceanBase Oracle 的 Estimated Plan 由 DBX Host 以 `format: "json"` 返回（`dbType: "oceanbase-oracle"`）；
> Plan Detective 只消费 Host 返回的 JSON，不建立连接、不拼接 `EXPLAIN` 语句。
> 契约见 [docs/PLAN_INPUT_AND_FIXTURES.md](../../docs/PLAN_INPUT_AND_FIXTURES.md) 第 4.4 节。

目录、metadata sidecar、provenance 标记与 Golden Test 约定与 PostgreSQL / MySQL / SQL Server 相同，见
[docs/PLAN_INPUT_AND_FIXTURES.md](../../docs/PLAN_INPUT_AND_FIXTURES.md) 第 7 节。

## Provenance（重要）

本仓库与审计环境**没有 OceanBase 实例**，也没有可提交的真实采集样本。因此：

- `hash-join`（**official**）：逐字转录自 OceanBase 官方 Oracle 模式 `EXPLAIN` 文档中的 JSON 示例
  （OceanBase V4.3.5）。它是**公开文档示例**，不是本地实例采集，也**未在本环境执行**；
  `capturedAt` 记录的是从文档转录的日期。payload 保留文档中的键顺序与取值，仅移除了文档渲染用的表格边框。
- 其余 11 个 fixture 都是 **synthetic**：文件名带 `.synthetic`，`databaseVersion` / `capturedAt` /
  `captureCommand` / `sql` 均为 `null`，且**从未在 OceanBase 上回放**。

为避免“凭记忆写 parser”，synthetic fixture 的键名、键顺序语义与算子名称都对照了公开来源：

- Oracle 模式 `EXPLAIN` 参考（`FORMAT = {TRADITIONAL|JSON}`、JSON 示例中的
  `ID` / `OPERATOR` / `NAME` / `EST.ROWS` / `EST.TIME(us)` / `output` / `CHILD_1` / `CHILD_2`）：
  <https://github.com/oceanbase/oceanbase-doc/blob/V4.3.5/zh-CN/700.reference/500.sql-reference/100.sql-syntax/300.common-tenant-of-oracle-mode/900.sql-statement-of-oracle-mode/200.dml-of-oracle-mode/500.explain-of-oracle-mode.md>
- 执行计划算子参考（`TABLE FULL SCAN` / `TABLE RANGE SCAN` / `TABLE GET` / `TABLE SKIP SCAN` /
  `NESTED-LOOP JOIN` / `HASH JOIN` / `MERGE JOIN` / `SORT` / `SCALAR GROUP BY` / `MATERIAL` /
  `SUBPLAN SCAN` / `EXCHANGE` / `LIMIT` 等）：
  <https://github.com/oceanbase/oceanbase-doc/tree/V4.3.5/zh-CN/700.reference/1000.performance-tuning-guide/500.sql-optimization/200.sql-execution-plan/400.execution-plan-operator>
- OceanBase 自身 JSON plan writer（`ID` / `OPERATOR` / `NAME` / `EST.ROWS` / `EST.TIME(us)` / `output`，
  子节点名为 `CHILD_<position>`）：
  <https://github.com/oceanbase/oceanbase/blob/master/src/sql/monitor/ob_sql_plan.cpp>

表名、列名、行数与 `EST.TIME(us)` 数值都是合成测试数据，不是生产数据。若后续获得真实采集样本，
应新增 `locally-generated` fixture，而不是修改本目录的 synthetic 声明。

## Fixture 列表

| fixture | 场景 | 覆盖点 | 触发规则 / 热点 |
| --- | --- | --- | --- |
| `table-full-scan.synthetic` | `TABLE FULL SCAN`，250 000 行 | `seq_scan` 映射、单节点树、无 `CHILD_n` | `large-sequential-scan`（high）+ 热点 |
| `table-range-scan.synthetic` | `TABLE RANGE SCAN` 走索引，1 200 行 | `index_scan` 映射、`NAME` 保留 `TABLE(INDEX)` 形式 | — |
| `table-get-filter.synthetic` | `TABLE GET` 主键点查 + 扩展信息键 | `index_scan` 映射、`filter` / `access` / `range_key` 保留在 `extra` 且**不**提升为中立谓词 | — |
| `nested-loop-large-inner.synthetic` | `NESTED-LOOP JOIN`：外层 1 000 × 内层 50 000 | 带连字符算子标签归一、`CHILD_1` 外层 / `CHILD_2` 内层 | `nested-loop-large-inner`（warning）+ `large-sequential-scan`（warning）+ 两个热点 |
| `hash-join`（official） | 官方文档示例：`HASH JOIN` + 两个 `TABLE FULL SCAN` | `OPERATOR` 尾随空格被裁剪、官方 JSON 形状 | — |
| `sort.synthetic` | `SORT` over `TABLE FULL SCAN` | `sort` 映射、`sortCount`、无代价类 sort 信号 | `large-sequential-scan`（warning）+ 热点 |
| `aggregate.synthetic` | `SCALAR GROUP BY` over `TABLE FULL SCAN` | `aggregate` 映射、`aggregateCount` | — |
| `multi-level-tree.synthetic` | `LIMIT → SORT → HASH JOIN → (TABLE RANGE SCAN, MATERIAL → TABLE FULL SCAN)` | 5 层递归、每层 `CHILD_1` / `CHILD_2`、混合算子 | — |
| `unknown-operator.synthetic` | `PX FUTURE SHUFFLE`（未登记算子） | `kind: unknown`、子树与未知键保留、`unknownNodeTypes` | — |
| `unknown-fields.synthetic` | `EXCHANGE OUT DISTRIBUTED` + 多种类型的未识别键 | string / number / boolean / array / object / null 未知键原样保留在 `extra`，不参与错误推断 | — |
| `missing-optional-fields.synthetic` | 缺 `ID` / `NAME` / `EST.ROWS` / `EST.TIME(us)` / `COST` | 缺失字段为 `null`；无 `OPERATOR` 的节点用占位标签 `Plan` 并保留子树；非对象 `CHILD_9: null` 保留在 `extra` | — |
| `child-order.synthetic` | `UNION ALL`，payload 顺序为 `CHILD_1` / `CHILD_10` / `CHILD_2` | 子节点按 `CHILD_n` 数字后缀排序（不是字典序）、支持多于两个子节点 | — |

`estimated/` 之外没有 `actual/` 目录：Host API 只提供 Estimated Plan，OceanBase Oracle 也没有本插件建模的
Actual Plan 形状。

## 边界条件

- 根对象**就是**根算子，没有 `Plan` / `query_block` 之类 envelope；payload 不是对象、或对象里既没有
  `OPERATOR` 也没有对象型 `CHILD_n` 时，parser fail closed（`MALFORMED_PLAN`）。
- 子节点来自 `CHILD_<n>` 成员，`<n>` 是算子在计划中的位置，不保证连续，也不保证字典序；parser 按数字后缀
  排序建树，并接受任意个子节点。
- `OPERATOR` 会被 trim（引擎会输出尾随空格，例如 `"HASH JOIN "`）。
- 未知算子不会丢节点、不会报 unsupported、也不会回退成 Raw-only；原始标签保留在 `nodeType`，
  并记录在 `normalized.unknownNodeTypes`。
- `EST.ROWS` / `EST.TIME(us)` / `COST` / `ID` 只接受有限 JSON number；类型不符时对应字段为 `null`，
  原始值保留在 `engineSpecific.extra`，不把字符串强转成数字。
- `EST.TIME(us)` / `COST` 保留在 `engineSpecific.oceanBase`，**不**映射到 `startupCost` / `totalCost`；
  Metrics 报告 `costAttribution.status = "not-applicable"`，本轮也不新增基于它们的代价 / 时间热点信号。
- 官方 JSON 示例与引擎 JSON plan writer 未覆盖的扩展键（`filter` / `access` / `range_key` / ...）一律保留在
  `engineSpecific.extra`，**不**提升为中立 `filter` / `indexCondition` / `sortKeys`，避免伪造计划未报告的谓词。
- 不放入任何包含真实生产数据、凭据或连接串的内容。
