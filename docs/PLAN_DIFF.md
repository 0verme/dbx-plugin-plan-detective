# Estimated Plan Diff（Issue #73）

## 状态与边界

Issue #73 分为两个已交付部分：

- **Phase 73.1（PR #90，已合入 main）**：纯函数 `diffEstimatedPlans(baseline, current)`，实现于 `src/core/diff/estimated-plan-diff.js`。
- **Phase 73.2（本分支）**：展示报告 `buildEstimatedPlanDiff()`、快照基线选择流程、比较视图与实际 DOM 回归。

Core 只消费当前 Plan Core 已经产生的 structured analysis，不获取或重跑计划，不访问 DBX、数据库、Storage、网络或 DOM。比较 UI 只读取当前会话 / 历史快照，不会重新执行 SQL，也不会写 Storage。

当前仅支持 **PostgreSQL ↔ PostgreSQL** 和 **Native MySQL ↔ Native MySQL** 的完整 JSON Estimated structured plan。OceanBase MySQL 不会被当作 Native MySQL。其他方言、Actual、truncated、raw-only、分析失败、尚未完成的 session、非 JSON format 均不进入语义比较。输入可以是 `analyzeRawPlan()` / strict `analyzePlan()` 的结果、Host analysis session、snapshot session，或 `createPlanSnapshotView()` 返回对象中的 session；Core 不接受未经当前 Core 分析的 raw payload。

## 入口与职责

| 入口 | 职责 |
| --- | --- |
| `describeEstimatedPlanDiffSupport(input)` | 只读门禁：数据库、`format === "json"`、`mode === "estimated"`；返回 `{supported, reasonCode, database}`，用于 UI 决定是否显示比较入口。 |
| `diffEstimatedPlans(baseline, current)` | 一对一保守匹配、字段变化、unmatched / ambiguous；不生成任何 UI 文案。 |
| `buildEstimatedPlanDiff({baseline, current, baselineMeta?, currentMeta?})` | 在匹配结果之上组合可比性、分组变化、节点集合和 Findings / Hotspots 关联；输出 JSON-serializable 报告。 |
| `PlanDiffView.svelte` | 只负责展示报告与两侧计划树，不重新匹配，不重新分析。 |

`src/core/index.js` 导出 `diffEstimatedPlans`、`describeEstimatedPlanDiffSupport`、`readPlanAnalysis`、`buildEstimatedPlanDiff` 与 `DIFF_GROUP_ORDER`。

## Diff Core 结果契约

可比较输入返回：

```js
{
  status: "comparable",
  database: "postgresql" | "mysql",
  matches: [{
    beforeId, afterId,       // 各自计划中的 locator，不是身份依据
    evidence: { method, reason },
    changes: [{ field, before, after }]
  }],
  unmatched: {
    baseline: [{ id, reasonCode }],
    current: [{ id, reasonCode }]
  },
  ambiguous: [{
    beforeIds, afterIds, reasonCode, evidence: { method }
  }]
}
```

不兼容输入返回 `status: "incompatible"`、稳定 `reasonCode` 和空的匹配集合。原因码包括 `INVALID_ANALYSIS`、`ANALYSIS_NOT_READY`、`ANALYSIS_NOT_STRUCTURED`、`ANALYSIS_FAILED`、`PLAN_TRUNCATED`、`RAW_ONLY`、`INVALID_NORMALIZED_PLAN`、`DATABASE_MISMATCH`、`UNSUPPORTED_DATABASE`、`UNSUPPORTED_FORMAT`、`MODE_NOT_ESTIMATED`。

字段变化只记录明确字段的前后值：operator kind / nodeType、relation / schema / alias / index、estimated rows、filter / join / index condition、sort / group keys，以及 MySQL 的 `engineSpecific.mysql.message`。缺失值保持 `null`，不按 0 计算；`null` 与 `0` 不会被视为相同或可相减。文本变化只表示文本不同，不证明 SQL 语义变化。

## 展示报告契约

`buildEstimatedPlanDiff()` 返回：

