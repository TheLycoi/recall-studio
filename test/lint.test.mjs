// Run with: npm test  (bundles src/lint.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let l;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "lint.mjs");
  await build({ entryPoints: ["src/lint.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  l = await import(pathToFileURL(out).href);
});

// PHED163-style fixture, as specified in the brief.
const highlight = {
  id: "h1",
  sourcePath: "note.md",
  sourceTitle: "Stages of Change",
  text: "Contemplation: the client intends to change within the next six months and weighs pros and cons.",
  before: "",
  after: "",
  line: 0,
  page: null,
  heading: null,
  blockId: null,
  title: "",
  instruction: "",
  status: "ready",
  error: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  generatedAt: null,
  exportedAt: null,
  cards: [],
  origin: "selection",
};

function clozeCard(text, over = {}) {
  return {
    id: "c1",
    highlightId: "h1",
    kind: "cloze",
    front: "",
    back: "",
    text,
    extra: "",
    status: "pending",
    edited: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function qaCard(front, back, over = {}) {
  return {
    id: "c1",
    highlightId: "h1",
    kind: "qa",
    front,
    back,
    text: "",
    extra: "",
    status: "pending",
    edited: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// ---- cloze-not-grounded

test("cloze-not-grounded: fails when a deletion body is not in the highlight", () => {
  const card = clozeCard(
    "Contemplation: the client intends to change within the next {{c1::three weeks}} and weighs pros and cons.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("cloze-not-grounded"), "expected cloze-not-grounded");
});

test("cloze-not-grounded: passes when the deletion body is in the highlight", () => {
  const card = clozeCard(
    "Contemplation: the client intends to change within the next {{c1::six months}} and weighs pros and cons.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("cloze-not-grounded"), "should not fail cloze-not-grounded");
});

// ---- cloze-count (distinct deletion numbers, 1 to 3 inclusive)

test("cloze-count: fails with 0 deletions", () => {
  const card = clozeCard("Contemplation: the client intends to change within the next six months.");
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("cloze-count"), "expected cloze-count for 0 deletions");
});

test("cloze-count: fails with 4 distinct deletions", () => {
  const card = clozeCard(
    "{{c1::Contemplation}}: the {{c2::client}} intends to {{c3::change}} within the next {{c4::six months}}.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("cloze-count"), "expected cloze-count for 4 distinct deletions");
});

test("cloze-count: passes with 1 to 3 distinct deletions, and repeated same-number markers do not inflate the count", () => {
  const card = clozeCard(
    "{{c1::Contemplation}}: the client intends to {{c1::change}} within the next six months.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("cloze-count"), "one distinct number used twice is still one deletion");
});

// ---- cloze-numbering (distinct numbers exactly 1..k, no gaps)

test("cloze-numbering: fails when there is a gap", () => {
  const card = clozeCard(
    "{{c1::Contemplation}}: the client intends to {{c3::change}} within the next six months.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("cloze-numbering"), "expected cloze-numbering for a gap (1,3)");
});

test("cloze-numbering: passes for consecutive numbers starting at 1", () => {
  const card = clozeCard(
    "{{c1::Contemplation}}: the client intends to {{c2::change}} within the next six months.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("cloze-numbering"), "should not fail cloze-numbering for (1,2)");
});

// ---- cloze-framing (<=6 words, no framing marker)

test("cloze-framing: fails when a deletion body contains a framing marker", () => {
  const card = clozeCard(
    "Contemplation {{c1::is a stage of change}} where the client intends to change within the next six months.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("cloze-framing"), "expected cloze-framing for a body containing 'is'");
});

test("cloze-framing: fails when a deletion body is more than 6 words", () => {
  const card = clozeCard(
    "Contemplation: the client intends to change {{c1::within the next six long calendar months from now}} and weighs pros and cons.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("cloze-framing"), "expected cloze-framing for a 9-word body");
});

test("cloze-framing: passes for a short, marker-free deletion body", () => {
  const card = clozeCard(
    "Contemplation: the client intends to change within the next {{c1::six months}} and weighs pros and cons.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("cloze-framing"), "should not fail cloze-framing for 'six months'");
});

// ---- qa-empty

test("qa-empty: fails a qa card with a blank back", () => {
  const card = qaCard("What is contemplation?", "   ");
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("qa-empty"), "expected qa-empty for blank back");
});

test("qa-empty: fails a cloze card with no {{cN:: marker", () => {
  const card = clozeCard("Contemplation: the client intends to change within the next six months.");
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("qa-empty"), "expected qa-empty for a cloze with no marker");
});

test("qa-empty: passes a qa card with non-empty front and back", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("qa-empty"), "should not fail qa-empty");
});

// ---- qa-answer-long

test("qa-answer-long: fails when the back is more than 12 words", () => {
  const card = qaCard(
    "What does contemplation mean?",
    "The client intends to change within the next six months and also weighs the pros and cons carefully",
  );
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("qa-answer-long"), "expected qa-answer-long for a 17-word back");
});

test("qa-answer-long: passes when the back is 12 words or fewer", () => {
  const card = qaCard("What stage involves intending to change within six months?", "Contemplation");
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("qa-answer-long"), "should not fail qa-answer-long");
});

// ---- qa-yes-no

test("qa-yes-no: fails when the front starts with a yes/no auxiliary", () => {
  const card = qaCard("Is contemplation a stage of change?", "Yes");
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("qa-yes-no"), "expected qa-yes-no for a front starting with 'Is'");
});

test("qa-yes-no: passes when the front does not start with a yes/no auxiliary", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("qa-yes-no"), "should not fail qa-yes-no");
});

// ---- card-long

test("card-long: fails when front + back + text combined exceed 60 words", () => {
  const longBack = Array.from({ length: 65 }, (_, i) => `word${i}`).join(" ");
  const card = qaCard("What is contemplation?", longBack);
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("card-long"), "expected card-long for a 65+ word combined card");
});

test("card-long: passes when the combined word count is 60 or fewer", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("card-long"), "should not fail card-long");
});

test("card-long: counts cloze markup by its stripped body content, not the {{cN::...}} syntax", () => {
  // Body words: "Contemplation the client intends to change within the next six
  // months and weighs pros and cons" = 16 words either bare or wrapped in a
  // marker; the {{c1:: }} syntax itself must not inflate the count.
  const bareText = "Contemplation: the client intends to change within the next six months and weighs pros and cons.";
  const clozedText =
    "Contemplation: the client intends to change within the next {{c1::six months}} and weighs pros and cons.";
  const bareWords = l.lintCard(clozeCard(bareText), highlight, []);
  const clozedWords = l.lintCard(clozeCard(clozedText), highlight, []);
  // Neither should trip card-long, and in particular the clozed version must
  // not fail card-long due to marker syntax being counted as extra words.
  assert.ok(!clozedWords.failures.includes("card-long"), "clozed markers should not inflate card-long word count");
  assert.ok(!bareWords.failures.includes("card-long"));
});

// ---- answer-in-question

test("answer-in-question: fails when the normalized back is a substring of the normalized front", () => {
  const card = qaCard("What does contemplation mean in the stages of change model?", "Contemplation");
  const r = l.lintCard(card, highlight, []);
  assert.ok(r.failures.includes("answer-in-question"), "expected answer-in-question");
});

test("answer-in-question: passes when the back is not contained in the front", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("answer-in-question"), "should not fail answer-in-question");
});

