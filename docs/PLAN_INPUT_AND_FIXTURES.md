# 离线 Plan Core：输入契约、NormalizedPlan、Metrics、Rules 与 Fixture 约定

> 本文定义 Plan Detective **离线分析内核**（Plan Core）的全部契约：
> `RawPlanInput`、PostgreSQL parser 输出、`NormalizedPlan`、Metrics、Findings/Rules、
> fixture 目录约定与 Golden Test 机制。
> DBX → Plugin 的**只读数据契约**（`sql` / `dbType` / `dbVersion` / `executionPlan.mode|format|raw`）见
> [ARCHITECTURE.md](ARCHITECTURE.md) 第 3 节；两者由未来的 `dbx-adapter` 衔接。
> 本轮**不**实现 adapter，也不依赖任何未合并的 DBX API。

## 1. 职责边界与依赖方向

```text
DBX Host（执行 EXPLAIN，产出 Raw Execution Plan）
   │  executionPlan.raw / mode / format（只读）
   ▼
Execution Plan Plugin Extension Point（Host 提供；尚未落地）
   │
   ▼
dbx-adapter（Plan Detective 内唯一的 DBX 感知层；尚未实现）
   │
   ▼
RawPlanInput                     ← 本文第 2 节，Plan Core 的唯一输入契约
   │
   ▼
Parser（PostgreSQL）              → ParsedPlan（引擎专有、字段完整）
   │
   ▼
Normalizer                        → NormalizedPlan（数据库无关语义 + engineSpecific）
   │
   ▼
Metrics（确定性算术）
   │
   ▼
Rules（确定性阈值）                → Findings（结论 + Evidence）
```

- Plan Core 位于 `src/core/`，不得 import DBX Host 类型、不得访问浏览器全局、不得连接数据库；
  DBX 上游扩展点未落地**不阻塞** Core 开发（fixture-first）。
- 依赖方向由测试强制：`tests/core-isolation.test.js` 同时检查「不得引用 `window` / `document` /
  `dbxPlugin` / `svelte` / `@dbx-app` / `tauri`」与「`postgres` / `normalize` / `metrics` / `rules` /
  `findings` 阶段不得出现 `connectionId` / `credential` / `password` / `manifest` / `iframe` /
  `result-view` / `queryTab`」。
- `dbx-adapter` 是本契约唯一的转换点，必须保持极薄；本轮不实现 adapter，也不依赖任何未合并的 DBX API。
- DBX 的只读契约不包含 `connectionId`、`credential`、`catalog`、`clientSessionId`；`timeout` / `cancel`
  留在 Host 层。这些字段也**不进入**本契约。

内核只能通过文件读取 fixture 运行：`node scripts/analyze-fixture.mjs estimated/seq-scan`。

## 2. RawPlanInput Contract

```ts
interface RawPlanInput {
  database: "postgresql";        // 未来扩展为更多 database 值
  mode: "estimated" | "actual";  // EXPLAIN / EXPLAIN ANALYZE
  format: "json";

  sql?: string;                  // 展示 / 证据用，parser 不得依赖
  databaseVersion?: string;      // provenance，不参与解析

  plan: unknown;                 // 原始 payload，原样传递
}
```

| 字段 | 必填 | 为什么需要 |
| --- | --- | --- |
| `database` | 是 | 决定由哪个 parser 处理。当前只允许 `"postgresql"`；MySQL 等在契约扩展后由 adapter 分派，避免 PG parser 误吞其它数据库的计划。 |
| `mode` | 是 | 决定是否期望 Actual 执行字段。`EXPLAIN` → `estimated`，`EXPLAIN ANALYZE` → `actual`。 |
| `format` | 是 | 当前只允许 `"json"`。文本计划将是另一个契约值，等文本 parser 出现时再加，不用 `unknown` 混用。 |
| `plan` | 是 | 原始 payload，原样传递。PostgreSQL 必须保留完整顶层 envelope（单元素数组），而不是内部 `Plan` object。 |
| `sql` | 否 | 仅用于展示 / 证据材料。parser 不得依赖，且不得包含凭据。 |
| `databaseVersion` | 否 | 仅用于 provenance，不参与解析。 |

