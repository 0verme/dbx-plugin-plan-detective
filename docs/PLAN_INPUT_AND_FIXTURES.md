# 离线 Plan Core：输入契约、NormalizedPlan、Metrics、Rules 与 Fixture 约定

> 本文定义 Plan Detective **离线分析内核**（Plan Core）的全部契约：
> `RawPlanInput`、parser registry、PostgreSQL parser 输出、`NormalizedPlan`、Metrics、Findings/Rules、
> fixture 目录约定与 Golden Test 机制。
> DBX Host Plan API（已合并的 [t8y2/dbx#9692](https://github.com/t8y2/dbx/pull/9692)）到 `RawPlanInput` 的映射见
> 第 2.1 节；Host adapter 位于 `src/host/**`，与本文件定义的 Core 契约分层。

## 1. 职责边界与依赖方向

```text
DBX Host（Host API 1.2：getPlanCapabilities / explainPlan，只读 Estimated Plan）
   │  PluginPlanResult { dbType, dbVersion?, format, rawPlan, truncated, warnings }
   ▼
src/host/dbx-plan-host.js（Host Adapter：结构校验、稳定错误码、timeout guard）
   │
src/core/adapter/dbx-plan-response.js（Plan Detective 内唯一的 DBX response 感知层）
   │
   ▼
RawPlanInput                     ← 本文第 2 节，Plan Core 的唯一输入契约
   │
src/core/parsers/（registry：database family → structured parser）
   │
   ▼
Parser（PostgreSQL / MySQL）       → ParsedPlan（引擎专有、字段完整）
   │
   ▼
Normalizer                        → NormalizedPlan（数据库无关语义 + engineSpecific）
   │
   ▼
Metrics（确定性算术）
   │
   ▼
Rules（确定性阈值）                → Findings（结论 + Evidence）
   │
   ▼
src/lib/analysis-session.js（编排） + UI（Host 分析 / Fixtures 开发模式）
```

- Plan Core 位于 `src/core/`，不得 import DBX Host 类型、不得访问浏览器全局、不得连接数据库。
- UI 只消费 `analysis-session` / `analyzePlan()` 的输出；`src/lib/` 的 view model 只做展示映射，不重算 Metrics、
  不重跑规则、不修改 Core 语义。
- `window.dbxPlugin` 只在 `src/host/**` 与开发用 HostAudit 视图中出现；依赖方向由测试强制：
  `tests/core-isolation.test.js` 检查「不得引用 `window` / `document` / `dbxPlugin` / `svelte` / `@dbx-app` / `tauri`」
  与「`parsers` / `postgres` / `mysql` / `normalize` / `metrics` / `rules` / `findings` 阶段不得出现 `connectionId` / `credential` /
  `password` / `manifest` / `iframe` / `result-view` / `queryTab`」。
- DBX 的只读契约不包含 credential / connection string；插件拿不到它们。`timeout` 由 Host 执行，
  Host adapter 只做 UI 侧 guard。

内核只能通过文件读取 fixture 运行：`node scripts/analyze-fixture.mjs estimated/seq-scan`。

## 2. RawPlanInput Contract

```ts
interface RawPlanInput {
  database: string;              // Plan Core database family（见下表）
  mode: "estimated" | "actual";  // Host API 只服务 estimated；actual 仅用于离线 fixture
  format: "json" | "text" | "xml";

  sql?: string;                  // 展示 / 证据用，parser 不得依赖
  databaseVersion?: string;      // provenance，不参与解析

  plan: unknown;                 // 原始 payload，原样传递
}
```

| 字段 | 必填 | 为什么需要 |
| --- | --- | --- |
| `database` | 是 | 决定由 registry 中哪个 parser 处理。当前 structured：`"postgresql"` / `"mysql"`；raw-only：`"sqlserver"` / `"oracle"` / `"oceanbase-oracle"` / `"doris"` / `"dameng"` / `"questdb"`。该词汇是 Plan Core 自己的，不是 DBX `dbType`；adapter 负责映射。 |
| `mode` | 是 | 决定是否期望 Actual 执行字段。`EXPLAIN` → `estimated`，`EXPLAIN ANALYZE` → `actual`。DBX Host API 只返回 estimated；actual 值保留给离线 fixture / 未来契约。 |
| `format` | 是 | `json`（PostgreSQL / MySQL / OceanBase Oracle）、`xml`（SQL Server ShowPlanXML）、`text`（Oracle / Dameng / Doris / QuestDB）。registry 对 family + format 组合判定是否 structured。 |
| `plan` | 是 | 原始 payload，原样传递。PostgreSQL 必须保留完整顶层 envelope（单元素数组），而不是内部 `Plan` object；text / xml 为字符串。 |
| `sql` | 否 | 仅用于展示 / 证据材料。parser 不得依赖，且不得包含凭据。 |
| `databaseVersion` | 否 | 仅用于 provenance，不参与解析。 |

实现：`src/core/raw-plan-input.js`（`validateRawPlanInput` / `createRawPlanInput`）。

- 未知顶层字段被忽略（forward compatible），不导致失败。
- 契约错误一律抛 `PlanInputError`，带稳定 `code`（`INVALID_RAW_PLAN_INPUT`）。
- 与 DBX 只读契约的映射由 `dbx-adapter` 负责，映射表与正式契约定义见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 3 节。

### 2.1 DBX Response Adapter Contract（已随 Host MVP 接入生产路径）

实现：`src/core/adapter/dbx-plan-response.js`（纯函数；测试 `tests/core/dbx-plan-response.test.js`）。
Host 调用与响应结构校验在 `src/host/dbx-plan-host.js`（见 [ARCHITECTURE.md](ARCHITECTURE.md) 第 4、5 节）。

```ts
adaptDbxEstimatedPlanResponse(response, options?): RawPlanInput
```

- `response` 是 DBX Host API 成功返回的 plain object（t8y2/dbx#9692 的 `PluginPlanResult`）：

```ts
{
  dbType: string;              // DBX db_type 词汇
  dbVersion?: string;          // 宿主已知时才有
  format: "json" | "xml" | "text";
  rawPlan: unknown;            // format === "json" 时为已解析 JSON，其余为文本
  truncated: boolean;
  warnings: string[];          // plan_not_json / plan_truncated / plan_rows_truncated
}
```

- `options` 只允许 Adapter 已知、Host response 不返回的展示 provenance，当前仅 `{ sql?: string }`；
  未知 option key 忽略，`null` 视为未提供。
- 输出必须经过既有 `createRawPlanInput(...)`，不复制第二套校验。
- `truncated` 在 Adapter 边界消化（抛 `PLAN_TRUNCATED`），不进入 Core；`rawPlan` 原引用直传。

| DBX response | RawPlanInput | 规则 |
| --- | --- | --- |
| `dbType: "postgres"` | `database: "postgresql"` | structured |
| `dbType: "mysql"` | `database: "mysql"` | structured（`EXPLAIN FORMAT=JSON`，见 4.2） |
| `dbType: "sqlserver"` | `database: "sqlserver"` | raw-only |
| `dbType: "oracle"` | `database: "oracle"` | raw-only |
| `dbType: "oceanbase-oracle"` | `database: "oceanbase-oracle"` | raw-only |
| `dbType: "doris"` / `"dameng"` / `"questdb"` | 同名 family | raw-only |
| （响应无 `mode`） | `mode: "estimated"` | 一期 Estimated only；无 actual 路径 |
| `format` | 同名 `format` | `json` / `xml` / `text`；契约外值拒绝 |
| `rawPlan` | `plan` | 原引用直传，不克隆 / 不重写 / 不 JSON.parse |
| `dbVersion?` | `databaseVersion?` | 字符串原样保留 |
| `options.sql?` | `sql?` | 仅展示 provenance，parser 不依赖 |
| `truncated` | — | 在 Adapter 边界抛 `PLAN_TRUNCATED`，不进入 Core |

Fail-closed 错误契约（`DbxPlanAdapterError`，稳定 `code`，message 不 dump `rawPlan`）：

| code | 触发 |
| --- | --- |
| `INVALID_DBX_PLAN_RESPONSE` | 非 plain object；缺 / 空 `dbType`、`format`；缺 / null `rawPlan`；`warnings` 非字符串数组；`truncated` 非 boolean；`dbVersion` 非字符串（存在时）；`format` 与 `rawPlan` 类型不一致；`plan_not_json` 与 `format` 不一致 |
| `UNSUPPORTED_DB_TYPE` | `dbType` 不在已合并契约的 8 个方言内 |
| `UNSUPPORTED_PLAN_FORMAT` | `format` 不是 `json` / `text` / `xml` |
| `PLAN_TRUNCATED` | `truncated === true`，或 warnings 含 `plan_truncated` / `plan_rows_truncated` |
| `INVALID_ADAPTER_OPTIONS` | Adapter 调用参数本身非法（非对象 / `sql` 非字符串） |

Warning 策略：`plan_not_json` 与 `format: "text"` 一致时接受（宿主已降级）；截断类 warning 一律 reject；
未来未知 warning 不自动 crash（忽略，不写入 RawPlanInput）。UI 保留宿主原始 payload 与 warnings 用于展示。

### 2.2 Parser Registry（structured vs raw-only）

实现：`src/core/parsers/index.js`（registry）、`src/core/parsers/postgres.js`（PostgreSQL 声明）。

```ts
describeParserSupport(database, format) -> { structured, parser, reasonCode }
analyzeRawPlan(rawInput) -> {
  status: "structured" | "raw-only",
  parser, reasonCode, reason,
  parsed, normalized, metrics, findings,
}
```

- `structured`：family 有 parser 且 format 受支持（当前 `postgresql` + `json`、`mysql` + `json`）；跑完整 Core pipeline。
- `raw-only`：`PARSER_NOT_IMPLEMENTED`（family 已知）/ `UNSUPPORTED_FORMAT`（parser 不支持该 format）/ `UNKNOWN_DATABASE`；
  `parsed` / `normalized` / `metrics` 为 `null`，`findings` 为空。UI 展示 Raw Plan 并标注原因，不伪造 parser。
- 严格入口 `analyzePlan(rawInput)` 对 raw-only 抛 `PlanParseError`，供 fixture / golden 测试使用；
  Host UI 使用 `analyzeRawPlan`，因为 raw-only 是受支持结果而不是失败。
- `RawPlanInput` 契约错误在 registry 入口抛 `PlanInputError`（`INVALID_RAW_PLAN_INPUT`）。

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

## 4. Parser 输出（ParsedPlan）

每个 structured family 都有自己的 parser，输出形状对齐、语义各自保留：

| family | parser | normalizer | registry 声明 |
| --- | --- | --- | --- |
| PostgreSQL | `src/core/postgres/parse-json-plan.js` | `src/core/normalize/normalize-postgres.js` | `src/core/parsers/postgres.js` |
| MySQL | `src/core/mysql/parse-json-plan.js` | `src/core/normalize/normalize-mysql.js` | `src/core/parsers/mysql.js` |

### 4.1 PostgreSQL

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

### 4.2 MySQL

实现：`src/core/mysql/parse-json-plan.js`。契约来源是 DBX Host 实际返回的
`EXPLAIN FORMAT=JSON`（`t8y2/dbx/main` `crates/dbx-sql/src/query_execution_sql.rs` 生成该语句，
`estimated_plan_format(Mysql) == Json`；`plugin_plan.rs` 固定 `ExplainFormat::Json` 且从不 `analyze`）。

| MySQL JSON | ParsedMySqlNode | 说明 |
| --- | --- | --- |
| `query_block` | `structure: "query_block"` / `nodeType: "Query Block"` | 根与嵌套 query block |
| `table.access_type` | `nodeType` | `ALL` → `Table Scan`、`ref` → `Index Lookup`、`eq_ref` → `Unique Index Lookup`、`range` → `Index Range Scan`、`const/system` → `Const Row Lookup` / `System Row Lookup` 等；未知 access type 原样保留并进入 `unknownNodeTypes` |
| `table.table_name` / `key` | `relationName` / `indexName` | MySQL JSON 没有 alias |
| `table.rows_examined_per_scan` | `estimatedRows` | 每次访问该表的估算行数 |
| `table.rows_produced_per_join` | `mysql.rowsProducedPerJoin`；join 节点的 `estimatedRows` | MySQL 定义为 join prefix 累计输出行数 |
| `table.attached_condition` / `index_condition` | `filter` / `indexCondition` | |
| `table.filtered` | `mysql.filteredPercent` | MySQL 输出为 `"14.29"` 形式，严格解析为数字 |
| `table.possible_keys` / `used_key_parts` / `key_length` / `ref` / `used_columns` | `mysql.*` | 原样保留 |
| `table.using_index` / `using_index_for_group_by` / `using_join_buffer` / `first_match` | `mysql.*` | |
| `nested_loop[]` | 左深二叉 `Nested Loop` 链 | join 顺序保留：`NL(NL(A,B),C)`；join 节点 `estimatedRows` 取内层表的 `rows_produced_per_join` |
| `ordering_operation` | `nodeType: "Ordering Operation"`，`using_filesort` 进入 `mysql.*` | 单子节点包装 |
| `grouping_operation` | `nodeType: "Grouping Operation"`，`using_temporary_table` / `using_filesort` 进入 `mysql.*` | 单子节点包装 |
| `duplicates_removal` | `nodeType: "Duplicates Removal"` | DISTINCT 去重步骤 |
| `union_result` / `unary_result` / `intersect_result` / `except_result` | 对应 `* Result` 节点；`query_specifications` 元素可以是 `{ dependent, cacheable, query_block }`，也可以是嵌套的 set operation（MySQL 8.0.31+ 括号化 query expression） | `dependent` / `cacheable` 保留在子节点上；未消费的 wrapper key 进入 `extra` |
| `query_block.message` / `table.message` / `*_result.message` | `mysql.message` | MySQL 在这些结构上报告 message（如 `Deleting all rows`、`Not optimized, outer query is empty`），parser 不丢弃 |
| `materialized_from_subquery` | `nodeType: "Materialized Subquery"` | 可出现在 query block 或 table 下 |
| `attached_subqueries` / `optimized_away_subqueries` / `group_by_subqueries` / `having_subqueries` / `order_by_subqueries` / `select_list_subqueries` | `nodeType: "Subquery"` | 数组元素形状统一为 `{ dependent, cacheable, query_block }` |
| `cost_info.*` | `mysql.queryCost` / `readCost` / `evalCost` / `prefixCost` / `dataReadPerJoin` / `sortCost` | MySQL cost 是 numeric string，严格解析；未知子键进入 `extra.cost_info` |
| 其余原生键 | `extra` | 不丢弃；未知结构不会生成假节点 |

- 结构不可信时抛 `PlanParseError`：缺 `query_block`、`nested_loop` 非数组/为空、元素不是对象、
  数值字段类型不符、`query_specifications` / `*_subqueries` 形状错误等。
- `mode` 只支持 `estimated`：MySQL `EXPLAIN ANALYZE` 返回 TREE 文本而不是该 JSON，
  声明 `actual` 时抛 `MODE_MISMATCH`。
- **不把 MySQL cost 映射到 PostgreSQL 语义的 `startupCost` / `totalCost`**，原因见第 5 节。

## 5. NormalizedPlan

实现：`src/core/normalize/normalize-postgres.js`（PostgreSQL）与
`src/core/normalize/normalize-mysql.js`（MySQL）。NormalizedPlan 不是字段改名，而是稳定语义层：

```text
NormalizedPlan {
  database: "postgresql" | "mysql",
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
| `nodeType` | `string` | 原始引擎标签，始终保留（PostgreSQL Node Type；MySQL parser 给出的稳定 label，未知 access type 为原始值） |
| `relation` | `{name, alias, indexName} \| null` | 无关系信息时为 `null` |
| `estimatedRows` | `number \| null` | PostgreSQL Plan Rows；MySQL `rows_examined_per_scan`（表）/ join prefix `rows_produced_per_join`（join 节点） |
| `actualRows` / `actualStartupTime` / `actualTotalTime` / `loops` | `number \| null` | Actual 字段 |
| `startupCost` / `totalCost` | `number \| null` | PostgreSQL 估计代价；MySQL 恒为 `null`（MySQL cost 在 `engineSpecific.mysql`，语义不可直接比较） |
| `width` | `number \| null` | Plan Width |
| `filter` | `string \| null` | 过滤谓词 |
| `joinType` | `string \| null` | Inner / Left / … |
| `joinCondition` | `string \| null` | 取 Hash Cond → Merge Cond → Join Filter 中第一个存在者 |
| `indexCondition` | `string \| null` | Index Cond |
| `sortKeys` / `groupKeys` | `string[] \| null` | |
| `children` | `NormalizedNode[]` | |
| `engineSpecific` | `object` | 见下 |

`engineSpecific`（PostgreSQL）：`database`、`parentRelationship`、`subplanName`、`strategy`、`partialMode`、
`parallelAware`、`asyncCapable`、`hashCondition`、`mergeCondition`、`joinFilter`、`recheckCondition`、
`presortedKeys`、`extra`（parser 未映射的原生属性）。

`engineSpecific`（MySQL）：`database`、`mysql`（`structure`、`selectId`、`message`、`accessType`、
`possibleKeys`、`usedKeyParts`、`usedColumns`、`keyLength`、`ref`、`rowsExaminedPerScan`、
`rowsProducedPerJoin`、`filteredPercent`、`usingIndex`、`usingIndexForGroupBy`、`usingFilesort`、
`usingTemporaryTable`、`usingJoinBuffer`、`firstMatch`、`dependent`、`cacheable`、`queryCost`、
`readCost`、`evalCost`、`prefixCost`、`dataReadPerJoin`、`sortCost`）、`extra`。
**不为了"统一"丢弃数据库专有信息。**

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

MySQL 侧追加的 kind（现有 metrics / rules 不依赖）：

| kind | MySQL 结构 |
| --- | --- |
| `query_block` | `query_block` 容器（根与嵌套子查询） |
| `seq_scan` | `access_type: ALL`（`nodeType` 为 `Table Scan`） |
| `index_scan` | `index` / `range` / `ref` / `eq_ref` / `ref_or_null` / `fulltext` / `index_merge` / `*_subquery` |
| `const_scan` | `access_type: const` / `system`（单行查找，不计入 scan metrics） |
| `nested_loop` | 折叠后的 `nested_loop` 链 |
| `sort` / `aggregate` / `unique` | `ordering_operation` / `grouping_operation` / `duplicates_removal` |
| `append` / `setop` / `result` | `union_result` / `intersect_result` + `except_result` / `unary_result` |
| `materialize` / `subquery` | `materialized_from_subquery` / `*_subqueries` 数组 |

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

MySQL 适用性（cost 语义见上）：

| rule | MySQL |
| --- | --- |
| `large-sequential-scan` | 适用（`Table Scan` 按估算行数触发；`totalCost` 为 `null` 时代价分支不触发，finding 里不显示 `incremental cost of 0`） |
| `expensive-sort` | 不适用（依赖 PostgreSQL 语义的增量代价与计划总代价，MySQL 不映射） |
| `nested-loop-large-inner` | 适用（只用估算行数，`estimateOnly: true`） |

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
fixtures/postgres/                  # 真实采集 + synthetic
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

fixtures/mysql/                     # 仅 estimated；全部为 shape-verified synthetic
├── README.md
├── estimated/
│   ├── <name>.synthetic.plan.json
│   └── <name>.synthetic.meta.json
└── golden/
    └── estimated/<name>.synthetic.json
```

- `.plan.json` 不重排、不裁剪、不修饰；重采后应与数据库原始输出可直接对照。
- `.meta.json` 的 `expect` 记录该 fixture 要钉住的行为：
  `rootNodeType` / `hasActualFields` / `minDepth` / `findingRuleIds`（实际触发的 rule id 集合，
  没有触发则为 `[]`）。
- 一个 fixture 只验证一个主要行为，优先小而可人工核对。
- 合成 fixture 必须在文件名中标记 `.synthetic`。
- MySQL 只有 `estimated/`：Host API 不提供 MySQL actual plan，MySQL `EXPLAIN ANALYZE` 也不是该 JSON 形状。
- 测试侧 loader：`tests/helpers/fixtures.js`（按 database + mode 发现 fixture、校验 metadata、生成 `RawPlanInput`）。

当前 fixture：PostgreSQL 19 个（17 个真实采集 + 2 个 synthetic；明细见 `fixtures/postgres/README.md`）；
MySQL 11 个，全部为 shape-verified synthetic（明细见 `fixtures/mysql/README.md`）。

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

覆盖范围：契约校验、PostgreSQL / MySQL parser 字段映射与错误路径、estimated / actual 不混淆、未知节点与未知字段、
NormalizedPlan 语义与 id、Metrics 计数与增量代价、3 条规则的正反例与阈值边界、
Findings 契约、golden 四 stage、determinism 与 JSON 可序列化、Plan Core 无浏览器 / DBX 依赖。

## 11. 明确不在本轮范围

本轮（Offline Core vertical slice）不实现：`dbx-adapter` 的真实 Host wiring（仅 `DBX response → RawPlanInput`
离线契约已实现，见第 2.1 节）、Execution Plan 扩展点集成、
DBX Host API 调用、数据库 Driver / 连接池 / 凭据、Actual Plan 获取、
SQL Server / Oracle / Dameng / Doris / QuestDB parser、MariaDB / OceanBase MySQL / ADB MySQL 的自动兼容、
文本计划 parser、Plan Diff、History、Plan Canvas、AI / LLM、SQL Rewrite、自动建索引、性能评分。

以上均按独立 Issue 推进；Host 接入仍等待 t8y2/dbx#9675 / [PR #9692](https://github.com/t8y2/dbx/pull/9692) 落地，
落地后只需把 Host 返回值交给第 2.1 节的 Adapter，将 `rawPlan` 映射为本文第 2 节的 `RawPlanInput`。

> 更新（2026-09-20，Issue [#7](https://github.com/0verme/dbx-plugin-plan-detective/issues/7)）：
> Fixture-driven MVP UI 已实现（Fixture Selector / Plan Summary / Findings / Plan Tree / Node Inspector）。
> 它**消费同一份契约**，没有修改本文的 Parser / NormalizedPlan / Metrics / Rules / Findings 语义、
> 阈值与 golden；fixture 仍在构建期从 `fixtures/postgres/**` 读取，未复制为代码常量。
> UI 层禁止事项（Host API、Driver、Plan Canvas、评分、AI）与 Core 一致。
