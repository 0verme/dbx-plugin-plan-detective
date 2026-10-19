import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const BUILD_INPUTS = [
  "manifest.json",
  "package.json",
  "package-lock.json",
  "vite.config.js",
  "svelte.config.js",
  "index.html",
  "scripts/build-fingerprint.mjs",
  "scripts/vite-plugin-fixtures.mjs",
];

/** Hash the source/configuration inputs embedded into the UI bundle at build time. */
export function computeBuildFingerprint(root) {
  const files = [
    ...BUILD_INPUTS,
    ...listFiles(path.join(root, "src"), root),
    ...listFiles(path.join(root, "fixtures/postgres"), root),
  ].sort();
  const hash = createHash("sha256");
  for (const relativePath of files) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(path.join(root, relativePath)));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Fail packaging if the generated bundle does not identify these source inputs. */
export function assertBundleFingerprint(bundleText, expectedFingerprint) {
  if (typeof bundleText !== "string" || !bundleText.includes(expectedFingerprint)) {
    throw new Error(`Generated UI bundle fingerprint does not match current source inputs (${expectedFingerprint}).`);
  }
  return true;
}

function listFiles(directory, root) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listFiles(absolutePath, root);
      return entry.isFile() ? [path.relative(root, absolutePath).split(path.sep).join("/")] : [];
    });
}
