// Run with: npm test  (bundles src/pdflink.ts first, then exercises it with node:test)
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
  const out = path.join(dir, "pdflink.mjs");
  await build({ entryPoints: ["src/pdflink.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  pl = await import(pathToFileURL(out).href);
});

// Fixture notes copied verbatim from secondbrain (read-only source vault).
const PHARMACOLOGY_MD = `---
class: HBIO250
---
> [!PDF|255, 208, 0] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=2&annotation=846R|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.2]]
> > Pharmacology Pharmacology is the study of the action of drugs in the human body (from Greek pharmakia = drugs)

![[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=2&rect=37,186,711,385&color=yellow|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.2]]
> [!PDF] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=2&annotation=849R|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.2]]
> > [[Pharmacodynamics]] = “What drugs do in the body” 
> > [[Pharmacokinetics]] = “What the body does to drugs”

> [!PDF|yellow] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&selection=2,0,33,19&color=yellow|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]]
> > Receptors have 2 important properties: 1. They bind ligands (or drugs) with relatively high affinity, and after they bind a drug… 2. They transduce a signal to produce a biological effect (this property distinguishes receptors from inert binding sites – e.g., albumin – a blood protein that binds/carries many drugs but does not transduce a signal)

![[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&rect=13,55,713,222|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]]

> [!PDF|yellow] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=5&selection=10,0,12,8&color=yellow|p.5]]
> > The better the fit, the higher the “affinity” of a drug to a receptor

> [!PDF|yellow] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=6&selection=6,0,34,23&color=yellow|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.6]]
> > Types of “Receptors” 
> > • Enzymes (competitive – binds at ”active site”; noncompetitive – binds at allosteric site [not active site]) 
> > • Ion Channels (ligand-gated) 
> > • Membrane Receptors 
> > • Intracellular Receptors

![[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=9&rect=42,48,675,410|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.9]]
![[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=6&rect=12,31,719,290|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.6]]


- Competitive is 
`;

const DOPING_MD = `---
class: HBIO250
---
## WADA

> [!PDF|255, 208, 0] [[HBIO 250 History of Doping and Oversight Fall 2026.pdf#page=23&annotation=1110R|HBIO 250 History of Doping and Oversight Fall 2026, p.23]]
> > “The purpose of the Code is to ensure the fight against drugs in sport is intensified, accelerated, harmonized and unified.” Dick Pound, WADA President – March 2003
> 
> 

![[HBIO 250 History of Doping and Oversight Fall 2026.pdf#page=23&rect=20,34,714,344|HBIO 250 History of Doping and Oversight Fall 2026, p.23]]
![[HBIO 250 History of Doping and Oversight Fall 2026.pdf#page=24&rect=10,19,717,488&color=yellow|HBIO 250 History of Doping and Oversight Fall 2026, p.24]]

[[Therapeutic Use Exemption (TUE)]]

`;

const PHARMACOLOGY_PDF = "HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf";

test("parsePdfSubpath: acceptance table", () => {
  assert.deepEqual(pl.parsePdfSubpath("page=4&selection=2,0,33,19&color=yellow"), {
    page: 4,
    selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 },
    color: "yellow",
  });
  assert.deepEqual(pl.parsePdfSubpath("#page=2&annotation=846R"), { page: 2, annotation: "846R" });
  assert.deepEqual(pl.parsePdfSubpath("page=20&rect=37,49,697,348"), { page: 20, rect: [37, 49, 697, 348] });
  assert.deepEqual(pl.parsePdfSubpath("page=2&color=255, 208, 0"), { page: 2, color: "255,208,0" });
  assert.equal(pl.parsePdfSubpath("selection=1,2,3,4"), null);
  assert.equal(pl.parsePdfSubpath("page=x"), null);
});

test("parsePdfSubpath ignores offset= and tolerates a leading #", () => {
  const t = pl.parsePdfSubpath("#page=4&selection=2,0,33,19&offset=99&color=yellow");
  assert.equal(t.page, 4);
  assert.deepEqual(t.selection, { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 });
  assert.equal(t.color, "yellow");
});

