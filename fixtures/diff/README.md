# Plan Diff Core fixtures

These before/after pairs are **synthetic**, hand-assembled parser inputs. They are not captured plans, live database executions, or evidence that the hypothetical index improves query performance. Database versions are intentionally unknown (`null`). Each `.synthetic.meta.json` follows the repository fixture provenance convention; because no query was executed, the top-level captured `sql` is `null`, while the hypothetical query and operation are recorded under `expect`.

| Pair | Change scenario | SQL | Expected observation |
| --- | --- | --- | --- |
| `postgresql/index-*.synthetic` | Hypothetical `orders_status_idx` added | `SELECT * FROM orders AS o WHERE o.status = 'open';` | `Seq Scan` → `Index Scan`, relation occurrence remains matchable, index name and estimated rows are field changes. |
| `mysql/index-*.synthetic` | Hypothetical `idx_orders_status` added | `SELECT * FROM orders WHERE status = 'OPEN';` | `Table Scan` → `Index Lookup`, relation occurrence remains matchable, native MySQL cost stays in engine-specific evidence and is not converted into PostgreSQL cost. |

These focused Diff fixtures live outside the general parser/golden corpus so they can describe paired change scenarios without changing single-plan golden snapshots.
