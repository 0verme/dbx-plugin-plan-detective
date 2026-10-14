import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT } from "./helpers/fixtures.js";

/**
 * The manifest is what makes the Host APIs reachable: plan acquisition needs
 * `host.plans:read` and persistence needs `host.storage`. Storage is advertised
 * independently from Plan API and is runtime-gated for older/partial hosts.
 */

async function readManifest() {
  return JSON.parse(await readFile(path.join(REPO_ROOT, "manifest.json"), "utf8"));
}

test("manifest declares the Host API 1.2 floor", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.engines.host_api, "^1.2");
});

test("manifest declares host.plans:read", async () => {
  const manifest = await readManifest();
  assert.ok(Array.isArray(manifest.permissions), "manifest.permissions must be an array");
  assert.ok(
    manifest.permissions.includes("host.plans:read"),
    `manifest must declare host.plans:read; got ${JSON.stringify(manifest.permissions)}`,
  );
});

test("manifest declares both the Plan API and Host Storage permissions", async () => {
  const manifest = await readManifest();
  const hostPermissions = manifest.permissions.filter((permission) => permission.startsWith("host."));
  assert.deepEqual(hostPermissions, ["host.plans:read", "host.storage"]);
});

test("manifest is frontend-only and keeps both existing UI contributions", async () => {
  const manifest = await readManifest();
  assert.deepEqual(manifest.entrypoints, { ui: { root: "ui", entry: "ui/index.html" } });
  assert.equal(manifest.engines.dbx, ">=0.6.23");
  assert.deepEqual(manifest.permissions, ["host.plans:read", "host.storage"]);

  const types = manifest.contributions.map((contribution) => contribution.type).sort();
  assert.deepEqual(types, ["result-view", "workbench"]);
});
