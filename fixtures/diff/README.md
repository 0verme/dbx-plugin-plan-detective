# Plan Diff Core fixtures

These before/after pairs are **synthetic**, hand-assembled parser inputs. They are not captured plans, live database executions, or evidence that the hypothetical index improves query performance. Database versions are intentionally unknown (`null`). Each `.synthetic.meta.json` follows the repository fixture provenance convention; because no query was executed, the top-level captured `sql` is `null`, while the hypothetical query and operation are recorded under `expect`.

| Pair | Change scenario | SQL | Expected observation |
| --- | --- | --- | --- |
| `postgresql/index-*.synthetic` | Hypothetical `orders_status_idx` added | `SELECT * FROM orders AS o WHERE o.status = 'open';` | `Seq Scan` → `Index Scan`, relation occurrence remains matchable, index name and estimated rows are field changes. |
| `mysql/index-*.synthetic` | Hypothetical `idx_orders_status` added | `SELECT * FROM orders WHERE status = 'OPEN';` | `Table Scan` → `Index Lookup`, relation occurrence remains matchable, native MySQL cost stays in engine-specific evidence and is not converted into PostgreSQL cost. |
| `mysql/subquery-*.synthetic` | The same `orders` scan moves from the top-level query block into an attached subquery | `SELECT * FROM orders WHERE status = 'OPEN';` | Parser-path regression: MySQL query-scope evidence (`query_block` / `attached_subqueries` + `select_id`) keeps the scan unmatched across the boundary, while the identical scope still matches. |
| `mysql/message-*.synthetic` | A scan-free query block changes only its optimizer message | `SELECT * FROM orders WHERE 1 = 0;` | Parser-path regression: `Impossible WHERE` → `Select tables optimized away` is reported as an `engineSpecific.mysql.message` change instead of an empty diff. |
| `postgresql/mixed-subplan-*.synthetic` | Main relation scan remains while a constant InitPlan changes to SubPlan | `SELECT * FROM orders AS o WHERE (SELECT 1) > 0 AND o.status = 'open';` | Parser-path regression: the scan still matches; the no-scan subplan and mixed Result ancestor fail closed when role/name identity changes. |
| `postgresql/scan-subplan-*.synthetic` | A Seq Scan root has a direct no-scan InitPlan child changed to SubPlan | `SELECT * FROM orders AS o WHERE (SELECT 1) > 0 AND o.status = 'open';` | Parser-path regression: relation-scan matching includes descendant subplan identity, so the root does not match across role/name changes. |

These focused Diff fixtures live outside the general parser/golden corpus so they can describe paired change scenarios without changing single-plan golden snapshots.
