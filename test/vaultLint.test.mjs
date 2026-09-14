// Run with: npm test  (bundles src/vaultLint.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let vl;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-vlint-"));
  const out = path.join(dir, "vaultLint.mjs");
  await build({ entryPoints: ["src/vaultLint.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  vl = await import(pathToFileURL(out).href);
});

const ids = (r, id) => r.issues.filter((i) => i.id === id).map((i) => i.title);

test("lintVault reports a note with only frontmatter as empty", () => {
  const r = vl.lintVault([{ path: "wiki/WADA.md", content: "---\nclass: HBIO250\n---\n" }]);
  assert.deepEqual(ids(r, "empty-note"), ["WADA"]);
  assert.equal(r.units, 0);
});

test("lintVault separates a note with text but nothing quotable", () => {
  // An embed carries no text Ask could quote, so the note indexes to nothing.
  const r = vl.lintVault([
    { path: "wiki/Pharmacokinetics.md", content: "---\nclass: X\n---\n![[Lecture.pdf#page=20&rect=1,2,3,4]]\n" },
  ]);
  assert.deepEqual(ids(r, "no-evidence"), ["Pharmacokinetics"]);
  assert.equal(ids(r, "empty-note").length, 0);
});

test("lintVault finds a link that points at no note", () => {
  const r = vl.lintVault([
    { path: "wiki/a.md", content: "A real sentence that indexes fine. [[Missing Page]]" },
    { path: "wiki/b.md", content: "Another real sentence here. [[a]]" },
  ]);
  const dead = r.issues.filter((i) => i.id === "dead-link");
  assert.equal(dead.length, 1);
  assert.equal(dead[0].target, "Missing Page");
});

test("lintVault counts one dead link per note per target, not per mention", () => {
  const r = vl.lintVault([
    { path: "wiki/a.md", content: "Sentence one here. [[Gone]] and again [[Gone]] and [[Gone]]" },
  ]);
  assert.equal(r.issues.filter((i) => i.id === "dead-link").length, 1);
});

test("lintVault calls a note with no links either way an orphan, not merely unlinked", () => {
  const r = vl.lintVault([
    { path: "wiki/a.md", content: "A sentence that indexes fine here." },
    { path: "wiki/b.md", content: "Another sentence entirely. [[c]]" },
    { path: "wiki/c.md", content: "A third sentence for good measure." },
  ]);
  assert.deepEqual(ids(r, "orphan"), ["a"]);
  // c has an incoming link, b has an outgoing one: neither is cut off.
  assert.deepEqual(ids(r, "unlinked"), ["b"]);
});

test("lintVault does not count a self-link as reachability", () => {
  const r = vl.lintVault([{ path: "wiki/a.md", content: "A sentence that indexes fine. [[a]]" }]);
  assert.deepEqual(ids(r, "orphan"), ["a"]);
});

test("renderVaultLint says so plainly when nothing is wrong", () => {
  const md = vl.renderVaultLint({ notes: 3, units: 40, issues: [] });
  assert.match(md, /3 notes, 40 passages/);
  assert.match(md, /Nothing to fix/);
});

test("renderVaultLint groups issues and names the notes", () => {
  const r = vl.lintVault([
    { path: "wiki/a.md", content: "---\nx: 1\n---\n" },
    { path: "wiki/b.md", content: "A real sentence here. [[Missing]]" },
  ]);
  const md = vl.renderVaultLint(r);
  assert.match(md, /\[\[a\]\]/);
  assert.match(md, /`Missing`/);
});
