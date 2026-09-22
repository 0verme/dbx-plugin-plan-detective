# Dameng EXPLAIN fixtures

These fixtures cover the Dameng DM8 Estimated `EXPLAIN` text contract returned
by the DBX driver-native path. Operation rows use the documented
`[cost, rows, bytes-per-row]` tuple; tree parentage comes from indentation and
`Predicate Information` rows are associated by operation id.

- `official-nested-loop-index-join.plan.txt` is the published Dameng
  documentation example, transcribed without changing its plan rows.
- The `.synthetic` fixtures are hand-written shape tests for parser and shared
  pipeline coverage. They are not captures from a Dameng instance and were not
  executed.
- Dameng `cost` stays under `engineSpecific.dameng`; it is not PostgreSQL
  `startupCost` / `totalCost` and is not used for cost hotspots or rules.
- No `actual/` directory is intentional: this phase supports Estimated Plan
  only and does not implement Actual Plan or autotrace.

Shape references:

- [Dameng 查询优化：执行计划](https://eco.dameng.com/document/dm/zh-cn/pm/query-optimization.html)
- [Dameng SQL 调优](https://eco.dameng.com/document/dm/zh-cn/pm/sql-tuning.html)
- [Dameng 执行计划操作符](https://eco.dameng.com/document/dm/zh-cn/pm/dm8-admin-manual-appendix4.html)