```js
{
  status: "comparable" | "incompatible",
  reasonCode,
  database,
  sides: {
    baseline: { kind, id, title, savedAt, capturedAt, producerVersion,
                databaseVersion, source, sql, nodeCount,
                rootEstimatedRows, rootTotalCost },
    current: { ... }
  },
  comparability: {
    status: "comparable" | "limited",
    reasons: [{ code, level, baseline, current }],
    cost: { status: "available" | "withheld", reasonCode, unit, baseline, current }
  },
  summary: { matched, changed, unchanged, added, removed, unmatched, ambiguous, categoryCounts },
  totals: { baseline: { nodeCount, rootEstimatedRows, rootTotalCost }, current: { ... } },
  groups: {
    access: [...], index: [...], join: [...], sort: [...], aggregate: [...],
    rows: [...], predicate: [...], relation: [...], operator: [...],
    message: [...], other: [...]
  },
  matches: [{ ...coreMatch, before: nodeSummary, after: nodeSummary }],
  nodes: {
    added: [...], removed: [...],
    unmatched: { baseline: [...], current: [...] },
    ambiguous: [...]
  },
  diagnostics: {
    status: "available" | "unavailable",
    reasonCode,
    findings: { added, resolved, evidenceChanged, unchanged, unlinked: { baseline, current } },
    hotspots: { added, resolved, evidenceChanged, unchanged, unlinked: { baseline, current } }
  }
}
```

每个 group entry 都带 `beforeId` / `afterId`、两侧节点摘要、匹配 evidence、变化字段和原始值；`rows` group 额外提供 `rowsDelta`，但只在两侧都为有限数值时计算，否则为 `null`。`DIFF_GROUP_ORDER` 是固定展示顺序，未知类别追加到末尾。

### 新增 / 消失的保守判定

`added` / `removed` 只有在以下情况才成立：

1. 节点有可靠的、已匹配的后代作为锚点，且对侧没有被匹配后代的 **相同签名**；或
2. 扫描节点的 relation name 在对侧完全不存在（视为新 / 消失 relation scan）。

其余情况进入 `unmatched`，`ambiguous` 中的节点不会同时被宣称为新增或消失。实现使用匹配后的 `beforeId>afterId` 对键，计算子树内已匹配后代签名；这避免“给 Join 增加一个子扫描”时把仍然存在的 Join 根节点误报为 removed。

### 可比性

- 数据库版本未知或不同：`DATABASE_VERSION_UNKNOWN` / `DATABASE_VERSION_MISMATCH`，`comparability.status = "limited"`。
- 来源上下文未知或不同：`SOURCE_CONTEXT_UNKNOWN` / `SOURCE_CONTEXT_MISMATCH`，同样为 `limited`。
- SQL 文本未知：`SQL_TEXT_UNKNOWN`（info）；SQL 文本不同：`SQL_TEXT_DIFFERS`（info）。文本差异不会自动被解释为语义变化。
- 成本只在两侧都是 PostgreSQL 有限原生 cost 时显示 `unit: "postgresql-native"` 的原值，不计算差值、百分比、提速率或性能评分。MySQL 返回 `COST_MODEL_NOT_DIFFED`；PostgreSQL 缺值返回 `COST_MISSING`。两者都是 `withheld`，不会用 0 补齐。
- 未知值始终显示为未知，不会变成 `0`、相同值或伪造匹配。

## 保守匹配

1. **Relation scan**：先按 relation name + alias + 可用 schema evidence 的精确组合匹配，要求两侧均唯一；PostgreSQL `Schema` 从 `engineSpecific.extra` 读取，MySQL V2 `schema_name` 从 `engineSpecific.mysql.schemaName` 读取。PostgreSQL 的独立 `InitPlan` / `SubPlan` 边界及 `Subplan Name` 会作为其后代 scan 的身份上下文；普通 `Outer` / `Inner` 不进入该上下文，以允许 Join 输入换序。MySQL 的 query block 与 set operation 也会作为后代身份上下文（结构名 + 可用 `select_id`），因此 relation scan 在顶层 query block、attached / optimized-away / materialized 子查询之间移动时不会跨 scope 配对。schema 或独立子计划上下文不同、或仅一侧提供 schema 时不会跨上下文配对；schema 与上下文相同且 alias 不同时，只在两侧剩余该上下文下的 relation occurrence 均恰好一个时 fallback。不把 operator kind 或 index name 当身份，因此 Seq Scan → Index Scan、Index → 另一索引可以继续匹配。
2. **Repeated table / self-join**：稳定且唯一的 alias 可区分 occurrence；重复且相同的 relation identity 或多个 alias 同时变化时输出 `ambiguous`。不会按数组顺序、路径、cost 或 rows 拆分。
3. **Operators**：按 operator family + 已匹配、带 relation identity 的 descendant scans 无序集合匹配，集合对 Join child reorder 稳定，并允许 Nested Loop / Hash Join / Merge Join 算法变化；Sort / Incremental Sort 也共享一个 family。含 relation scan 的 identity（包括 scan 根节点）还纳入其后代独立 `InitPlan` / `SubPlan` 的 role/name 与语义子树 fingerprint，以及 MySQL 独立子查询 / set operation branch 的结构、`select_id` 与语义子树 fingerprint；因此同一主查询 scan 旁或直接挂在 scan 下的独立子计划 / subquery branch 改变角色或 context 时，即使 relation scan 仍可唯一匹配，也不会因 scan token 未变而错误配对 ancestor。PostgreSQL `Bitmap Index Scan` 没有独立 relation identity；仅当它在两侧各自是同一个已匹配 `Bitmap Heap Scan` 下唯一的此类后代时，才借父 heap relation 配对并报告 index / condition 变化。独立的匿名 scan（如 Function Scan）会使祖先 identity fail closed。该 subtree identity 必须唯一，才建立一对一匹配。
4. **No-scan subtree**：只有当 subtree 中没有 scan 时，才可用精确语义 subtree fingerprint；排除 node id、rows、cost、index name 和无关 engine-specific evidence，但纳入 available relation schema，并递归纳入 PostgreSQL 每个节点继承的独立 `InitPlan` / `SubPlan` role 与 `Subplan Name`，以及 MySQL 每个节点继承的 query block / subquery / set operation scope（结构名 + 可用 `select_id`）。MySQL 的 optimizer `message` 不参与 fingerprint：fingerprint 相同的 scan-free Query Block 仍可配对，但 message 差异会作为字段变化输出。重复 fingerprint 不按兄弟顺序配对；只有两侧均有候选时才报告歧义，单侧重复节点保留为 unmatched。
5. 没有可识别 relation scan 锚定、descendant relation scan 未匹配、重复候选或不完整结构会留下 `unmatched` / `ambiguous`；不会猜测一对多或多对一关系。

