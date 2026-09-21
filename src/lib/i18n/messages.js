/**
 * Runtime message catalog for Finding Presentation.
 *
 * Catalog entries contain wording and interpolation placeholders only. Rule
 * thresholds, severity decisions and plan facts stay outside this module.
 */
export const MESSAGE_CATALOG = Object.freeze({
  "zh-CN": Object.freeze({
    "diagnosis.section.summary": "发生了什么",
    "diagnosis.section.reasons": "为什么提示",
    "diagnosis.section.actions": "建议检查",
    "diagnosis.section.caveats": "注意事项",
    "diagnosis.section.technicalDetails": "技术细节",
    "diagnosis.section.evidence": "Evidence · {count} 项",
    "finding.largeSequentialScan.title.fullTable": "可能存在较大的全表扫描",
    "finding.largeSequentialScan.title.sequential": "可能存在较大的顺序扫描",
    "finding.largeSequentialScan.summary": "{relation} 预计扫描约 {estimatedRows} 行。",
    "finding.largeSequentialScan.reason.accessType": "MySQL 使用了全表访问（access_type = {accessType}）。",
    "finding.largeSequentialScan.reason.scan": "执行计划使用了顺序扫描（{nodeType}）。",
    "finding.largeSequentialScan.reason.noFilter": "当前计划没有报告过滤条件。",
    "finding.largeSequentialScan.reason.filterReported": "当前计划报告了过滤条件，但扫描规模仍值得检查。",
    "finding.largeSequentialScan.reason.estimatedRows": "预计读取约 {estimatedRows} 行。",
    "finding.largeSequentialScan.action.where": "检查 SQL 是否应该包含 WHERE 条件。",
    "finding.largeSequentialScan.action.index": "检查过滤字段是否存在合适的索引。",
    "finding.largeSequentialScan.action.intent": "确认查询是否本来就需要读取整张表。",
    "finding.caveat.estimatedPlan": "当前结果来自 Estimated Plan，不代表 SQL 实际执行一定很慢。",
    "finding.caveat.severity": "{severity} 表示规则关注级别，不代表已确认存在严重性能问题。",
  }),
  en: Object.freeze({
    "diagnosis.section.summary": "What happened",
    "diagnosis.section.reasons": "Why this was flagged",
    "diagnosis.section.actions": "What to check next",
    "diagnosis.section.caveats": "Caveats",
    "diagnosis.section.technicalDetails": "Technical details",
    "diagnosis.section.evidence": "Evidence · {count} items",
    "finding.largeSequentialScan.title.fullTable": "A potentially large full-table scan",
    "finding.largeSequentialScan.title.sequential": "A potentially large sequential scan",
    "finding.largeSequentialScan.summary": "{relation} is estimated to scan about {estimatedRows} rows.",
    "finding.largeSequentialScan.reason.accessType": "MySQL used full-table access (access_type = {accessType}).",
    "finding.largeSequentialScan.reason.scan": "The plan uses a sequential scan ({nodeType}).",
    "finding.largeSequentialScan.reason.noFilter": "The plan did not report a filter condition.",
    "finding.largeSequentialScan.reason.filterReported": "The plan reported a filter condition, but the scan size is still worth checking.",
    "finding.largeSequentialScan.reason.estimatedRows": "The plan estimates that about {estimatedRows} rows will be read.",
    "finding.largeSequentialScan.action.where": "Check whether the SQL should include a WHERE condition.",
    "finding.largeSequentialScan.action.index": "Check whether the filter columns have suitable indexes.",
    "finding.largeSequentialScan.action.intent": "Confirm whether the query is expected to read the whole table.",
    "finding.caveat.estimatedPlan": "This result comes from an Estimated Plan; it does not mean the SQL is definitely slow at runtime.",
    "finding.caveat.severity": "{severity} is the rule's attention level; it does not confirm a severe SQL performance problem.",
  }),
});
