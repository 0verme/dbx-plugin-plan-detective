import assert from "node:assert/strict";
import test from "node:test";
import { PlanInputError, PlanParseError } from "../../src/core/errors.js";
import { createRawPlanInput } from "../../src/core/raw-plan-input.js";
import { parseSqlServerShowPlanXml } from "../../src/core/sqlserver/parse-showplan-xml.js";

/**
 * Parser contract tests for SQL Server ShowPlanXML.
 *
 * The committed fixtures pin the whole pipeline; these tests pin the parser's
 * field mapping, its structure walk (children from any operator container), its
 * namespace handling and its fail-closed behavior for payloads that are not a
 * single estimated ShowPlanXML statement.
 */

/** @param {unknown} plan */
function xmlInput(plan, overrides = {}) {
  return createRawPlanInput({ database: "sqlserver", mode: "estimated", format: "xml", plan, ...overrides });
}

const SHOWPLAN_OPEN = '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan" Version="1.539">';

/** @param {string} statementXml @param {{ prolog?: string }} [options] */
function wrap(statementXml, options = {}) {
  const prolog = options.prolog ?? SHOWPLAN_OPEN;
  return `${prolog}<BatchSequence><Batch><Statements>${statementXml}</Statements></Batch></BatchSequence></ShowPlanXML>`;
}

/** @param {string} relOpXml @param {string} [attrs] */
function statement(relOpXml, attrs = 'StatementId="1" StatementType="SELECT"') {
  return `<StmtSimple ${attrs}><QueryPlan DegreeOfParallelism="1" MemoryGrant="1024" CachedPlanSize="32">${relOpXml}</QueryPlan></StmtSimple>`;
}

/** @param {string} attrs @param {...string} content */
function relOp(attrs, ...content) {
  return `<RelOp ${attrs}>${content.join("")}</RelOp>`;
}

const SCAN_ATTRS =
  'NodeId="0" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="10" EstimatedTotalSubtreeCost="0.02" EstimateCPU="0.0002" EstimateIO="0.01" AvgRowSize="20" Parallel="0"';

/** @param {string} xml @returns {any} */
function parse(xml) {
  return parseSqlServerShowPlanXml(xmlInput(xml));
}

