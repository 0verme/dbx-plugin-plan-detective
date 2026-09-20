/**
 * Minimal stand-in for the DBX Plugin SDK bridge (`window.dbxPlugin`).
 *
 * The real SDK installs the bridge object — including `getPlanCapabilities`
 * and `explainPlan` — before the host init message arrives. `capabilities` is
 * a getter that stays `{}` until then, `ready` resolves on init, and `onInit`
 * listeners fire on init. `sendInit()` replays that host init message so tests
 * can pin the initializing → available/unavailable transition.
 */

/**
 * @param {{
 *   getPlanCapabilities?: (connectionId: string) => Promise<unknown>,
 *   explainPlan?: (request: object) => Promise<unknown>,
 * }} [overrides]
 */
export function createSdkBridge(overrides = {}) {
  let advertisement = {};
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  return {
    get capabilities() {
      return advertisement;
    },
    ready,
    onInit: () => () => {},
    getPlanCapabilities: async () => {
      throw new Error("createSdkBridge: getPlanCapabilities is not stubbed");
    },
    explainPlan: async () => {
      throw new Error("createSdkBridge: explainPlan is not stubbed");
    },
    ...overrides,
    /** Simulate the host init message arriving with its capability advertisement. */
    sendInit(planApi = true) {
      advertisement = { downloadFile: false, planApi };
      resolveReady();
    },
  };
}
