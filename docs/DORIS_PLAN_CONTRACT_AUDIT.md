# Doris Estimated Plan Contract Audit

审计日期：2026-09-23。证据来自 Apache Doris 官方 4.x 文档；官方文档转录不是 Doris 实例 capture。来源、更新时间与 provenance 见 [fixtures/doris/README.md](../fixtures/doris/README.md)。

## 官方结构模型

```text
PLAN
└─ PLAN FRAGMENT*              distributed execution units
   ├─ fragment metadata        PARTITION / HAS_COLO_PLAN_NODE / OUTPUT EXPRS
   ├─ SINK                     fragment output descriptor, not a Plan Node
   └─ local Plan Node tree     operator tree; EXCHANGE is a local operator
```

Doris 官方 EXPLAIN 文档明确区分：`PLAN` 是完整计划；`FRAGMENT` 是分布式计划拆出的单节点执行片段；`PLAN NODE` 是 Fragment 内最小 operator。多个 Fragment 组成完整 PLAN。计划与 Fragment/operator 的行序按执行 sequence 展示，不应据 operation id 的数值或展示顺序推断 parent。

官方示例说明 operator 通过虚线连到 children；一个 operator 的多个 children 垂直排列且按 right-to-left 表示。官方例子中 `6:VHASH JOIN` 为 parent，operation `5:VEXCHANGE` 是 left child，`4:VEXCHANGE` 是 right child。恢复 Fragment-local tree 必须把 operator line、branch glyph（`|` / `|----`）、相对列位置与节点身份信息一起考虑；仅按普通空格缩进或 operation id 排序不构成可靠 parser。

## Fragment、Sink、Exchange

- `PLAN FRAGMENT` 是结构边界，不是 operator。
- `VRESULT SINK` / `RESULT SINK` 把结果送回 FE；`STREAM DATA SINK` 把数据送到 downstream Fragment；这些 sink descriptor 不是普通 Plan Node。
- `STREAM DATA SINK` 的 `EXCHANGE ID` 指向接收侧 Exchange；partition / distribution（例如 `UNPARTITIONED`、`RANDOM`、`HASH_PARTITIONED`）是数据路由证据。
- Fragment 间是 distributed data-flow / DAG 关系。SINK → EXCHANGE 关系作为 `engineSpecific.doris.exchangeEdges` metadata 保留，不能伪装成 `NormalizedNode.children`。
- 接收侧 `VEXCHANGE` / `EXCHANGE` 仍是它所在 Fragment 的真实 Plan Node，可在其本地 operator tree 中展示；它的 producer Fragment 不是它的 children。
- Pipeline 是 BE 内 Fragment 的另一层执行 pipeline/task 结构。当前 Estimated EXPLAIN parser 只解析 EXPLAIN 输出里的 Fragment 与 Plan Node，不尝试推断 runtime Pipeline DAG、PipelineTask 或 Profile。

## 可提升和必须保留的属性

| Doris text evidence | 处理边界 |
| --- | --- |
| `cardinality` | 官方定义为 optimizer estimated row count；严格解析为有限、非负 numeric value 时可映射 `estimatedRows`，同时保留 Doris 原值。未知 / 非法 / 负值格式为 `null`，不猜。 |
| Scan `TABLE` | 仅在明确 Scan operator/property 组合中映射 relation；原始 TABLE 保留。 |
| `avgRowSize` | 官方称 optimizer estimated average row size，但文档没有明确公共单位 / 各 operator 的通用适用范围；保留 `engineSpecific.doris.avgRowSize`，不映射共享 `width`。 |
| `PREAGGREGATION`、partitions、tablets、tabletList、numNodes | 保留原始/解析属性作为 Doris evidence；本轮不增加启发式诊断。 |
| join op / predicates / runtime filters / projections / group by / order by / limit / offset / outputs / distribute expr lists | 在所属真实 operator 上识别必要字段并完整保留 raw property；未来未知属性也保留，不报错。 |
| cost | 官方 text contract 不提供与 PostgreSQL NormalizedPlan 等价的公共累计 cost；`startupCost` / `totalCost` 保持 `null`，归因 `not-applicable`。 |

## Operator 归一化边界

- `OlapScanNode`、`VOlapScanNode`、`HIVE_SCAN_NODE`、`HUDI_SCAN_NODE`、`ICEBERG_SCAN_NODE`、`PAIMON_SCAN_NODE`、`JdbcScanNode`、`EsScanNode` 等可确认的 relation access 保守映射为中性 `scan`，不映射 `seq_scan`，不推导 `index_scan`。由此不触发 `large-sequential-scan`。
- Hash / Nested Loop Join 可映射为共享 join kinds；`joinType` 与 Doris `joinStrategy` / distribution 保持分离。`BROADCAST` / `PARTITIONED` / `BUCKET_SHUFFLE` / `COLOCATE` 等不折叠进 join type。
- Aggregate、Analytic、Sort / Top-N、Select、set operators、Exchange 等仅在名称与证据明确时映射；未知 operator 保留原始 label、properties、children，并作为 unknown operator。
- Fragment、Sink 与 synthetic wrappers 不是 Plan Node，不计 operator metrics、unknown count、Finding 或 Hotspot。

## 失败边界

Fail-soft：未知 operator / property / sink / distribution、缺失可选 cardinality / TABLE、未识别的新字段；原文与扩展属性均保留。Host 已声明截断、空计划、完全没有可解析 Fragment/Plan Node、严重损坏的 Fragment 结构或无法构成合法 Fragment-local branch tree 时 fail-closed。文档转录中的省略段（若用作 fixture）须清楚标注为 official excerpt，不得冒充完整真实计划。

## Decision

```text
Doris distributed plan model: one structural tree root + one structural Fragment wrapper per fragment
Fragment-local operator edges: NormalizedNode.children
Cross-fragment SINK → EXCHANGE: engineSpecific metadata edge only
Cost / width: not mapped without reliable shared semantics
Estimated-only: retained
```

对共享 IR 的影响由 [DORIS_IR_GAP_AUDIT.md](DORIS_IR_GAP_AUDIT.md) 判定；Decision Gate 为 `B — SMALL_IR_GAP`。
