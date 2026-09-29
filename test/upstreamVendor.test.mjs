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
//
// The same bundle also carries three probes next to the facade, so they share
// its module graph: one of upstream's `.passthrough()` output schemas, the
// `zodSchema()` adapter from `ai` that upstream's output-args.ts converts
// those schemas with, and one of WikiLM's own zod schemas. Upstream is written
// and tested against zod 3; WikiLM uses zod 4.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function obsidianStub() {
  const dts = readFileSync(path.join(ROOT, "node_modules/obsidian/obsidian.d.ts"), "utf8");
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
let dir;
before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "wikilm-upstream-"));
  const out = path.join(dir, "vendor.cjs");
  const shared = sharedBuildOptions();
  await build({
    ...shared,
    stdin: {
      contents: [
        'export * from "./src/upstream/vendor.ts";',
        'export { DedupResultLLMSchema as probeUpstreamPassthroughSchema } from "@llm-wiki/llm-sdk/output-schemas";',
        'export { zodSchema as probeZodSchema } from "ai";',
        'export { DigestOut as probeWikilmSchema } from "./src/schemas.ts";',
      ].join("\n"),
      resolveDir: ROOT,
      sourcefile: "upstream-vendor-probe.ts",
      loader: "ts",
    },
    outfile: out,
    logLevel: "error",
    external: shared.external.filter((e) => e !== "obsidian"),
    plugins: [obsidianStub(), ...shared.plugins],
  });
  up = createRequire(import.meta.url)(out);
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
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
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "vendor/llm-wiki/manifest.json"), "utf8"));
  assert.equal(up.UPSTREAM_VERSION, manifest.version);
  assert.equal(up.UPSTREAM_VERSION, "1.27.2");
});

// `ai`'s zodSchema() picks its converter by `"_zod" in schema`. The zod 4
// branch forces `additionalProperties: false` on every object, which would
// send upstream's `.passthrough()` schemas to the model as closed.
test("vendored code gets zod 3, so a passthrough schema stays open on the wire", () => {
  const schema = up.probeUpstreamPassthroughSchema;
  assert.equal("_zod" in schema, false, "upstream's schema was built by zod 4");
  assert.equal(typeof schema._def, "object", "upstream's schema has zod 3's _def");
  const json = up.probeZodSchema(schema).jsonSchema;
  assert.equal(json.type, "object");
  assert.equal(json.additionalProperties, true, "top-level passthrough object is open");
  assert.equal(json.properties.duplicates.items.additionalProperties, true, "nested passthrough object is open");
});

test("WikiLM's own files still get zod 4", () => {
  assert.equal("_zod" in up.probeWikilmSchema, true, "WikiLM's schema was built by zod 4");
});
