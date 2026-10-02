// Run with: npm test. Bundles src/fixPlan.ts, which is pure — no `obsidian`
// import — so esbuild can hand it to plain node, the same way
// test/vaultFix.test.mjs does.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let fp;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-plan-"));
  const out = path.join(dir, "fixPlan.mjs");
  await build({ entryPoints: ["src/fixPlan.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  fp = await import(pathToFileURL(out).href);
});

// ---------------------------------------------------------------- fixtures

const KARPATHY_PAGE = `---
type: concept
tags: [term]
---

# Spaced repetition

## Summary
Review at widening intervals.

## Related Concepts
- [[concepts/retrieval-practice|Retrieval practice]]

## Flashcard Seeds
`;

const CLASS_PAGE = `---
type: concept
class: BIO101
tags: [term]
---

# Doping

## Summary
Sport pharmacology.

## Related topics
- [[Drug Receptors]]

## Flashcard Seeds
`;

const NO_SECTION_PAGE = `---
type: concept
---

# Lone page

## Summary
Nothing links here.

## Highlights

- something

## Flashcard Seeds
`;

const HUB = `---
type: topic-index
class: KIN110
---

# KIN110

## Module 1 (CH 1)
- [[Health Coach]]
- [[Wellness]]

## Sources
- [[KIN110 Chapter 1.pdf]]
`;

const RECT_NOTE = `---
type: concept
---

# Rect only

## Highlights

![[BIO 101.pdf#page=20&rect=37,49,697,348|BIO 101, p.20]]
`;

const QUOTE_NOTE = `---
type: concept
---

# Quoting page

## Mentions in Source

- "The prompt is the unit of work."
- "Already cited here." — [[sources/other]]
`;

// ------------------------------------------------------------ addRelatedLink

test("addRelatedLink appends under the class schema's Related topics", () => {
  const out = fp.addRelatedLink(CLASS_PAGE, "concepts/doping-control", "Doping control", "class", "concept");
  assert.match(out, /## Related topics\n- \[\[Drug Receptors\]\]\n- \[\[concepts\/doping-control\|Doping control\]\]/);
  // Idempotent: applying twice equals once.
  assert.equal(fp.addRelatedLink(out, "concepts/doping-control", "Doping control", "class", "concept"), out);
});

test("addRelatedLink picks the karpathy section by the target's kind", () => {
  const concept = fp.addRelatedLink(KARPATHY_PAGE, "concepts/interleaving", "Interleaving", "karpathy", "concept");
  assert.match(concept, /## Related Concepts\n- \[\[concepts\/retrieval-practice\|Retrieval practice\]\]\n- \[\[concepts\/interleaving\|Interleaving\]\]/);

  const entity = fp.addRelatedLink(KARPATHY_PAGE, "entities/andy-matuschak", "Andy Matuschak", "karpathy", "entity");
  assert.match(entity, /## Related Entities\n- \[\[entities\/andy-matuschak\|Andy Matuschak\]\]/);
  // The new section lands before the trailing headings, not at EOF.
  assert.ok(entity.indexOf("## Related Entities") < entity.indexOf("## Flashcard Seeds"));
});

test("addRelatedLink skips a link already there under another spelling", () => {
  // The section says `[[concepts/retrieval-practice|…]]`; the fix asks for
  // `[[Retrieval practice]]`, the same page by linkKey.
  assert.equal(fp.addRelatedLink(KARPATHY_PAGE, "Retrieval practice", "Retrieval practice", "karpathy", "concept"), KARPATHY_PAGE);
  // A display alias and a heading anchor do not hide the target either.
  const anchored = KARPATHY_PAGE.replace("- [[concepts/retrieval-practice|Retrieval practice]]", "- [[concepts/retrieval-practice#Summary|the testing effect]]");
  assert.equal(fp.addRelatedLink(anchored, "concepts/retrieval-practice", "Retrieval practice", "karpathy", "concept"), anchored);
});

test("addRelatedLink fills an empty section and a prose-only one without breaking either", () => {
  // Empty: the line goes straight under the heading, not glued to it.
  const empty = "# X\n\n## Related topics\n\n## Flashcard Seeds\n";
  const filled = fp.addRelatedLink(empty, "concepts/y", "Y", "class", "concept");
  assert.match(filled, /## Related topics\n- \[\[concepts\/y\|Y\]\]\n/);
  assert.equal(fp.addRelatedLink(filled, "concepts/y", "Y", "class", "concept"), filled);

  // Prose with no list: the link becomes its own block, the prose survives.
  const prose = "# X\n\n## Related topics\nSee also nothing yet.\n\n## Flashcard Seeds\n";
  const added = fp.addRelatedLink(prose, "concepts/y", "Y", "class", "concept");
  assert.match(added, /See also nothing yet\.\n\n- \[\[concepts\/y\|Y\]\]/);
  assert.equal(fp.addRelatedLink(added, "concepts/y", "Y", "class", "concept"), added);
});

test("addRelatedLink creates a karpathy page's missing section before the trailing headings", () => {
  // A karpathy page's Related Concepts/Entities do precede Mentions in Source
  // and Highlights, so `insertBeforeTrailing` is still the right placement.
  const out = fp.addRelatedLink(NO_SECTION_PAGE, "concepts/x", "X", "karpathy", "concept");
  assert.match(out, /## Related Concepts\n- \[\[concepts\/x\|X\]\]/);
  assert.ok(out.indexOf("## Related Concepts") < out.indexOf("## Highlights"));
  assert.equal(fp.addRelatedLink(out, "concepts/x", "X", "karpathy", "concept"), out);
});

test("addRelatedLink puts a class page's new Related topics after its Highlights", () => {
  // `renderTopicNote` writes Summary, Highlights, Related topics, Flashcard
  // Seeds; a created section takes that place, never the one ahead of
  // Highlights that `insertBeforeTrailing` would pick.
  const out = fp.addRelatedLink(NO_SECTION_PAGE, "concepts/x", "X", "class", "concept");
  assert.match(out, /## Related topics\n- \[\[concepts\/x\|X\]\]/);
  assert.ok(out.indexOf("## Highlights") < out.indexOf("## Related topics"));
  assert.ok(out.indexOf("## Related topics") < out.indexOf("## Flashcard Seeds"));
  assert.equal(fp.addRelatedLink(out, "concepts/x", "X", "class", "concept"), out);
});

test("addRelatedLink appends a class page's new Related topics at EOF with no Flashcard Seeds", () => {
  const page = "# Doping\n\n## Summary\nSport pharmacology.\n\n## Highlights\n\n- something\n";
  const out = fp.addRelatedLink(page, "concepts/x", "X", "class", "concept");
  assert.ok(out.indexOf("## Highlights") < out.indexOf("## Related topics"));
  assert.match(out, /- something\n\n## Related topics\n- \[\[concepts\/x\|X\]\]\n$/);
  assert.equal(fp.addRelatedLink(out, "concepts/x", "X", "class", "concept"), out);
});

// -------------------------------------------------------------- hubListLink

test("hubListLink appends after the last list line before ## Sources", () => {
  const out = fp.hubListLink(HUB, "Doping", "Doping");
  assert.match(out, /- \[\[Wellness\]\]\n- \[\[Doping\|Doping\]\]\n/);
  assert.ok(out.indexOf("- [[Doping|Doping]]") < out.indexOf("## Sources"));
  // The Sources list is untouched.
  assert.match(out, /## Sources\n- \[\[KIN110 Chapter 1\.pdf\]\]/);
  assert.equal(fp.hubListLink(out, "Doping", "Doping"), out);
});

test("hubListLink skips a page the hub already lists", () => {
  assert.equal(fp.hubListLink(HUB, "Health Coach", "Health Coach"), HUB);
  assert.equal(fp.hubListLink(HUB, "wiki/concepts/health-coach", "Health Coach"), HUB);
});

test("hubListLink inserts a list when the hub has none", () => {
  const bare = "# KIN110\n\n## Sources\n- [[a.pdf]]\n";
  const out = fp.hubListLink(bare, "Doping", "Doping");
  assert.match(out, /- \[\[Doping\|Doping\]\]/);
  assert.ok(out.indexOf("- [[Doping|Doping]]") < out.indexOf("## Sources"));
  assert.equal(fp.hubListLink(out, "Doping", "Doping"), out);
});

// ------------------------------------------------------------ rectToCallout

test("rectToCallout replaces the embed line with the PDF++ callout", () => {
  const key = "page=20&rect=37,49,697,348";
  const out = fp.rectToCallout(RECT_NOTE, key, "BIO 101", "Doping is the use of banned substances.");
  assert.match(out, /> \[!PDF\] \[\[BIO 101\.pdf#page=20&rect=37,49,697,348\|BIO 101, p\.20\]\]\n> > Doping is the use of banned substances\./);
  assert.doesNotMatch(out, /!\[\[BIO 101\.pdf#page=20/);
  assert.equal(fp.rectToCallout(out, key, "BIO 101", "Doping is the use of banned substances."), out);
});

test("rectToCallout leaves the note alone with no text or no matching key", () => {
  assert.equal(fp.rectToCallout(RECT_NOTE, "page=20&rect=37,49,697,348", "BIO 101", ""), RECT_NOTE);
  assert.equal(fp.rectToCallout(RECT_NOTE, "page=99&rect=1,2,3,4", "BIO 101", "text"), RECT_NOTE);
});

test("rectToCallout keeps the prose that shares the embed's line", () => {
  const note = "# X\n\nSee this: ![[X.pdf#page=2&rect=1,2,3,4|X, p.2]] which shows it.\n";
  const out = fp.rectToCallout(note, "page=2&rect=1,2,3,4", "X", "The banned list.");
  assert.equal(
    out,
    "# X\n\nSee this:\n> [!PDF] [[X.pdf#page=2&rect=1,2,3,4|X, p.2]]\n> > The banned list.\nwhich shows it.\n",
  );
  assert.equal(fp.rectToCallout(out, "page=2&rect=1,2,3,4", "X", "The banned list."), out);
});

test("rectToCallout changes only the matching embed when a line holds two", () => {
  const note = "# X\n\n![[X.pdf#page=2&rect=1,2,3,4|a]] ![[X.pdf#page=3&rect=5,6,7,8|b]]\n";
  const out = fp.rectToCallout(note, "page=3&rect=5,6,7,8", "X", "Second only.");
  assert.match(out, /!\[\[X\.pdf#page=2&rect=1,2,3,4\|a\]\]/);
  assert.doesNotMatch(out, /!\[\[X\.pdf#page=3/);
  assert.match(out, /> \[!PDF\] \[\[X\.pdf#page=3&rect=5,6,7,8\|b\]\]\n> > Second only\./);
  assert.equal(fp.rectToCallout(out, "page=3&rect=5,6,7,8", "X", "Second only."), out);
});

// ----------------------------------------------------------- attributeQuote

test("attributeQuote appends the citation to the matching bullet only", () => {
  const out = fp.attributeQuote(QUOTE_NOTE, "The prompt is the unit of work.", "sources/prompts");
  assert.match(out, /- "The prompt is the unit of work\." — \[\[sources\/prompts\]\]/);
  assert.match(out, /- "Already cited here\." — \[\[sources\/other\]\]\n/);
  assert.equal(fp.attributeQuote(out, "The prompt is the unit of work.", "sources/prompts"), out);
});

test("attributeQuote matches through smart quotes and spacing", () => {
  const smart = QUOTE_NOTE.replace('"The prompt is the unit of work."', "“The  prompt is the unit of work.”");
  const out = fp.attributeQuote(smart, "The prompt is the unit of work.", "sources/prompts");
  assert.match(out, /— \[\[sources\/prompts\]\]/);
});

test("attributeQuote leaves a note with no such quote unchanged", () => {
  assert.equal(fp.attributeQuote(QUOTE_NOTE, "Never said.", "sources/prompts"), QUOTE_NOTE);
});

test("attributeQuote cites the Mentions bullet, not the same words under Highlights", () => {
  // The lint raises `unattributed-quote` only from `## Mentions in Source`, so
  // citing a repeat of the bullet elsewhere leaves the finding standing and the
  // next Apply cites again.
  const both = `---
type: concept
---

# Repeated

## Highlights

- "The prompt is the unit of work."

## Mentions in Source

- "The prompt is the unit of work."
`;
  const out = fp.attributeQuote(both, "The prompt is the unit of work.", "sources/prompts");
  assert.match(out, /## Highlights\n\n- "The prompt is the unit of work\."\n/);
  assert.match(out, /## Mentions in Source\n\n- "The prompt is the unit of work\." — \[\[sources\/prompts\]\]\n/);
  // Applying twice equals once.
  assert.equal(fp.attributeQuote(out, "The prompt is the unit of work.", "sources/prompts"), out);
});

test("attributeQuote leaves a note with no Mentions in Source section alone", () => {
  const noMentions = '# Page\n\n## Highlights\n\n- "The prompt is the unit of work."\n';
  assert.equal(fp.attributeQuote(noMentions, "The prompt is the unit of work.", "sources/prompts"), noMentions);
});

// ---------------------------------------------------------------- frontmatter

test("setAliases writes the quoted block form, existing names first", () => {
  const inline = "---\ntype: concept\naliases: [Receptors]\n---\n\n# Drug Receptors\n";
  const out = fp.setAliases(inline, ["Drug Receptors", "receptors"]);
  assert.match(out, /aliases:\n  - "Receptors"\n  - "Drug Receptors"\n/);
  // Case-insensitive union: "receptors" is already there as "Receptors".
  assert.equal((out.match(/- "Receptors"/g) ?? []).length, 1);
  assert.equal(fp.setAliases(out, ["Drug Receptors", "receptors"]), out);
});

test("setAliases inserts after tags: and creates frontmatter when absent", () => {
  const withTags = "---\ntype: concept\ntags: [term]\n---\n\n# X\n";
  const out = fp.setAliases(withTags, ["Ex"]);
  assert.match(out, /tags: \[term\]\naliases:\n  - "Ex"\n---/);

  const bare = "# X\n\nbody\n";
  const made = fp.setAliases(bare, ["Ex"]);
  assert.match(made, /^---\naliases:\n  - "Ex"\n---\n\n# X/);
  assert.equal(fp.setAliases(made, ["Ex"]), made);
});

test("setAliases with no new names returns the note unchanged", () => {
  const md = "---\ntype: concept\n---\n\n# X\n";
  assert.equal(fp.setAliases(md, []), md);
});

test("setTag replaces inline and block tags and inserts after type:", () => {
  assert.match(fp.setTag("---\ntype: concept\ntags: [other]\n---\n", "term"), /tags: \[term\]/);
  assert.match(fp.setTag("---\ntype: concept\ntags:\n  - other\n  - junk\n---\n", "term"), /tags: \[term\]\n---/);
  const inserted = fp.setTag("---\ntype: concept\nclass: BIO101\n---\n", "term");
  assert.match(inserted, /type: concept\ntags: \[term\]\nclass: BIO101/);
  assert.equal(fp.setTag(inserted, "term"), inserted);
});

// ---------------------------------------------------------------- repoint

test("repoint rewrites a dead target at the page the reader picked", () => {
  const md = "# A\n\nSee [[Spaced repetition]] and [[Spaced repetition|the spacing effect]].\n";
  const page = { path: "wiki/concepts/spaced-repetition.md", title: "spaced-repetition", displayTitle: "Spaced repetition", aliases: [] };
  const out = fp.repoint(md, "Spaced repetition", page, "wiki/");
  assert.match(out, /\[\[concepts\/spaced-repetition\|Spaced repetition\]\]/);
  // A reader's own display text survives the repoint.
  assert.match(out, /\[\[concepts\/spaced-repetition\|the spacing effect\]\]/);
  assert.equal(fp.repoint(out, "Spaced repetition", page, "wiki/"), out);
});

// ---------------------------------------------------------------- planners

const PAGES = () =>
  new Map([
    [
      "wiki/concepts/coaching-communication.md",
      { path: "wiki/concepts/coaching-communication.md", title: "coaching-communication", displayTitle: "Coaching Communication", schema: "class", kind: "concept", classCodes: ["KIN110"], content: CLASS_PAGE },
    ],
    [
      "wiki/concepts/empowering-behavior-change.md",
      { path: "wiki/concepts/empowering-behavior-change.md", title: "empowering-behavior-change", displayTitle: "Empowering Behavior Change", schema: "class", kind: "concept", classCodes: ["KIN110"], content: CLASS_PAGE },
    ],
  ]);

test("planCrossLinks proposes both directions of a duplicate pair", () => {
  const issues = [
    {
      id: "duplicate-pages",
      path: "wiki/concepts/coaching-communication.md",
      title: "Coaching Communication",
      target: "wiki/concepts/empowering-behavior-change.md",
    },
  ];
  const fixes = fp.planCrossLinks(issues, PAGES(), "wiki/");
  assert.equal(fixes.length, 2);
  assert.deepEqual(fixes.map((f) => f.kind), ["cross-link", "cross-link"]);
  assert.deepEqual(fixes.map((f) => f.path), [
    "wiki/concepts/coaching-communication.md",
    "wiki/concepts/empowering-behavior-change.md",
  ]);
  assert.equal(fixes[0].label, "Link Coaching Communication ↔ Empowering Behavior Change");
  assert.ok(fixes.every((f) => f.enabled));
  // The edit is the related-link edit, applied to the note's own text.
  const applied = fixes[0].apply(CLASS_PAGE);
  assert.match(applied, /- \[\[concepts\/empowering-behavior-change\|Empowering Behavior Change\]\]/);
});

test("planCrossLinks under a topic folder prefix writes links relative to that folder", () => {
  const pages = new Map([
    [
      "classes/BIO101/receptors.md",
      { path: "classes/BIO101/receptors.md", title: "receptors", displayTitle: "Receptors", schema: "class", kind: "concept", classCodes: ["BIO101"], content: CLASS_PAGE },
    ],
    [
      "classes/BIO101/agonists.md",
      { path: "classes/BIO101/agonists.md", title: "agonists", displayTitle: "Agonists", schema: "class", kind: "concept", classCodes: ["BIO101"], content: CLASS_PAGE },
    ],
  ]);
  const issues = [
    {
      id: "duplicate-pages",
      path: "classes/BIO101/receptors.md",
      title: "Receptors",
      target: "classes/BIO101/agonists.md",
    },
  ];
  const fixes = fp.planCrossLinks(issues, pages, "classes/");
  assert.equal(fixes.length, 2);
  const applied = fixes[0].apply(CLASS_PAGE);
  // Relative to the prefix, `.md` stripped, `|display` — the same shape
  // `buildReplacement` gives a repoint under this prefix.
  assert.match(applied, /- \[\[BIO101\/agonists\|Agonists\]\]/);
});

test("planRelinks wraps the fixable rows the link fixer already found", () => {
  const fixable = [
    {
      path: "wiki/concepts/a.md",
      from: "Spaced repetition",
      toPath: "wiki/concepts/spaced-repetition.md",
      to: "[[concepts/spaced-repetition|Spaced repetition]]",
      confidence: "slug",
    },
  ];
  const fixes = fp.planRelinks(fixable);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].kind, "relink");
  assert.equal(fixes[0].enabled, true);
  assert.equal(fixes[0].label, "Rewrite → concepts/spaced-repetition (same name, different spelling)");
  assert.equal(
    fixes[0].apply("See [[Spaced repetition]].\n"),
    "See [[concepts/spaced-repetition|Spaced repetition]].\n",
  );
});

test("planRepoints asks for a target and applies nothing until one is chosen", () => {
  const unresolved = [{ id: "dead-link", path: "wiki/concepts/a.md", title: "A", target: "Vasodilation" }];
  const rows = fp.planRepoints(unresolved);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "repoint");
  assert.equal(rows[0].needsTarget, true);
  assert.equal(rows[0].enabled, false);
  const md = "See [[Vasodilation]].\n";
  assert.equal(rows[0].apply(md), md);

  const page = { path: "wiki/concepts/vasodilation.md", title: "vasodilation", displayTitle: "Vasodilation", aliases: [] };
  const concrete = fp.repointFix(rows[0], page, "wiki/");
  assert.equal(concrete.enabled, true);
  assert.equal(concrete.needsTarget, false);
  assert.equal(concrete.path, "wiki/concepts/a.md");
  assert.equal(concrete.id, rows[0].id);
  assert.match(concrete.apply(md), /\[\[concepts\/vasodilation\|Vasodilation\]\]/);
});

test("a repoint carries its dead target, so parentheses in a link survive", () => {
  // The label is prose; reading the target back out of it would break here.
  const rows = fp.planRepoints([{ id: "dead-link", path: "wiki/a.md", title: "A", target: "Vasodilation (drugs)" }]);
  assert.equal(rows[0].target, "Vasodilation (drugs)");
  const page = { path: "wiki/concepts/vasodilation.md", title: "vasodilation", displayTitle: "Vasodilation", aliases: [] };
  const concrete = fp.repointFix(rows[0], page, "wiki/");
  assert.equal(
    concrete.apply("See [[Vasodilation (drugs)]].\n"),
    "See [[concepts/vasodilation|Vasodilation]].\n",
  );
});

test("attributeQuote leaves a PDF++ callout mention alone", () => {
  // A callout carries its own anchor; it is not an unattributed bullet.
  const callout = '## Mentions in Source\n\n> [!PDF] [[x.pdf#page=1|x]]\n> > The prompt is the unit of work.\n';
  assert.equal(fp.attributeQuote(callout, "The prompt is the unit of work.", "sources/prompts"), callout);
});

test("planHubLinks lists an unlinked page in its class's hub", () => {
  const pages = new Map([
    [
      "wiki/concepts/doping.md",
      { path: "wiki/concepts/doping.md", title: "doping", displayTitle: "Doping", schema: "class", kind: "concept", classCodes: ["BIO101"], content: CLASS_PAGE },
    ],
  ]);
  const hubs = new Map([
    ["BIO101", { path: "classes/BIO101/BIO101.md", title: "BIO101", schema: "class", kind: "concept", classCodes: ["BIO101"], content: HUB }],
  ]);
  const issues = [{ id: "unlinked", path: "wiki/concepts/doping.md", title: "Doping" }];
  const fixes = fp.planHubLinks(issues, pages, hubs, "wiki/");
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].kind, "hub-link");
  assert.equal(fixes[0].path, "classes/BIO101/BIO101.md");
  assert.equal(fixes[0].label, "List Doping in BIO101 hub");
  assert.match(fixes[0].apply(HUB), /- \[\[concepts\/doping\|Doping\]\]/);

  // The hub is never listed in itself.
  const hubIssue = [{ id: "orphan", path: "classes/BIO101/BIO101.md", title: "BIO101" }];
  assert.deepEqual(fp.planHubLinks(hubIssue, hubs, hubs, "wiki/"), []);
  // A page whose class has no hub gets no row here.
  assert.deepEqual(fp.planHubLinks(issues, pages, new Map(), "wiki/"), []);
});

test("planRelatedFrom links an orphan from its nearest neighbour", () => {
  const pages = new Map([
    [
      "wiki/concepts/doping.md",
      { path: "wiki/concepts/doping.md", title: "doping", displayTitle: "Doping", schema: "class", kind: "concept", classCodes: ["BIO101"], content: CLASS_PAGE },
    ],
  ]);
  const neighbour = {
    path: "wiki/concepts/pharmacology.md",
    title: "pharmacology",
    displayTitle: "Pharmacology",
    schema: "class",
    kind: "concept",
    classCodes: ["BIO101"],
    content: CLASS_PAGE,
  };
  const issues = [{ id: "orphan", path: "wiki/concepts/doping.md", title: "Doping" }];
  const fixes = fp.planRelatedFrom(issues, pages, () => neighbour, "wiki/");
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].kind, "related-link");
  // The edit is applied to the neighbour, not the orphan.
  assert.equal(fixes[0].path, "wiki/concepts/pharmacology.md");
  assert.equal(fixes[0].label, "Relate Doping from Pharmacology");
  assert.match(fixes[0].apply(CLASS_PAGE), /- \[\[concepts\/doping\|Doping\]\]/);

  assert.deepEqual(fp.planRelatedFrom(issues, pages, () => null, "wiki/"), []);
});

test("planRectCallouts proposes one row per rect-only note with text", () => {
  const pages = new Map([
    [
      "wiki/concepts/rect.md",
      { path: "wiki/concepts/rect.md", title: "rect", displayTitle: "Rect only", schema: "class", kind: "concept", classCodes: ["BIO101"], content: RECT_NOTE },
    ],
  ]);
  const issues = [{ id: "no-evidence", path: "wiki/concepts/rect.md", title: "Rect only" }];
  const rectText = () => [{ key: "page=20&rect=37,49,697,348", pdfBasename: "BIO 101", text: "Doping is banned." }];
  const fixes = fp.planRectCallouts(issues, rectText);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].kind, "rect-callout");
  assert.equal(fixes[0].label, "Quote 1 rectangle from BIO 101");
  assert.match(fixes[0].apply(RECT_NOTE), /> > Doping is banned\./);

  // A rect with no text layer is no row at all: honesty over coverage.
  assert.deepEqual(fp.planRectCallouts(issues, () => [{ key: "page=20&rect=37,49,697,348", pdfBasename: "BIO 101", text: "" }]), []);
  assert.deepEqual(fp.planRectCallouts(issues, () => []), []);
});

test("planAttributions cites a quote found in exactly one source", () => {
  const issues = [
    { id: "unattributed-quote", path: "wiki/concepts/q.md", title: "Quoting page", detail: "The prompt is the unit of work." },
  ];
  const one = new Map([
    ["sources/prompts.md", "He wrote: “The prompt  is the unit of work.”"],
    ["sources/other.md", "Nothing relevant."],
  ]);
  const fixes = fp.planAttributions(issues, one);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].kind, "attribute");
  assert.equal(fixes[0].path, "wiki/concepts/q.md");
  assert.equal(fixes[0].label, "Cite prompts.md");
  assert.match(fixes[0].apply(QUOTE_NOTE), /- "The prompt is the unit of work\." — \[\[sources\/prompts\]\]/);

  // Two sources say it, so which one the page meant is unknown: no row.
  const two = new Map([
    ["sources/prompts.md", "The prompt is the unit of work."],
    ["sources/other.md", "The prompt is the unit of work."],
  ]);
  assert.deepEqual(fp.planAttributions(issues, two), []);
  assert.deepEqual(fp.planAttributions(issues, new Map()), []);
});

test("planAttributions ignores a quote too short to identify a source", () => {
  // "the cell" is nine characters: a substring hit says nothing about which
  // document the page was reading.
  const sources = new Map([["sources/bio.md", "Inside the cell, the mitochondrion works."]]);
  const short = [{ id: "unattributed-quote", path: "wiki/concepts/q.md", title: "Q", detail: "the cell" }];
  assert.deepEqual(fp.planAttributions(short, sources), []);

  // A sentence is long enough to mean something.
  const long = [
    { id: "unattributed-quote", path: "wiki/concepts/q.md", title: "Q", detail: "Inside the cell, the mitochondrion works." },
  ];
  assert.equal(fp.planAttributions(long, sources).length, 1);
});

test("planAliases proposes aliases and a tag, dropping one outside the vocabulary", () => {
  const vocab = { concept: ["term", "process", "other"], entity: ["person", "drug", "other"] };
  const fixes = fp.planAliases(
    [{ path: "wiki/concepts/receptors.md", aliases: ["Drug Receptors"], tag: "term", kind: "concept" }],
    vocab,
  );
  assert.deepEqual(fixes.map((f) => f.kind), ["aliases", "tag"]);
  assert.equal(fixes[0].label, 'Add aliases: "Drug Receptors"');
  assert.equal(fixes[1].label, "Tag: term");
  assert.match(fixes[0].apply("---\ntype: concept\n---\n"), /aliases:\n  - "Drug Receptors"/);
  assert.match(fixes[1].apply("---\ntype: concept\n---\n"), /tags: \[term\]/);

  const bad = fp.planAliases([{ path: "wiki/a.md", aliases: [], tag: "nonsense", kind: "concept" }], vocab);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].kind, "tag");
  assert.match(bad[0].label, /other/);
  assert.match(bad[0].apply("---\ntype: concept\n---\n"), /tags: \[other\]/);

  // No aliases and no tag is no row.
  assert.deepEqual(fp.planAliases([{ path: "wiki/a.md", aliases: [], tag: "", kind: "concept" }], vocab), []);
});

// ------------------------------------------------------------ order & apply

test("orderFixes puts the plan in upstream's causal order, stable by path", () => {
  const mk = (kind, path) => ({ id: `${kind}:${path}:0`, kind, path, label: kind, enabled: true, apply: (s) => s });
  const shuffled = [
    mk("attribute", "b.md"),
    mk("relink", "z.md"),
    mk("aliases", "a.md"),
    mk("rect-callout", "c.md"),
    mk("relink", "a.md"),
    mk("hub-link", "h.md"),
    mk("cross-link", "x.md"),
    mk("tag", "a.md"),
    mk("repoint", "r.md"),
    mk("related-link", "n.md"),
  ];
  const ordered = fp.orderFixes(shuffled);
  assert.deepEqual(ordered.map((f) => f.kind), [
    "aliases",
    "tag",
    "cross-link",
    "relink",
    "relink",
    "repoint",
    "hub-link",
    "related-link",
    "rect-callout",
    "attribute",
  ]);
  // Inside a kind, by path.
  assert.deepEqual(ordered.filter((f) => f.kind === "relink").map((f) => f.path), ["a.md", "z.md"]);
});

test("applyFixesToNote folds only the ticked fixes, once, and groupByNote splits them", () => {
  const fixes = [
    { id: "a:x:0", kind: "aliases", path: "x.md", label: "a", enabled: true, apply: (s) => `${s}A` },
    { id: "b:x:1", kind: "tag", path: "x.md", label: "b", enabled: false, apply: (s) => `${s}B` },
    { id: "c:x:2", kind: "relink", path: "x.md", label: "c", enabled: true, apply: (s) => `${s}C` },
    { id: "d:y:0", kind: "relink", path: "y.md", label: "d", enabled: true, apply: (s) => `${s}D` },
  ];
  assert.equal(fp.applyFixesToNote("_", fixes.filter((f) => f.path === "x.md")), "_AC");
  const grouped = fp.groupByNote(fixes);
  assert.deepEqual([...grouped.keys()], ["x.md", "y.md"]);
  assert.equal(grouped.get("x.md").length, 3);
});

test("every fix id is unique within a plan", () => {
  const issues = [
    { id: "duplicate-pages", path: "wiki/concepts/coaching-communication.md", title: "Coaching Communication", target: "wiki/concepts/empowering-behavior-change.md" },
  ];
  const fixes = fp.orderFixes([
    ...fp.planCrossLinks(issues, PAGES(), "wiki/"),
    ...fp.planRepoints([
      { id: "dead-link", path: "wiki/a.md", title: "A", target: "X" },
      { id: "dead-link", path: "wiki/a.md", title: "A", target: "Y" },
    ]),
  ]);
  const ids = fixes.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ------------------------------------------------------- unwrapping rows
// The second repair for a dead link whose page nobody wrote: strip it back to
// plain text. The row sits beside the repoint row for the same finding, so the
// reader chooses between naming a page and withdrawing the link.

test("planUnwraps offers one row per dead link in a wiki page", () => {
  const rows = fp.planUnwraps(
    [{ id: "dead-link", path: "wiki/concepts/a.md", title: "A", target: "Iterative refinement" }],
    new Map([["wiki/concepts/a.md", "See [[Iterative refinement]]."]]),
    "wiki/",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "unwrap");
  assert.equal(rows[0].target, "Iterative refinement");
  assert.equal(rows[0].apply("See [[Iterative refinement]]."), "See Iterative refinement.");
});

test("planUnwraps skips the wiki's own generated and documentation notes", () => {
  // log.md is a generated report, and schema/config.md holds deliberate
  // placeholders like [[entities/page-name]]. Stripping those would corrupt
  // the examples the schema is documented with.
  const issues = [
    { id: "dead-link", path: "wiki/log.md", title: "log", target: "entities/andy-matuschak.md" },
    { id: "dead-link", path: "wiki/schema/config.md", title: "config", target: "entities/page-name" },
    { id: "dead-link", path: "wiki/concepts/a.md", title: "A", target: "Iterative refinement" },
  ];
  const contents = new Map([
    ["wiki/log.md", "[[entities/andy-matuschak.md]]"],
    ["wiki/schema/config.md", "[[entities/page-name]]"],
    ["wiki/concepts/a.md", "[[Iterative refinement]]"],
  ]);
  const rows = fp.planUnwraps(issues, contents, "wiki/");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, "wiki/concepts/a.md");
});

test("planUnwraps offers nothing when the edit would change no bytes", () => {
  // The finding names a target the note's text does not actually hold.
  const rows = fp.planUnwraps(
    [{ id: "dead-link", path: "wiki/concepts/a.md", title: "A", target: "Iterative refinement" }],
    new Map([["wiki/concepts/a.md", "nothing to unwrap here"]]),
    "wiki/",
  );
  assert.equal(rows.length, 0);
});

test("an unwrap row is deterministic and idempotent", () => {
  const issues = [{ id: "dead-link", path: "wiki/concepts/a.md", title: "A", target: "Iterative refinement" }];
  const contents = new Map([["wiki/concepts/a.md", "See [[Iterative refinement]]."]]);
  const a = fp.planUnwraps(issues, contents, "wiki/");
  const b = fp.planUnwraps(issues, contents, "wiki/");
  assert.deepEqual(a.map((r) => r.id), b.map((r) => r.id));
  const once = a[0].apply("See [[Iterative refinement]].");
  assert.equal(a[0].apply(once), once);
});

test("unwrap rows sort after repoints: naming a page beats withdrawing the link", () => {
  const issue = { id: "dead-link", path: "wiki/concepts/a.md", title: "A", target: "Iterative refinement" };
  const contents = new Map([["wiki/concepts/a.md", "[[Iterative refinement]]"]]);
  const ordered = fp.orderFixes([...fp.planUnwraps([issue], contents, "wiki/"), ...fp.planRepoints([issue])]);
  assert.deepEqual(ordered.map((f) => f.kind), ["repoint", "unwrap"]);
});

test("planUnwraps honours a configured wiki folder, not a hardcoded one", () => {
  // wikiConceptsFolder/wikiEntitiesFolder are settings. A reader who moved the
  // wiki to `knowledge/` must still keep their generated log and schema docs.
  const issues = [
    { id: "dead-link", path: "knowledge/log.md", title: "log", target: "Missing" },
    { id: "dead-link", path: "knowledge/schema/config.md", title: "config", target: "Missing" },
    { id: "dead-link", path: "knowledge/concepts/a.md", title: "A", target: "Missing" },
  ];
  const contents = new Map(issues.map((i) => [i.path, "[[Missing]]"]));
  const rows = fp.planUnwraps(issues, contents, "knowledge/");
  assert.deepEqual(rows.map((r) => r.path), ["knowledge/concepts/a.md"]);
});

test("planUnwraps does not mistake a note merely containing 'wiki/' for the wiki root", () => {
  // A path-substring match would strip the prefix off `notes/wiki/…` and, worse,
  // treat a reader's own `notes/wiki/schema/x.md` as documentation.
  const issues = [{ id: "dead-link", path: "notes/wikipedia/log.md", title: "log", target: "Missing" }];
  const contents = new Map([["notes/wikipedia/log.md", "[[Missing]]"]]);
  // With the wiki at `wiki/`, this note is not in it, so it is the reader's.
  assert.equal(fp.planUnwraps(issues, contents, "wiki/").length, 1);
});

// ------------------------------- a repoint and an unwrap for the same link

test("an unwrap never destroys the link a repoint just wrote", () => {
  // Both rows are offered for one dead link, and the reader picked the repoint.
  // A page at the top of the wiki folder repoints "Missing" to "Missing", which
  // the unwrap's target comparison still matches, so unwrap ran second and
  // deleted the reader's explicit choice while the UI reported success.
  const body = "See [[Missing]] here.\n";
  const issues = [{ id: "dead-link", path: "wiki/a.md", title: "A", target: "Missing" }];
  const contents = new Map([["wiki/a.md", body]]);
  const page = { path: "wiki/Missing.md", title: "Missing", aliases: [] };
  const concrete = fp.repointFix(fp.planRepoints(issues)[0], page, "wiki/");
  const rows = [concrete, ...fp.planUnwraps(issues, contents, "wiki/")];
  const out = fp.applyFixesToNote(body, fp.groupByNote(rows).get("wiki/a.md"));
  assert.match(out, /\[\[Missing\|Missing\]\]/, `the reader's repoint was unwrapped away: ${out}`);
});

test("a repoint to a different page still lets the unwrap no-op harmlessly", () => {
  // The general repoint-before-unwrap order is sound: once the link points
  // somewhere new, the unwrap's target no longer matches and it changes nothing.
  const body = "See [[Missing]] here.\n";
  const issues = [{ id: "dead-link", path: "wiki/a.md", title: "A", target: "Missing" }];
  const contents = new Map([["wiki/a.md", body]]);
  const page = { path: "wiki/concepts/real.md", title: "real", displayTitle: "Real", aliases: [] };
  const concrete = fp.repointFix(fp.planRepoints(issues)[0], page, "wiki/");
  const rows = [concrete, ...fp.planUnwraps(issues, contents, "wiki/")];
  const list = fp.groupByNote(rows).get("wiki/a.md");
  const out = fp.applyFixesToNote(body, list);
  assert.equal(out, "See [[concepts/real|Real]] here.\n");
  // And applying the same list again is a no-op, as every plan must be.
  assert.equal(fp.applyFixesToNote(out, list), out);
});

test("an unwrap for a link no repoint claimed is still applied", () => {
  // Dropping the collision must not disarm unwraps generally: a second dead
  // link on the same note, which no repoint touched, still gets stripped.
  const body = "See [[Missing]] and [[Other]].\n";
  const issues = [
    { id: "dead-link", path: "wiki/a.md", title: "A", target: "Missing" },
    { id: "dead-link", path: "wiki/a.md", title: "A", target: "Other" },
  ];
  const contents = new Map([["wiki/a.md", body]]);
  const page = { path: "wiki/Missing.md", title: "Missing", aliases: [] };
  const repoints = fp.planRepoints(issues);
  const chosen = fp.repointFix(repoints.find((r) => r.target === "Missing"), page, "wiki/");
  const rows = [chosen, ...fp.planUnwraps(issues, contents, "wiki/")];
  const out = fp.applyFixesToNote(body, fp.groupByNote(rows).get("wiki/a.md"));
  assert.equal(out, "See [[Missing|Missing]] and Other.\n");
});

test("an unticked repoint leaves its unwrap free to run", () => {
  // The reader never picked a page, so the repoint applies nothing and the
  // unwrap is the only answer on offer. It must not be suppressed by a row
  // that does nothing.
  const body = "See [[Missing]] here.\n";
  const issues = [{ id: "dead-link", path: "wiki/a.md", title: "A", target: "Missing" }];
  const contents = new Map([["wiki/a.md", body]]);
  const rows = [...fp.planRepoints(issues), ...fp.planUnwraps(issues, contents, "wiki/")];
  const out = fp.applyFixesToNote(body, fp.groupByNote(rows).get("wiki/a.md"));
  assert.equal(out, "See Missing here.\n");
});

test("a cross-link row names its pair, and applyDuplicateVerdicts drops only the rows of pairs the model cleared", () => {
  const issues = [
    { id: "duplicate-pages", path: "wiki/concepts/coaching-communication.md", title: "Coaching Communication", target: "wiki/concepts/empowering-behavior-change.md" },
  ];
  const fixes = fp.planCrossLinks(issues, PAGES(), "wiki/");
  const key = fp.pairKey("wiki/concepts/empowering-behavior-change.md", "wiki/concepts/coaching-communication.md");
  assert.equal(key, "wiki/concepts/coaching-communication.md\x00wiki/concepts/empowering-behavior-change.md", "the lesser path first, however the pair was given");
  assert.ok(fixes.every((f) => f.pair === key), "both directions carry the same pair key");
  const other = { id: "aliases:x:0", kind: "aliases", path: "x.md", label: "x", enabled: true, apply: (c) => c };
  const kept = fp.applyDuplicateVerdicts([...fixes, other], [key]);
  assert.deepEqual(kept, [other], "a cleared pair loses both rows; unrelated rows stay");
  assert.equal(fp.applyDuplicateVerdicts([...fixes, other], ["a\x00b"]).length, 3, "an unknown key clears nothing");
});

// ------------------------------------------------ lint model review wiring

test("cross-link ids come from the pair and the direction, so a verdict's rows merge instead of colliding", () => {
  const pages = new Map([
    ...PAGES(),
    [
      "wiki/concepts/linear-kinematics.md",
      { path: "wiki/concepts/linear-kinematics.md", title: "linear-kinematics", displayTitle: "Linear Kinematics", schema: "class", kind: "concept", classCodes: [], content: CLASS_PAGE },
    ],
  ]);
  // The lint's own finding, planned on one call...
  const first = fp.planCrossLinks(
    [{ id: "duplicate-pages", path: "wiki/concepts/coaching-communication.md", title: "C", target: "wiki/concepts/empowering-behavior-change.md" }],
    pages,
    "wiki/",
  );
  // ...and a pair the model confirmed later, planned on another. Both start
  // from the same page, which a per-call counter numbered `:0` both times.
  const second = fp.planCrossLinks(
    [{ id: "duplicate-pages", path: "wiki/concepts/coaching-communication.md", title: "C", target: "wiki/concepts/linear-kinematics.md" }],
    pages,
    "wiki/",
  );
  const known = new Set(first.map((f) => f.id));
  const added = second.filter((r) => !known.has(r.id));
  assert.equal(added.length, 2, "both directions of the confirmed pair survive the modal's dedupe by id");
  const merged = [...first, ...added];
  assert.equal(new Set(merged.map((f) => f.id)).size, 4);
  // The same pair planned twice gives the same ids: a re-check adds nothing.
  assert.deepEqual(fp.planCrossLinks(
    [{ id: "duplicate-pages", path: "wiki/concepts/empowering-behavior-change.md", title: "E", target: "wiki/concepts/coaching-communication.md" }],
    pages,
    "wiki/",
  ).map((f) => f.id).sort(), first.map((f) => f.id).sort());
});

test("planRelatedFrom leaves a page to its hub when its class has one", () => {
  const doping = { path: "wiki/concepts/doping.md", title: "doping", displayTitle: "Doping", schema: "class", kind: "concept", classCodes: ["BIO101"], content: CLASS_PAGE };
  const lone = { path: "wiki/concepts/lone.md", title: "lone", displayTitle: "Lone", schema: "class", kind: "concept", classCodes: ["KIN999"], content: CLASS_PAGE };
  const pages = new Map([[doping.path, doping], [lone.path, lone]]);
  const hub = { path: "classes/BIO101/BIO101.md", title: "BIO101", schema: "class", kind: "concept", classCodes: ["BIO101"], content: HUB };
  const hubs = new Map([["BIO101", hub]]);
  const neighbour = { path: "wiki/concepts/pharmacology.md", title: "pharmacology", displayTitle: "Pharmacology", schema: "class", kind: "concept", classCodes: ["BIO101"], content: CLASS_PAGE };
  const issues = [
    { id: "orphan", path: doping.path, title: "Doping" },
    { id: "unlinked", path: lone.path, title: "Lone" },
  ];
  const hubRows = fp.planHubLinks(issues, pages, hubs, "wiki/");
  const related = fp.planRelatedFrom(issues, pages, () => neighbour, "wiki/", hubs);
  assert.deepEqual(hubRows.map((f) => f.label), ["List Doping in BIO101 hub"]);
  assert.deepEqual(related.map((f) => f.label), ["Relate Lone from Pharmacology"], "the page with a hub gets the hub row only");
  // Without hubs passed, every orphan still gets a neighbour row, as before.
  assert.equal(fp.planRelatedFrom(issues, pages, () => neighbour, "wiki/").length, 2);
});

const REVIEW_PAGES = () =>
  new Map([
    ["wiki/concepts/a.md", { path: "wiki/concepts/a.md", title: "a", displayTitle: "Alpha", schema: "karpathy", kind: "concept", classCodes: [], content: KARPATHY_PAGE }],
    ["wiki/entities/b.md", { path: "wiki/entities/b.md", title: "b", displayTitle: "Beta", schema: "karpathy", kind: "entity", classCodes: [], content: KARPATHY_PAGE }],
    ["classes/X/c.md", { path: "classes/X/c.md", title: "c", displayTitle: "Gamma", schema: "class", kind: "concept", classCodes: ["X"], content: CLASS_PAGE }],
  ]);

test("planReviewLinks edits the reviewed page, linking to what it discusses", () => {
  const links = [{ path: "wiki/concepts/a.md", targetPath: "wiki/entities/b.md", targetTitle: "Beta", reason: "names Beta" }];
  const rows = fp.planReviewLinks(links, [], REVIEW_PAGES(), "wiki/");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "add-link");
  assert.equal(rows[0].path, "wiki/concepts/a.md");
  assert.equal(rows[0].label, "Link Alpha → Beta");
  assert.equal(rows[0].enabled, true);
  const once = rows[0].apply(KARPATHY_PAGE);
  // The target is an entity, so the karpathy page's Related Entities section.
  assert.match(once, /## Related Entities\n- \[\[entities\/b\|Beta\]\]/);
  assert.equal(rows[0].apply(once), once, "applying twice changes nothing more");
});

test("planReviewLinks turns a nomination round when the reviewed page is cut off", () => {
  const links = [{ path: "wiki/concepts/a.md", targetPath: "wiki/entities/b.md", targetTitle: "Beta", reason: "names Beta" }];
  for (const id of ["orphan", "unlinked"]) {
    const rows = fp.planReviewLinks(links, [{ id, path: "wiki/concepts/a.md", title: "a" }], REVIEW_PAGES(), "wiki/");
    assert.equal(rows.length, 1);
    // An outgoing link would not fix an orphan: the nominated page links back.
    assert.equal(rows[0].path, "wiki/entities/b.md", id);
    assert.equal(rows[0].label, "Link Beta → Alpha");
    assert.match(rows[0].apply(KARPATHY_PAGE), /## Related Concepts\n- \[\[concepts\/retrieval-practice\|Retrieval practice\]\]\n- \[\[concepts\/a\|Alpha\]\]/);
  }
  // A finding on the target, not the reviewed page, does not turn the row.
  const other = fp.planReviewLinks(links, [{ id: "orphan", path: "wiki/entities/b.md", title: "b" }], REVIEW_PAGES(), "wiki/");
  assert.equal(other[0].path, "wiki/concepts/a.md");
});

test("planReviewLinks gives each link one row with a stable id, and skips pages it does not know", () => {
  const link = { path: "wiki/concepts/a.md", targetPath: "wiki/entities/b.md", targetTitle: "Beta", reason: "r" };
  const rows = fp.planReviewLinks([link, { ...link }, { ...link, targetPath: "wiki/missing.md" }], [], REVIEW_PAGES(), "wiki/");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, fp.planReviewLinks([link], [], REVIEW_PAGES(), "wiki/")[0].id);
});

test("hub and neighbour rows name the page they make reachable", () => {
  const doping = { path: "wiki/concepts/doping.md", title: "doping", displayTitle: "Doping", schema: "class", kind: "concept", classCodes: ["BIO101"], content: CLASS_PAGE };
  const lone = { path: "wiki/concepts/lone.md", title: "lone", displayTitle: "Lone", schema: "class", kind: "concept", classCodes: ["KIN999"], content: CLASS_PAGE };
  const pages = new Map([[doping.path, doping], [lone.path, lone]]);
  const hubs = new Map([["BIO101", { path: "classes/BIO101/BIO101.md", title: "BIO101", schema: "class", kind: "concept", classCodes: ["BIO101"], content: HUB }]]);
  const neighbour = { path: "wiki/concepts/pharmacology.md", title: "pharmacology", displayTitle: "Pharmacology", schema: "class", kind: "concept", classCodes: [], content: CLASS_PAGE };
  const issues = [{ id: "orphan", path: doping.path, title: "Doping" }, { id: "unlinked", path: lone.path, title: "Lone" }];
  assert.deepEqual(fp.planHubLinks(issues, pages, hubs, "wiki/").map((f) => f.about), [doping.path]);
  assert.deepEqual(fp.planRelatedFrom(issues, pages, () => neighbour, "wiki/", hubs).map((f) => f.about), [lone.path]);
});

test("planReviewLinks leaves a turned-round row unticked when the plan already links the page another way", () => {
  const links = [{ path: "wiki/concepts/a.md", targetPath: "wiki/entities/b.md", targetTitle: "Beta", reason: "names Beta" }];
  const issues = [{ id: "orphan", path: "wiki/concepts/a.md", title: "a" }];
  const row = (kind, about) => ({ id: `${kind}:x`, kind, path: "wiki/x.md", label: kind, enabled: true, about, apply: (c) => c });
  for (const kind of ["hub-link", "related-link"]) {
    const rows = fp.planReviewLinks(links, issues, REVIEW_PAGES(), "wiki/", [row(kind, "wiki/concepts/a.md")]);
    assert.equal(rows[0].path, "wiki/entities/b.md");
    assert.equal(rows[0].enabled, false, `${kind}: one link in is enough to fix an orphan; the second is the reader's call`);
  }
  // A row for some other page, or no row at all, leaves it ticked.
  assert.equal(fp.planReviewLinks(links, issues, REVIEW_PAGES(), "wiki/", [row("hub-link", "wiki/entities/b.md")])[0].enabled, true);
  assert.equal(fp.planReviewLinks(links, issues, REVIEW_PAGES(), "wiki/")[0].enabled, true);
  // A row that is not turned round is the page's own missing link: always ticked.
  assert.equal(fp.planReviewLinks(links, [], REVIEW_PAGES(), "wiki/", [row("hub-link", "wiki/concepts/a.md")])[0].enabled, true);
});

test("mergeReview drops cleared pairs from rows and findings, adds the review's rows once each, and orders the plan", () => {
  const pages = new Map([
    ["wiki/concepts/a.md", { path: "wiki/concepts/a.md", title: "a", schema: "karpathy", kind: "concept", classCodes: [], content: KARPATHY_PAGE }],
    ["wiki/concepts/c.md", { path: "wiki/concepts/c.md", title: "c", schema: "karpathy", kind: "concept", classCodes: [], content: KARPATHY_PAGE }],
  ]);
  const dup = { id: "duplicate-pages", path: "wiki/concepts/a.md", title: "a", target: "wiki/concepts/c.md", detail: "same name" };
  const orphan = { id: "orphan", path: "wiki/concepts/a.md", title: "a" };
  const cross = fp.planCrossLinks([dup], pages, "wiki/");
  const mk = (kind, path, id = `${kind}:${path}`) => ({ id, kind, path, label: kind, enabled: true, apply: (x) => x });
  const plan = [mk("related-link", "wiki/concepts/z.md"), ...cross];
  const report = { notes: 2, units: 0, issues: [orphan, dup], candidates: [{ a: "x", b: "y", pass: "similar", detail: "" }], claims: [] };
  const missing = { id: "missing-link", path: "wiki/concepts/a.md", title: "a", target: "Beta", detail: "names Beta" };
  const review = {
    issues: [missing],
    candidates: [],
    rows: [mk("add-link", "wiki/concepts/a.md"), mk("related-link", "wiki/concepts/z.md"), mk("kind", "wiki/concepts/a.md")],
    cleared: [fp.pairKey(dup.path, dup.target)],
  };
  const got = fp.mergeReview(plan, report, review);
  assert.deepEqual(got.plan.map((f) => f.id), ["kind:wiki/concepts/a.md", "related-link:wiki/concepts/z.md", "add-link:wiki/concepts/a.md"]);
  assert.deepEqual(got.report.issues.map((i) => i.id), ["orphan", "missing-link"], "worst first, and a cleared reported pair is no longer a finding");
  assert.deepEqual(got.report.candidates, [], "the review's candidates replace the scan's");
  assert.equal(got.report.notes, 2);
  // Nothing cleared: the reported pair and its rows stay.
  const kept = fp.mergeReview(plan, report, { ...review, cleared: [] });
  assert.equal(kept.plan.filter((f) => f.kind === "cross-link").length, 2);
  assert.ok(kept.report.issues.some((i) => i.id === "duplicate-pages"));
});

test("setKind rewrites type: and leaves a page without one alone", () => {
  const md = "---\ntype: concept\ntags: [term]\n---\n\n# A\n";
  const once = fp.setKind(md, "entity");
  assert.equal(once, "---\ntype: entity\ntags: [term]\n---\n\n# A\n");
  assert.equal(fp.setKind(once, "entity"), once, "applying twice changes nothing more");
  assert.equal(fp.setKind(md, "concept"), md, "already that kind: byte-identical");
  const classPage = "---\nclass: BIO101\n---\n\n# A\n";
  assert.equal(fp.setKind(classPage, "entity"), classPage);
  assert.equal(fp.setKind("# No frontmatter\n", "entity"), "# No frontmatter\n");
  assert.equal(fp.setKind('---\ntype: "concept"\n---\n', "entity"), "---\ntype: entity\n---\n");
  assert.equal(fp.setKind('---\ntype: "concept"\n---\n', "concept"), '---\ntype: "concept"\n---\n', "a quoted kind already right is left as written");
});

test("planKinds offers an unticked row only for pages that carry type:", () => {
  const pages = REVIEW_PAGES();
  pages.set("classes/X/d.md", { path: "classes/X/d.md", title: "d", displayTitle: "Delta", schema: "class", kind: "concept", classCodes: ["X"], content: "---\nclass: X\n---\n\n# Delta\n" });
  const rows = fp.planKinds(
    [
      { path: "wiki/concepts/a.md", kind: "entity", reason: "a person" },
      { path: "classes/X/d.md", kind: "entity", reason: "a person" },
      { path: "wiki/missing.md", kind: "entity", reason: "x" },
    ],
    pages,
  );
  assert.equal(rows.length, 1, "a class-schema page's kind verdict stays a finding only");
  assert.equal(rows[0].kind, "kind");
  assert.equal(rows[0].path, "wiki/concepts/a.md");
  assert.equal(rows[0].enabled, false);
  assert.match(rows[0].label, /concept → entity/);
  const once = rows[0].apply(KARPATHY_PAGE);
  assert.match(once, /^---\ntype: entity\n/);
  assert.equal(rows[0].apply(once), once);
});

test("orderFixes puts add-link after related-link and kind after tag", () => {
  const mk = (kind, path) => ({ id: `${kind}:${path}`, kind, path, label: kind, enabled: true, apply: (s) => s });
  const ordered = fp.orderFixes([mk("add-link", "a.md"), mk("kind", "a.md"), mk("related-link", "a.md"), mk("tag", "a.md"), mk("cross-link", "a.md"), mk("rect-callout", "a.md")]);
  assert.deepEqual(ordered.map((f) => f.kind), ["tag", "kind", "cross-link", "related-link", "add-link", "rect-callout"]);
});
