// Run with: npm test  (bundles src/util.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let u;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "util.mjs");
  await build({ entryPoints: ["src/util.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  u = await import(pathToFileURL(out).href);
});

test("slugify matches the vault convention", () => {
  assert.equal(u.slugify("My 11-month Journey: Why the real problem isn't the AI"), "my-11-month-journey-why-the-real-problem-isn-t-the-ai");
  assert.equal(u.slugify("Église Catholique"), "eglise-catholique");
});

test("splitFrontmatter strips YAML and reports the offset", () => {
  const raw = "---\ntitle: x\n---\nBody here";
  const { body, offset } = u.splitFrontmatter(raw);
  assert.equal(body, "Body here");
  assert.equal(raw.slice(offset), body);
  assert.deepEqual(u.splitFrontmatter("no fm"), { body: "no fm", offset: 0 });
});

test("locateQuote finds exact, whitespace-variant, and markdown-wrapped spans", () => {
  const text = "The **Catholic Church**, also known as the Roman Catholic Church, is the largest\nChristian church, with 1.27 to 1.41 billion baptized Catholics worldwide.";
  const exact = u.locateQuote(text, "is the largest");
  assert.deepEqual(exact, { start: text.indexOf("is the largest"), end: text.indexOf("is the largest") + 14, exact: true });
  const loose = u.locateQuote(text, "The Catholic Church, also known as the Roman Catholic Church, is the largest Christian church");
  assert.ok(loose && !loose.exact);
  assert.ok(text.slice(loose.start, loose.end).startsWith("The **Catholic Church**"));
  assert.ok(text.slice(loose.start, loose.end).endsWith("Christian church"));
  assert.equal(u.locateQuote(text, "not in the text at all"), null);
});

test("contextWindow snaps to word boundaries", () => {
  const text = "alpha beta gamma delta epsilon zeta";
  const start = text.indexOf("gamma");
  const { before, after } = u.contextWindow(text, start, start + 5, 7);
  assert.equal(before, "alpha beta");
  assert.equal(after, "delta epsilon");
});

test("findMarkdownHighlights ignores spans across blank lines", () => {
  const text = "a ==first one== b\n\n==second\nline== c\n\n==bad\n\nspan==";
  const spans = u.findMarkdownHighlights(text).map((s) => s.text);
  assert.deepEqual(spans, ["first one", "second\nline"]);
});

test("headingAbove and lineOf", () => {
  const text = "# Top\n\ntext\n\n## Section two\n\nmore text";
  const off = text.indexOf("more text");
  assert.equal(u.headingAbove(text, off), "Section two");
  assert.equal(u.lineOf(text, off), 6);
});

test("inlineMarkdownToHtml keeps cloze markers and escapes html", () => {
  const html = u.inlineMarkdownToHtml("The **pope** is {{c1::the bishop of <Rome>}}\nline 2 `x<y`");
  assert.equal(html, "The <b>pope</b> is {{c1::the bishop of &lt;Rome&gt;}}<br>line 2 <code>x&lt;y</code>");
});

test("clozeToDisplay and countClozes", () => {
  assert.equal(u.clozeToDisplay("{{c1::24}} sui iuris and {{c2::23::number}} Eastern"), "[24] sui iuris and [23] Eastern");
  assert.equal(u.countClozes("{{c1::a}} {{c1::b}} {{c2::c}}"), 2);
});

test("buildAnkiTextImport writes directives and quotes fields", () => {
  const out = u.buildAnkiTextImport([
    { notetype: "Basic", deck: "Default", tags: ["recall", "source::x"], fields: ["Q?", 'A "quoted"\tx'] },
  ]);
  const lines = out.trim().split("\n");
  assert.deepEqual(lines.slice(0, 5), ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:3"]);
  assert.equal(lines[5], 'Basic\tDefault\trecall source::x\tQ?\t"A ""quoted""\tx"');
});

test("ankiTag replaces spaces", () => {
  assert.equal(u.ankiTag("two words"), "two_words");
});

test("basenameNoExt strips .md and .pdf", () => {
  assert.equal(u.basenameNoExt("sources/x/Paper (2).pdf"), "Paper (2)");
  assert.equal(u.basenameNoExt("wiki/a.md"), "a");
});

test("ungroundedClozes flags deletions missing from the highlight", () => {
  const hl = "The Catholic Church has 1.3 billion baptized members.";
  assert.deepEqual(u.ungroundedClozes("It has {{c1::1.3 billion}} members, founded in {{c2::AD 33}}.", hl), ["AD 33"]);
  assert.deepEqual(u.ungroundedClozes("{{c1::Catholic Church::hint}}", hl), []);
});

test("ungroundedClozes ignores unicode normalization form differences", () => {
  const word = "r\u00e9plication";           // NFC: e-acute as one glyph
  const decomposed = "re\u0301plication";    // NFD: e + combining acute
  const hlNfd = `DNA ${decomposed} is semiconservative.`;
  const hlNfc = `DNA ${word} is semiconservative.`;
  assert.deepEqual(u.ungroundedClozes(`DNA {{c1::${word}}} is semiconservative.`, hlNfd), []);
  assert.deepEqual(u.ungroundedClozes(`DNA {{c1::${decomposed}}} is semiconservative.`, hlNfc), []);
  // a genuinely invented deletion is still flagged
  assert.deepEqual(u.ungroundedClozes(`DNA {{c1::transcription}} is semiconservative.`, hlNfc), ["transcription"]);
});

test("canWrapAsHighlight refuses nested or multi-paragraph spans", () => {
  assert.equal(u.canWrapAsHighlight("plain text"), true);
  assert.equal(u.canWrapAsHighlight("==already=="), false);
  assert.equal(u.canWrapAsHighlight("has ==inner== marks"), false);
  assert.equal(u.canWrapAsHighlight("two\n\nparagraphs"), false);
});

test("canWrapAsHighlight refuses spans that cross block-level markdown", () => {
  // The reported bug: a span running from a heading into the bullet below it
  // used to be wrapped, which killed the heading and leaked == into the note.
  assert.equal(u.canWrapAsHighlight("## Precontemplation\n- **Traits:** Unaware of the problem."), false);
  assert.equal(u.canWrapAsHighlight("Some lead-in text\n## A heading"), false);
  assert.equal(u.canWrapAsHighlight("intro line\n- a bullet"), false);
  assert.equal(u.canWrapAsHighlight("intro line\n* a bullet"), false);
  assert.equal(u.canWrapAsHighlight("intro line\n+ a bullet"), false);
  assert.equal(u.canWrapAsHighlight("intro line\n1. an ordered item"), false);
  assert.equal(u.canWrapAsHighlight("intro line\n2) an ordered item"), false);
  assert.equal(u.canWrapAsHighlight("intro line\n> a quote"), false);
  assert.equal(u.canWrapAsHighlight("intro line\n| a | table |"), false);
  assert.equal(u.canWrapAsHighlight("intro line\n  - an indented bullet"), false);
});

test("canWrapAsHighlight still accepts spans that only wrap lines", () => {
  // A sentence soft-wrapped across two lines is the common case and must stay wrappable.
  assert.equal(u.canWrapAsHighlight("a sentence that runs\nonto a second line"), true);
  assert.equal(u.canWrapAsHighlight("## Just the heading itself"), true);
  assert.equal(u.canWrapAsHighlight("a hyphen - mid sentence\nand more text"), true);
  assert.equal(u.canWrapAsHighlight("5 - 3 = 2 in a line\ncontinued here"), true);
});

test("normalizeTranscript strips WebVTT scaffolding", () => {
  assert.equal(
    u.normalizeTranscript(
      "WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nHello there\n\n2\n00:00:04.000 --> 00:00:06.000\nGeneral Kenobi",
    ),
    "Hello there\nGeneral Kenobi",
  );
});

test("normalizeTranscript strips SRT scaffolding (comma timestamps, no header)", () => {
  assert.equal(
    u.normalizeTranscript(
      "1\n00:00:01,000 --> 00:00:04,000\nFirst line\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line",
    ),
    "First line\nSecond line",
  );
});

test("normalizeTranscript strips leading bracketed timestamps", () => {
  assert.equal(
    u.normalizeTranscript("[00:12] Today we cover decisional balance.\n(01:30) This will be on the exam."),
    "Today we cover decisional balance.\nThis will be on the exam.",
  );
});

test("normalizeTranscript strips <v> tags but keeps Name: speaker prefixes", () => {
  assert.equal(
    u.normalizeTranscript("<v Lecturer>Note this.</v>\nSpeaker 1: keep the speaker label"),
    "Note this.\nSpeaker 1: keep the speaker label",
  );
});

test("normalizeTranscript collapses inner whitespace and extra blank lines", () => {
  assert.equal(
    u.normalizeTranscript("Para one.\n\n\n\nPara\ttwo  has   spaces.  "),
    "Para one.\n\nPara two has spaces.",
  );
});

test("normalizeTranscript drops a single-line NOTE block", () => {
  assert.equal(u.normalizeTranscript("NOTE this is a vtt comment\n\nreal text"), "real text");
});

test("normalizeTranscript drops a multi-line NOTE block", () => {
  assert.equal(u.normalizeTranscript("NOTE\nline one of comment\nline two\n\nreal text"), "real text");
});

test("normalizeTranscript strips cue settings and <c> tags", () => {
  assert.equal(
    u.normalizeTranscript("WEBVTT\n\n00:01.000 --> 00:04.000 align:start\n<c>Styled</c> text"),
    "Styled text",
  );
});

test("truncateTranscript leaves short text untouched", () => {
  assert.deepEqual(u.truncateTranscript("short text", 100), { text: "short text", truncated: false });
});

test("truncateTranscript cuts at the last sentence boundary within the limit", () => {
  const r = u.truncateTranscript("One sentence. Two sentence! Three sentence? Four", 30);
  assert.equal(r.text, "One sentence. Two sentence!");
  assert.equal(r.truncated, true);
});

test("truncateTranscript falls back to a word boundary", () => {
  const r = u.truncateTranscript("word ".repeat(20).trim(), 23);
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 23);
  assert.ok(!/\s$/.test(r.text));
});

test("truncateTranscript hard-cuts when there is no boundary", () => {
  const r = u.truncateTranscript("x".repeat(50), 10);
  assert.equal(r.text, "x".repeat(10));
  assert.equal(r.truncated, true);
});

test("contentHash is stable, distinct for different text, and eight hex characters", () => {
  assert.equal(u.contentHash("abc"), u.contentHash("abc"));
  assert.notEqual(u.contentHash("abc"), u.contentHash("abd"));
  assert.match(u.contentHash(""), /^[0-9a-f]{8}$/);
  assert.match(u.contentHash("a much longer note body\nwith lines"), /^[0-9a-f]{8}$/);
});

test("normalizeTranscript strips a Wispr note's frontmatter, callout wrapper and trailing pointer line", () => {
  const wispr = [
    "---",
    "wispr_id: efc2088d-374f-4c48-b85c-a82e6a138710",
    "title: Childhood and Adolescent-Onset Disorders",
    "source: wispr-flow",
    "---",
    "",
    "> [!summary]- Flow Summary",
    "> Class lecture on ADHD and learning disabilities.",
    "",
    "### ADHD Presentation and Treatment",
    "- Stimulants redirect energy toward focus",
    "    - Effect on people who need them is night-and-day",
    "",
    "Childhood and Adolescent-Onset Disorders-2026-09-24_16-22-42-transcript",
  ].join("\n");
  const out = u.normalizeTranscript(wispr);
  assert.ok(!out.includes("wispr_id"), out);
  assert.ok(!out.includes("[!summary]"), out);
  assert.ok(out.startsWith("Class lecture on ADHD and learning disabilities."), out);
  assert.ok(out.includes("### ADHD Presentation and Treatment\n- Stimulants redirect energy toward focus\n- Effect on people"), out);
  assert.ok(!out.includes("-transcript"), out);
});

test("normalizeTranscript leaves a plain pasted transcript alone", () => {
  assert.equal(u.normalizeTranscript("Today we cover impulse.\n\nIt is force times time."), "Today we cover impulse.\n\nIt is force times time.");
});

test("orderTranscriptFiles puts the transcript folder first, newest first, then the rest by path", () => {
  const files = [
    { path: "notes/a.md", mtime: 5 },
    { path: "wiki/sources/wispr/old.md", mtime: 1 },
    { path: "clippings/b.txt", mtime: 9 },
    { path: "wiki/sources/wispr/new.md", mtime: 3 },
  ];
  assert.deepEqual(
    u.orderTranscriptFiles(files, "wiki/sources/wispr").map((f) => f.path),
    ["wiki/sources/wispr/new.md", "wiki/sources/wispr/old.md", "clippings/b.txt", "notes/a.md"],
  );
  // An empty folder setting keeps the plain path order.
  assert.deepEqual(u.orderTranscriptFiles(files, "").map((f) => f.path), ["clippings/b.txt", "notes/a.md", "wiki/sources/wispr/new.md", "wiki/sources/wispr/old.md"]);
});

test("isUnderFolder is a path-segment test, not a string prefix", () => {
  assert.equal(u.isUnderFolder("wiki/schema/wikilm.md", "wiki/schema"), true);
  assert.equal(u.isUnderFolder("wiki/schema/wikilm.md", "wiki/schema/"), true);
  assert.equal(u.isUnderFolder("wiki/schemas/x.md", "wiki/schema"), false);
  assert.equal(u.isUnderFolder("wiki/concepts/Kinetics.md", "wiki/schema"), false);
  assert.equal(u.isUnderFolder("anything.md", ""), false);
});

test("plainText reduces links to their words: PDF++ and wiki links to their display text, bare links to the note name, embeds dropped", () => {
  const raw = "Qualitative Analysis: [[2 - TBCM and Linear Kinematics 2026.pdf#page=10&selection=2,0,4,47&color=yellow|Non-numerical, description of variables of interest]]";
  assert.equal(u.plainText(raw), "Qualitative Analysis: Non-numerical, description of variables of interest");
  assert.equal(u.plainText("See [[Kinematics]] and [[wiki/concepts/TBCM.md#Definition]]."), "See Kinematics and TBCM.");
  assert.equal(u.plainText("A figure ![[deck.pdf#page=7&rect=1,2,3,4]] here and [a site](https://x.y) too."), "A figure here and a site too.");
  assert.equal(u.plainText("plain sentence, no links"), "plain sentence, no links");
});

test("transcriptRecord normalizes, cuts to the limit, and records where the guide came from", () => {
  const rec = u.transcriptRecord({ text: "Line one\r\nLine two", origin: "file", sourceFile: "wiki/sources/wispr/L1.md" }, 1000, "2026-09-28T00:00:00.000Z");
  assert.deepEqual(rec, { text: "Line one\nLine two", origin: "file", sourceFile: "wiki/sources/wispr/L1.md", addedAt: "2026-09-28T00:00:00.000Z", truncated: false });
  const long = u.transcriptRecord({ text: "word ".repeat(100), origin: "pasted", sourceFile: null }, 50, "t");
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= 50);
  assert.equal(long.text, u.truncateTranscript(u.normalizeTranscript("word ".repeat(100)), 50).text, "the same cut add-transcript made");
});

