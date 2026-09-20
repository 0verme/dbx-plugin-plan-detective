import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT } from "./helpers/fixtures.js";

/**
 * The manifest is what makes the Host Plan API reachable at all: without the
 * `host.plans:read` permission the bridge rejects both plan methods, and
 * without the `^1.2` engine floor DBX would load the plugin on a host that has
 * no plan API. These are contract values from t8y2/dbx#9692, so they are pinned
 * here next to the adapter tests.
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

test("manifest keeps the plan permission as its only privileged host permission", async () => {
  const manifest = await readManifest();
  const hostPermissions = manifest.permissions.filter((permission) => permission.startsWith("host."));
  assert.deepEqual(hostPermissions, ["host.plans:read"]);
});

test("manifest keeps the UI entrypoint and the workbench contribution", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.entrypoints.ui.root, "ui");
  assert.equal(manifest.entrypoints.ui.entry, "ui/index.html");

  const types = manifest.contributions.map((contribution) => contribution.type).sort();
  assert.deepEqual(types, ["result-view", "workbench"]);
});