实现：`src/core/raw-plan-input.js`（`validateRawPlanInput` / `createRawPlanInput`）。

- 未知顶层字段被忽略（forward compatible），不导致失败。
- 契约错误一律抛 `PlanInputError`，带稳定 `code`（`INVALID_RAW_PLAN_INPUT`）。
- 与 DBX 只读契约的映射由 `dbx-adapter` 负责，映射表与正式契约定义见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 3 节。

## 3. Estimated vs Actual

| | estimated | actual |
| --- | --- | --- |
| 来源 | `EXPLAIN (FORMAT JSON)` | `EXPLAIN (ANALYZE, FORMAT JSON)` |
| `Actual Rows` / `Actual Total Time` / `Actual Loops` / `Actual Startup Time` | 不存在 | 存在 |
| parser 输出 | 四个字段一律 `null` | 映射为数字 |
| 冲突检测 | estimated 输入出现 actual-only 字段 → `PlanParseError`（`MODE_MISMATCH`） | — |
| 禁止 | 用 `0` 冒充缺失值、把 `Plan Rows` 当 `Actual Rows` | 同左 |

JSON 没有 `undefined`，因此用 `null` 表示"不可用"，语义为：原生 payload 中没有该字段。
`Plan Rows`（估计）与 `Actual Rows`（实测）永远是两个独立字段，不允许互相填充。
规则不得把 estimated 计划渲染成拥有 runtime loop 数据（见第 6 节 nested-loop 规则的措辞）。

## 4. PostgreSQL Parser 输出（ParsedPlan）

实现：`src/core/postgres/parse-json-plan.js`。输入是 `RawPlanInput`，输出：

```text
ParsedPlan { database, format, mode, root: ParsedPlanNode }
```

每个 `ParsedPlanNode` 映射以下 PostgreSQL 原生字段（缺失 → `null`，类型不符 → `MALFORMED_NODE` 错误）：

| PostgreSQL 字段 | ParsedPlanNode | 说明 |
| --- | --- | --- |
| `Node Type` | `nodeType` | 必填；未知节点类型不报错，原样保留 |
| `Relation Name` / `Alias` / `Index Name` | `relationName` / `alias` / `indexName` | |
| `Startup Cost` / `Total Cost` / `Plan Rows` / `Plan Width` | `startupCost` / `totalCost` / `planRows` / `planWidth` | |
| `Filter` / `Index Cond` / `Recheck Cond` | `filter` / `indexCondition` / `recheckCondition` | |
| `Hash Cond` / `Merge Cond` / `Join Filter` / `Join Type` | `hashCondition` / `mergeCondition` / `joinFilter` / `joinType` | |
| `Sort Key` / `Group Key` / `Presorted Key` | `sortKeys` / `groupKeys` / `presortedKeys` | `string[]`；单个字符串按单元素列表接受 |
| `Strategy` / `Partial Mode` | `strategy` / `partialMode` | 例：`Hashed` / `Simple` |
| `Parallel Aware` / `Async Capable` | `parallelAware` / `asyncCapable` | |
| `Actual Startup Time` / `Actual Total Time` / `Actual Rows` / `Actual Loops` | `actualStartupTime` / `actualTotalTime` / `actualRows` / `actualLoops` | 仅 actual |
| `Plans` | `children` | 递归，任意深度 |
| `Parent Relationship` / `Subplan Name` | `parentRelationship` / `subplanName` | |
| 其余全部字段 | `extra` | 原样保留，不因模型未映射而丢失 |

- 已覆盖并在 fixture 中钉住节点：Seq Scan、Index Scan、Index Only Scan、Bitmap Heap Scan、
  Bitmap Index Scan、Nested Loop、Hash Join、Merge Join、Hash、Sort、Aggregate（含 HashAggregate /
  GroupAggregate）、Group、Limit，以及 Gather / Gather Merge / Materialize / Memoize。
