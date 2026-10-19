# GaussDB / Huawei DWS Host contract audit

**Checked:** 2026-10-19. This is a source/API audit, not a live DBX Host or database test.

## Host-owned boundary

Plan Detective must use DBX's `host.getPlanCapabilities(connectionId)` and `host.explainPlan(request)` bridge methods, with the manifest permission `host.plans:read`. The Host owns the connection, credentials, SQL safety check, EXPLAIN construction/acquisition, timeout and payload limit. The plugin supplies the user's SQL with `mode: "estimated"`; there is no plugin field for an EXPLAIN statement or driver command. Never execute EXPLAIN directly or fall back to a plugin-owned connection.

The current DBX API contract in `apps/desktop/src/types/pluginPlan.ts` defines:

- capabilities: `dbType`, optional stored `dbVersion`, `supports.estimatedPlan`, and timeout/byte limits;
- result: `dbType`, optional `dbVersion`, `format` (`json` / `xml` / `text`), `rawPlan`, `truncated`, and warnings;
- host ceiling: 4 MiB raw plan. A non-JSON Host response can be reported as text (`plan_not_json`) rather than guessed as JSON.

The contract does **not** return a DWS profile / product-identity field. Consequently this plugin only trusts an affirmative capability returned by the Host for the same connection; `dbType: "gaussdb"`, a version string, or a familiar JSON envelope alone is not identity proof. The adapter rejects an unconfirmed capability, rejects capability/result dialect mismatches and preserves the original Host payload for Raw Plan display. Old Hosts without the API/capability fail closed before `explainPlan` is called.

## DBX implementation status

The current upstream DBX `main` snapshot checked for this audit is `cb4406c715bc778d101f7ca3c9f8737b53392071` (2026-10-19). Its `crates/dbx-core/src/query/plugin_plan.rs` still derives the capability from `supports_explain_plan`; `crates/dbx-sql-core/src/query_execution_sql.rs` still treats `DatabaseType::Gaussdb` as unsupported for Estimated Plan. DBX Issue #12601 records the earlier source snapshot `5e8c754f412b941f0ececb377d98b851a1161bbd` and reaches the same conclusion. The fact that GaussDB may pass a general read-only EXPLAIN SQL safety check is not Plugin Host Estimated Plan support.

As of this check, upstream DBX [Issue #12601](https://github.com/t8y2/dbx/issues/12601) remains open and [PR #12644](https://github.com/t8y2/dbx/pull/12644) is open and Draft, updated 2026-10-19 and targeting `main` from `feat/12601-dws-estimated-plan`. It is not merged, so this plugin change depends on a future Host that advertises the capability.

The Draft PR diff implements a `gaussdbProductProfile: "huawei-dws"` profile signal for the native GaussDB driver and routes the matching Host plan strategy to JSON. Generic GaussDB and M-JDBC remain unsupported. In the inspected diff, the positive capability is selected by that explicit profile; the Plugin Host API does not expose the profile itself, and the diff does not apply a server-version allowlist before enabling the strategy. Thus a positive capability is Host's profile decision, not independent plugin proof that a server is specifically version 9.1.1. Do not describe the upstream change as merged or as runtime-verified.

## Plugin behavior and limits in this branch

- `src/lib/analysis-session.js` fetches capabilities before requesting exactly one estimated plan and refuses unsupported / older Hosts without probing `explainPlan`.
- `src/core/adapter/dbx-plan-response.js` maps `gaussdb` only with affirmative same-connection `supports.estimatedPlan` and a matching response `dbType`.
- `src/core/gaussdb/parse-json-plan.js` accepts only Estimated JSON and a bounded one-element JSON envelope; text/XML remains raw-only, malformed, actual, over-depth and over-node-count inputs fail safely.
- GaussDB shares the PostgreSQL-family JSON tree walker, but has a separate normalizer and is **not** normalized as PostgreSQL. DWS native cost values remain under engine-specific fields for inspection; PostgreSQL cost attribution, cost-based findings and cost hotspots are withheld. Row estimates remain available where the source reports them.
- Fixtures in `fixtures/gaussdb` are expressly synthetic, hand-authored parser tests. They are not captured from GaussDB 9.1.1 and are not Host integration evidence.

## Live verification status

No Windows mount, running DBX desktop process, or accessible live DBX Host / DWS connection was found in the current Linux workspace. This turn did not invoke the real `getPlanCapabilities` / `explainPlan` bridge, query a database, capture a real 9.1.1 plan, or verify the GUI. These checks remain **not run**, not passed. Any future real fixture needs a sanitized Host capture and a reviewed provenance sidecar; never place secrets or business SQL in fixtures.