test("renderPdfSubpath is canonical (round trip through parse)", () => {
  const cases = [
    "page=4&selection=2,0,33,19&color=yellow",
    "page=2&annotation=846R",
    "page=20&rect=37,49,697,348",
    "page=2&color=255,208,0",
  ];
  for (const c of cases) {
    const t = pl.parsePdfSubpath(c);
    assert.equal(pl.renderPdfSubpath(t), c);
  }
});

test("highlightKey drops color, keeps the rest canonical", () => {
  const t = pl.parsePdfSubpath("page=4&selection=2,0,33,19&color=yellow");
  assert.equal(pl.highlightKey(t), "page=4&selection=2,0,33,19");
});

test("renderPdfLink", () => {
  // renderPdfLink(pdfBasename, t, display) -> [[<basename>.pdf#<subpath>|<display>]];
  // pdfBasename is the basename without extension, per the manifest/topic-note
  // conventions used throughout the plan (e.g. pdf_link: "[[<basename>.pdf]]").
  const t = pl.parsePdfSubpath("page=4&selection=2,0,33,19&color=yellow");
  assert.equal(pl.renderPdfLink("A", t, "p.4"), "[[A.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]");
});

test("renderCallout: selection callout shape", () => {
  const t = pl.parsePdfSubpath("page=4&selection=2,0,33,19&color=yellow");
  assert.equal(
    pl.renderCallout("A", t, "p.4", "T"),
    "> [!PDF|yellow] [[A.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]\n> > T",
  );
});

test("renderCallout: rect target with empty text renders as an embed", () => {
  const t = pl.parsePdfSubpath("page=4&rect=13,55,713,222");
  assert.equal(pl.renderCallout("A", t, "p.4", ""), "![[A.pdf#page=4&rect=13,55,713,222|p.4]]");
});

test("calloutHeader", () => {
  assert.equal(pl.calloutHeader("yellow"), "[!PDF|yellow]");
  assert.equal(pl.calloutHeader("255,208,0"), "[!PDF|255, 208, 0]");
  assert.equal(pl.calloutHeader(null), "[!PDF]");
});

test("findPdfReferences: Pharmacology.md yields 9 references in file order", () => {
  const refs = pl.findPdfReferences(PHARMACOLOGY_MD, PHARMACOLOGY_PDF);
  assert.equal(refs.length, 9);

  const [r1, r2, r3, r4, r5, r6, r7, r8, r9] = refs;

  assert.equal(r1.target.annotation, "846R");
  assert.equal(r1.embed, false);
  assert.ok(r1.quote && r1.quote.startsWith("Pharmacology Pharmacology is the study"));
  assert.equal(r1.calloutColor, "255,208,0");
  // The link itself is #page=2&annotation=846R with no &color=; the callout
  // color comes only from the [!PDF|...] header, never the annotation link.
  assert.equal(r1.target.color, undefined);

  assert.ok(r2.target.rect);
  assert.equal(r2.embed, true);
  assert.equal(r2.quote, null);

  assert.equal(r3.target.annotation, "849R");
  assert.equal(r3.embed, false);
  assert.equal(
    r3.quote,
    "[[Pharmacodynamics]] = “What drugs do in the body” [[Pharmacokinetics]] = “What the body does to drugs”",
  );
  assert.equal(r3.calloutColor, null);

  assert.equal(r4.target.selection.beginIndex, 2);
  assert.equal(r4.target.color, "yellow");
  assert.equal(r4.embed, false);
  assert.ok(r4.quote && r4.quote.startsWith("Receptors have 2 important properties"));

  assert.ok(r5.target.rect);
  assert.equal(r5.embed, true);
  assert.equal(r5.target.page, 4);

  assert.equal(r6.target.page, 5);
  assert.equal(r6.embed, false);
  assert.ok(r6.target.selection);

  assert.equal(r7.target.page, 6);
  assert.equal(r7.embed, false);
  assert.ok(r7.quote.includes("Enzymes"));
  assert.ok(r7.quote.includes("Intracellular Receptors"));
  assert.ok(r7.quote.startsWith("Types of"));

  assert.ok(r8.target.rect);
  assert.equal(r8.target.page, 9);
  assert.equal(r8.embed, true);

  assert.ok(r9.target.rect);
  assert.equal(r9.target.page, 6);
  assert.equal(r9.embed, true);
});

