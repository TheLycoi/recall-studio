// Run with: npm test  (bundles src/sentences.ts, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let s;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "sentences.mjs");
  await build({ entryPoints: ["src/sentences.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  s = await import(pathToFileURL(out).href);
});

test("two sentences split at the full stop", () => {
  assert.deepEqual(s.splitSentences("Force is mass times acceleration. Impulse is force over time."), [
    "Force is mass times acceleration.",
    "Impulse is force over time.",
  ]);
});

test("a full stop inside brackets does not split", () => {
  assert.equal(s.splitSentences("The model (see ch. 3 for detail) holds.").length, 1);
});