// Review High 3: two spans on one line used to come out as
// "==Alpha beta== gamma delta epsilon zeta. ^recall-id2eta. ^recall-id1".
test("markSpans: two spans on one line share one block id, placed once at the line's end", () => {
  const body = "Alpha beta gamma delta epsilon zeta.";
  const a = body.indexOf("Alpha beta");
  const d = body.indexOf("delta");
  const { text, blockIds } = u.markSpans(
    body,
    [
      { start: a, end: a + "Alpha beta".length },
      { start: d, end: d + "delta".length },
    ],
    "highlight+block",
  );
  assert.match(text, /^==Alpha beta== gamma ==delta== epsilon zeta\. \^recall-[a-z0-9]+$/);
  const id = text.match(/\^(recall-[a-z0-9]+)$/)[1];
  assert.equal(blockIds.get(0), id);
  assert.equal(blockIds.get(1), id);
  assert.equal(text.match(/\^recall-/g).length, 1);
});

test("markSpans: a line that already ends in a block id gets no second id", () => {
  const body = "Alpha beta gamma. ^mine\nNext line.";
  const a = body.indexOf("beta");
  const { text, blockIds } = u.markSpans(body, [{ start: a, end: a + 4 }], "highlight+block");
  assert.equal(text, "Alpha ==beta== gamma. ^mine\nNext line.");
  assert.equal(blockIds.get(0), "mine");
});

