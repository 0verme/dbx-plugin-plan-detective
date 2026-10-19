import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertBundleFingerprint } from "../../scripts/build-fingerprint.mjs";
import { buildPluginPackage, inspectPluginZip } from "../../scripts/package-plugin.mjs";
import { REPO_ROOT } from "../helpers/fixtures.js";

async function filesUnder(root, relative = "") {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.replaceAll(path.sep, "/"), entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

test("build fingerprint validation detects a package that does not match current source", () => {
  const current = `sha256:${"a".repeat(64)}`;
  const older = `sha256:${"b".repeat(64)}`;
  assert.equal(assertBundleFingerprint(`bundle ${current}`, current), true);
  assert.throws(() => assertBundleFingerprint(`bundle ${older}`, current), /fingerprint does not match/);
});

test("official .dbxp is frontend-only, complete, and integrity-checked", async (t) => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "plan-detective-frontend-package-test-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const result = await buildPluginPackage({ root: REPO_ROOT, outputDirectory });
  assert.match(result.buildFingerprint, /^sha256:[a-f0-9]{64}$/);
  const archive = await readFile(result.packagePath);
  const entries = inspectPluginZip(archive);
  const names = [...entries.keys()].sort();
  const sourceManifest = JSON.parse(await readFile(path.join(REPO_ROOT, "manifest.json"), "utf8"));
  const packagedManifest = JSON.parse(entries.get("manifest.json").data.toString("utf8"));

  assert.equal(packagedManifest.id, "io.github.0verme.plan-detective");
  assert.equal(packagedManifest.version, sourceManifest.version);
  assert.deepEqual(packagedManifest.permissions, ["host.plans:read", "host.storage"]);
  assert.deepEqual(packagedManifest.engines, { dbx: ">=0.6.23", host_api: "^1.2" });
  assert.deepEqual(packagedManifest.entrypoints, { ui: { root: "ui", entry: "ui/index.html" } });
  assert.deepEqual(packagedManifest.contributions, sourceManifest.contributions);
  const packagedBundle = [...entries]
    .filter(([name]) => name.startsWith("ui/assets/") && name.endsWith(".js"))
    .map(([, entry]) => entry.data.toString("utf8"))
    .join("\n");
  assertBundleFingerprint(packagedBundle, result.buildFingerprint);

  for (const name of ["manifest.json", "checksums.json", "assets/plugin.svg", "ui/index.html"]) {
    assert.ok(entries.has(name), `package must include ${name}`);
  }
  assert.equal(names.some((name) => /^(backend|bin)\//.test(name)), false, "no sidecar or executable launcher may ship");
  assert.equal(names.some((name) => /(?:\.bat|\.sh)$/.test(name)), false, "no platform launcher may ship");
  assert.equal(names.some((name) => /^(fixtures|tests|docs|node_modules|src)\//.test(name)), false);

  const expectedStaticFiles = [
    ...(await filesUnder(REPO_ROOT, "assets")),
    ...(await filesUnder(REPO_ROOT, "ui")),
  ].sort();
  const packagedStaticFiles = names.filter((name) => name.startsWith("assets/") || name.startsWith("ui/")).sort();
  assert.deepEqual(packagedStaticFiles, expectedStaticFiles, "all and only the static package inputs must be present");

  const checksums = JSON.parse(entries.get("checksums.json").data.toString("utf8"));
  assert.equal(checksums.algorithm, "sha256");
  const checksumNames = Object.keys(checksums.files).sort();
  assert.deepEqual(checksumNames, names.filter((name) => name !== "checksums.json").sort());
  for (const name of checksumNames) {
    const actual = createHash("sha256").update(entries.get(name).data).digest("hex");
    assert.equal(checksums.files[name], actual, `checksum mismatch for ${name}`);
  }

  const metadata = JSON.parse(await readFile(result.metadataPath, "utf8"));
  assert.equal(metadata.target, "universal");
  assert.equal(metadata.url, path.basename(result.packagePath));
  assert.equal(metadata.sha256, createHash("sha256").update(archive).digest("hex"));
  assert.equal(metadata.size, archive.length);

  const config = await readFile(path.join(REPO_ROOT, "dbx-plugin.toml"), "utf8");
  assert.match(config, /include\s*=\s*\["assets",\s*"ui"\]/);
  assert.doesNotMatch(config, /^\[backend\]/m);
});
