# SQL Server Fixtures

本目录存放 SQL Server ShowPlanXML 执行计划的**离线样本**，作为 Parser、Normalizer、Metrics、
Rule Engine 与 UI 的一等开发与测试输入。

> **当前状态：14 个 `estimated/` fixture + 对应 golden，已接入结构化 pipeline。**
> SQL Server 的 Estimated Plan 由 DBX Host 以 ShowPlanXML（`format: "xml"`）返回；
> Plan Detective 只消费 Host 返回的 XML，不建立连接、不执行 `SET SHOWPLAN_XML`。
> 契约见 [docs/PLAN_INPUT_AND_FIXTURES.md](../../docs/PLAN_INPUT_AND_FIXTURES.md) 第 4.3 节。

目录、metadata sidecar、provenance 标记与 Golden Test 约定与 PostgreSQL / MySQL 相同，见
[docs/PLAN_INPUT_AND_FIXTURES.md](../../docs/PLAN_INPUT_AND_FIXTURES.md) 第 7 节。

## Provenance（重要）

本仓库与审计环境**没有 SQL Server 实例**，也没有可提交的真实 ShowPlanXML 采集样本。
因此**所有 SQL Server fixture 都是 synthetic**：人工构造、文件名带 `.synthetic`、
`databaseVersion` / `capturedAt` / `captureCommand` / `sql` 均为 `null`。

为避免"凭记忆写 parser"，每个 fixture 的元素层级与属性名都对照了公开的 ShowPlanXML 规范与文档：

- ShowPlanXML 命名空间与 schema：`http://schemas.microsoft.com/sqlserver/2004/07/showplan`
  （`ShowPlanXML` / `BatchSequence` / `Batch` / `Statements` / `StmtSimple` / `QueryPlan` / `RelOp`
  层级与属性名）；
- [Display an Actual Execution Plan](https://learn.microsoft.com/en-us/sql/relational-databases/performance/display-an-explained-execution-plan)
  （`RelOp` 的 `PhysicalOp` / `LogicalOp` / `EstimateRows` / `EstimateCPU` / `EstimateIO` /
  `AvgRowSize` / `EstimatedTotalSubtreeCost` / `Parallel`，`Object` 的 `Database` / `Schema` /
  `Table` / `Index` / `Alias` / `IndexKind` / `Storage`）；
- [Showplan Logical and Physical Operators Reference](https://learn.microsoft.com/en-us/sql/relational-databases/showplan-logical-and-physical-operators-reference)
  （`NestedLoops` / `Hash` / `Merge` / `Sort` / `StreamAggregate` / `ComputeScalar` / `Filter` /
  `Concat` / `Parallelism` / `IndexScan` / `TableScan` / `Top` 的子结构与 `SeekPredicates` /
  `OrderBy` / `GroupBy` / `HashKeysBuild` / `HashKeysProbe` 形状）。

表名、行数与 cost 数值是合成测试数据，不是生产数据，也**未在真实 SQL Server 实例上回放**。
`source.reference` 指向上述公开文档。若后续获得真实采集样本，应新增 `locally-generated`
fixture，而不是修改本目录的 synthetic 声明。

## Fixture 列表

| fixture | 场景 | 覆盖点 | 触发规则 / 热点 |
| --- | --- | --- | --- |
| `table-scan.synthetic` | 堆表全表扫描 + 谓词，250 000 行 | `Table Scan`、`Object` 无 `Index`、`Predicate` | `large-sequential-scan`（high）+ 热点 |
| `index-seek.synthetic` | 聚簇索引单行 seek | `Clustered Index Seek`、`SeekPredicates` / `Prefix(EQ)` | — |
| `index-scan.synthetic` | 非聚簇索引全扫描，150 000 行 | `Index Scan`、`IndexKind: NonClustered` | 热点 `sqlserver-large-index-scan`（high） |
| `key-lookup.synthetic` | Key Lookup + 内层 Index Seek | `Lookup="1"`、`IndexScan` 内的嵌套 `RelOp` | — |
| `nested-loops.synthetic` | 小结果集 inner join | `NestedLoops`、`OuterReferences`、`EstimateRebinds` | — |
| `nested-loops-large-inner.synthetic` | 外层 1 000 行 × 内层 50 000 行 | 大内层估算、`StartRange` seek | `nested-loop-large-inner`（warning）+ 热点 |
| `hash-match.synthetic` | Hash Match inner join | `Hash`、`HashKeysBuild` / `HashKeysProbe` / `ProbeResidual` | — |
| `merge-join.synthetic` | Merge Join + 残差谓词 | `Merge`、`ManyToMany`、`Residual`、`StartRange` + `EndRange` | — |
| `sort.synthetic` | 排序 120 000 行（并行 gather） | `Sort`、`OrderBy` ASC/DESC、`Parallelism` | 热点 `sqlserver-sort`（high）+ `sqlserver-large-index-scan`（high） |
| `stream-aggregate.synthetic` | 分组聚合 | `StreamAggregate`、`GroupBy`、`DefinedValue` / `ScalarOperator` | — |
| `compute-scalar-filter.synthetic` | 过滤器 + 计算列（三层） | `ComputeScalar`、`Filter`（`Predicate` 位于输入之后）、`DefinedValues` | — |
| `unknown-operator.synthetic` | 未知 `PhysicalOp` | `Future Shuffle` → `unknownNodeTypes`，子树与未知属性保留 | — |
| `minimal-fields.synthetic` | 缺 `EstimateRows` / cost / `Object` | `Constant Scan`、`Filter`，graceful degradation | — |
| `top-concatenation.synthetic` | Top 10 over Concatenation | `Top` / `RowCount`、`Concat`、两个索引访问 | 两个 `sqlserver-large-index-scan`（high） |

`estimated/` 之外没有 `actual/` 目录：Host API 只提供 Estimated Plan，`RunTimeInformation` /
`QueryTimeStats`（Actual 专属元素）会使 parser 抛 `MODE_MISMATCH`。

## 边界条件

- Parser 按 local name 匹配元素，不依赖 namespace 前缀；默认命名空间与带前缀的元素均可解析。
- `EstimatedTotalSubtreeCost` 是**子树累计代价**；`EstimateCPU` / `EstimateIO` 是节点自身估算。
  本轮不把任何 SQL Server 代价映射到 NormalizedPlan 的 `startupCost` / `totalCost`，也**不**用
  父子相减推算 self cost；代价只作为 engineSpecific 证据展示。Metrics 报告
  `costAttribution.status = "not-applicable"`。
- 一个 ShowPlanXML 中存在多个带 `QueryPlan` 的 `StmtSimple` 时 parser fail closed
  （`MULTIPLE_STATEMENTS`），不无声只取第一条。
- 未知 operator 保留节点、原始 `PhysicalOp` / `LogicalOp` 与完整子树；不会因不认识而丢弃。
- 缺失 `EstimateRows` / cost / `Object` / `Predicate` 时对应字段为 `null`，不会导致整树解析失败。
- 不放入任何包含真实生产数据、凭据或连接串的内容。
