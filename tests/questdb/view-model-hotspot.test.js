import assert from "node:assert/strict";
import test from "node:test";
import { presentHotspotCostNote } from "../../src/lib/hotspot-presentation.js";

test("QuestDB cost note states the unavailable-evidence boundary without implying signals exist", () => {
  assert.match(
    presentHotspotCostNote({ engine: "questdb", status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" }, "zh-CN"),
    /未提供共享的 estimated rows \/ PostgreSQL cost；未推导代价、行数或性能信号/,
  );
  assert.match(
    presentHotspotCostNote({ engine: "questdb", status: "not-applicable", reason: "NOT_POSTGRES_COST_MODEL" }, "en"),
    /no cost, row-count, or performance signals are inferred/,
  );
});
