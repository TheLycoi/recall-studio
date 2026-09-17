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

// ---- schema, aliases and quote grounding
//
// These checks are opt-in: a vault that configures no schema and supplies no
// source text gets exactly the structural report it got before. That is what
// lets one plugin serve two vaults with different conventions.

const SCHEMA = {
  kindKey: "type",
  tagsByKind: {
    concept: ["method", "theory", "term"],
    entity: ["person", "product"],
  },
  aliasKinds: ["concept", "entity"],
};

const page = (path, front, body) => ({ path, content: `---\n${front}\n---\n\n${body}\n` });

test("a tag outside the vocabulary is a schema violation", () => {
  const r = vl.lintVault([page("wiki/a.md", 'type: concept\ntags: [vibes]\naliases:\n  - "A"', "Text with a claim in it.")], { schema: SCHEMA });
  const found = r.issues.filter((i) => i.id === "schema-violation");
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /vibes/);
});

test("a tag inside the vocabulary passes", () => {
  const r = vl.lintVault([page("wiki/a.md", 'type: concept\ntags: [method]\naliases:\n  - "A"', "Text with a claim in it.")], { schema: SCHEMA });
  assert.deepEqual(r.issues.filter((i) => i.id === "schema-violation"), []);
});

test("an unknown kind is reported once, not once per tag", () => {
  const r = vl.lintVault([page("wiki/a.md", "type: pamphlet\ntags: [method, theory]", "Text with a claim in it.")], { schema: SCHEMA });
  const found = r.issues.filter((i) => i.id === "schema-violation");
  assert.equal(found.length, 1);
  assert.match(found[0].detail, /pamphlet/);
});

test("an empty alias list counts as no aliases", () => {
  // The bug worth not repeating: testing for the key alone treats a page whose
  // aliases were all deleted as configured.
  for (const front of ["type: concept\ntags: [method]\naliases: []", 'type: concept\ntags: [method]\naliases:\n  - ""']) {
    const r = vl.lintVault([page("wiki/a.md", front, "Text with a claim in it.")], { schema: SCHEMA });
    assert.equal(r.issues.filter((i) => i.id === "no-aliases").length, 1, front);
  }
});

test("a real alias satisfies the check, inline or block", () => {
  for (const front of ['type: concept\ntags: [method]\naliases: ["Other name"]', 'type: concept\ntags: [method]\naliases:\n  - "Other name"']) {
    const r = vl.lintVault([page("wiki/a.md", front, "Text with a claim in it.")], { schema: SCHEMA });
    assert.deepEqual(r.issues.filter((i) => i.id === "no-aliases"), [], front);
  }
});

test("no schema configured means no schema findings", () => {
  const r = vl.lintVault([page("wiki/a.md", "class: HBIO408", "Text with a claim in it.")]);
  assert.deepEqual(r.issues.filter((i) => i.id === "schema-violation" || i.id === "no-aliases"), []);
});

const QUOTED = (quote, cite) =>
  page(
    "wiki/a.md",
    'type: concept\ntags: [method]\naliases:\n  - "A"',
    `Some prose about it.\n\n## Mentions in Source\n\n- "${quote}"${cite ? ` — [[${cite}]]` : ""}`,
  );

const SOURCES = new Map([["sources/paper.md", "The study found that spacing improves retention over massing."]]);

test("a quote that is in its cited source is clean", () => {
  const r = vl.lintVault([QUOTED("spacing improves retention", "sources/paper")], { sources: SOURCES });
  assert.deepEqual(r.issues.filter((i) => i.id.endsWith("-quote")), []);
});

test("a quote that is not in its cited source is ungrounded", () => {
  const r = vl.lintVault([QUOTED("spacing has no effect on retention", "sources/paper")], { sources: SOURCES });
  const found = r.issues.filter((i) => i.id === "ungrounded-quote");
  assert.equal(found.length, 1);
  assert.equal(found[0].target, "sources/paper");
  assert.match(found[0].detail, /no effect/);
});

