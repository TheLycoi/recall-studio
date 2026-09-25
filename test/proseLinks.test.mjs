// Run with: npm test  (bundles src/proseLinks.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let pl;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "proseLinks.mjs");
  await build({ entryPoints: ["src/proseLinks.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  pl = await import(pathToFileURL(out).href);
});

const PAGES = [
  { path: "wiki/concepts/Kinetics.md", title: "Kinetics", aliases: ["Kinetic analysis"] },
  { path: "wiki/concepts/TBCM.md", title: "TBCM", aliases: ["Total body center of mass"] },
];
const PDF = "Lab 4 - Linear Impulse and Momentum 2026";
const HL = [
  { id: "H01", page: 1, target: { page: 1, selection: { beginIndex: 43, beginOffset: 0, endIndex: 48, endOffset: 31 } } },
  { id: "H02", page: 2, target: { page: 2, selection: { beginIndex: 58, beginOffset: 0, endIndex: 65, endOffset: 1 }, color: "yellow" } },
];

test("a marker that names a page becomes a full-path wikilink with the name as its text", () => {
  const r = pl.resolveProseLinks("Impulse translates the {{TBCM}} and is studied in {{kinetic analysis}}.", PAGES, HL, PDF);
  assert.equal(r.prose, "Impulse translates the [[wiki/concepts/TBCM|TBCM]] and is studied in [[wiki/concepts/Kinetics|kinetic analysis]].");
  assert.deepEqual(r.orphans, []);
});

test("a marker no page answers to is stripped to its words and reported once as an orphan", () => {
  const r = pl.resolveProseLinks("See {{Angular Impulse}} and {{Angular Impulse}} again; also {{  }}.", PAGES, HL, PDF);
  assert.equal(r.prose, "See Angular Impulse and Angular Impulse again; also.");
  assert.deepEqual(r.orphans, ["Angular Impulse"]);
  assert.ok(!r.prose.includes("[["), "the model never gets a bracket for free");
});

test("a citation by id becomes a PDF++ link with the file's title and page; a list of ids becomes one link each", () => {
  const r = pl.resolveProseLinks("Linear impulse is the area under the force-time curve [H01]. It equals the change in momentum [H01, H02].", PAGES, HL, PDF);
  assert.equal(
    r.prose,
    `Linear impulse is the area under the force-time curve [[${PDF}.pdf#page=1&selection=43,0,48,31|${PDF}, p.1]]. It equals the change in momentum [[${PDF}.pdf#page=1&selection=43,0,48,31|${PDF}, p.1]] [[${PDF}.pdf#page=2&selection=58,0,65,1&color=yellow|${PDF}, p.2]].`,
  );
  assert.deepEqual(r.citedIds, ["H01", "H02"]);
  assert.deepEqual(r.droppedIds, []);
});

test("an id the manifest lacks is dropped, counted, and leaves no stray space before the full stop", () => {
  const r = pl.resolveProseLinks("A claim with no support [H09]. Another [H01, H09].", PAGES, HL, PDF);
  assert.equal(r.prose, `A claim with no support. Another [[${PDF}.pdf#page=1&selection=43,0,48,31|${PDF}, p.1]].`);
  assert.deepEqual(r.droppedIds, ["H09"]);
  assert.deepEqual(r.citedIds, ["H01"]);
});

test("ordinary brackets are left alone: only an id-shaped token is a citation", () => {
  const r = pl.resolveProseLinks("Values in [N] and [kg m/s], and a range [1, 2].", PAGES, HL, PDF);
  assert.equal(r.prose, "Values in [N] and [kg m/s], and a range [1, 2].");
});

test("a custom display renders the citation text", () => {
  const r = pl.resolveProseLinks("x [H02]", PAGES, HL, PDF, (page) => `p.${page}`);
  assert.equal(r.prose, `x [[${PDF}.pdf#page=2&selection=58,0,65,1&color=yellow|p.2]]`);
});
