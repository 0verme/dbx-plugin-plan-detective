import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { REPO_ROOT, relativeToRepo } from "./helpers/fixtures.js";

/**
 * Plan Core must stay runnable without a browser, without DBX and without any
 * host bridge. These tests are a cheap tripwire against accidentally importing
 * host types or touching browser globals.
 */

const CORE_DIR = path.join(REPO_ROOT, "src", "core");
const FORBIDDEN_TOKENS = ["window", "document", "dbxPlugin", "svelte", "@dbx-app", "tauri"];

/**
 * Kernel stages below the adapter must not even mention host-side concepts.
 * `raw-plan-input.js` lives at the Core root and deliberately names the values
 * that stay outside the contract, so only the stages are scanned here.
 */
const KERNEL_DIRS = ["parsers", "postgres", "mysql", "normalize", "metrics", "rules", "findings"].map((name) =>
  path.join(CORE_DIR, name),
);
const FORBIDDEN_KERNEL_TOKENS = [
  "connectionId",
  "credential",
  "password",
  "iframe",
  "manifest",
  "result-view",
  "queryTab",
  "dbxPlugin",
];

async function coreFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await coreFiles(full)));
    } else if (entry.name.endsWith(".js")) {
      files.push(full);
    }
  }
  return files.sort();
}

function importSpecifiers(source) {
  const specifiers = [];
  for (const pattern of [/from\s+["']([^"']+)["']/g, /import\s+["']([^"']+)["']/g, /import\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

test("Plan Core sources stay free of browser and DBX host APIs", async () => {
  const files = await coreFiles(CORE_DIR);
  assert.ok(files.length >= 3, `expected Plan Core sources under src/core, found ${files.length}`);

  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const token of FORBIDDEN_TOKENS) {
      assert.equal(source.includes(token), false, `${relativeToRepo(file)} must not reference "${token}"`);
    }
  }
});

test("kernel stages stay free of host, connection and credential concepts", async () => {
  let scanned = 0;
  for (const dir of KERNEL_DIRS) {
    let files;
    try {
      files = await coreFiles(dir);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      scanned += 1;
      const source = await readFile(file, "utf8");
      for (const token of FORBIDDEN_KERNEL_TOKENS) {
        assert.equal(source.includes(token), false, `${relativeToRepo(file)} must not reference "${token}"`);
      }
    }
  }
  assert.ok(scanned >= 6, `expected at least 6 kernel sources, found ${scanned}`);
});

test("Plan Core imports nothing outside src/core", async () => {
  for (const file of await coreFiles(CORE_DIR)) {
    const source = await readFile(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      assert.ok(specifier.startsWith("."), `${relativeToRepo(file)} imports bare specifier "${specifier}"`);
      const resolved = path.resolve(path.dirname(file), specifier);
      assert.ok(
        resolved.startsWith(`${CORE_DIR}${path.sep}`),
        `${relativeToRepo(file)} imports "${specifier}", which leaves src/core`,
      );
    }
  }
});
