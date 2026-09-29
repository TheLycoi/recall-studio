// Run with: npm test. Bundles src/upstream/vendor.ts, the one file through which
// WikiLM reaches the vendored obsidian-llm-wiki source, with the same esbuild
// options the plugin build uses (externals, the @llm-wiki alias, CommonJS
// output, no native dynamic import), then loads the bundle with require.
//
// `obsidian` is replaced by a stub that exports every value name declared in
// the installed obsidian.d.ts, each as a plain function. A function can be
// called and can be extended, so upstream modules that subclass Modal or
// ItemView at load time evaluate without the real app. Nothing here calls
// into the vault.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

function obsidianStub() {
  const dts = readFileSync("node_modules/obsidian/obsidian.d.ts", "utf8");
  const names = new Set();
  const decl = /^export (?:declare )?(?:abstract )?(?:class|function|const|let|var|enum) (\w+)/gm;
  for (const m of dts.matchAll(decl)) names.add(m[1]);
  return {
    name: "obsidian-stub",
    setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: [...names].map((n) => `export function ${n}() {}`).join("\n"),
        loader: "js",
      }));
    },
  };
}

let up;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-upstream-"));
  const out = path.join(dir, "vendor.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    entryPoints: ["src/upstream/vendor.ts"],
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub(), ...shared.plugins],
  });
  up = createRequire(import.meta.url)(out);
});

test("the facade exports upstream's engine, schema manager, settings and retrieval functions", () => {
  for (const name of ["WikiEngine", "SchemaManager", "UPSTREAM_DEFAULT_SETTINGS", "selectPprSeeds", "loadRelevantPagesForQuery", "UPSTREAM_VERSION"]) {
    assert.notEqual(up[name], undefined, `${name} is exported`);
  }
  assert.equal(typeof up.WikiEngine, "function");
  assert.equal(typeof up.SchemaManager, "function");
  assert.equal(typeof up.selectPprSeeds, "function");
  assert.equal(typeof up.loadRelevantPagesForQuery, "function");
  assert.equal(typeof up.UPSTREAM_DEFAULT_SETTINGS, "object");
});

test("UPSTREAM_VERSION is the version in the vendored manifest, and that is 1.27.2", () => {
  const manifest = JSON.parse(readFileSync("vendor/llm-wiki/manifest.json", "utf8"));
  assert.equal(up.UPSTREAM_VERSION, manifest.version);
  assert.equal(up.UPSTREAM_VERSION, "1.27.2");
});
