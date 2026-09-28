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

test("two pages citing the same PDF span are reported as duplicate pages", () => {
  const callout = (q) =>
    `## Highlights\n\n> [!PDF|yellow] [[Pharm.pdf#page=4&selection=2,0,33,19&color=yellow|Pharm, p.4]]\n> > ${q}`;
  const r = vl.lintVault([
    page("wiki/a.md", "type: concept", callout("Receptors bind ligands with high affinity.")),
    page("wiki/b.md", "type: concept", callout("Receptors bind ligands with high affinity.")),
  ]);
  const dup = r.issues.filter((i) => i.id === "duplicate-pages");
  assert.equal(dup.length, 1);
  assert.equal(dup[0].path, "wiki/a.md");
  assert.equal(dup[0].target, "wiki/b.md");
});

test("two pages citing the same PDF page, with no span, are not duplicates", () => {
  const claim = (text) => `## Key claims\n- ${text} — [[Deck.pdf#page=1|p.1]]`;
  const r = vl.lintVault([
    page("wiki/a.md", "type: concept", claim("Coaches support client-led change.")),
    page("wiki/b.md", "type: concept", claim("Referral networks widen what a coach can offer.")),
  ]);
  assert.deepEqual(r.issues.filter((i) => i.id === "duplicate-pages"), []);
});

test("a legacy topic page is a known kind with no tag rule, not a schema violation", () => {
  const r = vl.lintVault([page("classes/HBIO250/Doping.md", "type: topic\nclass: HBIO250\ntags: [hbio250]", "A sentence of prose here.")], { schema: vl.WIKI_SCHEMA });
  assert.deepEqual(r.issues.filter((i) => i.id === "schema-violation"), []);
  const hub = vl.lintVault([page("classes/PHED163/PHED163.md", "type: topic-index\nclass: PHED163", "A sentence of prose here.")], { schema: vl.WIKI_SCHEMA });
  assert.deepEqual(hub.issues.filter((i) => i.id === "schema-violation"), []);
});

test("an unknown kind is still a schema violation", () => {
  const r = vl.lintVault([page("wiki/x.md", "type: nonsense", "A sentence of prose here.")], { schema: vl.WIKI_SCHEMA });
  assert.equal(r.issues.filter((i) => i.id === "schema-violation").length, 1);
});

test("a bullet whose link opens the PDF is anchored, never string-checked", () => {
  const p = page(
    "wiki/a.md",
    'type: concept\ntags: [method]\naliases:\n  - "A"',
    '## Mentions in Source\n\n- "a span that appears in no source note" [[Paper.pdf#page=2&selection=1,0,1,9&color=yellow|p.2]]',
  );
  const r = vl.lintVault([p], { sources: SOURCES });
  assert.deepEqual(r.issues.filter((i) => i.id.endsWith("-quote")), []);
});

test("look-alike pages are held back as candidates for the model, not reported as duplicates", () => {
  const r = vl.lintVault([
    { path: "wiki/concepts/Kinetics.md", content: "---\ntype: concept\naliases: [x]\n---\n# Kinetics\n\nForces. [[Kinematics]]" },
    { path: "wiki/concepts/Kinematics.md", content: "---\ntype: concept\naliases: [y]\n---\n# Kinematics\n\nMotion. [[Kinetics]]" },
  ]);
  assert.deepEqual(r.issues.filter((i) => i.id === "duplicate-pages"), []);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].pass, "similar");
  const text = vl.renderVaultLint(r);
  assert.match(text, /1 pair spelled alike/, text);
});

// ---- a page's own prose, and the pure findings built on it
//
// "Own prose" is what the page says in its own sentences: not a quote it
// carries, not a bullet, a heading or a table. Thin pages and the residue of
// unquoted sentences are both measured on it.

const MIXED = [
  "---",
  "type: concept",
  "aliases: [A]",
  "---",
  "# Title",
  "",
  "First paragraph with a [[Target|shown words]] link.",
  "It runs on a second line.",
  "",
  "## Section",
  "- a bullet that is not prose",
  "1. a numbered item that is not prose",
  "> a callout line that is not prose",
  "| a | table |",
  "| --- | --- |",
  "```",
  "code that is not prose",
  "```",
  "![[Deck.pdf#page=2&rect=1,2,3,4]]",
  "",
  "Second paragraph.",
].join("\n");