test("findPdfReferences: Doping.md yields 3", () => {
  const refs = pl.findPdfReferences(DOPING_MD, "HBIO 250 History of Doping and Oversight Fall 2026.pdf");
  assert.equal(refs.length, 3);
  assert.equal(refs[0].target.annotation, "1110R");
  assert.equal(refs[1].embed, true);
  assert.equal(refs[1].target.page, 23);
  assert.equal(refs[2].embed, true);
  assert.equal(refs[2].target.page, 24);
});

test("findAllPdfReferences carries the pdf basename per reference", () => {
  const refs = pl.findAllPdfReferences(PHARMACOLOGY_MD);
  assert.equal(refs.length, 9);
  for (const r of refs) {
    assert.equal(r.pdfBasename, PHARMACOLOGY_PDF.replace(/\.pdf$/i, ""));
  }
});

test("renderPdfLink accepts the name with or without .pdf", () => {
  const t = pl.parsePdfSubpath("page=4&selection=2,0,33,19&color=yellow");
  assert.equal(pl.renderPdfLink("A.pdf", t, "p.4"), "[[A.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]");
  assert.equal(pl.renderPdfLink("A", t, "p.4"), "[[A.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]");
  assert.equal(pl.renderPdfEmbed("A.PDF", { page: 2, rect: [1, 2, 3, 4] }, "p.2"), "![[A.pdf#page=2&rect=1,2,3,4|p.2]]");
});

// --------------------------------------------- percent-encoded subpath values

test("parsePdfSubpath decodes a percent-encoded selection", () => {
  // Obsidian and PDF++ both encode the commas in some links. Read raw, the
  // four numbers fail the digit test, the selection is dropped, and the target
  // degrades to page-only — where it collides in dedupe with every other
  // page-only highlight on that page, losing distinct reader highlights.
  assert.deepEqual(pl.parsePdfSubpath("#page=3&selection=1%2C2%2C3%2C4"), {
    page: 3,
    selection: { beginIndex: 1, beginOffset: 2, endIndex: 3, endOffset: 4 },
  });
});

test("parsePdfSubpath decodes a percent-encoded rect and color", () => {
  assert.deepEqual(pl.parsePdfSubpath("#page=3&rect=1%2C2%2C3%2C4"), { page: 3, rect: [1, 2, 3, 4] });
  assert.equal(pl.parsePdfSubpath("#page=3&color=255%2C208%2C0").color, "255,208,0");
});

test("an encoded and a plain selection are the same highlight", () => {
  const a = pl.parsePdfSubpath("#page=3&selection=1%2C2%2C3%2C4");
  const b = pl.parsePdfSubpath("#page=3&selection=1,2,3,4");
  assert.equal(pl.highlightKey(a), pl.highlightKey(b));
  // And neither collides with the page-only target it used to degrade into.
  assert.notEqual(pl.highlightKey(a), pl.highlightKey(pl.parsePdfSubpath("#page=3")));
});

test("parsePdfSubpath decodes an encoded annotation id", () => {
  assert.equal(pl.parsePdfSubpath("#page=3&annotation=a%20b").annotation, "a b");
});

test("a malformed selection or rect refuses the link rather than degrading it", () => {
  // Degrading to page-only is the dangerous answer: the truncated target is a
  // valid-looking one that merges with unrelated highlights on the same page.
  // Refusing it leaves the reader's link alone instead.
  assert.equal(pl.parsePdfSubpath("#page=3&selection=oops"), null);
  assert.equal(pl.parsePdfSubpath("#page=3&selection=1,2,3"), null);
  assert.equal(pl.parsePdfSubpath("#page=3&rect=a,b,c,d"), null);
});

test("an invalid percent escape falls back to the raw value, never throws", () => {
  // decodeURIComponent throws on "%zz"; a malformed link must not take the
  // whole scan down with it.
  assert.equal(pl.parsePdfSubpath("#page=3&color=%zz").color, "%zz");
  assert.deepEqual(pl.parsePdfSubpath("#page=%zz"), null);
});

test("an ordinary unencoded subpath is unchanged by decoding", () => {
  assert.deepEqual(pl.parsePdfSubpath("#page=4&selection=2,0,33,19&color=yellow"), {
    page: 4,
    selection: { beginIndex: 2, beginOffset: 0, endIndex: 33, endOffset: 19 },
    color: "yellow",
  });
});

