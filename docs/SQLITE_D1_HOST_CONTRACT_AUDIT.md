# SQLite 与 Cloudflare D1 Host Plan API 契约审计（Issue #105 Phase 0）

关联：
- 插件 Issue：[#105 feat: support SQLite EXPLAIN QUERY PLAN and Cloudflare D1 (phased)](https://github.com/0verme/dbx-plugin-plan-detective/issues/105)
- 上游 Issue：[t8y2/dbx#14879](https://github.com/t8y2/dbx/issues/14879)
- 上游 SQLite PR：[t8y2/dbx#14885](https://github.com/t8y2/dbx/pull/14885)（**MERGED**，`60ad2a12c198ec97724dd5b9c50bf747cb8b70c1`）
- 上游 DuckDB PR：[t8y2/dbx#14899](https://github.com/t8y2/dbx/pull/14899)（**MERGED**，`5d2997acd601e43ffd9c0975b577f53cc219c11a`）

## 审计结论摘要

| 目标方言 | 上游 Host Plan API 状态 | 插件 Phase 1 / Phase 2 结论 |
| --- | --- | --- |
| **SQLite** (`dbType: "sqlite"`) | **VERIFIED（上游源码与核心驱动测试已合并）** | 可直接按 `#14885` 的冻结契约实现 Phase 1 结构化 parser、normalizer、fixtures 与 UI；真实 DBX Desktop GUI 手工验收待在包含 `#14885` 的 Desktop 构建上执行 |
| **Cloudflare D1** (`dbType: "cloudflare-d1"`) | **BLOCKED（上游 capability 仍显式关闭）** | `#14885` 与 `#14899` 均在 `query_execution_sql.rs` 测试中断言 `estimated_plan_strategy(Some(DatabaseType::CloudflareD1)).is_none()`；Phase 2 继续阻塞，插件不绕过 Host 或伪造支持 |

## 1. SQLite Host Plan API 契约证据（VERIFIED）

依据上游已合并的 [t8y2/dbx#14885](https://github.com/t8y2/dbx/pull/14885)：

1. **Strategy 与 SQL 生成**（`crates/dbx-sql-core/src/query_execution_sql.rs`）：
   - `DatabaseType::Sqlite` 注册为 `EstimatedPlanStrategy { sql_generation: SqliteQueryPlan, acquisition: GeneratedSql, format: Json }`。
   - `build_explain_sql` 生成 `EXPLAIN QUERY PLAN <sql>`；即使传入 `analyze: Some(true)` 也只生成 `EXPLAIN QUERY PLAN`，绝不生成或执行 `EXPLAIN ANALYZE`。
   - 沿用 Host 只读 SQL 安全校验，拒绝 `DELETE`、多语句等非安全语句。
2. **结构化行序列化**（`crates/dbx-core/src/query/plugin_plan.rs`）：
   - `strategy.returns_structured_rows()` 对 SQLite 为 `true`，调用 `structured_plan_rows(&result)`。
   - 宿主将列名统一转为 ASCII 小写，并强制校验结果非空、无重复列名且包含必填列 `["id", "parent", "notused", "detail"]`；每行转换为 JSON Object，最终作为 JSON Array 放入 `PluginPlanResult.raw_plan`（`format: "json"`）。
   - 若驱动层截断了结果行，`mark_plan_rows_truncated` 将 `payload.truncated` 置为 `true` 并追加 `"plan_rows_truncated"` warning。
3. **Bridge 响应示例**（`packages/app-tests/pluginPlanHostApi.test.ts`）：
   ```json
   {
     "dbType": "sqlite",
     "format": "json",
     "rawPlan": [
       { "id": 3, "parent": 0, "notused": 0, "detail": "SEARCH example USING INDEX idx_example_name" }
     ],
     "truncated": false,
     "warnings": []
   }
   ```

## 2. Cloudflare D1 状态（BLOCKED）

- 在 `t8y2/dbx#14885` 与 `t8y2/dbx#14899` 合并后，`crates/dbx-sql-core/src/query_execution_sql.rs` 仍显式断言 `DatabaseType::CloudflareD1` 的 `estimated_plan_strategy` 为 `None`、`supports_explain_plan` 为 `false`。
- 因此插件在 Phase 1 仅注册并映射 `dbType: "sqlite"`，不映射 Cloudflare D1，也不引入任何 Cloudflare API / Token 直连逻辑。
