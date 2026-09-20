# PostgreSQL Fixtures

本目录存放 PostgreSQL 执行计划的**离线样本**，是 Parser、Normalizer、Metrics、Rule Engine 与 UI 的
一等开发与测试输入。

```text
raw fixture → parser → normalized → metrics → findings → golden expected JSON
```

完整约定（契约、provenance、golden 机制、estimated vs actual 语义、规则阈值）见
[docs/PLAN_INPUT_AND_FIXTURES.md](../../docs/PLAN_INPUT_AND_FIXTURES.md)。

## 当前样本

### estimated（EXPLAIN）

| Fixture | Root | 主要验证 |
| --- | --- | --- |
| `estimated/seq-scan` | Seq Scan | 单节点计划；不出现任何 Actual 字段；小表不触发规则 |
| `estimated/index-scan` | Index Scan | Index Scan 字段 + 原生字段进入 `extra` |
| `estimated/hash-join` | Hash Join | 多节点树 + `Hash` 子树 |
| `estimated/nested-loop` | Nested Loop | LATERAL + 三级树 + `Limit` |
| `estimated/aggregate-sort` | Sort | Sort → Aggregate 结构 |
| `estimated/large-seq-scan` | Seq Scan | 200 000 估算行数；`large-sequential-scan` 触发 `high` |
| `estimated/filtered-seq-scan` | Seq Scan | 非索引谓词 14 093 估算行；`large-sequential-scan` 触发 `warning` |
| `estimated/bitmap-scan` | Bitmap Heap Scan | Bitmap Heap Scan + Bitmap Index Scan 子节点；不触发规则 |
| `estimated/index-only-scan` | Aggregate | Index Only Scan（依赖 `setup.sql` 的 VACUUM）；不触发规则 |
| `estimated/merge-join` | Merge Join | 内层 Sort + Seq Scan；sort 增量代价低于 expensive-sort 阈值 |
| `estimated/nested-loop-large-inner` | Nested Loop | 内层估算 66 667 行；同时触发 `nested-loop-large-inner` 与 `large-sequential-scan` |
| `estimated/expensive-sort` | Sort | Sort 增量代价占主导；同时触发 `expensive-sort` 与 `large-sequential-scan` |
| `estimated/group-by-status` | Group | 并行计划：Group ← Gather Merge ← Sort ← Aggregate ← Seq Scan |
| `estimated/future-properties.synthetic` | Nested Loop | `synthetic` provenance + 未知 / 未来**属性**不导致失败 |
| `estimated/unknown-node.synthetic` | Future Shuffle Node | 未知**节点类型**保留类型、children 与未知属性 |

### actual（EXPLAIN ANALYZE）

| Fixture | Root | 主要验证 |
| --- | --- | --- |
| `actual/seq-scan` | Seq Scan | Actual Rows / Actual Total Time / Actual Loops = 1 |
| `actual/nested-loop-loops` | Nested Loop | 内层节点 `Actual Loops = 80` |
| `actual/estimate-mismatch` | Seq Scan | `Plan Rows = 20` vs `Actual Rows = 3600` |
| `actual/multi-level-aggregate` | Sort | 五级树；每一层都有 Actual 字段 |

每个 `.plan.json` 都配有同名 `.meta.json`，记录来源、版本、采集命令、SQL、features 与 `expect`
（含 `findingRuleIds`）。

## Provenance 分类

- `locally-generated` —— 本地 PostgreSQL 15.19 真实 `EXPLAIN` 输出；测试库表由 `setup.sql` 建立，
  数据是合成的。共 17 个。
- `synthetic` —— 人工构造的最小结构，**未**经过任何数据库；文件名以 `.synthetic` 标记。共 2 个。

不得把 synthetic 写成真实采集；不得提交生产 SQL、真实业务表名、用户数据、连接信息或凭据。

## 重新采集

```bash
# 1. 建表 + 插入合成测试数据（可重复执行；含 200 000 行 pd_fix_events 与 VACUUM）
psql -h <host> -U <user> -d <test-db> -v ON_ERROR_STOP=1 -f fixtures/postgres/setup.sql

# 2. 按对应 .meta.json 的 captureCommand 重新导出原始 payload
psql -h <host> -U <user> -d <test-db> -At -c "EXPLAIN (FORMAT JSON) <sql>" \
  > fixtures/postgres/estimated/<name>.plan.json
psql -h <host> -U <user> -d <test-db> -At -c "EXPLAIN (ANALYZE, FORMAT JSON) <sql>" \
  > fixtures/postgres/actual/<name>.plan.json

# 3. 重新生成 golden 并运行测试
npm run test:update-goldens
npm test
```

注意事项：

- `.plan.json` 必须原样保存数据库输出，不要手工重排或裁剪。
- `merge-join` 通过 `SET enable_hashjoin = off; SET enable_nestloop = off;` 在采集会话中取得
  Merge Join 节点；`SET` 已写入其 `captureCommand`。这只影响采集，不代表插件会设置 planner GUC。
- `index-only-scan` 依赖 `setup.sql` 末尾的 `VACUUM (ANALYZE)`（visibility map）。
- `nested-loop-large-inner` 使用 `JOIN LATERAL (… OFFSET 0)` 阻止子查询被上拉，从而得到内层大估算值；
  这是采集手段，不代表生产的 SQL 形态。
- 重新采集不同 PostgreSQL 主版本时，节点类型与估算可能变化；golden 需按有意变更 review 后更新。