test("a quote citing a source the vault does not hold is unverifiable, not ungrounded", () => {
  // The distinction matters: one says the page is wrong, the other says we
  // cannot tell. Reporting them together would overstate what is known.
  const r = vl.lintVault([QUOTED("spacing improves retention", "sources/missing")], { sources: SOURCES });
  assert.equal(r.issues.filter((i) => i.id === "unverifiable-quote").length, 1);
  assert.deepEqual(r.issues.filter((i) => i.id === "ungrounded-quote"), []);
});

test("an uncited quote is unattributed, never ungrounded, even when a source happens to contain it", () => {
  const present = vl.lintVault([QUOTED("spacing improves retention", null)], { sources: SOURCES });
  assert.equal(present.issues.filter((i) => i.id === "unattributed-quote").length, 1);
  assert.deepEqual(present.issues.filter((i) => i.id === "ungrounded-quote"), []);
  // A coincidental match in an unrelated source is not provenance.
  const absent = vl.lintVault([QUOTED("spacing is a myth", null)], { sources: SOURCES });
  assert.equal(absent.issues.filter((i) => i.id === "unattributed-quote").length, 1);
  assert.deepEqual(absent.issues.filter((i) => i.id === "ungrounded-quote"), []);
  assert.match(absent.issues[0].detail, /myth/);
});

test("findings sort by severity class before path", () => {
  const pages = [
    page("wiki/a.md", "type: concept", ""),
    page(
      "wiki/z.md",
      'type: concept\ntags: [method]\naliases:\n  - "Z"',
      'Prose about it.\n\n## Mentions in Source\n\n- "spacing is a myth" — [[sources/paper]]',
    ),
  ];
  const r = vl.lintVault(pages, { sources: SOURCES });
  assert.equal(r.issues[0].id, "ungrounded-quote", "a wrong quote on z outranks an empty page on a");
  assert.equal(r.issues[0].path, "wiki/z.md");
});

test("the unattributed label says nothing can confirm the quote, not that it is wrong", () => {
  assert.match(vl.VAULT_ISSUE_LABELS["unattributed-quote"], /No source recorded/);
});

test("quote matching survives reflowing and smart quotes", () => {
  const sources = new Map([["sources/paper.md", "the spacing\neffect is “real” and well documented"]]);
  const r = vl.lintVault([QUOTED("the spacing effect is “real”", "sources/paper")], { sources });
  assert.deepEqual(r.issues.filter((i) => i.id.endsWith("-quote")), []);
});

test("a PDF++ callout is not string-checked: it carries its own anchor", () => {
  const p = page(
    "wiki/a.md",
    'type: concept\ntags: [method]\naliases:\n  - "A"',
    '## Mentions in Source\n\n> [!PDF|yellow] [[Paper.pdf#page=2|Paper, p.2]]\n> > a span that appears in no source note',
  );
  const r = vl.lintVault([p], { sources: SOURCES });
  assert.deepEqual(r.issues.filter((i) => i.id.endsWith("-quote")), []);
});

test("no sources supplied means no quote findings", () => {
  const r = vl.lintVault([QUOTED("anything at all", "sources/paper")]);
  assert.deepEqual(r.issues.filter((i) => i.id.endsWith("-quote")), []);
});

test("the report is byte-identical across runs on an unchanged vault", () => {
  const pages = [
    QUOTED("spacing is a myth", "sources/paper"),
    page("wiki/b.md", "type: concept\ntags: [vibes]", "Another note with prose."),
  ];
  const a = vl.renderVaultLint(vl.lintVault(pages, { schema: SCHEMA, sources: SOURCES }));
  const b = vl.renderVaultLint(vl.lintVault(pages, { schema: SCHEMA, sources: SOURCES }));
  assert.equal(a, b);
});

test("the ungrounded quote leads the report", () => {
  const pages = [QUOTED("spacing is a myth", "sources/paper"), page("wiki/b.md", "type: concept", "")];
  const out = vl.renderVaultLint(vl.lintVault(pages, { schema: SCHEMA, sources: SOURCES }));
  const quoteAt = out.indexOf("Quote not in its source");
  const emptyAt = out.indexOf("Empty:");
  assert.ok(quoteAt > -1 && emptyAt > -1);
  assert.ok(quoteAt < emptyAt, "a wrong answer outranks a missing one");
});
