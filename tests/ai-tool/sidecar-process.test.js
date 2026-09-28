import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { ANALYZE_TOOL_NAME, PLUGIN_ID, PLUGIN_VERSION } from "../../backend/plan-detective-runtime.mjs";
import { REPO_ROOT } from "../helpers/fixtures.js";

function request(id, method, params) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

test("Node sidecar speaks JSONL initialize, mcp/tools, and mcp/call over stdio", async () => {
  const sidecar = spawn(process.execPath, [path.join(REPO_ROOT, "backend/plan-detective-runtime.mjs")], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  sidecar.stdout.setEncoding("utf8").on("data", (chunk) => stdout.push(chunk));
  sidecar.stderr.setEncoding("utf8").on("data", (chunk) => stderr.push(chunk));
  sidecar.stdin.end([
    request(1, "plugin/initialize", {
      host: { protocolVersions: [1] },
      plugin: { id: PLUGIN_ID, version: PLUGIN_VERSION },
    }),
    request(2, "mcp/tools", {}),
    request(3, "mcp/call", { tool: ANALYZE_TOOL_NAME, arguments: [] }),
  ].join("\n") + "\n");

  const exitCode = await new Promise((resolve, reject) => {
    sidecar.once("error", reject);
    sidecar.once("close", (code) => resolve(code));
  });
  assert.equal(exitCode, 0, stderr.join(""));
  const lines = stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].result.protocolVersion, 1);
  assert.equal(lines[1].result.tools[0].name, "analyze_estimated_plan");
  assert.equal(lines[2].result.isError, true);
  assert.equal(stderr.join(""), "", "protocol responses and diagnostics stay separated");
});
