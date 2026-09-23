/**
 * OceanBase Oracle structured parser entry.
 *
 * Wraps the OceanBase Oracle stages behind the parser registry shape:
 *
 *     RawPlanInput -> parseOceanBaseJsonPlan -> normalizeOceanBasePlan -> NormalizedPlan
 *
 * The stages are unchanged; this file only declares which database family and
 * format the registry may route here. DBX asks OceanBase Oracle for
 * `EXPLAIN FORMAT=JSON` and returns the decoded JSON payload as `format:
 * "json"`; the plugin never opens a connection and never builds the EXPLAIN
 * statement itself.
 *
 * `format: "text"` is deliberately not claimed: if a host answers with
 * `plan_not_json`, DBX downgrades the payload to text, and the registry reports
 * that combination as raw-only instead of guessing at a text plan.
 */

import { createOceanBaseJsonParser } from "./oceanbase-json.js";

export const oceanBaseOracleParser = createOceanBaseJsonParser("oceanbase-oracle");
