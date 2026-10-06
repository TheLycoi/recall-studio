// Run with: npm test  (bundles src/schemaNote.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let s;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "schemaNote.mjs");
  await build({ entryPoints: ["src/schemaNote.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  s = await import(pathToFileURL(out).href);
});

const opts = { today: "2026-09-19" };

const HEADINGS = ["Card Templates", "Card Rules", "Content Rules", "Learned"];

test("the default schema carries today's date", () => {
  const md = s.renderDefaultSchema(opts);
  assert.match(md, /^---\nversion: 1\nupdated: 2026-09-19\nlearned_count: 0\n---\n/);
  assert.match(md, /^# Recall Schema Configuration$/m);
  assert.ok(md.includes("These are your rules for the cards Recall writes."));
});

test("the rules note has no wiki sections", () => {
  const md = s.renderDefaultSchema(opts);
  for (const gone of ["Wiki Structure", "Concept Page Template", "Entity Page Template", "Naming Conventions"]) {
    assert.equal(md.includes(gone), false, gone);
  }
});

test("the default schema has every section, in order", () => {
  const md = s.renderDefaultSchema(opts);
  const found = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(found, HEADINGS);
});

test("parseSchema round-trips the default schema's frontmatter and headings", () => {
  const parsed = s.parseSchema(s.renderDefaultSchema(opts));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.updated, "2026-09-19");
  assert.equal(parsed.learnedCount, 0);
  assert.deepEqual(parsed.sections.map((x) => x.heading), HEADINGS);
});

test("parseSchema tolerates a note with no frontmatter, and drops the intro", () => {
  const parsed = s.parseSchema("# Title\n\nSome intro prose.\n\n## Card Rules\n- one fact per card\n");
  assert.equal(parsed.version, 1);
  assert.equal(parsed.updated, "");
  assert.equal(parsed.learnedCount, 0);
  assert.deepEqual(parsed.sections, [{ heading: "Card Rules", body: "- one fact per card" }]);
});

test("parseSchema never throws on garbage", () => {
  for (const junk of ["", "---\n", "---\nversion: banana\n---\n## \n#### x", "\u0000## A\nb"]) {
    assert.doesNotThrow(() => s.parseSchema(junk));
  }
  assert.equal(s.parseSchema("---\nversion: banana\n---\n").version, 1);
});

test("parseSchema is CRLF-safe", () => {
  const md = "---\r\nversion: 2\r\nupdated: 2026-01-02\r\nlearned_count: 3\r\n---\r\n\r\nintro\r\n\r\n## Card Rules\r\n- keep it short\r\n\r\n## Content Rules\r\n- quotes verbatim\r\n";
  const parsed = s.parseSchema(md);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.updated, "2026-01-02");
  assert.equal(parsed.learnedCount, 3);
  assert.deepEqual(parsed.sections, [
    { heading: "Card Rules", body: "- keep it short" },
    { heading: "Content Rules", body: "- quotes verbatim" },
  ]);
});

test("a card section's rules reach the cards block", () => {
  const { cards } = s.schemaBlocks(s.parseSchema("## Card Rules\n- one fact per card\n"));
  assert.match(cards, /^<house_rules>\n/);
  assert.ok(cards.includes("## Card Rules"));
  assert.ok(cards.includes("- one fact per card"));
  assert.match(cards, /<\/house_rules>$/);
});

test("an unknown heading reaches the cards block too — the reader wrote it", () => {
  const mine = s.schemaBlocks(s.parseSchema("## My Own Rules\n- write in German\n"));
  assert.ok(mine.cards.includes("- write in German"));
});

test("an empty body and the untouched Learned placeholder contribute nothing", () => {
  assert.deepEqual(s.schemaBlocks(s.parseSchema("## Card Rules\n")), { cards: "" });
  const learnedOnly = s.parseSchema(s.renderDefaultSchema(opts)).sections.filter((x) => x.heading === "Learned");
  assert.deepEqual(s.schemaBlocks({ version: 1, updated: "", learnedCount: 0, sections: learnedOnly }), { cards: "" });
});

test("the default schema's cards block carries the card rules and the content rules", () => {
  const { cards } = s.schemaBlocks(s.parseSchema(s.renderDefaultSchema(opts)));
  assert.ok(cards.includes("## Card Rules"));
  assert.ok(cards.includes("## Card Templates"));
  assert.ok(cards.includes("## Content Rules"));
});

test("appendLearnedRule adds the rule, bumps the count, and moves updated", () => {
  const md = s.renderDefaultSchema(opts);
  const next = s.appendLearnedRule(md, "Answers in German", { date: "2026-10-01", count: 4 });
  assert.ok(next.includes("- Answers in German _(learned 2026-10-01 from 4 edits)_"));
  assert.match(next, /^learned_count: 1$/m);
  assert.match(next, /^updated: 2026-10-01$/m);
  const learned = s.parseSchema(next).sections.find((x) => x.heading === "Learned");
  const lines = learned.body.split("\n");
  assert.match(lines[0], /^_Rules promoted from your own edits/, "the placeholder stays above the rules");
  assert.equal(lines[lines.length - 1], "- Answers in German _(learned 2026-10-01 from 4 edits)_");
  // A second rule lands under the first, and the count keeps climbing.
  const third = s.appendLearnedRule(next, "Cite the page", { date: "2026-10-02", count: 2 });
  assert.match(third, /^learned_count: 2$/m);
  const body = s.parseSchema(third).sections.find((x) => x.heading === "Learned").body.split("\n");
  assert.equal(body[body.length - 1], "- Cite the page _(learned 2026-10-02 from 2 edits)_");
});

