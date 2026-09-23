# Doris Estimated Plan Host Contract Audit

审计日期：2026-09-23
Host 源码：`t8y2/dbx` `origin/main`，commit `d5a05a98840e54726bfec0c7dadabb8dc9a4c755`（本轮 fetch 后读取；不修改上游仓库）

## 结论

```text
dbType: doris
format: text
mode: estimated
generated SQL: EXPLAIN <source SQL>
driver-native: false
rawPlan: string
```

Doris 走普通 Host `explainPlan` 路径，由 DBX 在已打开的当前连接上构造 `EXPLAIN`、执行只读计划请求并把行文本拼成一个字符串；Plan Detective 不生成 EXPLAIN、不连接数据库、不接触 Driver / Credential。

## 源码证据

| 文件 / 符号 | 审计发现 |
| --- | --- |
| `crates/dbx-sql/src/query_execution_sql.rs`：`supports_explain_plan` | Doris 在 Host 支持列表中。 |
| 同文件：`build_explain_sql` | `DatabaseType::Doris` 分支生成 `format!("EXPLAIN {source}")`，不是 MySQL `FORMAT=JSON`。SQL 先经过 DBX 的 read-only safety gate 与单语句检查。 |
| 同文件：`estimated_plan_format` | Doris 映射为 `EstimatedPlanFormat::Text`。 |
| `crates/dbx-core/src/query/plugin_plan.rs`：`uses_driver_native_plan` | 仅 `Dameng | Oracle` 为 true，Doris 为 false。 |
| 同文件：`validate_plugin_plan_request` | Host API 只接受精确值 `mode == "estimated"`；`actual`、`analyze`、`autotrace` 等均拒绝。 |
| 同文件：`native_estimated_plan` | `build_explain_sql` 收到 `analyze: None`，普通执行路径在当前 DBX connection 上执行 Host 构造的计划语句。 |
| 同文件：`join_result_text` | 把 QueryResult 的各 row / cell 转成文本，以 `\n` 连接；计划不以每行数组对象传给插件。 |
| 同文件：`finalize_plan_payload` | text 结果保留为 JSON string；序列化 payload 上限 4 MiB。文本可按 UTF-8 字符边界截断并设置 `truncated=true` / `plan_truncated`。 |
| 同文件：`PLUGIN_PLAN_MAX_ROWS` 与 QueryExecutionOptions | 最多收集 20,000 行；Driver/QueryResult 行截断设置 `truncated=true` / `plan_rows_truncated`。 |
| `apps/desktop/src/lib/diagram/explainPlan.ts`：`parseDorisExplain` | DBX 自身 Doris viewer 把每个非空文本行平铺为普通 `Plan` node；这里只视为 raw-ish viewer 实现，不作为 Plan Detective parser contract。 |
| `apps/desktop/src/lib/__tests__/query/dorisExplainPlan.spec.ts` | 测试确认 Doris 支持、raw 原文保留，并断言每个非空行变成一个普通节点；不证明 Doris operator tree / fragment semantics。 |

## 完整 Host Contract

| 字段 | 核验结果 |
| --- | --- |
| `dbType` | `"doris"` |
| `format` | `"text"` |
| `mode` | 仅 `"estimated"`；请求验证阶段 fail-closed。 |
| generated SQL | `EXPLAIN <source SQL>`；不追加 `FORMAT=JSON`。 |
| driver-native | 否；`uses_driver_native_plan()` 只匹配 Dameng / Oracle。 |
| execution path | Plugin `host.explainPlan(mode="estimated")` → DBX open-connection / capability gate → `build_explain_sql()` → DBX read-only gate → 当前 DBX connection 执行 `EXPLAIN <sql>` → `QueryResult` → `join_result_text()` → `rawPlan`。 |
| `rawPlan` type | string (`PluginPlanResult.raw_plan` 序列化为 JSON string)。 |
| row join strategy | QueryResult 所有 rows/cells 转成文本，以单个 `\n` 连接；插件收到单一 text payload。 |
| max rows | 20,000。超限以 `plan_rows_truncated` warning 表示。 |
| max bytes | `limits.maxPlanBytes = 4 * 1024 * 1024`，按序列化 payload 字节计；text 超限可截断到上限。 |
| truncation | 任一 rows / bytes 截断均令 `truncated=true`；Plan Detective adapter 会拒绝截断 payload，不把不完整计划送进 parser。 |
| warnings | Doris 文本计划可能有 `plan_rows_truncated`、`plan_truncated`；`plan_not_json` 仅是 JSON 解码失败降级路径，不适用于 Doris `format=text`。 |
| actual/analyze reachable | 不可达。Host API 固定 `estimated`，请求不接受其他 mode，Host 调用 `build_explain_sql` 时 `analyze=None`；本轮不增加任何执行用户 SQL 的路径。 |

Host 的只读边界依赖 DBX 的既有 SQL 安全门及已打开连接；插件不得绕过 Host，自行构造 EXPLAIN、Driver 调用或连接。

## Doris viewer 与 parser 的边界

`t8y2/dbx/main` 的 `parseDorisExplain()` 仍是逐行普通节点的可视化实现。它没有表达 `PLAN FRAGMENT`、Fragment local operator tree、`SINK` 或跨 Fragment `EXCHANGE ID` 关联的 Plan Detective 语义。本项目不得复制或把该实现当成 structured contract。
