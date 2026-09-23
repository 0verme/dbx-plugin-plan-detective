# Doris IR Gap Audit — Phase 3.6 Decision Gate

日期：2026-09-23。审计基于 Phase 3.6 分支 baseline `11820fc1c70dc03c6ccdc98406624374a3686b67` 与当前 `NormalizedPlan` / `tree.js` / Metrics / Rules / Hotspots / View Model 实现。Doris 源语义证据见 [DORIS_PLAN_CONTRACT_AUDIT.md](DORIS_PLAN_CONTRACT_AUDIT.md)。

## 当前 IR

现有 `NormalizedPlan` 是单一 `root: NormalizedNode` 的递归 tree；`children` 表示 operator tree edge。`walkNodes()` / `flattenNodes()` 包括 root 与所有 children；`depthOf()` 把每个 tree node 计入深度；Metrics 的 `nodeCount` 当前是扁平节点数。Rules、Hotspots、Plan Tree 和 Node Inspector 也遍历/呈现同一棵树。

Doris 的完整 EXPLAIN 包含多个独立 Fragment-local operator trees；Sink → Exchange 是 Fragment 之间的数据流 / DAG edge，不是 operator parent-child edge。直接把一个 Fragment root 接到另一个 Fragment 的 Exchange children 会伪造 operator 语义。

## 九项硬门槛

### 1. 当前 NormalizedPlan 是否必须仍保持单 root tree？

**是，保持现有 public `root` tree contract。** Parser 不引入第二套顶层 `fragments[]` IR，也不把 normalized plan 改成 DAG。

### 2. Doris 多 Fragment 是否可以安全映射进当前 tree model？

**可以，但只作为明确标记的 structural containment：**

```text
Doris Distributed Plan [structural]
├─ Fragment 0 [structural] → Fragment 0 local operator root
├─ Fragment 1 [structural] → Fragment 1 local operator root
└─ ...
```

Wrapper→Fragment / Fragment→local root 是 UI 可用的容器关系，不能解释为 Doris operator parent-child。每个 Fragment 的真实 operator children 只表示该 Fragment 内官方 EXPLAIN tree 证据。

### 3. Fragment 是否应该成为普通 NormalizedNode？

**否。** Fragment 使用 wrapper node 携带展示层级，但通过 `engineSpecific.structural: true` 标记为结构容器；它不伪装成 Doris operator，不进入 operator metrics 或 diagnostics。Fragment metadata 放在 `engineSpecific.doris`。

### 4. Exchange / Sink 跨 Fragment 关系是否需要表达成 tree edge？

**否。** local `VEXCHANGE` / `EXCHANGE` 是所在 Fragment 的真实 Plan Node；跨 Fragment 的 producer `STREAM DATA SINK` → receiver `EXCHANGE ID` 另存 `engineSpecific.doris.exchangeEdges`，含未匹配边与原始 ID 证据。Sink 只保存在 fragment metadata，不成为 tree node。

### 5. 不表达跨 Fragment DAG，是否仍能正确计算现有 Metrics？

**对当前确定性 tree Metrics 可以。** 遍历全部 Fragment-local 的真实 operator nodes 后，scan/join/sort/aggregate 计数与最大 cardinality 均可按 node 事实计算；`largestEstimatedRows` 不需要跨 Fragment edge。最大深度取所有 Fragment-local operator trees 的最大 operator depth。由于分布式计划没有唯一 operator root，Doris `rootEstimatedRows` 保持 `null`；cost 指标保持 `null` / `not-applicable`。不跨 Fragment 推断 join 输入或 rows flow，因此不对缺少局部估计的跨 Fragment Join 触发 Nested Loop heuristic。

### 6. synthetic structural root 会不会污染 Metrics / Finding / Hotspot？

当前未经扩展的实现会把 root 与 Fragment wrapper 计入 `nodeCount`、`maxDepth`；它们也可能被误当 unknown。虽然以 `kind: "structural"` 可避免 scan/join/sort/aggregate 的 kind 计数，但仅靠 kind 不足以建立通用排除语义。

Gate 要求采用可选、数据库中立 marker：

```js
engineSpecific.structural === true
```

增加 generic operator-only tree traversal：**继续递归访问 structural node 的 children，但 structural node 自身不作为 operator 项**。Metrics、Rules、Hotspots 使用 operator-only traversal；operator depth 忽略 wrapper 层；unknown type 集合不登记 wrapper。这样：

