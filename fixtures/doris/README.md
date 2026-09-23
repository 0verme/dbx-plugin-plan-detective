# Doris Estimated Plan fixtures 与 provenance

本目录服务 Phase 3.6 Doris Estimated text Plan parser。所有 source provenance 必须区分 `official`、`synthetic`、`locally-generated`；官方文档转录不是 Doris 实例 capture，不能填写虚构的数据库版本、capture 时间、命令或 SQL。

## 官方文档证据

审计时读取 Apache Doris 官方 4.x 文档（官网 sitemap 将这些页面列为当前 4.x 文档）：

1. **EXPLAIN**：<https://doris.apache.org/docs/4.x/sql-manual/sql-statements/data-query/EXPLAIN/>（页面标注 last updated 2025-12-22）。
   - `PLAN` 是完整执行计划，`FRAGMENT` 是分布式执行计划划分出的单节点执行片段，`PLAN NODE` 是 Fragment 内 operator；多个 Fragment 组成完整 PLAN。
   - EXPLAIN 结果可能按执行次序从 back-to-front 显示。虚线表示 operator→child；多子节点垂直排列并按 right-to-left 表示。官方样例说明 `6:VHASH JOIN` 的 left child 是 operation `5:VEXCHANGE`、right child 是 operation `4:VEXCHANGE`。
   - `STREAM DATA SINK` 给出下游 EXCHANGE 与 distribution；`VRESULT SINK` 将结果返回 FE。SINK 是 Fragment output descriptor，不是普通 Plan Node。
   - `cardinality` 定义为 optimizer estimated row count，可在值可靠时映射为 `estimatedRows`。Scan 节点的 `avgRowSize` 定义为 optimizer estimated average row size，但文档没有给出明确共享单位，因此只保留 Doris-specific。
   - 文档列有 operator 与属性，包括 TABLE / PREAGGREGATION / partitions / tablets / tabletList / numNodes、join fields、runtime filters、conjuncts、projections、group by、order by、limit / offset、output、distribute expr lists 等。
2. **MPP Architecture**：<https://doris.apache.org/docs/4.x/key-features/mpp/>（页面标注 last updated 2026-05-11）。
   - FE 产生 PlanFragment DAG 并调度到 BE；Fragment 间通过接收侧 ExchangeNode 与发送侧 DataStreamSink 传递数据。Distribution mode 描述网络 shuffle，不是 SQL join type。
3. **Pipeline Execution Engine**：<https://doris.apache.org/docs/4.x/key-features/pipeline-execution-engine/>（页面标注 last updated 2026-05-10）。
   - PlanFragment 在 BE 内进一步拆成 Pipeline DAG / PipelineTasks。该运行时层与 EXPLAIN 展示的 Fragment/local Plan Node 不是同一结构；本插件不解析 runtime Profile，也不构造 Pipeline DAG。
4. **Pipeline Execution Engine (query-acceleration detail)**：<https://doris.apache.org/docs/4.x/query-acceleration/optimization-technology-principle/pipeline-execution-engine/>（页面标注 last updated 2026-05-17）。
   - 进一步说明物理计划通过 DataSink / ExchangeNode 切分到 Fragment；Fragment 包含 PlanNodes，并作为独立任务发往 BE。

上述内容是官方结构契约证据，不表示计划文本在真实 Doris 环境中采集或验证。Doris 计划可能随版本、planner、表类型和查询形状变化；所有未验证属性均保留 raw evidence 并 fail-soft。

## 树与分布式关系

```text
PLAN
├─ PLAN FRAGMENT N
│  ├─ fragment metadata
│  ├─ sink metadata (not operator)
│  └─ Fragment-local Plan Node tree
└─ ...

producer STREAM DATA SINK → consumer EXCHANGE ID
  = cross-fragment metadata edge, never NormalizedNode.children
```

Fragment wrapper / synthetic distributed root 是结构容器，不是 Doris Plan Node；Sink 不归一化成 operator。接收侧 `VEXCHANGE` / `EXCHANGE` 若出现在 EXPLAIN 的 local Plan Node tree 中，仍作为该 fragment 的真实 Plan Node。节点 parent-child 以 branch glyph 与相对布局恢复，不根据 operation id 数值排序或推断 parent。

## 估值边界

- `cardinality` 可映射到 shared `estimatedRows` 的前提是严格解析为有限数值；同时原字段存入 `engineSpecific.doris.cardinality`。不可靠时为 `null`。
- 暂不将 `avgRowSize` 映射为 `width`：官方定义为平均行大小估值，但缺少足以证明共享单位 / 通用适用范围的证据。
- Doris cost 不映射为 PostgreSQL `startupCost` / `totalCost`；`costAttribution.status = not-applicable`。不计算 self-cost / incremental cost / cost share。
- 扫描映射为中性 `scan`，不伪装 `seq_scan` 或 `index_scan`；不据此触发 `large-sequential-scan`。
- 保留 BROADCAST / PARTITIONED / BUCKET_SHUFFLE / COLOCATE 等 join strategy/distribution，以及 partitions/tablets/preaggregation/runtime filters/numNodes 等 evidence；本轮不新增 Doris-specific heuristics。
- 全链路仅处理 Host `mode: estimated` 的 `EXPLAIN`；不处理 ANALYZE、PROFILE 或 runtime profile。

## Fixture 分类与真实测试声明

- `official`：官方 Apache Doris 文档中的计划示例或语义转录，必须引用 URL；不属于真实数据库捕获，capture metadata 全为 `null`，detail 明确说明未本地执行。
- `synthetic`：人工构造的最小文本，不声称经 Doris 执行；文件名带 `.synthetic`，capture metadata 全为 `null`。
- `locally-generated`：若未来加入真实 Doris Host capture，必须记录真实服务器版本、采集日期、EXPLAIN 命令与 SQL。

当前环境没有 Doris + Windows DBX：`Real Doris: NOT AVAILABLE`；`Host Smoke: NOT RUN`。现有五个 fixture 为一个官方文档转录与四个人工 synthetic；不得把文档、synthetic fixture 或 DBX upstream viewer test 写成真实 Doris smoke。

## Fixture 清单

- `estimated/distributed-hash-join.plan.txt`：Apache Doris EXPLAIN 文档的多 Fragment 哈希 Join 示例；文档框架表格外围已去除，其 inner plan text 保留。Capture metadata 为 `null`。
- `estimated/branch-order.synthetic.plan.txt`：branch glyph、多层树、右到左 child 顺序与未知 operator。
- `estimated/exchange-link.synthetic.plan.txt`：跨 Fragment `STREAM DATA SINK` / `EXCHANGE ID` metadata edge。
- `estimated/operator-mapping.synthetic.plan.txt`：SORT / AGGREGATE / SELECT / OlapScanNode 共享 kind 与属性映射。
- `estimated/unknown-properties.synthetic.plan.txt`：未知 / 非数字 cardinality、avgRowSize 与 forward properties 保留。