/** @param {string} xml @param {string} code */
function parseError(xml, code) {
  try {
    parse(xml);
  } catch (error) {
    assert.ok(error instanceof PlanParseError, `expected PlanParseError, got ${error?.name ?? typeof error}`);
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected PlanParseError ${code}`);
}

test("parses the statement and query-plan envelope metadata", () => {
  const parsed = parse(
    wrap(
      statement(
        relOp(SCAN_ATTRS, '<TableScan><Object Table="[Orders]" Alias="[o]"/></TableScan>'),
        'StatementId="3" StatementType="SELECT" StatementSubTreeCost="0.02" StatementEstRows="10" StatementOptmLevel="FULL"',
      ),
    ),
  );

  assert.equal(parsed.database, "sqlserver");
  assert.equal(parsed.format, "xml");
  assert.equal(parsed.mode, "estimated");
  assert.deepEqual(parsed.statement, {
    type: "SELECT",
    id: 3,
    subtreeCost: 0.02,
    estimatedRows: 10,
    optimizationLevel: "FULL",
  });
  assert.deepEqual(parsed.queryPlan, { degreeOfParallelism: 1, memoryGrant: 1024, cachedPlanSize: 32 });
  assert.equal(parsed.root.nodeType, "Table Scan");
});

test("maps RelOp attributes onto typed fields and keeps unmapped ones in extra", () => {
  const attrs = [
    'NodeId="7"',
    'PhysicalOp="Nested Loops"',
    'LogicalOp="Inner Join"',
    'EstimateRows="25"',
    'EstimatedTotalSubtreeCost="0.024"',
    'EstimateCPU="0.0006"',
    'EstimateIO="0"',
    'EstimateRebinds="1.5"',
    'EstimateRewinds="2"',
    'EstimateExecutions="3"',
    'AvgRowSize="32"',
    'Parallel="1"',
    'Partitioned="1"',
    'FutureFlag="abc"',
  ].join(" ");

  const parsed = parse(wrap(statement(relOp(attrs, "<NestedLoops/>"))));
  const node = parsed.root;

  assert.equal(node.nodeType, "Nested Loops");
  assert.equal(node.physicalOp, "Nested Loops");
  assert.equal(node.logicalOp, "Inner Join");
  assert.equal(node.nodeId, 7);
  assert.equal(node.estimatedRows, 25);
  assert.equal(node.estimatedTotalSubtreeCost, 0.024);
  assert.equal(node.estimateCpu, 0.0006);
  assert.equal(node.estimateIo, 0);
  assert.equal(node.estimateRebinds, 1.5);
  assert.equal(node.estimateRewinds, 2);
  assert.equal(node.estimateExecutions, 3);
  assert.equal(node.avgRowSize, 32);
  assert.equal(node.parallel, true);
  assert.deepEqual(node.extra, { Partitioned: "1", FutureFlag: "abc" });
});

test("an uninterpretable mapped attribute degrades to null and stays in extra", () => {
  const parsed = parse(
    wrap(
      statement(
        relOp(
          'NodeId="0" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="many" EstimateExecutions="" Parallel="yes"',
          "<TableScan/>",
        ),
      ),
    ),
  );

  assert.equal(parsed.root.estimatedRows, null, "a non-numeric estimate must not be coerced");
  assert.equal(parsed.root.estimateExecutions, null, "an empty numeric attribute must not become 0");
  assert.equal(parsed.root.parallel, null, "a non-boolean flag must not be guessed");
  assert.equal(parsed.root.extra.EstimateRows, "many");
  assert.equal(parsed.root.extra.EstimateExecutions, "");
  assert.equal(parsed.root.extra.Parallel, "yes");
});

test("extracts object identity, predicate and seek predicates", () => {
  const parsed = parse(
    wrap(
      statement(
        relOp(SCAN_ATTRS, [
          "<IndexScan Ordered=\"1\" Storage=\"RowStore\">",
          '<Object Database="[Sales]" Schema="[dbo]" Table="[Orders]" Index="[PK_Orders]" Alias="[o]" IndexKind="Clustered" Storage="RowStore"/>',
          '<Predicate><ScalarOperator ScalarString="[o].[Status]=\'OPEN\'"/></Predicate>',
          "<SeekPredicates><SeekPredicateNew><SeekKeys>",
          '<Prefix ScanType="EQ"><RangeColumns><ColumnReference Alias="[o]" Column="[OrderID]"/></RangeColumns>',
          "<RangeExpressions><ScalarOperator ScalarString=\"(42)\"/></RangeExpressions></Prefix>",
          '<StartRange ScanType="GE"><RangeColumns><ColumnReference Alias="[o]" Column="[OrderDate]"/></RangeColumns>',
          "<RangeExpressions><ScalarOperator ScalarString=\"('2024-01-01')\"/></RangeExpressions></StartRange>",
          "</SeekKeys></SeekPredicateNew></SeekPredicates>",
          "</IndexScan>",
        ].join("")),
      ),
    ),
  );

  const node = parsed.root;
  assert.equal(node.database, "[Sales]");
  assert.equal(node.schema, "[dbo]");
  assert.equal(node.table, "[Orders]");
  assert.equal(node.index, "[PK_Orders]");
  assert.equal(node.alias, "[o]");
  assert.equal(node.indexKind, "Clustered");
  assert.equal(node.storage, "RowStore");
  assert.equal(node.predicate, "[o].[Status]='OPEN'");
  assert.equal(
    node.indexCondition,
    "Prefix(EQ) [o].[OrderID] = (42); StartRange(GE) [o].[OrderDate] = ('2024-01-01')",
  );
});

test("extracts sort keys, group keys, hash keys, residuals and defined values", () => {
  const parsed = parse(
    wrap(
      statement(
        relOp(SCAN_ATTRS, [
          '<Sort Distinct="0"><OrderBy>',
          '<OrderByColumn Ascending="1"><ColumnReference Alias="[o]" Column="OrderDate"/></OrderByColumn>',
          '<OrderByColumn Ascending="0"><ColumnReference Alias="[o]" Column="TotalDue"/></OrderByColumn>',
          "</OrderBy></Sort>",
          "<StreamAggregate><GroupBy><ColumnReference Alias=\"[o]\" Column=\"CustomerID\"/></GroupBy></StreamAggregate>",
          "<Hash><HashKeysBuild><ColumnReference Alias=\"[c]\" Column=\"CustomerID\"/></HashKeysBuild>",
          "<HashKeysProbe><ColumnReference Alias=\"[o]\" Column=\"CustomerID\"/></HashKeysProbe>",
          '<ProbeResidual><ScalarOperator ScalarString="[o].[Region]=[c].[Region]"/></ProbeResidual>',
          '<BuildResidual><ScalarOperator ScalarString="[c].[Active]=1"/></BuildResidual></Hash>',
          '<Merge ManyToMany="0"><Residual><ScalarOperator ScalarString="[o].[X]=[c].[X]"/></Residual></Merge>',
          "<ComputeScalar><DefinedValues>",
          '<DefinedValue><ColumnReference Column="Expr1003"/><ScalarOperator ScalarString="[o].[TotalDue]*1.2"/></DefinedValue>',
          "</DefinedValues></ComputeScalar>",
        ].join("")),
      ),
    ),
  );

  const node = parsed.root;
  assert.deepEqual(node.sortKeys, ["[o].OrderDate ASC", "[o].TotalDue DESC"]);
  assert.deepEqual(node.groupKeys, ["[o].CustomerID"]);
  assert.deepEqual(node.hashKeysBuild, ["[c].CustomerID"]);
  assert.deepEqual(node.hashKeysProbe, ["[o].CustomerID"]);
  assert.equal(node.probeResidual, "[o].[Region]=[c].[Region]");
  assert.equal(node.buildResidual, "[c].[Active]=1");
  assert.equal(node.residual, "[o].[X]=[c].[X]");
  assert.deepEqual(node.definedValues, ["[o].[TotalDue]*1.2"]);
});

test("reads operator configuration flags without copying the operator XML", () => {
  const sort = parse(
    wrap(statement(relOp(SCAN_ATTRS, '<Sort Distinct="1"><OrderBy><OrderByColumn Ascending="1"><ColumnReference Column="c"/></OrderByColumn></OrderBy></Sort>'))),
  ).root;
  assert.deepEqual(sort.operator, { distinct: true });

  const top = parse(
    wrap(statement(relOp(SCAN_ATTRS, '<Top RowCount="10" IsPercent="0" WithTies="0"><TopExpression><ScalarOperator ScalarString="(10)"/></TopExpression></Top>'))),
  ).root;
  assert.deepEqual(top.operator, { topRowCount: 10, topIsPercent: false });

  const merge = parse(wrap(statement(relOp(SCAN_ATTRS, '<Merge ManyToMany="1"><Residual/></Merge>')))).root;
  assert.deepEqual(merge.operator, { manyToMany: true });

  const parallelism = parse(wrap(statement(relOp(SCAN_ATTRS, '<Parallelism PartitioningType="Hash"/>')))).root;
  assert.deepEqual(parallelism.operator, { partitioningType: "Hash" });

  const lookup = parse(
    wrap(
      statement(
        relOp(
          `${SCAN_ATTRS} Lookup="1"`,
          '<IndexScan Lookup="1" Ordered="1"><Object Table="[Orders]" Index="[PK_Orders]"/></IndexScan>',
        ),
      ),
    ),
  ).root;
  assert.deepEqual(lookup.operator, { lookup: true, ordered: true });
});

test("builds children from any operator container and stops at nested RelOp boundaries", () => {
  const nestedLoops = parse(
    wrap(
      statement(
        relOp(
          'NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="25"',
          "<NestedLoops><OuterReferences/>",
          '<RelOp NodeId="1" PhysicalOp="Index Seek" EstimateRows="25"><IndexScan><Object Table="[Orders]" Index="[IX]"/></IndexScan></RelOp>',
          '<RelOp NodeId="2" PhysicalOp="Clustered Index Seek" EstimateRows="1"><IndexScan><Object Table="[Customers]" Index="[PK]"/></IndexScan></RelOp>',
          "</NestedLoops>",
        ),
      ),
    ),
  ).root;

  assert.deepEqual(
    nestedLoops.children.map((child) => child.nodeType),
    ["Index Seek", "Clustered Index Seek"],
  );
  assert.equal(nestedLoops.table, null, "the wrapper must not borrow a child Object");
  assert.equal(nestedLoops.children[0].table, "[Orders]");

  const lookup = parse(
    wrap(
      statement(
        relOp(
          'NodeId="0" PhysicalOp="Clustered Index Seek" LogicalOp="Clustered Index Seek" Lookup="1"',
          "<IndexScan>",
          '<Object Table="[Orders]" Index="[PK_Orders]"/>',
          '<RelOp NodeId="1" PhysicalOp="Index Seek" EstimateRows="5"><IndexScan><Object Table="[Orders]" Index="[IX]"/></IndexScan></RelOp>',
          "</IndexScan>",
        ),
      ),
    ),
  ).root;

  assert.equal(lookup.table, "[Orders]", "the lookup target keeps its own Object");
  assert.equal(lookup.children.length, 1);
  assert.equal(lookup.children[0].nodeType, "Index Seek");
});

test("keeps an unknown operator, its attributes and its whole subtree", () => {
  const parsed = parse(
    wrap(
      statement(
        relOp(
          'NodeId="0" PhysicalOp="Future Shuffle" LogicalOp="Future Shuffle" EstimateRows="7" Mode="Adaptive"',
          '<FutureShuffle><RelOp NodeId="1" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="7"><TableScan><Object Table="[t]"/></TableScan></RelOp></FutureShuffle>',
        ),
      ),
    ),
  );

  assert.equal(parsed.root.nodeType, "Future Shuffle");
  assert.equal(parsed.root.children.length, 1);
  assert.equal(parsed.root.children[0].nodeType, "Table Scan");
  assert.deepEqual(parsed.root.extra, { Mode: "Adaptive" });
});

test("matches elements by local name under a namespace prefix", () => {
  const xml =
    '<p:ShowPlanXML xmlns:p="http://schemas.microsoft.com/sqlserver/2004/07/showplan">' +
    "<p:BatchSequence><p:Batch><p:Statements>" +
    '<p:StmtSimple StatementType="SELECT"><p:QueryPlan>' +
    '<p:RelOp NodeId="0" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="1"><p:TableScan><p:Object Table="[t]"/></p:TableScan></p:RelOp>' +
    "</p:QueryPlan></p:StmtSimple>" +
    "</p:Statements></p:Batch></p:BatchSequence></p:ShowPlanXML>";

  const parsed = parse(xml);
  assert.equal(parsed.root.nodeType, "Table Scan");
  assert.equal(parsed.root.table, "[t]");
});

test("a statement without a query plan does not make a single-plan payload ambiguous", () => {
  const setStatement = '<StmtSimple StatementId="1" StatementType="SET"><SetOptions/></StmtSimple>';
  const parsed = parse(
    wrap(setStatement + statement(relOp(SCAN_ATTRS, '<TableScan><Object Table="[t]"/></TableScan>'), 'StatementId="2" StatementType="SELECT"')),
  );

  assert.equal(parsed.statement.type, "SELECT");
  assert.equal(parsed.root.nodeType, "Table Scan");
});

test("multiple statements with a query plan fail closed instead of picking the first", () => {
  const plan = statement(relOp(SCAN_ATTRS, '<TableScan><Object Table="[t]"/></TableScan>'));
  const error = parseError(wrap(plan + plan), "MULTIPLE_STATEMENTS");
  assert.match(error.message, /2 statements/);
});

test("actual-plan markers and a declared actual mode are rejected", () => {
  const actualMarker = parseError(
    wrap(
      statement(
        relOp(SCAN_ATTRS, '<TableScan><Object Table="[t]"/><RunTimeInformation><RunTimeCountersPerThread ActualRows="10"/></RunTimeInformation></TableScan>'),
      ),
    ),
    "MODE_MISMATCH",
  );
  assert.match(actualMarker.message, /RunTimeInformation/);

  try {
    parseSqlServerShowPlanXml(
      xmlInput(wrap(statement(relOp(SCAN_ATTRS, "<TableScan/>"))), { mode: "actual" }),
    );
    assert.fail("mode actual must be rejected");
  } catch (error) {
    assert.ok(error instanceof PlanParseError);
    assert.equal(error.code, "MODE_MISMATCH");
  }
});

test("malformed XML, a wrong root element and a planless envelope fail closed", () => {
  parseError('<ShowPlanXML><BatchSequence>', "MALFORMED_XML");
  parseError("<NotShowPlanXML/>", "MALFORMED_PLAN");
  parseError("<ShowPlanXML/>", "MALFORMED_PLAN");
  parseError(wrap('<StmtSimple StatementType="SELECT"><QueryPlan/></StmtSimple>'), "MALFORMED_PLAN");
  parseError(wrap('<StmtSimple StatementType="SELECT"><QueryPlan><NotARelOp/></QueryPlan></StmtSimple>'), "MALFORMED_PLAN");
});

test("a non-string plan payload is a malformed plan, not a crash", () => {
  assert.throws(
    () => parseSqlServerShowPlanXml(xmlInput({ ShowPlanXML: true })),
    (error) => {
      assert.ok(error instanceof PlanParseError);
      assert.equal(error.code, "MALFORMED_PLAN");
      return true;
    },
  );
});

test("the parser still enforces the RawPlanInput contract", () => {
  assert.throws(
    () => parseSqlServerShowPlanXml({ database: "sqlserver", mode: "estimated", format: "xml" }),
    (error) => {
      assert.ok(error instanceof PlanInputError);
      assert.equal(error.code, "INVALID_RAW_PLAN_INPUT");
      return true;
    },
  );
});

test("a RelOp without PhysicalOp falls back to LogicalOp and stays identifiable", () => {
  const parsed = parse(wrap(statement(relOp('NodeId="0" LogicalOp="Filter" EstimateRows="3"', '<Filter StartupExpression="0"/>'))));

  assert.equal(parsed.root.nodeType, "Filter");
  assert.equal(parsed.root.physicalOp, null);
  assert.equal(parsed.root.logicalOp, "Filter");
});