test("answer-in-question: a short answer inside a longer word is not a match", () => {
  // "on" is a letter-substring of "contemplation" but not a word of the front.
  const card = qaCard("What defines the contemplation stage?", "on");
  const r = l.lintCard(card, highlight, []);
  assert.ok(!r.failures.includes("answer-in-question"), "substring inside a word must not count");
});

test("answer-in-question: a multi-word answer must match as a whole run of words", () => {
  const contiguous = qaCard("Why does the contemplation stage precede action?", "the contemplation stage");
  assert.ok(l.lintCard(contiguous, highlight, []).failures.includes("answer-in-question"));

  const scattered = qaCard("Which stage names the six month intention window?", "stage window");
  assert.ok(!l.lintCard(scattered, highlight, []).failures.includes("answer-in-question"), "non-adjacent words must not count");
});

// ---- duplicate-card (warning)

test("duplicate-card: warns when a sibling has the same normalized front", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const sibling = qaCard("what stage of change involves intending to change within six months", "Something else");
  const r = l.lintCard(card, highlight, [sibling]);
  assert.ok(r.warnings.includes("duplicate-card"), "expected duplicate-card warning");
});

test("duplicate-card: no warning when siblings have a different normalized front/text", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const sibling = qaCard("What does the client weigh during contemplation?", "Pros and cons");
  const r = l.lintCard(card, highlight, [sibling]);
  assert.ok(!r.warnings.includes("duplicate-card"), "should not warn duplicate-card");
});

