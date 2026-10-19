# GaussDB / Huawei DWS Estimated JSON fixtures

These fixtures are **synthetic, hand-authored parser tests**, not real database captures. They use only generic placeholder identifiers and small invented estimate values to exercise the PostgreSQL-family JSON envelope plus representative DWS-style node/property names. They do not assert compatibility with a real GaussDB / Huawei DWS release. No database was contacted and no business SQL, host, schema, table, account, or connection data is included.

The fixture set does not establish that every GaussDB connection is Huawei DWS. The Host adapter only maps `dbType: "gaussdb"` when the same connection's runtime `getPlanCapabilities` result affirmatively reports `supports.estimatedPlan: true`; older or unsupported Hosts fail closed before parsing.

Coverage includes JSON array envelope, `Streaming` / `Gather`, Hash Join, aggregate, sort, WindowAgg, Values Scan, Append, Seq Scan, native estimates and unrecognized-node subtree preservation. GaussDB/DWS native costs are retained for inspection, not fed into PostgreSQL cost attribution or represented as elapsed time.

Real GaussDB 9.1.1 Host / database evidence is not included in these fixtures. Record a new source-reported, sanitized fixture only after the actual Host capture is available and reviewed for sensitive content.
