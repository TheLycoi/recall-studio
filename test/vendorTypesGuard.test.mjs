// Run with: npm test. Covers the check `npm run build` makes before its
// typecheck: the declarations `npm run vendor:types` writes for the vendored
// obsidian-llm-wiki source must exist and must have been made from the
// vendored source as it is now. Each case builds a small fake vendor folder
// and declarations folder in a temporary directory; nothing touches the real
// vendor/llm-wiki or .types.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkDeclarations,
  rewriteZodSpecifiers,
  vendorFingerprint,
  writeStamp,
} from "../scripts/vendor-stamp.mjs";

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A fake checkout: a vendor folder at `version`, an extra config file, and an empty declarations path. */
function fixture(version = "1.27.2") {
  const root = mkdtempSync(path.join(tmpdir(), "wikilm-vendor-guard-"));
  dirs.push(root);
  const vendorRoot = path.join(root, "vendor", "llm-wiki");
  write(path.join(vendorRoot, "manifest.json"), JSON.stringify({ version }));
  write(path.join(vendorRoot, "package.json"), "{}");
  write(path.join(vendorRoot, "tsconfig.json"), "{}");
  write(path.join(vendorRoot, "src", "types.ts"), "export type A = string;\n");
  write(path.join(vendorRoot, "src", "wiki", "engine.ts"), "export class E {}\n");
  write(path.join(vendorRoot, "src", "__tests__", "engine.test.ts"), "// a test\n");
  const extra = path.join(root, "tsconfig.llm-wiki-types.json");
  write(extra, "{}");
  const opts = { vendorRoot, typesDir: path.join(root, ".types", "llm-wiki"), extraFiles: [extra] };
  return { root, vendorRoot, opts };
}

/** What vendor:types leaves behind: some declarations and a stamp for the vendor folder as it is now. */
function emit(opts) {
  write(path.join(opts.typesDir, "types.d.ts"), "export type A = string;\n");
  writeStamp(opts.typesDir, vendorFingerprint(opts));
}

test("missing: no declarations folder, and the message says to run npm run vendor:types", () => {
  const { opts } = fixture();
  const r = checkDeclarations(opts);
  assert.equal(r.status, "missing");
  assert.match(r.message, /npm run vendor:types/);
});

test("stale: declarations without a stamp, as an older vendor:types left them", () => {
  const { opts } = fixture();
  write(path.join(opts.typesDir, "types.d.ts"), "export type A = string;\n");
  const r = checkDeclarations(opts);
  assert.equal(r.status, "stale");
  assert.match(r.message, /npm run vendor:types/);
});

test("current: declarations stamped from the vendor folder as it is", () => {
  const { opts } = fixture();
  emit(opts);
  assert.equal(checkDeclarations(opts).status, "current");
});

test("stale: a vendored source file changed after the declarations were made", () => {
  const { vendorRoot, opts } = fixture();
  emit(opts);
  write(path.join(vendorRoot, "src", "wiki", "engine.ts"), "export class E { x = 1 }\n");
  const r = checkDeclarations(opts);
  assert.equal(r.status, "stale");
  assert.match(r.message, /npm run vendor:types/);
});

test("stale: a vendored source file was added or removed", () => {
  const { vendorRoot, opts } = fixture();
  emit(opts);
  write(path.join(vendorRoot, "src", "wiki", "new.ts"), "export const n = 1;\n");
  assert.equal(checkDeclarations(opts).status, "stale");
  rmSync(path.join(vendorRoot, "src", "wiki", "new.ts"));
  assert.equal(checkDeclarations(opts).status, "current");
  rmSync(path.join(vendorRoot, "src", "wiki", "engine.ts"));
  assert.equal(checkDeclarations(opts).status, "stale");
});

test("stale: the vendored version was bumped, and the message names both versions", () => {
  const { vendorRoot, opts } = fixture("1.27.2");
  emit(opts);
  write(path.join(vendorRoot, "manifest.json"), JSON.stringify({ version: "1.28.0" }));
  const r = checkDeclarations(opts);
  assert.equal(r.status, "stale");
  assert.match(r.message, /1\.27\.2/);
  assert.match(r.message, /1\.28\.0/);
});

test("stale: the declaration build config changed", () => {
  const { root, opts } = fixture();
  emit(opts);
  write(path.join(root, "tsconfig.llm-wiki-types.json"), '{"compilerOptions":{}}');
  assert.equal(checkDeclarations(opts).status, "stale");
});

test("current: upstream's tests are not part of the fingerprint, and neither are file times", () => {
  const { vendorRoot, opts } = fixture();
  emit(opts);
  write(path.join(vendorRoot, "src", "__tests__", "engine.test.ts"), "// a changed test\n");
  write(path.join(vendorRoot, "src", "wiki", "engine.ts"), "export class E {}\n"); // same bytes, new mtime
  assert.equal(checkDeclarations(opts).status, "current");
});

test("the fingerprint does not depend on where the checkout lives", () => {
  const a = fixture();
  const b = fixture();
  assert.deepEqual(vendorFingerprint(a.opts), vendorFingerprint(b.opts));
});

test("declarations import zod 3 from zod/v3, the same module the bundle gives vendored code", () => {
  const dts = [
    "import type { z } from 'zod';",
    'import { z as z2 } from "zod";',
    "export declare const S: import('zod').ZodObject<{}>;",
    "import type { X } from 'zod/v4';",
    "import type { Y } from 'zodiac';",
  ].join("\n");
  assert.equal(
    rewriteZodSpecifiers(dts),
    [
      "import type { z } from 'zod/v3';",
      'import { z as z2 } from "zod/v3";',
      "export declare const S: import('zod/v3').ZodObject<{}>;",
      "import type { X } from 'zod/v4';",
      "import type { Y } from 'zodiac';",
    ].join("\n"),
  );
});
