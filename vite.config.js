import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { computeBuildFingerprint } from "./scripts/build-fingerprint.mjs";
import { planDetectiveFixtures } from "./scripts/vite-plugin-fixtures.mjs";

const buildFingerprint = computeBuildFingerprint(process.cwd());

export default defineConfig({
  define: { __PD_BUILD_FINGERPRINT__: JSON.stringify(buildFingerprint) },
  plugins: [
    svelte(),
    // Exposes fixtures/postgres/** to the UI as `virtual:plan-detective-fixtures`
    // for the offline / demo mode. It embeds fixture plans + provenance only,
    // never golden files or setup.sql.
    planDetectiveFixtures(),
    { name: "dbx-build-signal", closeBundle() { console.log("DBX_UI_BUILD_SUCCESS"); } },
  ],
  build: { outDir: "ui", emptyOutDir: true },
});