- 未知节点类型「Future Shuffle Node」由 `estimated/unknown-node.synthetic` 固定：
  保留类型、children 与未知属性，不 crash。
- 未单独建 fixture 的节点类型仍由通用映射覆盖；`normalize` 中未登记的节点类型映射为 `kind: "unknown"`，
  并记录在 `NormalizedPlan.unknownNodeTypes`。

## 5. NormalizedPlan

实现：`src/core/normalize/normalize-postgres.js`。NormalizedPlan 不是字段改名，而是稳定语义层：

```text
NormalizedPlan {
  database: "postgresql",
  mode, format,
  root: NormalizedNode,
  unknownNodeTypes: string[]   // 排序去重，便于测试与 UI 提示
}
```

每个 NormalizedNode：

| 字段 | 类型 | 来源 / 语义 |
| --- | --- | --- |
| `id` | `string` | 稳定路径 id：根为 `"0"`，第 n 个子节点为 `"<parent>.<n>"` |
| `kind` | `string` | 数据库无关语义（见下表），未知类型为 `"unknown"` |
| `nodeType` | `string` | 原始 PostgreSQL 节点类型，始终保留 |
| `relation` | `{name, alias, indexName} \| null` | 无关系信息时为 `null` |
| `estimatedRows` | `number \| null` | Plan Rows |
| `actualRows` / `actualStartupTime` / `actualTotalTime` / `loops` | `number \| null` | Actual 字段 |
| `startupCost` / `totalCost` | `number \| null` | 估计代价 |
| `width` | `number \| null` | Plan Width |
| `filter` | `string \| null` | 过滤谓词 |
| `joinType` | `string \| null` | Inner / Left / … |
| `joinCondition` | `string \| null` | 取 Hash Cond → Merge Cond → Join Filter 中第一个存在者 |
| `indexCondition` | `string \| null` | Index Cond |
| `sortKeys` / `groupKeys` | `string[] \| null` | |
| `children` | `NormalizedNode[]` | |
| `engineSpecific` | `object` | 见下 |

`engineSpecific`：`database`、`parentRelationship`、`subplanName`、`strategy`、`partialMode`、
`parallelAware`、`asyncCapable`、`hashCondition`、`mergeCondition`、`joinFilter`、`recheckCondition`、
`presortedKeys`、`extra`（parser 未映射的原生属性）。**不为了"统一"丢弃数据库专有信息。**

`kind` 主要映射：

| kind | PostgreSQL 节点 |
| --- | --- |
| `seq_scan` / `index_scan` / `index_only_scan` | Seq Scan / Index Scan / Index Only Scan |
| `bitmap_heap_scan` / `bitmap_index_scan` | Bitmap Heap Scan / Bitmap Index Scan |
| `nested_loop` / `hash_join` / `merge_join` | 对应 Join |
| `hash` / `sort` / `incremental_sort` | Hash / Sort / Incremental Sort |
| `aggregate` | Aggregate / HashAggregate / GroupAggregate / MixedAggregate |
| `group` / `analytic` / `unique` / `limit` | Group / WindowAgg / Unique / Limit |
| `memoize` / `materialize` / `gather` / `gather_merge` | 对应节点 |
| `append` / `result` / `subquery_scan` / `values_scan` / `function_scan` / `cte_scan` / `modify_table` / … | 常见辅助节点 |
| `unknown` | 未登记类型；`nodeType` 与 `unknownNodeTypes` 记录原始值 |

NormalizedPlan 必须 deterministic、可 JSON 序列化、可离线 fixture 测试，且不依赖 UI。

## 6. Metrics 与 Rules

### Metrics（`src/core/metrics/compute-metrics.js`）

纯算术，不含评分 / 排名 / 判断；数据缺失时保持 `null`，不用 `0` 冒充。