test("markSpans: spans on two lines get two ids, and highlight mode adds none", () => {
  const body = "First line here.\nSecond line here.";
  const f = body.indexOf("First");
  const s = body.indexOf("Second");
  const spans = [
    { start: s, end: s + 6 },
    { start: f, end: f + 5 },
  ];
  const { text, blockIds } = u.markSpans(body, spans, "highlight+block");
  const m = /^==First== line here\. \^(recall-[a-z0-9]+)\n==Second== line here\. \^(recall-[a-z0-9]+)$/.exec(text);
  assert.ok(m, text);
  assert.notEqual(m[1], m[2]);
  assert.equal(blockIds.get(1), m[1]);
  assert.equal(blockIds.get(0), m[2]);
  const plain = u.markSpans(body, spans, "highlight");
  assert.equal(plain.text, "==First== line here.\n==Second== line here.");
  assert.equal(plain.blockIds.size, 0);
});

// Review High 4: marking happens in the live note text, so each quote is found again there.
test("markQuotes: a quote missing from the live text leaves the text unchanged", () => {
  const live = "---\ntags: [x]\n---\nThe reader rewrote this paragraph while the model ran.";
  const { text, blockIds } = u.markQuotes(live, [{ text: "Alpha beta", start: 0, end: 10 }], "highlight+block");
  assert.equal(text, live);
  assert.equal(blockIds.size, 0);
});

test("markQuotes: a quote that moved in the live text is found and marked where it now is", () => {
  const live = "---\ntags: [x]\n---\nA new first line typed meanwhile.\nAlpha beta gamma.";
  const { text, blockIds } = u.markQuotes(live, [{ text: "Alpha beta", start: 0, end: 10 }], "highlight+block");
  assert.match(text, /^---\ntags: \[x\]\n---\nA new first line typed meanwhile\.\n==Alpha beta== gamma\. \^recall-[a-z0-9]+$/);
  assert.equal(blockIds.get(0), text.match(/\^(recall-[a-z0-9]+)$/)[1]);
});