test("appendLearnedRule leaves every other line byte-identical", () => {
  const md = s.renderDefaultSchema(opts);
  const next = s.appendLearnedRule(md, "Answers in German", { date: "2026-10-01", count: 4 });
  const before = md.split("\n");
  const after = next.split("\n");
  const drop = (lines) =>
    lines.filter((l) => !/^updated: /.test(l) && !/^learned_count: /.test(l) && !/^- Answers in German /.test(l));
  assert.deepEqual(drop(after), drop(before));
});

test("appendLearnedRule creates the section and the frontmatter when they are missing", () => {
  const next = s.appendLearnedRule("# Mine\n\n## Card Rules\n- short answers\n", "Answers in German", { date: "2026-10-01", count: 4 });
  assert.match(next, /^---\nversion: 1\nupdated: 2026-10-01\nlearned_count: 1\n---\n/);
  assert.ok(next.includes("## Card Rules\n- short answers"), "the reader's own section survives");
  const learned = s.parseSchema(next).sections.find((x) => x.heading === "Learned");
  assert.equal(learned.body, "- Answers in German _(learned 2026-10-01 from 4 edits)_");
});

test("the empty suggestions file explains itself", () => {
  const md = s.renderEmptySuggestions();
  assert.ok(!md.startsWith("---\n"), "no frontmatter");
  assert.match(md, /^# Recall Schema Suggestions$/m);
  assert.match(md, /^> .+$/m);
  assert.ok(md.includes("Recall/recall-rules.md"));
  assert.deepEqual(s.parseProposals(md), []);
});

test("the suggestions file points at the reader's own schema path", () => {
  // The schema folder is a setting, so the sentence telling the reader where to
  // accept a rule by hand has to name the file they actually have.
  const md = s.renderEmptySuggestions("study/rules/wikilm.md");
  assert.ok(md.includes("`study/rules/wikilm.md`"), "names the configured schema note");
  assert.ok(!md.includes("Recall/recall-rules.md"), "and does not also name the default one");
});

const p1 = {
  id: "sug-1",
  date: "2026-09-19",
  summary: "You shorten answers to a phrase",
  rule: "Keep every answer under six words.",
  evidence: ["edited: 'it is the ...' -> 'the hippocampus'", "edited: 'because ...' -> 'salt content'"],
  count: 2,
};
const p2 = { ...p1, id: "sug-2", date: "2026-09-20", summary: "You drop the subject cue", rule: "No cue when the question names its subject.", evidence: ["deleted a cue"], count: 1 };

test("a proposal round-trips through render and parse", () => {
  const md = s.renderEmptySuggestions() + s.renderProposal(p1);
  const [got] = s.parseProposals(md);
  assert.equal(got.id, "sug-1");
  assert.equal(got.date, "2026-09-19");
  assert.equal(got.status, "open");
  assert.equal(got.statusDate, undefined);
  assert.equal(got.summary, p1.summary);
  assert.equal(got.rule, p1.rule);
  assert.deepEqual(got.evidence, p1.evidence);
  assert.equal(got.count, 2);
});

test("setProposalStatus flips one proposal and leaves the other untouched", () => {
  const md = s.renderEmptySuggestions() + s.renderProposal(p1) + s.renderProposal(p2);
  const next = s.setProposalStatus(md, "sug-1", "applied", "2026-10-03");
  const got = s.parseProposals(next);
  assert.equal(got.length, 2);
  assert.equal(got[0].status, "applied");
  assert.equal(got[0].statusDate, "2026-10-03");
  assert.equal(got[1].status, "open");
  assert.equal(got[1].statusDate, undefined);
  // Only the one comment line differs.
  const diff = md.split("\n").filter((l, i) => next.split("\n")[i] !== l);
  assert.equal(diff.length, 1);
  assert.match(diff[0], /^<!-- id: sug-1 status: open -->$/);
  const dismissed = s.setProposalStatus(next, "sug-2", "dismissed", "2026-10-04");
  assert.deepEqual(s.parseProposals(dismissed).map((x) => x.status), ["applied", "dismissed"]);
});

test("setProposalStatus on an unknown id returns the note unchanged", () => {
  const md = s.renderEmptySuggestions() + s.renderProposal(p1);
  assert.equal(s.setProposalStatus(md, "nope", "applied", "2026-10-03"), md);
});

test("parseProposals reads CRLF and survives a malformed block", () => {
  const md = (s.renderEmptySuggestions() + s.renderProposal(p1)).replace(/\n/g, "\r\n");
  const [got] = s.parseProposals(md);
  assert.equal(got.id, "sug-1");
  assert.deepEqual(got.evidence, p1.evidence);
  assert.doesNotThrow(() => s.parseProposals("## Suggestion — \n<!-- id: -->\n**Rule:**\n"));
});
