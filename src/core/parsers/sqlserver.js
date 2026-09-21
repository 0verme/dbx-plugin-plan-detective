/**
 * SQL Server structured parser entry.
 *
 * Wraps the SQL Server stages behind the parser registry shape:
 *
 *     RawPlanInput -> parseSqlServerShowPlanXml -> normalizeSqlServerPlan -> NormalizedPlan
 *
 * The stages are unchanged; this file only declares which database family and
 * format the registry may route here. DBX asks SQL Server for ShowPlanXML and
 * returns it as the `xml` string; the plugin never opens a connection and never
 * runs `SET SHOWPLAN_XML` itself.
 */

import { normalizeSqlServerPlan } from "../normalize/normalize-sqlserver.js";
import { parseSqlServerShowPlanXml } from "../sqlserver/parse-showplan-xml.js";

export const sqlserverParser = Object.freeze({
  id: "sqlserver",
  database: "sqlserver",
  /** Formats this parser accepts. SQL Server estimated plans are ShowPlanXML. */
  formats: Object.freeze(["xml"]),
  /** @param {import("../raw-plan-input.js").RawPlanInput} rawInput */
  parse: (rawInput) => parseSqlServerShowPlanXml(rawInput),
  /** @param {ReturnType<typeof parseSqlServerShowPlanXml>} parsed */
  normalize: (parsed) => normalizeSqlServerPlan(parsed),
});