// ---- 2.0: the reader's notes under a bare link

const CLASS_NOTE = `---
class: PSYC360
---
## Attachment Disorders, Conduct Disorder, and Oppositional Defiant Disorder
[[Chapter 5 -1.pdf#page=23&selection=0,0,2,33&color=note|Chapter 5 -1, p.23]]

- **Oppositional Defiant Disorder**
	- A pattern of angry/irritable mood lasting 6 months
		- "About control"
	- Defiance but no aggression
- Conduct Disorder (CD) [[Chapter 5 -1.pdf#page=30&selection=0,0,0,30&color=yellow|Chapter 5 -1, p.30]]
	- CD is associated with smaller gray matter volume
	- Harsh parental discipline and aggression (environmental)
## Autism Spectrum Disorder (ASD)
[[Chapter 5 -1.pdf#page=31&selection=0,0,0,30&color=yellow|Chapter 5 -1, p.31]]
`;

test("a bare link under a heading carries the heading and the lines beneath it as notes", () => {
  const refs = pl.findPdfReferences(CLASS_NOTE, "Chapter 5 -1.pdf");
  assert.equal(refs.length, 3);
  const [first] = refs;
  assert.equal(first.quote, null, "a bare link has no callout quote");
  assert.equal(first.heading, "Attachment Disorders, Conduct Disorder, and Oppositional Defiant Disorder");
  assert.equal(
    first.notes,
    [
      "- **Oppositional Defiant Disorder**",
      "\t- A pattern of angry/irritable mood lasting 6 months",
      '\t\t- "About control"',
      "\t- Defiance but no aggression",
    ].join("\n"),
    "notes stop at the next line holding a PDF++ link",
  );
});

test("a link inline in a bullet keeps the bullet's own words and the nested lines under it", () => {
  const refs = pl.findPdfReferences(CLASS_NOTE, "Chapter 5 -1.pdf");
  const cd = refs[1];
  assert.equal(cd.target.page, 30);
  assert.equal(cd.heading, "Attachment Disorders, Conduct Disorder, and Oppositional Defiant Disorder");
  assert.equal(
    cd.notes,
    ["- Conduct Disorder (CD)", "\t- CD is associated with smaller gray matter volume", "\t- Harsh parental discipline and aggression (environmental)"].join("\n"),
    "the link is removed from its own line; the notes stop at the next heading",
  );
});

test("a link with nothing under it has null notes and the heading above it", () => {
  const refs = pl.findPdfReferences(CLASS_NOTE, "Chapter 5 -1.pdf");
  const asd = refs[2];
  assert.equal(asd.heading, "Autism Spectrum Disorder (ASD)");
  assert.equal(asd.notes, null);
});

test("a link on a heading line takes that heading as its own, and the lines under it as notes", () => {
  const md = [
    "## [[Lab 4.pdf#page=1&selection=38,0,38,10|Linear Impulse]]",
    "[[Lab 4.pdf#page=1&selection=40,0,41,12|The effect of a force on a system]]: the net force acting over time",
    "",
    "- Propulsive > braking => increase in velocity",
    "## Linear Momentum",
  ].join("\n");
  const refs = pl.findPdfReferences(md, "Lab 4.pdf");
  assert.equal(refs.length, 2);
  assert.equal(refs[0].heading, "Linear Impulse");
  assert.equal(refs[0].notes, null, "the next line holds a PDF++ link, so nothing is left for the heading link");
  assert.equal(refs[1].heading, "Linear Impulse");
  assert.equal(refs[1].notes, ": the net force acting over time\n- Propulsive > braking => increase in velocity");
});

test("a callout reference keeps its quote and carries no notes", () => {
  const md = "> [!PDF|yellow] [[Deck.pdf#page=4&selection=2,0,3,1|Deck, p.4]]\n> > Receptors bind ligands\n\n- a bullet after the callout";
  const [ref] = pl.findPdfReferences(md, "Deck.pdf");
  assert.equal(ref.quote, "Receptors bind ligands");
  assert.equal(ref.notes, null);
  assert.equal(ref.heading, null);
});