// ---- shared-answer (warning)

test("shared-answer: warns when a sibling qa card has the same normalized back", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const sibling = qaCard("What does the client weigh during contemplation?", "Contemplation");
  const r = l.lintCard(card, highlight, [sibling]);
  assert.ok(r.warnings.includes("shared-answer"), "expected shared-answer warning");
});

test("shared-answer: no warning when sibling backs differ, and cloze siblings never trigger it", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const differentBack = qaCard("What does the client weigh during contemplation?", "Pros and cons");
  const clozeSibling = clozeCard(
    "Contemplation: the client intends to change within the next {{c1::six months}} and weighs pros and cons.",
  );
  const r = l.lintCard(card, highlight, [differentBack, clozeSibling]);
  assert.ok(!r.warnings.includes("shared-answer"), "should not warn shared-answer");
});

// ---- kind isolation: a qa card can never emit a cloze-* failure

test("a qa card never emits cloze-* failure ids", () => {
  const card = qaCard("Is contemplation a stage of change?", "");
  const r = l.lintCard(card, highlight, []);
  assert.ok(
    !r.failures.some((f) => f.startsWith("cloze-")),
    "qa cards must never emit cloze-* ids: " + JSON.stringify(r.failures),
  );
});

// ---- realistic zero-failure, zero-warning card

test("a well-formed PHED163-style cloze card with no siblings passes clean", () => {
  const card = clozeCard(
    "Contemplation: the client intends to change within the next {{c1::six months}} and weighs pros and cons.",
  );
  const r = l.lintCard(card, highlight, []);
  assert.deepEqual(r.failures, [], "expected zero failures");
  assert.deepEqual(r.warnings, [], "expected zero warnings");
});

test("a well-formed qa card with no siblings passes clean", () => {
  const card = qaCard("What stage of change involves intending to change within six months?", "Contemplation");
  const r = l.lintCard(card, highlight, []);
  assert.deepEqual(r.failures, [], "expected zero failures");
  assert.deepEqual(r.warnings, [], "expected zero warnings");
});

// ---- deterministic ordering matches the table order in the brief

test("failures are returned in the fixed table order, not push-arbitrary order", () => {
  // Construct a cloze card that trips cloze-not-grounded, cloze-count (0),
  // cloze-numbering (n/a: 0 deletions so distinctNumbers is empty -> also
  // fails numbering), and card-long simultaneously, then a qa card that
  // trips qa-empty, qa-yes-no, and answer-in-question together.
  const clozeBad = clozeCard(
    Array.from({ length: 65 }, (_, i) => `nomatch${i}`).join(" "),
  );
  const rClozeBad = l.lintCard(clozeBad, highlight, []);
  // Table order for cloze-applicable ids: cloze-not-grounded, cloze-count,
  // cloze-numbering, qa-empty, card-long (cloze-framing does not apply, 0 deletions).
  assert.deepEqual(rClozeBad.failures, ["cloze-count", "cloze-numbering", "qa-empty", "card-long"]);
  // cloze-not-grounded does not fire here since there are no {{cN::}} markers
  // at all to check groundedness of (ungroundedClozes finds none to flag).

  const qaBad = qaCard("Is contemplation contemplation?", "contemplation");
  const rQaBad = l.lintCard(qaBad, highlight, []);
  // Table order for qa-applicable ids: qa-yes-no, answer-in-question (qa-empty
  // does not apply, both fields non-empty; qa-answer-long does not apply, 1
  // word back; card-long does not apply, well under 60 words).
  assert.deepEqual(rQaBad.failures, ["qa-yes-no", "answer-in-question"]);
});

// ---- findCrossInterference

