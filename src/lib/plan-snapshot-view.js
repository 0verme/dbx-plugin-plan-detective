import { PlanInputError } from "../core/errors.js";
import { analyzeRawPlan } from "../core/parsers/index.js";
import { PlanSnapshotError, validatePlanSnapshot } from "./plan-snapshot.js";

/**
 * Re-analyze one validated saved RawPlanInput with the current local Plan Core.
 * This path deliberately has no Host bridge parameter and cannot call explainPlan.
 *
 * @param {unknown} value
 * @returns {{snapshot: object, session: object}}
 */
export function createPlanSnapshotView(value) {
  const validation = validatePlanSnapshot(value);
  if (!validation.valid) throw new PlanSnapshotError(validation.code, validation.message);
  const snapshot = validation.snapshot;
  const rawInput = snapshot.rawInput;
  const hostResult = {
    dbType: rawInput.database,
    ...(rawInput.databaseVersion === undefined ? {} : { dbVersion: rawInput.databaseVersion }),
    format: rawInput.format,
    rawPlan: rawInput.plan,
    truncated: false,
    warnings: [],
  };
  const shared = {
    rawInput,
    hostResult,
    capturedAt: snapshot.capturedAt,
    source: snapshot.source,
  };

  try {
    const analysis = analyzeRawPlan(rawInput);
    return {
      snapshot,
      session: {
        ...shared,
        status: analysis.status,
        analysis,
        message: null,
      },
    };
  } catch (error) {
    const code = error instanceof PlanInputError ? "INVALID_RAW_PLAN_INPUT" : "PLAN_PARSE_FAILED";
    return {
      snapshot,
      session: {
        ...shared,
        status: "error",
        analysis: null,
        error: {
          code,
          causeCode: error?.code ?? code,
          message: error instanceof Error ? error.message : String(error),
          hostMessage: null,
          name: error instanceof Error ? error.name : "Error",
        },
      },
    };
  }
}

/** Format a known UTC snapshot timestamp in the selected UI locale. */
export function formatPlanSnapshotTime(timestamp, locale = "zh-CN") {
  if (typeof timestamp !== "string") return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