test("proseParagraphs keeps paragraphs and drops frontmatter, headings, lists, callouts, tables, code and embeds", () => {
  const got = vl.proseParagraphs(MIXED);
  assert.deepEqual(got, ["First paragraph with a [[Target|shown words]] link. It runs on a second line.", "Second paragraph."]);
});

test("proseChars counts what the reader sees, not the link markup", () => {
  assert.equal(vl.proseChars(MIXED), "First paragraph with a shown words link. It runs on a second line.".length + "Second paragraph.".length);
});

const CONCEPT = 'type: concept\ntags: [method]\naliases:\n  - "A"';
/** Prose of exactly `n` characters: one sentence of repeated words, cut to length and ended with a period. */
const proseOf = (n) => `${"word ".repeat(n).slice(0, n - 1)}.`;

test("a concept page with prose just under the threshold is thin; at the threshold it is not", () => {
  const T = vl.THIN_PROSE_CHARS;
  assert.equal(typeof T, "number");
  const under = vl.lintVault([page("wiki/a.md", CONCEPT, `${proseOf(T - 1)}\n\n- a long bullet ${"x".repeat(400)}`)], { schema: SCHEMA });
  assert.deepEqual(ids(under, "thin-page"), ["a"]);
  const at = vl.lintVault([page("wiki/a.md", CONCEPT, proseOf(T))], { schema: SCHEMA });
  assert.deepEqual(ids(at, "thin-page"), []);
});

test("an entity page is measured too, and bullets and callouts do not count as its prose", () => {
  const r = vl.lintVault([page("wiki/e.md", 'type: entity\ntags: [person]\naliases: ["E"]', `> ${"quoted ".repeat(100)}\n\n- ${"listed ".repeat(100)}`)], { schema: SCHEMA });
  assert.deepEqual(ids(r, "thin-page"), ["e"]);
});

test("an empty page is empty, not thin, and a source page is never thin", () => {
  const empty = vl.lintVault([page("wiki/a.md", CONCEPT, "")], { schema: SCHEMA });
  assert.deepEqual(ids(empty, "empty-note"), ["a"]);
  assert.deepEqual(ids(empty, "thin-page"), []);
  const source = vl.lintVault([page("wiki/sources/s.md", "type: source\ntags: [paper]", "Short.")], { schema: vl.WIKI_SCHEMA });
  assert.deepEqual(ids(source, "thin-page"), []);
});

test("with no schema there is no kind, so nothing is thin", () => {
  const r = vl.lintVault([page("wiki/a.md", "type: concept", "Short.")]);
  assert.deepEqual(ids(r, "thin-page"), []);
});

test("thin sits just above empty in the report, and every new id has a label", () => {
  const r = vl.lintVault([page("wiki/a.md", CONCEPT, ""), page("wiki/b.md", CONCEPT, "Short prose here.")], { schema: SCHEMA });
  const out = vl.renderVaultLint(r);
  assert.ok(out.indexOf("Thin:") > -1 && out.indexOf("Thin:") < out.indexOf("Empty:"), out);
  for (const id of ["unsupported-prose", "wrong-kind", "missing-link", "thin-page"]) assert.ok(vl.VAULT_ISSUE_LABELS[id], id);
  const order = vl.ORDER;
  const at = (id) => order.indexOf(id);
  assert.equal(at("unsupported-prose"), at("unattributed-quote") + 1);
  assert.equal(at("wrong-kind"), at("schema-violation") + 1);
  assert.equal(at("missing-link"), at("unlinked") + 1);
  assert.equal(at("thin-page"), at("empty-note") - 1);
});

// ---- residue: the page's own sentences that none of its quotes back
//
// Candidates for the model review, never findings: token overlap misses
// paraphrase, so an unquoted sentence is one to look at, not one that is wrong.

const KEY_CLAIM = "Spacing improves long term retention of vocabulary items in adults";
const withClaims = (path, prose) =>
  page(path, CONCEPT, `${prose}\n\n## Key claims\n- ${KEY_CLAIM} — [[Deck.pdf#page=1|p.1]]`);