test("findCrossInterference: two qa cards from different highlights with equivalent backs interfere", () => {
  const c1 = qaCard("What stage involves intending to change?", "six months", { id: "c1", highlightId: "h1" });
  const c2 = qaCard("How long until the client changes?", "Six months.", { id: "c2", highlightId: "h2" });
  const map = l.findCrossInterference([
    { card: c1, highlightId: "h1" },
    { card: c2, highlightId: "h2" },
  ]);
  assert.deepEqual(map.get("c1"), ["c2"]);
  assert.deepEqual(map.get("c2"), ["c1"]);
  assert.equal(map.size, 2);
});

test("findCrossInterference: same-highlight pairs are excluded", () => {
  const c1 = qaCard("What stage involves intending to change?", "six months", { id: "c1", highlightId: "h1" });
  const c2 = qaCard("How long until the client changes?", "Six months.", { id: "c2", highlightId: "h1" });
  const map = l.findCrossInterference([
    { card: c1, highlightId: "h1" },
    { card: c2, highlightId: "h1" },
  ]);
  assert.equal(map.size, 0);
});

test("findCrossInterference: two cloze cards with identical text interfere across highlights", () => {
  const c1 = clozeCard("Contemplation: intends to change within {{c1::six months}}.", { id: "c1", highlightId: "h1" });
  const c2 = clozeCard("Contemplation: intends to change within {{c1::six months}}.", { id: "c2", highlightId: "h2" });
  const map = l.findCrossInterference([
    { card: c1, highlightId: "h1" },
    { card: c2, highlightId: "h2" },
  ]);
  assert.deepEqual(map.get("c1"), ["c2"]);
  assert.deepEqual(map.get("c2"), ["c1"]);
});

test("findCrossInterference: a qa back and a cloze text that normalize equal never collide (different kinds)", () => {
  const c1 = qaCard("How long?", "six months", { id: "c1", highlightId: "h1" });
  const c2 = clozeCard("six months", { id: "c2", highlightId: "h2" });
  const map = l.findCrossInterference([
    { card: c1, highlightId: "h1" },
    { card: c2, highlightId: "h2" },
  ]);
  assert.equal(map.size, 0);
});

test("findCrossInterference: cards with an empty key are skipped", () => {
  const c1 = qaCard("How long?", "", { id: "c1", highlightId: "h1" });
  const c2 = qaCard("When?", "", { id: "c2", highlightId: "h2" });
  const map = l.findCrossInterference([
    { card: c1, highlightId: "h1" },
    { card: c2, highlightId: "h2" },
  ]);
  assert.equal(map.size, 0);
});

test("findCrossInterference: three qa cards across three highlights sharing a back all list each other", () => {
  const c1 = qaCard("Q1?", "six months", { id: "c1", highlightId: "h1" });
  const c2 = qaCard("Q2?", "six months", { id: "c2", highlightId: "h2" });
  const c3 = qaCard("Q3?", "six months", { id: "c3", highlightId: "h3" });
  const map = l.findCrossInterference([
    { card: c1, highlightId: "h1" },
    { card: c2, highlightId: "h2" },
    { card: c3, highlightId: "h3" },
  ]);
  assert.deepEqual(map.get("c1"), ["c2", "c3"]);
  assert.deepEqual(map.get("c2"), ["c1", "c3"]);
  assert.deepEqual(map.get("c3"), ["c1", "c2"]);
});

test("findCrossInterference: two h1 cards sharing a back with h2 only cross-list the h2 card", () => {
  const c1 = qaCard("Q1?", "six months", { id: "c1", highlightId: "h1" });
  const c3 = qaCard("Q3?", "six months", { id: "c3", highlightId: "h1" });
  const c2 = qaCard("Q2?", "six months", { id: "c2", highlightId: "h2" });
  const map = l.findCrossInterference([
    { card: c1, highlightId: "h1" },
    { card: c2, highlightId: "h2" },
    { card: c3, highlightId: "h1" },
  ]);
  assert.deepEqual(map.get("c2"), ["c1", "c3"]);
  assert.deepEqual(map.get("c1"), ["c2"]);
  assert.deepEqual(map.get("c3"), ["c2"]);
});
