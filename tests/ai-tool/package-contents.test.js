import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildPluginPackage, inspectStoredZip } from "../../scripts/package-plugin.mjs";
import { REPO_ROOT, loadFixture } from "../helpers/fixtures.js";

const REQUIRED_ENTRIES = [
  "manifest.json",
  "package.json",
  "assets/plugin.svg",
  "ui/index.html",
  "backend/plan-detective-runtime.mjs",
  "src/ai-tool/analyze-estimated-plan.js",
  "src/ai-tool/dbx-agent-plan-input.js",
  "src/core/analyze.js",
  "src/core/raw-plan-input.js",
  "src/core/adapter/dbx-plan-response.js",
  "src/lib/ai-analysis-prompt.js",
  "src/lib/finding-presentation.js",
  "src/lib/hotspot-presentation.js",
  "src/lib/view-model.js",
  "bin/universal/plan-detective-runtime",
  "bin/universal/plan-detective-runtime.bat",
  "checksums.json",
];

test(".dbxp contains the complete sidecar/UI runtime and excludes development inputs", async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "plan-detective-package-test-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const result = await buildPluginPackage({ root: REPO_ROOT, outputDirectory });
  const archive = await readFile(result.packagePath);
  const entries = inspectStoredZip(archive);
  const names = [...entries.keys()];

  for (const name of REQUIRED_ENTRIES) assert.ok(entries.has(name), `package must include ${name}`);
  assert.equal(names.some((name) => /^(fixtures|tests|docs|node_modules)\//.test(name)), false);
  assert.equal(names.includes("src/host/dbx-plan-host.js"), false, "AI sidecar package must not need Host Plan API code");
  assert.equal(entries.get("bin/universal/plan-detective-runtime").mode & 0o777, 0o755);

  const packagedManifest = JSON.parse(entries.get("manifest.json").data.toString("utf8"));
  assert.equal(packagedManifest.version, "0.7.0-rc.1");
  assert.deepEqual(JSON.parse(entries.get("package.json").data.toString("utf8")), { type: "module" });
  assert.equal(packagedManifest.entrypoints.backend.executable, "bin/universal/plan-detective-runtime");
  assert.deepEqual(packagedManifest.permissions, ["host.plans:read"]);

  const metadata = JSON.parse(await readFile(result.metadataPath, "utf8"));
  assert.equal(metadata.target, "universal");
  assert.equal(metadata.url, path.basename(result.packagePath));
  assert.equal(metadata.sha256, createHash("sha256").update(archive).digest("hex"));
  assert.equal(metadata.size, archive.length);

  const configuredIncludes = await readFile(path.join(REPO_ROOT, "dbx-plugin.toml"), "utf8");
  for (const include of ["assets", "ui", "backend", "package.json", "src/ai-tool", "src/core", "src/lib/ai-analysis-prompt.js", "src/lib/finding-presentation.js", "src/lib/hotspot-presentation.js", "src/lib/i18n", "src/lib/format.js", "src/lib/view-model.js"]) {
    assert.ok(configuredIncludes.includes(`"${include}"`), `dbx-plugin.toml must cover ${include}`);
  }

  const unpacked = path.join(outputDirectory, "unpacked");
  for (const [name, entry] of entries) {
    const destination = path.join(unpacked, name);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.data);
  }
  const fixture = await loadFixture({ mode: "estimated", name: "large-seq-scan" });
  const packedManifest = JSON.parse(entries.get("manifest.json").data.toString("utf8"));
  const payloads = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "plugin/initialize",
      params: { host: { protocolVersions: [1] }, plugin: { id: packedManifest.id, version: packedManifest.version } },
    },
    { jsonrpc: "2.0", id: 2, method: "mcp/tools", params: {} },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "mcp/call",
      params: {
        tool: "analyze_estimated_plan",
        arguments: {
          dbType: "postgres",
          mode: "estimated",
          format: "json",
          rawPlan: JSON.stringify(fixture.plan),
          truncated: false,
          warnings: [],
        },
        lifecycle: {},
      },
    },
  ];
  const child = spawn(process.execPath, [path.join(unpacked, "backend/plan-detective-runtime.mjs")], {
    cwd: unpacked,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8").on("data", (chunk) => stdout.push(chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(`${payloads.map((payload) => JSON.stringify(payload)).join("\n")}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, stderr.join(""));
  const runtimeResponses = stdout.join("").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(runtimeResponses.length, 3);
  assert.equal(runtimeResponses[0].result.protocolVersion, 1);
  assert.equal(runtimeResponses[1].result.tools[0].name, "analyze_estimated_plan");
  assert.equal(runtimeResponses[2].result.isError, false);
  assert.match(runtimeResponses[2].result.content[0].text, /large-sequential-scan/);
});
