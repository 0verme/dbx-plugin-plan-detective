/**
 * OceanBase Oracle parsed plan -> database-neutral NormalizedPlan.
 *
 * The normalizer mirrors the PostgreSQL / MySQL / SQL Server stages: it maps
 * OceanBase operator labels onto stable semantic `kind` values, promotes the
 * fields metrics and rules care about into database-neutral names, and keeps
 * everything OceanBase-specific under `engineSpecific.oceanBase`.
 *
 * Cost mapping decision (deliberate, see docs/PLAN_INPUT_AND_FIXTURES.md):
 * OceanBase reports its own `EST.TIME(us)` estimate and, in some shapes, `COST`.
 * Neither is a PostgreSQL cumulative `Total Cost`, so **no** OceanBase cost is
 * mapped onto `startupCost` / `totalCost`: those stay `null`, both values stay
 * under `engineSpecific.oceanBase`, and the shared metrics report
 * `costAttribution.status = "not-applicable"`. As a consequence the cost-based
 * branches of the existing rules cannot fire for OceanBase Oracle; the rules
 * still work through kind / estimated rows.
 *
 * Predicate mapping decision: the official Oracle-mode JSON example and the
 * engine's JSON plan writer guarantee `ID` / `OPERATOR` / `NAME` / `EST.ROWS` /
 * `EST.TIME(us)` / `output` / `CHILD_<n>`; the extended "Outputs & filters" keys
 * (`filter`, `access`, `range_key`, ...) are not part of any sample this round
 * verified. They are preserved verbatim in `engineSpecific.extra` and are
 * deliberately **not** promoted into the neutral `filter` / `indexCondition` /
 * `sortKeys` fields, because a wrong key name would silently fabricate a
 * predicate the plan never reported.
 *
 * It never interprets cost, never guesses missing values and never depends on
 * the number of nodes: the same input always produces the same output.
 */

/**
 * OceanBase operator label -> stable semantic kind.
 *
 * The map is deliberately finite and covers the operators the Oracle-mode
 * reference describes. Labels are compared after `operatorKey()`, so
 * `NESTED-LOOP JOIN` and `NESTED LOOP JOIN` classify identically while
 * `nodeType` always keeps the engine's own spelling.
 *
 * Scan mapping is the one place where a label is ambiguous:
 *
 * - `TABLE FULL SCAN` is a full table access -> `seq_scan`;
 * - `TABLE SCAN` / `TABLE RANGE SCAN` / `TABLE SKIP SCAN` / `TABLE GET` are
 *   index- or primary-key-based access paths -> `index_scan`. OceanBase folds
 *   index back-lookup into `TABLE SCAN` and reports the chosen index inside
 *   `NAME` (`T1(IDX)`), so a bare `TABLE SCAN` is described as a range scan;
 *   classifying it as `seq_scan` would fire the shared large-sequential-scan
 *   signal on an access path that may well be an index range.
 *
 * Unknown or future operators become `unknown`; the raw label and the whole
 * child subtree are always preserved, and the plan records which raw labels were
 * not classified.
 */
const KIND_BY_OPERATOR = Object.freeze({
  "TABLE FULL SCAN": "seq_scan",
  "TABLE SCAN": "index_scan",
  "TABLE RANGE SCAN": "index_scan",
  "TABLE SKIP SCAN": "index_scan",
  "TABLE GET": "index_scan",
  "NESTED LOOP JOIN": "nested_loop",
  "HASH JOIN": "hash_join",
  "MERGE JOIN": "merge_join",
  SORT: "sort",
  "SCALAR GROUP BY": "aggregate",
  "HASH GROUP BY": "aggregate",
  "MERGE GROUP BY": "aggregate",
  COUNT: "aggregate",
  "WINDOW FUNCTION": "analytic",
  LIMIT: "limit",
  MATERIAL: "materialize",
  "SUBPLAN SCAN": "subquery_scan",
  "SUBPLAN FILTER": "subquery",
  "HASH DISTINCT": "unique",
  "MERGE DISTINCT": "unique",
  "UNION ALL": "append",
  "HASH UNION DISTINCT": "setop",
  "MERGE UNION DISTINCT": "setop",
  INSERT: "modify_table",
  DELETE: "modify_table",
  UPDATE: "modify_table",
  MERGE: "modify_table",
});

/**
 * Distributed / parallel variants of the table access operators carry a prefix
 * (`DISTRIBUTED TABLE RANGE SCAN`) but mean the same access path. The suffix
 * match keeps them in the same bucket as their serial form without pretending
 * the prefix does not exist: `nodeType` still shows the full label.
 */
const KIND_BY_OPERATOR_SUFFIX = Object.freeze([
  ["TABLE FULL SCAN", "seq_scan"],
  ["TABLE RANGE SCAN", "index_scan"],
  ["TABLE SKIP SCAN", "index_scan"],
]);

