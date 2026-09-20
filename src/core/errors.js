/**
 * Error types shared by Plan Core.
 *
 * Plan Core has no dependency on any host, browser or database API; these two
 * classes are the only way core signals that an input cannot be processed.
 *
 * - `PlanInputError`  — the caller did not satisfy the RawPlanInput contract.
 * - `PlanParseError`  — the contract was satisfied, but the plan payload itself
 *                       is malformed or contradicts the declared mode.
 *
 * Both carry a stable `code` so tests and callers can branch on the failure
 * kind without matching message text.
 */

export class PlanInputError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable description
   */
  constructor(code, message) {
    super(message);
    this.name = "PlanInputError";
    this.code = code;
  }
}

export class PlanParseError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message human-readable description
   */
  constructor(code, message) {
    super(message);
    this.name = "PlanParseError";
    this.code = code;
  }
}
