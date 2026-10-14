# Estimated Plan Diff Core（Issue #73 Phase 73.1）

## 状态与边界

Phase 73.1 新增纯函数 `diffEstimatedPlans(baseline, current)`，实现位置为 `src/core/diff/estimated-plan-diff.js`，并从 `src/core/index.js` 导出。它只消费同一当前 Plan Core 已经产生的 structured analysis，不获取或重跑计划，不访问 DBX、数据库、Storage、网络或 DOM。

本阶段**没有交付比较 UI、快照选择流程或 Desktop 验收**。真实 DBX Desktop 不可用；Issue #72 的 Storage 持久化、权限、重启恢复、多窗口均仍 **NOT VERIFIED**。Issue #73 仍 OPEN。

当前仅支持 **PostgreSQL ↔ PostgreSQL** 和 **Native MySQL ↔ Native MySQL** 的完整 JSON Estimated structured plan。OceanBase MySQL、其他方言、Actual、truncated、raw-only、分析失败、尚未完成的 session、非 JSON format 均不进入语义比较。输入可以是 `analyzeRawPlan()` / strict `analyzePlan()` 的结果、Host analysis session、snapshot session，或 `createPlanSnapshotView()` 返回对象中的 session；Diff Core 不接受未经当前 Core 分析的 raw payload。

## 结果契约

可比较输入返回 JSON-serializable 对象：

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

不兼容输入返回 `status: "incompatible"`、稳定 `reasonCode` 和空的匹配集合。当前原因码包括 `INVALID_ANALYSIS`、`ANALYSIS_NOT_READY`、`ANALYSIS_NOT_STRUCTURED`、`ANALYSIS_FAILED`、`PLAN_TRUNCATED`、`RAW_ONLY`、`INVALID_NORMALIZED_PLAN`、`DATABASE_MISMATCH`、`UNSUPPORTED_DATABASE`、`UNSUPPORTED_FORMAT`、`MODE_NOT_ESTIMATED`。

Node changes 只记录明确字段的前后值：operator kind / label、relation / alias / index、estimated rows、filter / join / index condition、sort / group keys。缺失值保持 `null`，不按 0 计算。成本字段目前不进入 Diff 输出，因为纯 Core 输入没有足够的数据库版本 / 来源 / optimizer context 来声明成本可比；也不计算差值、百分比、总体优化率、提速率或性能评分。MySQL cost 保持在引擎专属 evidence，`startupCost` / `totalCost` 仍为 `null`，Diff 不会伪造 PostgreSQL cost。文本变化只表示文本不同，不证明 SQL 语义变化。

## 保守匹配

1. **Relation scan**：先按 relation name + alias 的精确组合匹配，要求两侧均唯一；不把 operator kind 或 index name 当身份，因此 Seq Scan → Index Scan、Index → 另一索引可以继续匹配。若 alias 不同，只在两侧剩余的该 relation occurrence 均恰好一个时按 relation name fallback。
2. **Repeated table / self-join**：稳定且唯一的 alias 可区分 occurrence；重复且相同的 relation identity 或多个 alias 同时变化时输出 `ambiguous`。不会按数组顺序、路径、cost 或 rows 拆分。
3. **Operators**：按 operator family + 已匹配 descendant scans 的无序集合匹配，集合对 Join child reorder 稳定，并允许 Nested Loop / Hash Join / Merge Join 算法变化；Sort / Incremental Sort 也共享一个 family。该 subtree identity 必须唯一，才建立一对一匹配。
4. **No-scan subtree**：只有当 subtree 中没有 scan 时，才可用精确语义 subtree fingerprint；排除 node id、rows、cost、index name 与 engine-specific evidence，保留 child order。重复 fingerprint 不按兄弟顺序配对。
5. 无可靠 identity、descendant scan 自身未匹配、重复候选或不完整结构会留下 `unmatched` / `ambiguous`；不会猜测一对多或多对一关系。

路径式 `NormalizedNode.id` 仅用于输入树定位与结果引用，不参与 identity。结果顺序确定，但排序也不作为配对依据。

## Fixtures 与验证边界

`fixtures/diff/` 有 PostgreSQL 与 Native MySQL 各一组修改前 / 修改后 synthetic JSON plan 与 metadata sidecar：都描述假设性新增索引，**不是**真实 capture、真实数据库验证或真实性能提升证据。普通 parser golden corpus 未被改写。

覆盖同计划确定性与 JSON round-trip、扫描方式变化、Sort 插入 / 删除、Join 算法和子节点顺序变化、self-join / 重复表歧义、rows/cost 不作 identity、缺失与零值、输入资格拒绝及 PG/MySQL fixture pair。Node tests 不等同于真实 Desktop 验收。Issue #73 的后续阶段仍需完成比较 UI、版本 / 来源可比性提示、diagnostic association、历史工作流和实际 Desktop 验收；不得将本 Core 单独描述为完整 Plan Diff 功能。
