# Oracle DBMS_XPLAN fixtures

These fixtures cover the Oracle text plan contract used by DBX: `EXPLAIN PLAN`
followed by `DBMS_XPLAN.DISPLAY('PLAN_TABLE', statement_id, 'TYPICAL +PREDICATE')`.
They are synthetic, estimated-only samples for the structured parser and are
not captured from an Oracle instance.

- `.plan.txt` keeps the host-returned text boundary intact.
- Table columns intentionally vary between fixtures.
- Tree parentage is encoded by operation-column indentation, not by `Id`.
- Oracle `Cost`, `Bytes`, `%CPU`, `Time`, predicate markers and predicate text
  remain under `engineSpecific.oracle`; Oracle `Cost` is never PostgreSQL
  `startupCost` / `totalCost`.