路径式 `NormalizedNode.id` 仅用于输入树定位与结果引用，不参与 identity。结果顺序确定，但排序也不作为配对依据。

## Findings / Hotspots 关联

诊断只通过**已匹配节点**关联：

- `added`：诊断出现在 current 侧的已匹配节点，baseline 侧不存在。
- `resolved`：诊断出现在 baseline 侧的已匹配节点，current 侧不存在。
- `evidenceChanged`：两侧同一 rule / reason code 存在，但稳定字段（status、message、evidence 等）变化。
- `unchanged`：两侧都存在且稳定字段相同。
- `unlinked`：诊断所在节点没有可靠匹配，或诊断无法绑定到匹配对；分别列出 baseline / current，不推断为 added / resolved。

诊断不可用时整块标记 `DIAGNOSTICS_UNAVAILABLE`，不会显示伪造的零差异。

## UI 用户闭环

1. 用户分析当前 SQL，或在历史快照中打开任意一条记录。
2. 在 `SnapshotManager` 中把一条快照设为基线；基线栏显示标题，并提供“与当前计划比较”。
3. 对另一条历史快照点击“与基线比较”，或对当前打开的快照点击比较按钮。
4. `App` 创建独立的 `diffState`，不替换 `session` / `activeSnapshot`；`PlanDiffView` 渲染两侧计划树、节点比较表、按 category 分组的变化、added / removed / unmatched / ambiguous、Findings / Hotspots 差异。
5. 点击变化项会同时聚焦 / 展开两侧节点；“Swap sides”交换 A/B；“Exit comparison”返回原视图。
6. 比较过程不调用 Host `explainPlan`，不重新执行 SQL，不写 Storage。当前 / 基线快照被删除或输入失效时，比较状态被清理。

两侧都使用当前 Core 重新分析快照的 RawPlanInput；因此快照比较反映的是“当前 Core 对两份已保存输入的解释”，不是历史 Core 的旧输出。

## 验证与边界

- `tests/core/estimated-plan-diff.test.js`：底层匹配、歧义、unmatched、兼容性拒绝与 fixture 覆盖。
- `tests/core/plan-diff-report.test.js`：报告契约、确定性、JSON round-trip、成本 / 版本 / 来源可比性、诊断关联、新增 / 消失守恒、无性能声明。
- `tests/ui/plan-diff-workflow.test.js`：静态接线与文案门禁。
- `tests/ui/snapshot-dom.test.js`：在 Chromium + DBX 风格 opaque sandbox 中实际点击基线、比较当前 / 历史快照、交换、退出、空差异、删除基线与中英文文案。
- `fixtures/diff/` 的 PostgreSQL / Native MySQL 计划均为 synthetic，不是真实 capture、真实数据库验证或真实性能提升证据。

Node / DOM 测试不等同于真实 DBX Desktop 验收。当前环境没有可用的真实 DBX Desktop 会话，因此 Issue #73 的真实桌面端到端验收仍 **NOT VERIFIED**；测试证明的是用户可以在这套 UI 中看到 A/B diff，而不是证明任何真实查询变快。