| 指标 / 诊断 | structural wrapper 行为 |
| --- | --- |
| `nodeCount` | 排除 wrapper；只数真实 Plan Node。 |
| `maxDepth` | 排除 wrapper 层；按 Fragment-local operator path 计。 |
| scan / join / sort / aggregate | wrapper 不计；继续遍历真实 operator descendants。 |
| `unknownNodeTypeCount` | wrapper 不加入 `unknownNodeTypes`。 |
| Finding / Hotspot | generic operator traversal 排除 wrapper；不会由 wrapper 产生规则或信号。 |

Plan Tree / Node Inspector 仍遍历所有 nodes，以显式展示 `Distributed Plan` / `Fragment N` containment 和 metadata；Node Inspector 消费通用 `engineSpecific.extra`，不新增 Doris-specific Svelte/component 分支。

### 7. 是否必须修改公共 NormalizedPlan contract？

**只需一个很小的 backward-compatible 扩展：是。** `NormalizedPlan` 顶层字段和既有 node fields 不变；规范化节点可选携带 `engineSpecific.structural: true`，其语义是“此节点是展示 / 结构容器，不是 operator”。既有数据库节点没有该标记，行为不变。此字段通用且不含 Doris 特判。

### 8. 是否必须修改 `tree.js` / `computeMetrics`？

**需要，且是泛化的最小修改。** 在 `tree.js` 新增 structural 判定与 operator-only traversal / operator depth helper；`compute-metrics.js` 改用 operator-only traversal / depth。Rules 与 Hotspots 也改用相同的通用 operator traversal，避免 wrapper 进入Finding/Hotspot。保留 `walkNodes` / `flattenNodes` 作为包含 wrappers 的完整 tree traversal，供 UI / inspector 使用。不得增加 `database === "doris"` 分支。

必须用完整现有 fixture/golden 回归及 metrics regression tests 证明 PostgreSQL、MySQL、SQL Server、OceanBase Oracle、Oracle、Dameng、QuestDB 的既有 `nodeCount`、`maxDepth`、scan/join/sort/aggregate/unknown counts 与所有其他 golden stage 不变。

### 9. UI 是否能不做 DAG Canvas 而表达 Doris？

**可以。** 保留现有 nested Plan Tree：`Distributed Plan` root → 每个 `Fragment N` 容器 → Fragment-local operator tree。容器标题/Inspector 明确标为 Structural / Fragment，避免被误读为 operator。根级 Inspector 显示 fragment count / exchange metadata；Fragment wrapper Inspector 显示 partition、output expressions、sink / sink exchange id / distribution / colocate marker。Node Inspector 通过通用 `engineSpecific.extra` / native properties fields 展示 operator 与 Fragment / Sink / Exchange evidence，不新增 Doris-specific component branch。跨 Fragment edge 以 Inspector metadata 列表展示，不绘制为 Plan Tree child edge，不建 DAG Canvas。

## Decision Gate

### 结论：`B — SMALL_IR_GAP`

- 采用现有单 root tree + structural distributed root + Fragment structural wrappers。
- Fragment-local operator trees保持真实 parent-child；Fragment 间 edge 只存 metadata。
- 加入通用、可选、向后兼容的 `engineSpecific.structural: true`。
- generic tree/metrics/rules/hotspots traversal 排除 wrapper 自身并继续递归 children。
- 不重构公共 IR 为 DAG，不引入 Doris 特判到 shared metrics，也不改变七个现有方言语义。

**Decision Gate 已在 parser 实施前通过；Phase 3.6 按 `B — SMALL_IR_GAP` 实现。** 如果实施中发现 cross-Fragment 准确分析必须重构 `NormalizedPlan` 为 DAG 或重写 Rules / Hotspots / Plan Tree 核心，立即停止并把本 Gate 改为 `C — DAG_REQUIRED`；不得在本 Feature PR 扩大 IR 重构。

## Gate 执行状态

`2026-09-23`：Generic structural marker / operator-only traversal 已落地；Doris structured parser 使用单 root + Fragment wrappers；Sink→Exchange 只进 `engineSpecific.doris.exchangeEdges` metadata。Doris parser、normalizer、registry、fixtures、goldens、generic Node Inspector / Plan Tree 测试已实现。完整多数据库 golden 回归与 build / PR 状态以根目录 `STATUS.md` 更新为准；本文件不宣称真实 Doris 或 Windows Host smoke。