/**
 * @typedef {Object} NormalizedNode
 * @property {string} id stable path id: "0", "0.0", "0.1.0", ...
 * @property {string} kind semantic kind; "unknown" for unclassified operators
 * @property {string} nodeType raw OceanBase `OPERATOR` (or the `Plan` placeholder)
 * @property {{ name: string|null, alias: string|null, indexName: string|null }|null} relation
 * @property {number|null} estimatedRows
 * @property {number|null} actualRows always null: OceanBase estimated plans have no runtime fields
 * @property {number|null} actualStartupTime always null
 * @property {number|null} actualTotalTime always null
 * @property {number|null} loops always null
 * @property {number|null} startupCost always null: OceanBase has no PostgreSQL startup cost
 * @property {number|null} totalCost always null: OceanBase cost stays under engineSpecific
 * @property {number|null} width always null: OceanBase JSON has no row-width estimate
 * @property {string|null} filter always null: extended keys are not promoted
 * @property {string|null} joinType always null: the JSON reports no join direction
 * @property {string|null} joinCondition always null
 * @property {string|null} indexCondition always null
 * @property {string[]|null} sortKeys always null
 * @property {string[]|null} groupKeys always null * @property {NormalizedNode[]} children
 * @property {Record<string, unknown>} engineSpecific OceanBase-only fields
 *
 * @typedef {Object} NormalizedPlan
 * @property {"oceanbase-oracle"} database
 * @property {"estimated"} mode
 * @property {"json"} format
 * @property {NormalizedNode} root
 * @property {string[]} unknownNodeTypes sorted unique labels that had no kind
 */

/**
 * @param {import("../oceanbase/parse-json-plan.js").ParsedPlan} parsed
 * @returns {NormalizedPlan}
 */
export function normalizeOceanBasePlan(parsed) {
  const unknownNodeTypes = new Set();
  const root = normalizeNode(parsed.root, "0", unknownNodeTypes);

  return {
    database: "oceanbase-oracle",
    mode: parsed.mode,
    format: parsed.format,
    root,
    unknownNodeTypes: [...unknownNodeTypes].sort(),
  };
}

/**
 * @param {import("../oceanbase/parse-json-plan.js").ParsedOceanBaseNode} node
 * @param {string} id
 * @param {Set<string>} unknownNodeTypes
 * @returns {NormalizedNode}
 */
function normalizeNode(node, id, unknownNodeTypes) {
  const kind = kindOf(node.nodeType);
  // The `Plan` placeholder is not an engine label, so only labels the engine
  // actually reported are recorded as unclassified.
  if (kind === "unknown" && node.operator !== null) unknownNodeTypes.add(node.operator);

  const name = node.name === null ? null : node.name.trim();

  return {
    id,
    kind,
    nodeType: node.nodeType,
    // OceanBase reports the accessed object in `NAME`; for index access it is
    // `TABLE(INDEX)`. The value is kept verbatim: splitting it would mean
    // guessing which part is the index (and `(Reverse)` is not an index).
    relation: name === null || name.length === 0 ? null : { name, alias: null, indexName: null },
    estimatedRows: node.estimatedRows,
    // Estimated OceanBase plans never carry runtime values; nothing to map.
    actualRows: null,
    actualStartupTime: null,
    actualTotalTime: null,
    loops: null,
    // OceanBase estimates are its own cost model; see the module header.
    startupCost: null,
    totalCost: null,
    width: null,
    filter: null,
    joinType: null,
    joinCondition: null,
    indexCondition: null,
    sortKeys: null,
    groupKeys: null,
    children: node.children.map((child, index) => normalizeNode(child, `${id}.${index}`, unknownNodeTypes)),
    engineSpecific: {
      database: "oceanbase-oracle",
      oceanBase: {
        id: node.nodeId,
        operator: node.operator,
        name: node.name,
        estimatedRows: node.estimatedRows,
        estimatedTimeUs: node.estimatedTimeUs,
        cost: node.cost,
        output: node.output,
      },
      extra: node.extra,
    },
  };
}

/**
 * @param {string} nodeType
 * @returns {string}
 */
function kindOf(nodeType) {
  const label = operatorKey(nodeType);
  const exact = KIND_BY_OPERATOR[label];
  if (exact !== undefined) return exact;
  for (const [suffix, kind] of KIND_BY_OPERATOR_SUFFIX) {
    if (label.endsWith(suffix)) return kind;
  }
  return "unknown";
}

/**
 * Comparison key for an operator label: uppercase, hyphens and runs of
 * whitespace collapsed to single spaces. `nodeType` keeps the original label.
 *
 * @param {string} nodeType
 * @returns {string}
 */
function operatorKey(nodeType) {
  return nodeType.trim().toUpperCase().replace(/[-\s]+/g, " ");
}
