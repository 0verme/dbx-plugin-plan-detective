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
Parser（PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle） → ParsedPlan（引擎专有、字段完整）
   │
   ▼
Normalizer                        → NormalizedPlan（数据库无关语义 + engineSpecific）
   │
   ▼
Metrics（确定性算术）
   │
   ├─► Rules（确定性阈值）              → Findings（结论 + Evidence）
   │
   └─► Hotspots（确定性信号聚合）        → HotspotAnalysis（注意力列表 + reason + evidence）
   │
   ▼
src/lib/analysis-session.js（编排） + UI（Host 分析 / Fixtures 开发模式）
```

- Plan Core 位于 `src/core/`，不得 import DBX Host 类型、不得访问浏览器全局、不得连接数据库。
- UI 只消费 `analysis-session` / `analyzePlan()` 的输出；`src/lib/` 的 view model 只做展示映射，不重算 Metrics、
  不重跑规则、不重算热点。
- `window.dbxPlugin` 只在 `src/host/**` 与开发用 HostAudit 视图中出现；依赖方向由测试强制：
  `tests/core-isolation.test.js` 检查「不得引用 `window` / `document` / `dbxPlugin` / `svelte` / `@dbx-app` / `tauri`」
  与「`parsers` / `postgres` / `mysql` / `sqlserver` / `oceanbase` / `normalize` / `metrics` / `rules` / `findings` 阶段不得出现 `connectionId` / `credential` /
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
| `database` | 是 | 决定由 registry 中哪个 parser 处理。当前 structured：`"postgresql"` / `"mysql"` / `"sqlserver"` / `"oceanbase-oracle"` / `"oracle"`；raw-only：`"doris"` / `"dameng"` / `"questdb"`。该词汇是 Plan Core 自己的，不是 DBX `dbType`；adapter 负责映射。 |
| `mode` | 是 | 决定是否期望 Actual 执行字段。`EXPLAIN` → `estimated`，`EXPLAIN ANALYZE` → `actual`。DBX Host API 只返回 estimated；actual 值保留给离线 fixture / 未来契约。 |
| `format` | 是 | `json`（PostgreSQL / MySQL / OceanBase Oracle）、`xml`（SQL Server ShowPlanXML）、`text`（Oracle / Dameng / Doris / QuestDB；Oracle 的 structured parser 只接受 DBMS_XPLAN `TYPICAL +PREDICATE`）。registry 对 family + format 组合判定是否 structured。 |
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
| `dbType: "sqlserver"` | `database: "sqlserver"` | structured（ShowPlanXML，见 4.3） |
| `dbType: "oceanbase-oracle"` | `database: "oceanbase-oracle"` | structured（`EXPLAIN FORMAT=JSON`，见 4.4） |
| `dbType: "oracle"` | `database: "oracle"` | structured（DBX 当前返回 DBMS_XPLAN `TYPICAL +PREDICATE` text，见 4.5） |
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

- `structured`：family 有 parser 且 format 受支持（当前 `postgresql` + `json`、`mysql` + `json`、`sqlserver` + `xml`、`oceanbase-oracle` + `json`、`oracle` + `text`）；跑完整 Core pipeline。
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
| SQL Server | `src/core/sqlserver/parse-showplan-xml.js` + `src/core/sqlserver/xml.js` | `src/core/normalize/normalize-sqlserver.js` | `src/core/parsers/sqlserver.js` |
| OceanBase Oracle | `src/core/oceanbase/parse-json-plan.js` | `src/core/normalize/normalize-oceanbase.js` | `src/core/parsers/oceanbase-oracle.js` |
| Oracle | `src/core/oracle/parse-text-plan.js` | `src/core/normalize/normalize-oracle.js` | `src/core/parsers/oracle.js` |

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

实现：`src/core/mysql/parse-json-plan.js`（V1）与
`src/core/mysql/parse-json-plan-v2.js`（V2）。契约来源是 DBX Host 实际返回的
`EXPLAIN FORMAT=JSON`（`t8y2/dbx/main` `crates/dbx-sql/src/query_execution_sql.rs` 生成该语句，
`estimated_plan_format(Mysql) == Json`；`plugin_plan.rs` 固定 `ExplainFormat::Json` 且从不 `analyze`）。
V1 `query_block` 与 V2 `query_plan` 保持独立解析分支，V2 不伪造 V1 容器。

| MySQL JSON | ParsedMySqlNode | 说明 |
| --- | --- | --- |
| `query_block` | `structure: "query_block"` / `nodeType: "Query Block"` | V1 根与嵌套 query block |
| `query_plan` + `json_schema_version: "2.x"` | `structure: "query_plan"` / access-path `nodeType` | MySQL JSON Explain V2 根 access path；V2 使用独立递归 parser，不创建伪 `query_block` |
| `query_plan.inputs` / `inputs_from_select_list` | `children` | 按 MySQL writer 顺序递归建立统一 `ParsedPlan` 树；两种数组均受严格数组/对象校验 |
| V2 `table_name` / `schema_name` / `alias` | `relationName` / `mysql.schemaName` / `mysql.alias` | 表与 schema/alias 信息 |
| V2 `estimated_rows` | `estimatedRows` | 严格要求有限 number，不接受 numeric string |
| V2 `condition` / `pushed_index_condition` | `filter` / `indexCondition` | V2 谓词保持字符串 |
| V2 `join_type` / `join_algorithm` / `join_columns` / `hash_condition` | `mysql.*` | join 证据保留在 MySQL-specific 字段；数组不强行拼为通用字符串 |
| V2 `used_columns` / `filter_columns` / `sort_fields` / `group_items` | `mysql.*` / `sortKeys` / `groupKeys` | 类型严格校验，未知合法字段进入 `extra` |
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
| `cost_info.*` | `mysql.queryCost` / `readCost` / `evalCost` / `prefixCost` / `dataReadPerJoin` / `sortCost` | cost 字段是 numeric string，严格解析；`data_read_per_join` 是 data size，单独由 `optionalDataSize()` 解析 MySQL `human_readable_num_bytes()` 格式（1024 进制整数 + `K`/`M`/`G`/`T`/`P`/`E`/`Z`/`Y` 后缀，如 `"167K"`）并归一化为 byte 数值；未知子键进入 `extra.cost_info` |
| 其余原生键 | `extra` | 不丢弃；未知结构不会生成假节点 |

- 结构不可信时抛 `PlanParseError`：V1 缺 `query_block`、V2 缺 `query_plan`/`operation`、
  `nested_loop`/`inputs` 非数组或为空、元素不是对象、数值字段类型不符、
  `query_specifications` / `*_subqueries` 形状错误等。
- V2 必须有 `json_schema_version: "2.x"`；缺失、未知版本、同时出现 V1/V2 根或错误结构均
  fail closed，不猜测 schema。未知但合法字段进入 `extra`，不静默丢弃。
- `mode` 只支持 `estimated`：MySQL `EXPLAIN ANALYZE` 返回 TREE 文本而不是该 JSON，
  声明 `actual` 时抛 `MODE_MISMATCH`。
- **不把 MySQL cost 映射到 PostgreSQL 语义的 `startupCost` / `totalCost`**，原因见第 5 节。

### 4.3 SQL Server

实现：`src/core/sqlserver/parse-showplan-xml.js`（ShowPlanXML 语义）与 `src/core/sqlserver/xml.js`（无依赖 XML 读取）。
输入是 DBX Host 返回的 ShowPlanXML 字符串（`format: "xml"`），对应 DBX 的 Estimated Plan；插件不建立连接、
不执行 `SET SHOWPLAN_XML`。

- **XML 读取**：不新增 npm 依赖。浏览器与 `node --test` 都需要可用的 XML 读取能力，而 `DOMParser`
  在 Node 中不存在，Core 也不能触碰浏览器全局；因此自建一个迭代式（非递归）读取器，支持元素、属性、
  CDATA、注释、PI、被跳过且从不解析的 DOCTYPE、五个预定义实体与数字字符引用。元素一律按 local name
  匹配，所以 ShowPlanXML 默认命名空间与带前缀元素都能解析；不实现 DTD / 外部实体 / 命名空间解析 / schema 校验。
- **Envelope**：必须是一个 `<ShowPlanXML>`，且只有一个带 `QueryPlan` 的 `StmtSimple`。存在多个带计划的
  `StmtSimple` 时 fail closed（`MULTIPLE_STATEMENTS`），不无声取第一条；没有 QueryPlan 的 `StmtSimple`
  （例如 SET）不参与唯一性判断。出现 `RunTimeInformation` / `QueryTimeStats` 或声明 `mode: "actual"`
  时抛 `MODE_MISMATCH`。
- **Tree 构造**：每个 `RelOp` 的输入是它自己 operator 容器内的 `RelOp` 后代，遇到嵌套 `RelOp` 即停止。
  这样无需为每个算子维护表：`NestedLoops` / `Hash` / `Merge` / `Sort` / `Concat` / `Spool` /
  `Parallelism`、以及 `IndexScan Lookup="1"` 的嵌套输入都能正确挂树，未知 operator 容器也不会丢掉子树。
  `Child RelOp` 顺序即 ShowPlanXML 顺序（Nested Loops 的第一个输入是 outer）。

| ShowPlanXML | ParsedSqlServerNode | 说明 |
| --- | --- | --- |
| `RelOp@PhysicalOp` / `@LogicalOp` | `physicalOp` / `logicalOp` / `nodeType` | `nodeType` 优先取 `PhysicalOp`，缺失时回退 `LogicalOp`；两者都缺失时保留 label `"RelOp"` |
| `RelOp@NodeId` / `@EstimateRows` | `nodeId` / `estimatedRows` | |
| `RelOp@EstimatedTotalSubtreeCost` | `estimatedTotalSubtreeCost` | **子树累计代价**，不映射到 `totalCost` |
| `RelOp@EstimateCPU` / `@EstimateIO` | `estimateCpu` / `estimateIo` | 节点自身估算，同样不映射到 `totalCost` / `startupCost` |
| `RelOp@EstimateRebinds` / `@EstimateRewinds` / `@EstimateExecutions` | 同名字段 | |
| `RelOp@AvgRowSize` | `avgRowSize` | normalizer 映射为中立 `width` |
| `RelOp@Parallel` | `parallel` | SQL Server 布尔 `0` / `1` |
| `RelOp@Lookup` 与 `IndexScan@Ordered` | `operator.lookup` / `operator.ordered` | 写操作容器的配置标志，未知属性进入 `extra` |
| `Object@Database/Schema/Table/Index/Alias/IndexKind/Storage` | 同名字段 | normalizer 只把去括号后的 table / alias / index 放到中立 `relation`，原始值保留在 engineSpecific |
| `Predicate` 内的 `ScalarOperator@ScalarString` | `predicate` | normalizer 映射为中立 `filter` |
| `SeekPredicates` 的 `Prefix` / `StartRange` / `EndRange` | `indexCondition` | 保留 `ScanType`、range 列与 range 表达式，确定性拼接 |
| `OrderBy` / `OrderByColumn@Ascending` | `sortKeys` | 保留 ` ASC` / ` DESC` |
| `StreamAggregate/GroupBy` 的 `ColumnReference` | `groupKeys` | |
| `Hash/HashKeysBuild` / `HashKeysProbe` | `hashKeysBuild` / `hashKeysProbe` | 保持数组，不拼成单一字符串 |
| `Hash/ProbeResidual`、`Hash/BuildResidual`、`Merge/Residual` | `probeResidual` / `buildResidual` / `residual` | 中立 `joinCondition` 保持 `null` |
| `ComputeScalar/DefinedValues/DefinedValue` | `definedValues` | 保留 `ScalarString` 列表 |
| `Sort@Distinct`、`Top/TopSort@RowCount` / `@IsPercent`、`Merge@ManyToMany`、`Parallelism@PartitioningType` | `operator.*` | 仅固定的一组算子配置，不复制整段 XML |
| `RelOp` 未映射属性 | `extra` | 包括存在但无法解释为数字 / 布尔的原值（例如 `EstimateRows="many"`） |

- **代价语义**：`EstimatedTotalSubtreeCost` 是子树累计值，`EstimateCPU` / `EstimateIO` 是节点自身估算；
  两者都属于 SQL Server 自己的 cost model。本轮不把任何一项映射到 `startupCost` / `totalCost`，也不
  用父子相减推算 self cost；Metrics 报告 `costAttribution.status = "not-applicable"`，Hotspots 不生成
  代价占比信号。代价仅作为 `engineSpecific.sqlServer` 证据展示。
- **失败模型**：`MALFORMED_XML`（XML 读取失败，带 line / column）、`MALFORMED_PLAN`（根元素不对、
  没有带 QueryPlan 的语句 / 没有根 RelOp、payload 不是字符串）、`MULTIPLE_STATEMENTS`、`MODE_MISMATCH`。
  缺失 `EstimateRows` / cost / `Object` / `Predicate` 不会失败，对应字段为 `null`。

### 4.4 OceanBase Oracle

实现：`src/core/oceanbase/parse-json-plan.js`（JSON 语义）与 `src/core/normalize/normalize-oceanbase.js`。
输入是 DBX Host 返回的 **已解码 JSON**（`dbType: "oceanbase-oracle"`、`format: "json"`）；
宿主自己构造 `EXPLAIN FORMAT=JSON` 并把驱动逐行返回的 JSON 文本拼接后解码，插件不建立连接、不拼 `EXPLAIN`。

上游证据（本仓库未在 OceanBase 实例上回放）：`crates/dbx-sql/src/query_execution_sql.rs` 中
`estimated_plan_format(OceanbaseOracle) == Json`、`build_explain_sql` 生成 `EXPLAIN FORMAT=JSON <sql>`；
`crates/dbx-core/src/query/plugin_plan.rs` 用 `join_result_text()` 拼接逐行结果后用 `serde_json::from_str`
解码，无法解码时降级为 `format: "text"` + warning `plan_not_json`。JSON 键与 `CHILD_<n>` 子节点编码同时对照
了 OceanBase Oracle 模式 `EXPLAIN` 官方文档与引擎的 JSON plan writer（`src/sql/monitor/ob_sql_plan.cpp`）。

| OceanBase JSON | ParsedOceanBaseNode | 说明 |
| --- | --- | --- |
| `OPERATOR` | `nodeType` / `operator` | 必填语义字段；trim 后作为标签（引擎会输出尾随空格，如 `"HASH JOIN "`），原值另存 `operator` |
| `ID` | `nodeId` | 严格有限 JSON number |
| `NAME` | `name` | 原样保留（`""` 表示无对象）；normalizer 把非空值映射到中立 `relation.name` |
| `EST.ROWS` | `estimatedRows` | 严格有限 JSON number |
| `EST.TIME(us)` | `estimatedTimeUs` | 严格有限 JSON number；保留在 `engineSpecific.oceanBase`，**不**进入中立代价字段 |
| `COST` | `cost` | 部分版本 / 形状才有；同样只作为 OceanBase 自己的估算保留 |
| `output` | `output` | 字符串时映射；其他类型保留在 `extra` |
| `CHILD_<n>` | `children` | `<n>` 是算子在计划中的位置，不保证连续 / 字典序；按数字后缀升序建树，支持任意个子节点 |
| 其余键（`filter` / `access` / `range_key` / `is_index_back` / ...） | `extra` | 原样保留，不参与错误推断，**不**提升为中立谓词字段 |

- **根就是根算子**：没有 `Plan` / `query_block` 之类 envelope。payload 不是 plain object，或对象里既没有非空
  `OPERATOR` 也没有对象型 `CHILD_<n>` 时，抛 `MALFORMED_PLAN`（不把无关 JSON 当成计划）。
- **fail-soft**：未知算子保留节点、原始标签与完整子树（`kind: "unknown"`，记入 `unknownNodeTypes`）；
  缺 `ID` / `NAME` / `EST.ROWS` / `EST.TIME(us)` / `COST` / `output` 时对应字段为 `null`；
  无 `OPERATOR` 的节点用占位标签 `Plan`（与 DBX 自己的 OceanBase plan viewer 一致），且不计入 `unknownNodeTypes`；
  非对象 `CHILD_<n>` 不是树边，保留在 `extra`。
- **不伪造数字**：`EST.ROWS` / `EST.TIME(us)` / `COST` / `ID` 只接受有限 JSON number；类型不符（例如
  `"EST.ROWS": "250000"`）时字段为 `null`，原值保留在 `extra`，不把 numeric string 强转为数字。
- **代价语义**：`EST.TIME(us)`（微秒估算时间）与 `COST` 都属于 OceanBase 自己的估算模型，本轮**不**映射到
  `startupCost` / `totalCost`，也**不**新增基于它们的热点 / 规则信号；Metrics 报告
  `costAttribution.status = "not-applicable"`。
- **`mode` 只支持 `estimated`**：Host API 不提供 OceanBase Oracle 的 Actual Plan；声明 `actual` 时抛 `MODE_MISMATCH`。
- **失败模型**：`MALFORMED_PLAN`、`MODE_MISMATCH`；`format: "text"`（宿主降级路径）由 registry 报
  `UNSUPPORTED_FORMAT` 并保持 raw-only，不猜文本计划。

### 4.5 Oracle DBMS_XPLAN text

实现：`src/core/oracle/parse-text-plan.js` 与 `src/core/normalize/normalize-oracle.js`，registry 声明位于
`src/core/parsers/oracle.js`。输入是 DBX Host 对 `dbType: "oracle"` 返回的 `format: "text"` 原文；本轮只接受
Estimated `DBMS_XPLAN.DISPLAY('PLAN_TABLE', statement_id, 'TYPICAL +PREDICATE')` 形状，不猜测其他
`DBMS_XPLAN` display format、`DISPLAY_CURSOR`、`ALLSTATS LAST` 或 arbitrary SQL*Plus 输出。

**上游契约证据（已核对 `t8y2/dbx/main`，commit `7b74cb42ffa57c18eeed5f869889add0c0d0a3`）：**
`agents/drivers/oracle-go/main.go` 的 explain 路径先执行 `EXPLAIN PLAN SET STATEMENT_ID = ... FOR ...`，
再查询：

```sql
SELECT PLAN_TABLE_OUTPUT
FROM TABLE(DBMS_XPLAN.DISPLAY('PLAN_TABLE', :1, 'TYPICAL +PREDICATE'))
```

执行后 driver 清理 `PLAN_TABLE`。`crates/dbx-core/src/query/plugin_plan.rs` 只把 driver 返回的 plan rows
交给 `PluginPlanResult`，插件不建立 Oracle 连接、不读取 credential、不执行原 SQL；`crates/dbx-sql/src/query_execution_sql.rs`
负责 EXPLAIN 方言与只读安全边界。该实现证据决定了本 parser 的 format、mode 和 display-option 范围。

| DBMS_XPLAN 主表 / 尾部 | ParsedOracleNode / ParsedPlan | 说明 |
| --- | --- | --- |
| `Id` | `id` | Oracle display id，只作为原生证据与 predicate 关联，**不**参与建树；缺失或非法值为 `null` |
| `Operation` | `nodeType` / `rawOperation` | trim 后为节点标签；空值使用 `Plan` 占位，不把行丢掉 |
| `Name` | `name` | 可选原文 |
| `Rows` | `estimatedRows` | 有限数字；缺失、`-` 或不可解析为 `null` |
| `Bytes` | `bytes` | Oracle 原生估算，保留在 `engineSpecific.oracle` |
| `Cost (%CPU)` | `cost` / `cpuPercent` | 拆出 Oracle `Cost` 与 `%CPU`，不映射 PostgreSQL cost |
| `Time` | `time` | 原生时间字符串，保留在 `engineSpecific.oracle` |
| `*` marker / `Predicate Information` | `predicateMarker` / `predicates` | marker 来自主表 Id 单元格；predicate 按 operation id 关联，原文字符串保留，不猜测 filter/access 中立语义 |
| 其他主表列 / 非法已知单元格 | `extra` | 保留列名和值，不因 optional / future column 丢失 |
| `Plan hash value` | `ParsedPlan.planHashValue` | 有限数字；没有该行则为 `null` |

主表识别要求 `Id` 与 `Operation` header；列边界由 header 的语义列名和主表分隔线共同确认，并按 header 的
实际固定宽度切割数据行，因此列宽变化、可选列缺失、CRLF 和非 ASCII 对象名不会改变字段对齐。主表结束后，
`Predicate Information` 与后续 `Note` / 其他尾部 section 不会被误当成 operation row。

- **树构造**：按 `Operation` 单元格的 leading whitespace 使用 indentation stack 建树。连续行中缩进更深的
  是前一行的子节点，缩进回退则弹栈；不读取 `Id` 来决定 parent，Id 重排、缺失或不连续不影响树结构。
- **fail-soft 字段**：缺失 `Name` / `Rows` / `Bytes` / `Cost` / `%CPU` / `Time` / predicate 不失败，对应字段为
  `null`；没有 operation label 的有效 row 用 `Plan` 占位。未知 operation 保留原始 label、children，并在
  normalizer 中以 `kind: "unknown"` 记录到 `unknownNodeTypes`。
- **`mode` 只支持 `estimated`**：DBX Host 当前只请求该 Oracle Estimated Plan；声明 `actual` 抛 `MODE_MISMATCH`。
- **代价语义**：Oracle `Cost` 是 Oracle 自己的估算模型，不是 PostgreSQL 累计 `Total Cost`。Normalizer 保持
  `startupCost` / `totalCost` 为 `null`，Metrics / Hotspots 返回 `costAttribution.status = "not-applicable"`；
  `Cost`、`Bytes`、`%CPU`、`Time`、Id、marker 和 predicates 只在 `engineSpecific.oracle` 中展示。
- **失败模型**：`MALFORMED_PLAN`（payload 不是 text、找不到 `Id` + `Operation` 主表、没有 operation rows、缩进产生多个根），
  `MODE_MISMATCH`。不把未声明 display format 的文本悄悄当作 DBMS_XPLAN 计划。

## 5. NormalizedPlan

实现：`src/core/normalize/normalize-postgres.js`（PostgreSQL）、
`src/core/normalize/normalize-mysql.js`（MySQL）、`src/core/normalize/normalize-sqlserver.js`（SQL Server）与
`src/core/normalize/normalize-oceanbase.js`（OceanBase Oracle）、`src/core/normalize/normalize-oracle.js`（Oracle）。NormalizedPlan 不是字段改名，而是稳定语义层：

```text
NormalizedPlan {
  database: "postgresql" | "mysql" | "sqlserver" | "oceanbase-oracle" | "oracle",
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
| `nodeType` | `string` | 原始引擎标签，始终保留（PostgreSQL Node Type；MySQL parser 给出的稳定 label，未知 access type 为原始值；SQL Server `PhysicalOp`；OceanBase Oracle `OPERATOR`；Oracle `Operation`） |
| `relation` | `{name, alias, indexName} \| null` | 无关系信息时为 `null`；OceanBase Oracle 取 `NAME`（索引访问时为 `TABLE(INDEX)`，原样保留）；Oracle 的 `TABLE ACCESS` / `VIEW` 取 `Name`，`INDEX ... SCAN` 的 `Name` 放 `indexName` |
| `estimatedRows` | `number \| null` | PostgreSQL Plan Rows；MySQL `rows_examined_per_scan`（表）/ join prefix `rows_produced_per_join`（join 节点）；SQL Server `EstimateRows`；OceanBase Oracle `EST.ROWS`；Oracle `Rows` |
| `actualRows` / `actualStartupTime` / `actualTotalTime` / `loops` | `number \| null` | Actual 字段 |
| `startupCost` / `totalCost` | `number \| null` | PostgreSQL 估计代价；MySQL / SQL Server / OceanBase Oracle / Oracle 恒为 `null`（各自的 cost / 时间估算在 `engineSpecific` 下，语义不可直接比较） |
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

`engineSpecific`（MySQL）：`database`、`mysql`（V1 的 `structure`、`selectId`、`message`、`accessType`、
`possibleKeys`、`usedKeyParts`、`usedColumns`、`keyLength`、`ref`、`rowsExaminedPerScan`、
`rowsProducedPerJoin`、`filteredPercent`、`usingIndex`、`usingIndexForGroupBy`、`usingFilesort`、
`usingTemporaryTable`、`usingJoinBuffer`、`firstMatch`、`dependent`、`cacheable`、`queryCost`、
`readCost`、`evalCost`、`prefixCost`、`dataReadPerJoin`、`sortCost`，以及 V2 的 `schemaName`、`alias`、
`joinAlgorithm`、`joinType`、`joinColumns`、`hashCondition`、`filterColumns`、`sortFields`、
`groupItems`、`estimatedTotalCost`、`jsonSchemaVersion`）、`extra`。
**不为了"统一"丢弃数据库专有信息。**

`engineSpecific`（SQL Server）：`database`、`sqlServer`（`nodeId`、`physicalOp`、`logicalOp`、
`estimatedTotalSubtreeCost`、`estimateCpu`、`estimateIo`、`estimateRebinds`、`estimateRewinds`、
`estimateExecutions`、`avgRowSize`、`parallel`、`database`、`schema`、`table`、`index`、`alias`、
`indexKind`、`storage`、`operator`、`hashKeysBuild`、`hashKeysProbe`、`probeResidual`、`buildResidual`、
`residual`、`definedValues`，根节点额外带 `statement` / `queryPlan`）、`extra`。SQL Server 中立
`relation` 的 table / alias / index 会去掉一层 `[ ]` 引用（保留 `engineSpecific` 原始值），使树标签
与其它引擎一致。
**不为了"统一"丢弃数据库专有信息。**

`engineSpecific`（OceanBase Oracle）：`database`、`oceanBase`（`id`、`operator`、`name`、`estimatedRows`、
`estimatedTimeUs`、`cost`、`output`）、`extra`（官方 JSON 示例与引擎 JSON plan writer 未覆盖的扩展键，
以及无法映射的原值，如 `filter` / `access` / `range_key` / `is_index_back`）。OceanBase 中立 `relation`
只取 `NAME` 字符串，**不**反解 `TABLE(INDEX)`：`(Reverse)` 等后缀说明括号内容不一定是索引名，反解会伪造语义。
**不为了"统一"丢弃数据库专有信息。**

`engineSpecific`（Oracle）：`database`、`oracle`（`id`、`rawOperation`、`name`、`estimatedRows`、`bytes`、`cost`、
`cpuPercent`、`time`、`predicateMarker`、`predicates`、根节点 `planHashValue`、`extra`）。Oracle 中立 `relation`
只在语义明确时提升：`TABLE ACCESS` / `VIEW` 的 `Name` 为 `relation.name`，`INDEX ... SCAN` 的 `Name` 为
`relation.indexName`；不把 Oracle `Cost` 复制为 PostgreSQL cost。**不为了"统一"丢弃数据库专有信息。**

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

MySQL / SQL Server 侧追加的 kind（现有 metrics / rules 不依赖）：

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

SQL Server 侧追加的 kind：

| kind | SQL Server `PhysicalOp` |
| --- | --- |
| `seq_scan` | `Table Scan` |
| `index_scan` | `Clustered Index Scan` / `Index Scan` / `Columnstore Index Scan` / `Clustered Index Seek` / `Index Seek`（seek 通过 `physicalOp` 区分，不单独造 seek kind） |
| `lookup` | `Key Lookup` / `RID Lookup` |
| `hash_join` / `merge_join` / `nested_loop` | `Hash Match` + Join 类 `LogicalOp` / `Merge Join` / `Nested Loops` |
| `hash_match` | `Hash Match` 的非 Join / 非 Aggregate 用法（如 Union） |
| `aggregate` | `Stream Aggregate`、`Hash Match` + `LogicalOp = Aggregate` |
| `sort` / `limit` | `Sort` / `Top N Sort`、`Top` |
| `compute_scalar` / `filter` | `Compute Scalar` / `Filter` |
| `append` / `parallelism` / `spool` | `Concatenation` / `Parallelism` / `Table Spool` / `Index Spool` / `Row Count Spool` |
| `values_scan` | `Constant Scan` |
| `unknown` | 未登记 `PhysicalOp`；`nodeType` 与 `unknownNodeTypes` 记录原始值，子树完整保留 |

OceanBase Oracle 侧追加的 kind（现有 metrics / rules 不依赖）：

| kind | OceanBase Oracle `OPERATOR` |
| --- | --- |
| `seq_scan` | `TABLE FULL SCAN`（含 `DISTRIBUTED TABLE FULL SCAN` 变体） |
| `index_scan` | `TABLE SCAN` / `TABLE RANGE SCAN` / `TABLE SKIP SCAN` / `TABLE GET`（OceanBase 把索引回表封装在 `TABLE SCAN` 中，选中的索引写在 `NAME` 里；裸 `TABLE SCAN` 官方描述为范围扫描，因此不归入 `seq_scan`） |
| `nested_loop` / `hash_join` / `merge_join` | `NESTED-LOOP JOIN`（与 `NESTED LOOP JOIN` 等价归一）/ `HASH JOIN` / `MERGE JOIN` |
| `sort` | `SORT` |
| `aggregate` | `SCALAR GROUP BY` / `HASH GROUP BY` / `MERGE GROUP BY` / `COUNT` |
| `analytic` / `limit` / `materialize` | `WINDOW FUNCTION` / `LIMIT` / `MATERIAL` |
| `subquery_scan` / `subquery` | `SUBPLAN SCAN` / `SUBPLAN FILTER` |
| `unique` / `append` / `setop` | `HASH DISTINCT` / `MERGE DISTINCT`；`UNION ALL`；`*UNION DISTINCT` |
| `modify_table` | `INSERT` / `DELETE` / `UPDATE` / `MERGE` |
| `unknown` | 未登记算子（例如 `EXCHANGE OUT DISTRIBUTED` / `PX COORDINATOR`）；`nodeType` 与 `unknownNodeTypes` 记录原始值，子树完整保留 |

Oracle 侧追加的 kind（现有 metrics / rules 不依赖）：

| kind | Oracle `Operation` |
| --- | --- |
| `result` | `SELECT STATEMENT` |
| `seq_scan` | `TABLE ACCESS FULL` / `TABLE ACCESS STORAGE FULL` |
| `lookup` | `TABLE ACCESS BY INDEX ROWID` / `TABLE ACCESS BY USER ROWID` |
| `index_scan` | `INDEX RANGE / UNIQUE / FULL / FAST FULL / SKIP / JOIN / SAMPLE SCAN` |
| `nested_loop` / `hash_join` / `merge_join` | `NESTED LOOPS` variants / `HASH JOIN` variants / `MERGE JOIN` variants |
| `sort` / `aggregate` / `unique` | `SORT ORDER BY` / `SORT JOIN`、`SORT GROUP BY` / `SORT AGGREGATE` / `HASH GROUP BY`、`SORT UNIQUE` / `HASH UNIQUE` |
| `filter` / `subquery_scan` / `append` / `setop` | `FILTER` / `VIEW` / `UNION-ALL` / `MINUS` / `INTERSECTION` |
| `unknown` | 未登记 Operation；原始 label 与子树完整保留并记录到 `unknownNodeTypes` |

算子标签比较前会做 `trim` + 大写 + 连字符 / 空白折叠，**只用于分类**；`nodeType` 始终保留引擎原始拼写。

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
| `costAttribution` | PostgreSQL 代价归因状态：`{ engine, status, reason }`（见下方） |
| `highestIncrementalCost` | 归因安全时可归因自代价最大的节点摘要（并列取先序第一个）；不安全时为 `null` |

代价指标不直接信任 `totalCost - Σ children.totalCost`。Metrics 与 Hotspots 共用
`src/core/cost/postgres-cost.js` 的归因边界，只有当计划的 `Total Cost` 确实按子树累加时，
`highestIncrementalCost` 才会从 `analyzePostgresCost().byNodeId`（可归因节点）中选出：

```text
costAttribution.status = "available"       归因可靠，highestIncrementalCost 可展示
                       = "withheld"        边界不成立或没有可归因节点，指标为 null
                       = "not-applicable"  MySQL / SQL Server / OceanBase Oracle / Oracle 等非 PostgreSQL 计划，不进入该语义
```

withheld reason（与 `hotspots.cost.reason` 同一套）：

| reason | 含义 |
| --- | --- |
| `NO_PLAN_COST` | 根节点没有正的 Total Cost，没有分母 |
| `MISSING_NODE_COST` | 任一节点缺 Total Cost；缺失不按 `0` 处理 |
| `PLAN_CONTAINS_SUBPLAN` | 含 InitPlan / SubPlan，父代价按 `cost_subplan()` 计入，不按子树累加 |
| `UNVERIFIED_COST_FLOW` | 缺失或未知 `Parent Relationship`，代价流向无法验证 |
| `NO_ATTRIBUTABLE_COST` | 边界可靠，但没有任何可归因节点（例如根节点自身截断子节点） |
| `NOT_POSTGRES_COST_MODEL` | `status = "not-applicable"`：MySQL / SQL Server / OceanBase Oracle / Oracle 使用各自的 cost model（OceanBase 为 `EST.TIME(us)` / `COST`，Oracle 为 `Cost` / `%CPU` / `Time`，本轮不进入任何代价信号） |

单节点负自代价（如 `Limit` 截断子节点）时，该节点及其子树不参与归因，祖先仍可归因；
`src/core/tree.js` 的 `incrementalCostOf` 作为 legacy 路径继续服务 Findings，
其“子节点无 cost 记 0”的语义不再用于 Metrics / Plan Summary。

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

MySQL / SQL Server / OceanBase Oracle / Oracle 适用性（cost 语义见上）：

| rule | MySQL | SQL Server | OceanBase Oracle | Oracle |
| --- | --- | --- | --- | --- |
| `large-sequential-scan` | 适用（`Table Scan` 按估算行数触发；`totalCost` 为 `null` 时代价分支不触发，finding 里不显示 `incremental cost of 0`） | 适用（`Table Scan` 按 `EstimateRows` 触发，同样不触发代价分支） | 适用（`TABLE FULL SCAN` 按 `EST.ROWS` 触发，同样不触发代价分支） | 适用（`TABLE ACCESS FULL` 按 `Rows` 触发，同样不触发代价分支） |
| `expensive-sort` | 不适用（依赖 PostgreSQL 语义的增量代价与计划总代价，MySQL 不映射） | 不适用（`EstimatedTotalSubtreeCost` 不属于 PostgreSQL 代价语义） | 不适用（`EST.TIME(us)` / `COST` 不属于 PostgreSQL 代价语义） | 不适用（Oracle `Cost` / `Time` 不属于 PostgreSQL 代价语义） |
| `nested-loop-large-inner` | 适用（只用估算行数，`estimateOnly: true`） | 适用（只用两个输入的 `EstimateRows`，`estimateOnly: true`） | 适用（只用 `CHILD_1` / `CHILD_2` 的 `EST.ROWS`，`estimateOnly: true`） | 适用（只用两个缩进子节点的 `Rows`，`estimateOnly: true`） |

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
  facts?: Record<string, unknown>;       // optional structured facts for Presentation
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

`facts` 是可选的、可 JSON 序列化的规则事实；它不保存翻译后的句子。Issue [#26](https://github.com/0verme/dbx-plugin-plan-detective/issues/26) 首个迁移的 `large-sequential-scan` facts 包含 database / mode / runtimeVerified、节点与 relation、estimatedRows、cost、MySQL accessType 和 hasFilter。Rule 仍负责判断事实，`src/lib/finding-presentation.js` 才负责按 locale 生成 `summary`、`reasons`、`actions`、`caveats`。

`title` / `summary` / `evidence` 保留为兼容字段。没有 `facts` 或没有对应 Presenter 的旧 Finding 回退到原 title / summary，页面不会因部分迁移而失败。`zh-CN` / `en` message catalog 只承载句式与插值，不承载阈值、severity 触发或 runtime truth 判断。

`info` 为纯观察档，当前 3 条规则未使用；契约允许规则后续按需选择。
`createFinding` 会校验 severity / title / summary / node / evidence，以及存在时的 facts 容器，非法输入抛 `TypeError`。

统一入口：`src/core/analyze.js` 的 `analyzePlan(rawInput)` 返回
`{ parsed, normalized, metrics, findings, hotspots }`；未来 adapter 与 UI 只调用它即可。

### Hotspots（`src/core/hotspots/`）

Hotspot 回答的是「这棵计划里优先看哪里」，与 Finding（「命中了哪条已知模式」）分层，两者可以命中同一节点但互不派生。
实现：`src/core/hotspots/compute-hotspots.js`（信号聚合）、`src/core/hotspots/thresholds.js`（阈值）、
`src/core/cost/postgres-cost.js`（PostgreSQL 代价归因边界，Metrics 共用）。

```ts
HotspotAnalysis {
  cost: {
    engine: "postgresql" | "mysql" | "sqlserver" | "oceanbase-oracle" | "oracle",
    status: "available" | "withheld" | "not-applicable",
    reason: string | null,
  },
  items: Hotspot[],
}

Hotspot {
  id: "hotspot:<nodeId>"; nodeId; nodeType; kind; relation;
  level: "high" | "warning" | "info";          // 注意力档位 = 最强 reason
  reasons: [{ code; level; statement; source; evidence }];
  evidence: Record<string, unknown>;             // 平面 node 快照 + 可用信号值
  estimateOnly: true;                            // 当前全部信号来自 planner estimate
}
```

确定性排序：`level` → reason 数量降序 → plan pre-order。它是注意力顺序，不是性能排名、不是综合评分。
raw-only 方言的 `hotspots` 为 `null`（与 `metrics` / `normalized` 一致），不进入结构化分析。

| reason code | 引擎 | 依据 | 档位 |
| --- | --- | --- | --- |
| `large-sequential-scan` | PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle | `kind = seq_scan`；PG `Plan Rows`，MySQL `rows_examined_per_scan`，SQL Server `EstimateRows`，OceanBase Oracle `EST.ROWS`，Oracle `Rows` | ≥ 10 000 `warning`；≥ 100 000 `high` |
| `nested-loop-amplification` | PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle | 外层 × 内层估算行数（OceanBase Oracle 取 `CHILD_1` / `CHILD_2` 的 `EST.ROWS`；Oracle 取 operation 缩进的两个子节点 `Rows`） | 外层 ≥ 10 且内层 ≥ 10 000 `warning`；内层 ≥ 100 000 `high` |
| `cost-concentration` | PostgreSQL | 节点自身增量代价 / 根 Total Cost（PostgreSQL cost units） | ≥ 25% `warning`；≥ 50% `high` |
| `mysql-rows-examined` | MySQL | 非 `ALL` 访问的 `rows_examined_per_scan` | ≥ 10 000 / ≥ 100 000 |
| `mysql-filtered-out` | MySQL | `filtered` 低且 `rows_examined_per_scan` 大 | `≤ 10%` 且 ≥ 1 000 行；`≤ 1%` 且 ≥ 100 000 行 |
| `mysql-cost-concentration` | MySQL | 同一 query block 内 ≥ 2 个有代价访问的 `(read_cost + eval_cost) / query_cost`（MySQL cost units） | ≥ 25% / ≥ 50% |
| `mysql-filesort` / `mysql-temporary-table` / `mysql-join-buffer` | MySQL | `using_filesort` / `using_temporary_table` / `using_join_buffer` + 子树最大估算行数 | ≥ 10 000 / ≥ 100 000 |
| `sqlserver-large-index-scan` | SQL Server | `PhysicalOp` 为 `Index Scan` / `Clustered Index Scan` 且 `EstimateRows` 大；seek 不算 | ≥ 10 000 `warning`；≥ 100 000 `high` |
| `sqlserver-sort` | SQL Server | `kind = sort` 且 `EstimateRows` 大；仅提示“值得看”，不断定 sort 必须移除 | ≥ 10 000 `warning`；≥ 100 000 `high` |

PostgreSQL 代价归因安全边界（`cost.status = "withheld"`，只用行数信号）：

| reason | 触发 |
| --- | --- |
| `NO_PLAN_COST` | 根节点没有正的 Total Cost |
| `MISSING_NODE_COST` | 任一节点缺少 Total Cost（不把缺失当 0） |
| `PLAN_CONTAINS_SUBPLAN` | 出现 `Parent Relationship: InitPlan` / `SubPlan`（父代价由 `cost_subplan()` 计入） |
| `UNVERIFIED_COST_FLOW` | 子节点缺少 / 未知 Parent Relationship |

即使计划整体可归因，单个节点自代价为负（`Limit` 会截断子节点代价）时，该节点及其子树也不产生占比信号；
祖先节点不受影响。MySQL 侧不做任何子节点相减，只用 `read_cost + eval_cost` 相对最近外层 query block `query_cost` 的占比，
且只在同一 block 内 ≥ 2 个有代价访问时输出（单表 block 恒为 100%，无区分度）。SQL Server 侧不生成任何代价占比信号：
`EstimatedTotalSubtreeCost` 是子树累计值，`cost.status = "not-applicable"`，只用行数信号。
OceanBase Oracle 侧同样不生成代价 / 时间占比信号：`EST.TIME(us)` / `COST` 属于 OceanBase 自己的估算模型，
本轮没有任何阈值可以跨引擎比较，`cost.status = "not-applicable"`，只用 `EST.ROWS` 行数信号；
Hotspot 面板文案会按 `engine` 选择对应说明（`hotspot.cost.oceanbaseOracleCostModel`）。
Oracle 侧采用同一边界：`Cost` / `%CPU` / `Time` 只作为 `engineSpecific.oracle` 与 node snapshot 证据，
不生成代价 / 时间占比信号；`cost` 返回 `engine: "oracle"`、`status: "not-applicable"`，面板使用
`hotspot.cost.oracleCostModel`。既有 `large-sequential-scan` / `nested-loop-amplification` 只读取 Oracle `Rows`。

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

fixtures/sqlserver/                 # 仅 estimated；全部为 synthetic ShowPlanXML
├── README.md
├── estimated/
│   ├── <name>.synthetic.plan.xml # 原始 ShowPlanXML 字符串
│   └── <name>.synthetic.meta.json
└── golden/
    └── estimated/<name>.synthetic.json

fixtures/oceanbase-oracle/          # 仅 estimated；1 个 official + 11 个 synthetic
├── README.md
├── estimated/
│   ├── <name>[.synthetic].plan.json  # Host 解码后的 JSON 计划对象，原样保存
│   └── <name>[.synthetic].meta.json
└── golden/
    └── estimated/<name>[.synthetic].json

fixtures/oracle/                     # 仅 estimated；DBX TYPICAL +PREDICATE text，5 个 synthetic
├── README.md
├── estimated/
│   ├── <name>.synthetic.plan.txt    # DBMS_XPLAN 原始文本边界
│   └── <name>.synthetic.meta.json
└── golden/
    └── estimated/<name>.synthetic.json
```

- `.plan.json` / `.plan.xml` / `.plan.txt` 不重排、不裁剪、不修饰；重采后应与数据库原始输出可直接对照。
  XML fixture 以纯文本提交，loader 不做 JSON.parse，保留 host 返回的原始字符串边界。
- `.meta.json` 的 `expect` 记录该 fixture 要钉住的行为：
  `rootNodeType` / `hasActualFields` / `minDepth` / `findingRuleIds`（实际触发的 rule id 集合，
  没有触发则为 `[]`）；可选 `hotspotNodeRefs`（`analysis.hotspots.items` 的 node id 顺序，未声明则不校验）。
- 一个 fixture 只验证一个主要行为，优先小而可人工核对。
- 合成 fixture 必须在文件名中标记 `.synthetic`。
- MySQL 只有 `estimated/`：Host API 不提供 MySQL actual plan，MySQL `EXPLAIN ANALYZE` 也不是该 JSON 形状。
- SQL Server 只有 `estimated/`：Host API 只提供 Estimated Plan，`RunTimeInformation` / `QueryTimeStats`
  等 Actual 专属元素会让 parser 抛 `MODE_MISMATCH`；fixture 的 `format` 必须是 `xml`。
- OceanBase Oracle 只有 `estimated/`：Host API 只提供 Estimated Plan，fixture 的 `format` 必须是 `json`，
  且 `.plan.json` 提交的是 Host 解码后的 JSON 计划对象（不是逐行驱动文本）。
- Oracle 只有 `estimated/`：Host API 只提供 Estimated Plan，fixture 的 `format` 必须是 `text`，`.plan.txt`
  保留 DBMS_XPLAN 文本；synthetic 样本覆盖列宽变化、缺失字段、marker、CRLF、未知 operation 子树与尾部 section。
- 测试侧 loader：`tests/helpers/fixtures.js`（按 database + mode 发现 fixture、校验 metadata、生成 `RawPlanInput`）。

当前 fixture：PostgreSQL 20 个（18 个真实采集 + 2 个 synthetic；明细见 `fixtures/postgres/README.md`）；
MySQL 14 个（12 个 V1 + 2 个 V2），全部为 shape-verified synthetic（明细见 `fixtures/mysql/README.md`）；
SQL Server 14 个，全部为 synthetic ShowPlanXML（本机无 SQL Server 实例；形状对照公开 schema 与文档，
明细见 `fixtures/sqlserver/README.md`）；
OceanBase Oracle 12 个（1 个 official = OceanBase V4.3.5 Oracle 模式 `EXPLAIN` 文档中的 JSON 示例，
11 个 synthetic；本机无 OceanBase 实例，键名与算子名对照官方文档与引擎 JSON plan writer，
明细见 `fixtures/oceanbase-oracle/README.md`）；Oracle 5 个，全部为 DBX TYPICAL +PREDICATE synthetic text
（明细见 `fixtures/oracle/README.md`）。

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
.plan.json / .plan.xml ──loadFixture（校验 metadata → RawPlanInput）
      │
      ▼ analyzePlan()
{ parsed, normalized, metrics, findings, hotspots }
      │
      ▼ deepStrictEqual
fixtures/<database>/golden/<mode>/<name>.json
```

- `npm test` 对每个 fixture 逐 stage 比较；不一致即失败，并提示重新生成命令。
- `npm run test:update-goldens` 重新生成 golden。只有确认 pipeline 行为变化是有意的，才允许提交更新后的
  golden，并逐文件 review diff。
- golden 与 fixture 一一对应，不允许 orphan 文件。
- `expect.findingRuleIds` 是独立于 golden 的第二重断言：即使 golden 被一并更新，
  也必须显式确认规则触发集合的意图；声明了 `expect.hotspotNodeRefs` 的 fixture 同样会独立校验 hotspot 顺序。

## 10. 测试

```bash
npm test                      # 离线：不需要 DBX、不需要数据库、不需要 npm install
npm run test:update-goldens   # 有意变更 pipeline 后重新生成 golden
npm run analyze -- estimated/seq-scan   # 开发用：对单个 fixture 跑完整 pipeline
```

覆盖范围：契约校验、PostgreSQL / MySQL / SQL Server / OceanBase Oracle / Oracle parser 字段映射与错误路径
（含 XML namespace / malformed XML / 多 statement / 未知 operator / 未知字段 / 缺失字段 / `CHILD_<n>` 数字排序 /
非法根对象）、estimated / actual 不混淆、
NormalizedPlan 语义与 id、Metrics 计数与增量代价、3 条规则的正反例与阈值边界、
Hotspot 契约 / PostgreSQL 代价归因边界（Limit 截断、InitPlan / SubPlan、缺失代价）/ MySQL 行数与 cost_info 信号 /
SQL Server `EstimateRows` 行数信号与成本 not-applicable / OceanBase Oracle `EST.ROWS` 行数信号与 `EST.TIME(us)` 不入信号、Oracle `Rows` 行数信号与 `Cost` 不入 PostgreSQL cost、
排序稳定性、Findings 契约、golden 五 stage、determinism 与 JSON 可序列化、Plan Core 无浏览器 / DBX 依赖。

## 11. 明确不在本轮范围

本轮（Offline Core vertical slice）不实现：`dbx-adapter` 的真实 Host wiring（仅 `DBX response → RawPlanInput`
离线契约已实现，见第 2.1 节）、Execution Plan 扩展点集成、
DBX Host API 调用、数据库 Driver / 连接池 / 凭据、Actual Plan 获取、
Dameng / Doris / QuestDB parser、MariaDB / OceanBase MySQL / ADB MySQL 的自动兼容、
其他未声明方言的文本计划 parser、Plan Diff、History、Plan Canvas、AI / LLM、SQL Rewrite、自动建索引、性能评分。

以上均按独立 Issue 推进；Host 接入仍等待 t8y2/dbx#9675 / [PR #9692](https://github.com/t8y2/dbx/pull/9692) 落地，
落地后只需把 Host 返回值交给第 2.1 节的 Adapter，将 `rawPlan` 映射为本文第 2 节的 `RawPlanInput`。

> 更新（2026-09-20，Issue [#19](https://github.com/0verme/dbx-plugin-plan-detective/issues/19)）：
> Hotspot Analysis 已实现（`src/core/hotspots/**`）：确定性、engine-aware、无综合评分，与 Findings 分层；
> golden 增加 `hotspots` stage；UI 新增 Hotspots 面板（Plan Summary → Hotspots → Findings → Plan Tree → Raw Plan）。
> Parser / NormalizedPlan / Metrics / Rules / Findings 语义与阈值未变。

> 更新（2026-09-20，Issue [#7](https://github.com/0verme/dbx-plugin-plan-detective/issues/7)）：
> Fixture-driven MVP UI 已实现（Fixture Selector / Plan Summary / Findings / Plan Tree / Node Inspector）。
> 它**消费同一份契约**，没有修改本文的 Parser / NormalizedPlan / Metrics / Rules / Findings 语义、
> 阈值与 golden；fixture 仍在构建期从 `fixtures/postgres/**` 读取，未复制为代码常量。
> UI 层禁止事项（Host API、Driver、Plan Canvas、评分、AI）与 Core 一致。

> 更新（2026-09-21，Phase 3.1 · SQL Server ShowPlanXML Structured Parser）：
> SQL Server 已从 raw-only 升级为 structured：新增 `src/core/sqlserver/**`（无依赖 XML 读取 + ShowPlanXML RelOp 映射）、
> `src/core/normalize/normalize-sqlserver.js` 与 `src/core/parsers/sqlserver.js`（registry：`sqlserver` + `xml`）。
> `EstimatedTotalSubtreeCost` / `EstimateCPU` / `EstimateIO` 保留在 `engineSpecific.sqlServer`，**不**映射到
> `startupCost` / `totalCost`，`costAttribution.status = "not-applicable"`；Hotspots 新增 SQL Server 行数信号
> （`sqlserver-large-index-scan` / `sqlserver-sort`），不生成任何代价占比信号。
> 新增 14 个 synthetic ShowPlanXML fixture（含 object / seek predicate / sort key / hash key / residual / defined value
> / unknown operator / 缺失字段 / Top / Concatenation / Parallelism 覆盖）与对应 golden；root-only 的规则集合扩为
> 3 条（`large-sequential-scan` / `expensive-sort` / `nested-loop-large-inner`）对 SQL Server 的适用范围已在第 6 节标注。
> Actual Plan / RunTimeInformation / Plan Diff / AI / SQL Rewrite 仍不在范围内。

> 更新（2026-09-22，Phase 3.2 · OceanBase Oracle Structured Parser）：
> OceanBase Oracle 已从 raw-only 升级为 structured：新增 `src/core/oceanbase/parse-json-plan.js`（`ID` / `OPERATOR` /
> `NAME` / `EST.ROWS` / `EST.TIME(us)` / `COST` / `output` / `CHILD_<n>` 映射）、
> `src/core/normalize/normalize-oceanbase.js` 与 `src/core/parsers/oceanbase-oracle.js`（registry：
> `oceanbase-oracle` + `json`，见第 4.4 节）。
> 上游证据：DBX 对 OceanBase Oracle 走 `EXPLAIN FORMAT=JSON`（`estimated_plan_format == Json`），
> Host 把驱动逐行返回的 JSON 文本拼接后解码，因此插件收到的是已解析的 JSON 对象；
> `format: "text"`（宿主 `plan_not_json` 降级）仍走 raw-only，不猜文本计划。
> `EST.TIME(us)` / `COST` 保留在 `engineSpecific.oceanBase`，**不**映射到 `startupCost` / `totalCost`，
> `costAttribution.status = "not-applicable"`；本轮**不新增** OceanBase 专属 hotspot 规则，
> 只让既有 `large-sequential-scan` / `nested-loop-amplification` 行数信号工作，并把它们的 `source`
> 按引擎标为 `EST.ROWS`。新增 12 个 fixture（1 个 official 文档示例 + 11 个 synthetic）与对应 golden。
> Oracle 已由 Phase 3.3 升级为 DBMS_XPLAN structured parser；Dameng / Doris / QuestDB、Actual Plan、Plan Diff / AI / SQL Rewrite 仍不在范围内。

> 更新（Phase 3.3 · Oracle DBMS_XPLAN Estimated Plan Structured Parser）：
> Oracle 已从 raw-only 升级为 structured：新增 `src/core/oracle/parse-text-plan.js`（主表 header / separator 边界、可变列宽、缺失字段、CRLF、predicate marker / section、Operation indentation stack）与
> `src/core/normalize/normalize-oracle.js`、`src/core/parsers/oracle.js`（registry：`oracle` + `text`，只接受 DBX 当前的 `TYPICAL +PREDICATE` 输出）。
> 上游证据：`t8y2/dbx/main` commit `7b74cb42ffa57c18eeed5f869889add0c0d0a3` 的 `agents/drivers/oracle-go/main.go` 使用
> `EXPLAIN PLAN SET STATEMENT_ID = ... FOR ...`，随后查询 `DBMS_XPLAN.DISPLAY('PLAN_TABLE', :1, 'TYPICAL +PREDICATE')`，执行后清理 `PLAN_TABLE`；Host 只传递 raw plan，插件不连接数据库。
> `Rows` 映射为 `estimatedRows`；Oracle `Cost` / `Bytes` / `%CPU` / `Time` / Id / predicates 仅保留在 `engineSpecific.oracle`，不映射 PostgreSQL `startupCost` / `totalCost`，`costAttribution.status = "not-applicable"`。
> 新增 5 个 synthetic text fixture + golden，覆盖可变列宽、缺失字段、predicate marker、未知 operation 子树和共享 Metrics / Hotspots / UI 链路。