| 指标 | 含义 |
| --- | --- |
| `nodeCount` / `maxDepth` | 节点数；最长 root-to-leaf 路径（单节点 = 1） |
| `totalEstimatedCost` / `rootEstimatedRows` | 根节点 Total Cost / Plan Rows |
| `scanCount` | 所有 scan 类节点（seq / index / index-only / bitmap / tid / sample） |
| `sequentialScanCount` / `indexScanCount` / `bitmapScanCount` | 分类计数 |
| `joinCount` / `sortCount` / `aggregateCount` | join / sort / aggregate+group 计数 |
| `unknownNodeTypeCount` | 未登记节点类型数 |
| `largestEstimatedRows` | 估算行数最大的节点摘要（并列取先序第一个） |
| `highestIncrementalCost` | 自身增量代价最大的节点摘要（并列取先序第一个） |

增量代价沿用 PostgreSQL 语义，由 `src/core/tree.js` 的 `incrementalCostOf` 计算：

```text
incrementalCost(node) = node.totalCost - Σ children.totalCost   （子节点无 cost 记 0）
node.totalCost 缺失 → null（不猜）
```

不做"性能评分 83 分"这类综合评分。

### Rules（`src/core/rules/`）

确定性阈值规则，阈值集中在 `src/core/rules/thresholds.js` 并写入 finding evidence：

| rule id | 触发节点 | 条件 | severity |
| --- | --- | --- | --- |
| `large-sequential-scan` | `seq_scan` | 估算行数 ≥ 10 000 或增量代价 ≥ 10 000 | `warning` |
| | | 估算行数 ≥ 100 000 或增量代价 ≥ 100 000 | `high` |
| `expensive-sort` | `sort` / `incremental_sort` | 增量代价 ≥ 1 000 且 ≥ 计划总估算代价的 25% | `warning` |
| `nested-loop-large-inner` | `nested_loop` | 外层估算行数 ≥ 10 且内层估算行数 ≥ 10 000 | `warning` |
| | | 内层估算行数 ≥ 100 000 | `high` |

规则措辞纪律：

- 以 observation 陈述（"值得检查…"），不使用"必须加索引"/"必须改写"；
- 只用计划中真实存在的数据；estimated 计划不得声称拥有 runtime loops；
  `nested-loop-large-inner` 的 `estimatedRowComparisons` 明确是估算乘积，并附带
  `estimateOnly` 标记；
- 每条 finding 带 evidence 与所用阈值，读者可自行复核为什么触发。

### Findings（`src/core/findings/finding.js`）

```ts
interface Finding {
  id: string;                              // `${ruleId}:${nodeRef}`，deterministic
  ruleId: string;
  severity: "info" | "warning" | "high";   // 不使用 critical
  title: string;
  summary: string;                         // 中性、基于证据
  nodeRef: string;                         // NormalizedNode.id
  evidence: {
    nodeId: string;
    nodeType: string;
    relation: string | null;
    estimatedRows: number | null;
    estimatedTotalCost: number | null;
    ...ruleSpecific
  };
}
```

`info` 为纯观察档，当前 3 条规则未使用；契约允许规则后续按需选择。
`createFinding` 会校验 severity / title / summary / node / evidence，非法输入抛 `TypeError`。

统一入口：`src/core/analyze.js` 的 `analyzePlan(rawInput)` 返回
`{ parsed, normalized, metrics, findings }`；未来 adapter 与 UI 只调用它即可。

## 7. Fixture Convention

```text
fixtures/postgres/
├── README.md
├── setup.sql
├── estimated/
│   ├── <name>.plan.json          # 数据库返回的原始 payload，原样保存
│   └── <name>.meta.json          # 来源、版本、采集命令、SQL、features、expect
├── actual/
│   └── <name>.plan.json + <name>.meta.json
└── golden/
    ├── estimated/<name>.json     # 期望的 parsed / normalized / metrics / findings
    └── actual/<name>.json
```

