/**
 * OceanBase MySQL compatibility-mode registry entry.
 *
 * This keeps the Plan Core family distinct from Oracle mode while reusing the
 * same OceanBase JSON parser and normalizer.
 */
import { createOceanBaseJsonParser } from "./oceanbase-json.js";

export const oceanBaseMysqlParser = createOceanBaseJsonParser("oceanbase-mysql");