test("a sentence a quote on the page states is not residue; one no quote states is", () => {
  const r = vl.lintVault([
    withClaims("wiki/a.md", "Spacing improves long term retention of vocabulary. Massed practice feels productive but fades within weeks."),
  ]);
  assert.deepEqual(r.claims, [{ path: "wiki/a.md", title: "a", n: 1, text: "Massed practice feels productive but fades within weeks." }]);
});

test("residue is numbered per page in page order and capped at eight", () => {
  const sentences = Array.from({ length: 10 }, (_, i) => `Unrelated sentence number ${["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"][i]} mentions giraffes wandering savannahs.`);
  const r = vl.lintVault([withClaims("wiki/b.md", sentences.slice(0, 5).join(" ") + "\n\n" + sentences.slice(5).join(" "))]);
  assert.equal(r.claims.length, 8);
  assert.deepEqual(r.claims.map((c) => c.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(r.claims[0].text, sentences[0]);
  assert.equal(r.claims[7].text, sentences[7]);
});

test("a sentence under the significant-word floor is never residue", () => {
  const r = vl.lintVault([withClaims("wiki/a.md", "It is so. Massed practice feels productive but fades within weeks.")]);
  assert.deepEqual(r.claims.map((c) => c.text), ["Massed practice feels productive but fades within weeks."]);
});

test("a page with no quote units yields no residue: its prose is its only evidence", () => {
  // No units at all: the only prose line reads as a citation, which the index skips.
  const none = vl.lintVault([page("wiki/a.md", CONCEPT, "Source: giraffes wander the savannahs looking for acacia trees.")]);
  assert.equal(none.units, 0);
  assert.deepEqual(none.claims, []);
  // Prose-only: indexNote falls back to the prose itself, which would cover every sentence trivially.
  const prose = vl.lintVault([page("wiki/b.md", CONCEPT, "Giraffes wander the savannahs looking\nfor acacia trees during dry seasons.")]);
  assert.ok(prose.units > 0);
  assert.deepEqual(prose.claims, []);
});

test("the report names the residue in one line and stays byte-identical", () => {
  const pages = [withClaims("wiki/a.md", "Massed practice feels productive but fades within weeks. Giraffes wander savannahs looking for acacia.")];
  const a = vl.renderVaultLint(vl.lintVault(pages));
  assert.match(a, /2 sentences on 1 page have no quote behind them, not reported: the model review decides them when it runs\./, a);
  assert.equal(a, vl.renderVaultLint(vl.lintVault(pages)));
  const none = vl.renderVaultLint(vl.lintVault([page("wiki/c.md", CONCEPT, "")]));
  assert.doesNotMatch(none, /no quote behind/);
});

test("quotes under Mentions in Source count as the page's quotes for residue, the form the wiki's pages carry", () => {
  const p = page(
    "wiki/concepts/m.md",
    CONCEPT,
    `## Definition\nSpacing improves long term retention of vocabulary. Giraffes wander savannahs looking for acacia.\n\n## Mentions in Source\n\n- "${KEY_CLAIM}"`,
  );
  const r = vl.lintVault([p]);
  assert.deepEqual(r.claims.map((c) => c.text), ["Giraffes wander savannahs looking for acacia."]);
  assert.deepEqual(vl.quoteUnits(p.path, p.content).map((u) => u.text), [KEY_CLAIM]);
});

test("residue is kept only for pages the review can judge: concept and entity, or a page with no kind key", () => {
  const prose = "Massed practice feels productive but fades within weeks.";
  const body = `${prose}\n\n## Key claims\n- ${KEY_CLAIM} — [[Deck.pdf#page=1|p.1]]`;
  const pages = [
    page("wiki/sources/s.md", "type: source\ntags: [paper]", body),
    page("classes/X/X.md", "type: topic-index\nclass: X", body),
    page("classes/X/doping.md", "class: X", body),
    page("wiki/concepts/c.md", CONCEPT, body),
    page("wiki/entities/e.md", 'type: entity\ntags: [person]\naliases:\n  - "E"', body),
  ];
  const r = vl.lintVault(pages, { schema: vl.WIKI_SCHEMA });
  assert.deepEqual(
    [...new Set(r.claims.map((c) => c.path))],
    ["classes/X/doping.md", "wiki/concepts/c.md", "wiki/entities/e.md"],
    "the review never reads a source page or an index note, so their residue would be counted and never decided",
  );
});