- `.plan.json` 不重排、不裁剪、不修饰；重采后应与数据库原始输出可直接对照。
- `.meta.json` 的 `expect` 记录该 fixture 要钉住的行为：
  `rootNodeType` / `hasActualFields` / `minDepth` / `findingRuleIds`（实际触发的 rule id 集合，
  没有触发则为 `[]`）。
- 一个 fixture 只验证一个主要行为，优先小而可人工核对。
- 合成 fixture 必须在文件名中标记 `.synthetic`。
- `fixtures/mysql/` 保持占位；MySQL 属于 Adapter Roadmap。
- 测试侧 loader：`tests/helpers/fixtures.js`（发现 fixture、校验 metadata、生成 `RawPlanInput`）。

当前 PostgreSQL fixture：19 个（17 个真实采集 + 2 个 synthetic 未知节点/未知属性；明细见
`fixtures/postgres/README.md`）。

## 8. Fixture Provenance

`source.kind` 三选一，且必须与实际数据来源一致：

| kind | 含义 | 额外要求 |
| --- | --- | --- |
| `official` | 来自数据库官方公开文档示例 | `source.reference` 必须是公开 URL |
| `locally-generated` | 从本地测试库真实采集（数据本身可以是合成测试数据） | `databaseVersion`、`capturedAt`、`captureCommand`、`sql` 必填，`detail` 必须包含 "locally generated" |
| `synthetic` | 人工构造的最小结构，**未**经过任何数据库 | 文件名含 `.synthetic`，上述字段必须为 `null`，`detail` 说明并非真实采集 |

红线：

- 不得把 synthetic fixture 写成真实采集；
- 不得提交生产 SQL、真实业务表名、用户数据、连接信息或凭据；
- `npm test` 会扫描 fixture 中 credential 类字段名。

## 9. Golden Test Convention

每个 fixture 的 golden 固定整条离线 pipeline：

```text
.plan.json ──loadFixture（校验 metadata → RawPlanInput）
      │
      ▼ analyzePlan()
{ parsed, normalized, metrics, findings }
      │
      ▼ deepStrictEqual
fixtures/postgres/golden/<mode>/<name>.json
```

- `npm test` 对每个 fixture 逐 stage 比较；不一致即失败，并提示重新生成命令。
- `npm run test:update-goldens` 重新生成 golden。只有确认 pipeline 行为变化是有意的，才允许提交更新后的
  golden，并逐文件 review diff。
- golden 与 fixture 一一对应，不允许 orphan 文件。
- `expect.findingRuleIds` 是独立于 golden 的第二重断言：即使 golden 被一并更新，
  也必须显式确认规则触发集合的意图。

## 10. 测试

```bash
npm test                      # 离线：不需要 DBX、不需要数据库、不需要 npm install
npm run test:update-goldens   # 有意变更 pipeline 后重新生成 golden
npm run analyze -- estimated/seq-scan   # 开发用：对单个 fixture 跑完整 pipeline
```

覆盖范围：契约校验、parser 字段映射与错误路径、estimated / actual 不混淆、未知节点与未知字段、
NormalizedPlan 语义与 id、Metrics 计数与增量代价、3 条规则的正反例与阈值边界、
Findings 契约、golden 四 stage、determinism 与 JSON 可序列化、Plan Core 无浏览器 / DBX 依赖。

## 11. 明确不在本轮范围

本轮（Offline Core vertical slice）不实现：`dbx-adapter`、Execution Plan 扩展点集成、
DBX Host API 调用、数据库 Driver / 连接池 / 凭据、Actual Plan 获取、
MySQL parser、DWS 适配、文本计划 parser、Plan Diff、History、UI Tree、Plan Canvas、
AI / LLM、SQL Rewrite、自动建索引、性能评分。

以上均按独立 Issue 推进；Host 接入仍等待 t8y2/dbx#9675 落地，落地后只需新增 adapter 将
`rawPlan` 映射为本文第 2 节的 `RawPlanInput`。
