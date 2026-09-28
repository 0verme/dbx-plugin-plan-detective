import { analyzePlan } from "../core/analyze.js";
import { adaptDbxAgentPlanInput } from "./dbx-agent-plan-input.js";
import { buildAiAnalysisPrompt } from "../lib/ai-analysis-prompt.js";

/** Hard ceiling for one MCP text response (24K Unicode code points). */
export const MAX_AI_TOOL_OUTPUT_CHARS = 24_000;
const MAX_EVIDENCE_CHARS = 5_000;
const OUTPUT_TRUNCATION_NOTE = "\n\n[Plan Detective: AI context 截断至输出上限；请勿将未展示部分视为不存在。]";

/**
 * Deterministically analyze a complete, already-acquired Estimated Plan.
 * The same `analyzePlan()` entry point used by Plan Core/UI is used here.
 * SQL may be accepted as provenance but is intentionally not echoed back to
 * the model; it can contain sensitive literals and the Agent already has the
 * user's original request in conversation context.
 *
 * @param {unknown} arguments_ MCP tool arguments
 * @returns {{ rawInput: import("../core/raw-plan-input.js").RawPlanInput, analysis: ReturnType<typeof analyzePlan>, context: string }}
 */
export function analyzeEstimatedPlan(arguments_) {
  const rawInput = adaptDbxAgentPlanInput(arguments_);
  const analysis = analyzePlan(rawInput);
  const promptInput = { ...rawInput };
  delete promptInput.sql;
  delete promptInput.databaseVersion;

  const context = boundContext(buildAiAnalysisPrompt({
    rawInput: promptInput,
    analysis,
    databaseType: arguments_.dbType,
    sourceWarnings: arguments_.warnings,
    locale: "zh-CN",
    maxEvidenceChars: MAX_EVIDENCE_CHARS,
  }));

  return { rawInput, analysis, context };
}

/** @param {string} text */
export function boundContext(text) {
  const characters = Array.from(text);
  if (characters.length <= MAX_AI_TOOL_OUTPUT_CHARS) return text;
  const noteLength = Array.from(OUTPUT_TRUNCATION_NOTE).length;
  const prefix = characters.slice(0, MAX_AI_TOOL_OUTPUT_CHARS - noteLength).join("");
  return `${prefix}${OUTPUT_TRUNCATION_NOTE}`;
}
