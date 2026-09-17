// Run with: npm test  (bundles src/duplicates.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let d;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-dup-"));
  const out = path.join(dir, "duplicates.mjs");
  await build({ entryPoints: ["src/duplicates.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  d = await import(pathToFileURL(out).href);
});

const pg = (path, title, aliases = [], evidence = []) => ({ path, title, aliases, evidence });

test("a title that is another page's alias is a duplicate by name", () => {
  const out = d.findDuplicates([
    pg("wiki/concepts/chunking.md", "chunking", ["Chunk Size"]),
    pg("wiki/concepts/chunk-size.md", "chunk-size", []),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pass, "name");
  assert.equal(out[0].a, "wiki/concepts/chunk-size.md", "a is the lesser path");
  assert.equal(out[0].b, "wiki/concepts/chunking.md");
  assert.match(out[0].detail, /Chunk Size/);
});

test("name matching folds case, spacing and punctuation", () => {
  const out = d.findDuplicates([pg("a.md", "Spaced Repetition!"), pg("b.md", "spaced-repetition")]);
  assert.equal(out.length, 1);
});

test("two pages citing the same span of the same document are duplicates by evidence", () => {
  const out = d.findDuplicates([
    pg("a.md", "Receptors", [], ["Pharm#page=4&selection=2,0,33,19"]),
    pg("b.md", "Binding", [], ["Pharm#page=4&selection=2,0,33,19", "Pharm#page=5&selection=0,0,1,1"]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pass, "evidence");
  assert.match(out[0].detail, /Pharm/);
  assert.match(out[0].detail, /page=4/);
});

test("the same span in two different documents is not shared evidence", () => {
  const out = d.findDuplicates([
    pg("a.md", "A", [], ["Deck1#page=4&selection=2,0,33,19"]),
    pg("b.md", "B", [], ["Deck2#page=4&selection=2,0,33,19"]),
  ]);
  assert.deepEqual(out, []);
});

test("a page never duplicates itself, and a pair is reported once even when both passes fire", () => {
  const out = d.findDuplicates([
    pg("a.md", "Chunking", ["chunk size"], ["P#page=1&selection=0,0,0,4"]),
    pg("b.md", "Chunk Size", ["chunking"], ["P#page=1&selection=0,0,0,4"]),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pass, "name", "the cheaper pass wins the report");
});

test("distinct pages produce nothing, and output is sorted by path", () => {
  assert.deepEqual(d.findDuplicates([pg("a.md", "Agents"), pg("b.md", "Agentic Systems")]), []);
  const out = d.findDuplicates([
    pg("z.md", "Same", []),
    pg("m.md", "same", []),
    pg("a.md", "SAME", []),
  ]);
  assert.deepEqual(
    out.map((f) => [f.a, f.b]),
    [
      ["a.md", "m.md"],
      ["a.md", "z.md"],
      ["m.md", "z.md"],
    ],
  );
});
