#!/usr/bin/env bun
// build.ts — bundles the four shared libs to dist/ for npm publish
// Output targets plain node >= 18 (consumers do not need bun).
import * as path from "node:path";
import * as fs from "node:fs";

const LIBS = [
  "config",
  "build-stamp",
  "manifest-help",
  "session-path-shortener",
] as const;

const SRC_DIR = path.join(import.meta.dir, "extensions/lib");
const DIST_DIR = path.join(import.meta.dir, "dist");

fs.mkdirSync(DIST_DIR, { recursive: true });

let errors = 0;
for (const lib of LIBS) {
  const entry = path.join(SRC_DIR, `${lib}.ts`);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: DIST_DIR,
    format: "esm",
    target: "node",
    naming: `${lib}.mjs`,
    external: [], // all deps are node builtins
  });
  if (!result.success) {
    console.error(`❌ ${lib}:`, result.logs);
    errors++;
  } else {
    console.log(`✅ dist/${lib}.mjs`);
  }
}

// Generate minimal .d.mts declaration stubs (types only — bun does not emit .d.ts)
for (const lib of LIBS) {
  const src = path.join(SRC_DIR, `${lib}.ts`);
  const dts = path.join(DIST_DIR, `${lib}.d.mts`);
  // Re-export all named exports from the TS source for type resolution
  fs.writeFileSync(dts, `export * from "../extensions/lib/${lib}.ts";\n`);
  console.log(`✅ dist/${lib}.d.mts`);
}

if (errors > 0) {
  console.error(`\n${errors} build error(s)`);
  process.exit(1);
}
console.log("\n✅ build complete");
