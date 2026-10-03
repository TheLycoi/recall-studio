// Run with: npm test  (bundles src/recall.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let r;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "recall.mjs");
  await build({ entryPoints: ["src/recall.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  r = await import(pathToFileURL(out).href);
});

// ---- fixtures ----------------------------------------------------------------

const COACHING = "wiki/concepts/Coaching.md";
const EPE = "Motivational interviewing › Elicit-provide-elicit";

function unit(id, section, text, notePath = COACHING, noteTitle = "Coaching") {
  return { id, notePath, noteTitle, pdfBasename: null, target: null, page: null, text, kind: "claim", classCodes: [], section };
}

function coaching() {
  return [
    unit("p0", "", "Health coaching is a client-centered partnership in which a coach helps a person change."),
    unit("p1", "Motivational interviewing", "Motivational interviewing (MI) is a client-centered approach to behavior change."),
    unit("p2", EPE, "Used when a client asks for information, and only with permission."),
    unit("p3", EPE, "Elicit: ask permission, and find out what the client already knows"),
    unit("p4", EPE, "Provide: share the most relevant information in small doses"),
    unit("p5", EPE, "Elicit: check understanding and response"),
    unit("p6", "Initial session › Rapport", "Sit at a 45-degree angle to the client during rapport building."),
  ];
}

function session(items = r.buildItems(coaching()), cap = 30) {
  return r.startRecall({ kind: "note", label: "Coaching" }, "", items, cap);
}

/** A grade draft for the current item: statuses in point order, `said` copied from the answer. */
function grade(statuses, extra = {}) {
  return {
    points: statuses.map((status, i) => ({
      n: i + 1,
      status,
      said: extra.said?.[i] ?? "",
      note: extra.note?.[i] ?? "",
      cue: extra.cue?.[i] ?? "",
    })),
    feedback: extra.feedback ?? "",
  };
}

// ---- items -------------------------------------------------------------------

test("buildItems groups a note's passages by section, in note order", () => {
  const items = r.buildItems(coaching());
  assert.deepEqual(
    items.map((i) => [i.section, i.points.map((p) => p.id)]),
    [
      ["", ["p0"]],
      ["Motivational interviewing", ["p1"]],
      [EPE, ["p2", "p3", "p4", "p5"]],
      ["Initial session › Rapport", ["p6"]],
    ],
  );
});

test("buildItems splits a long section into runs of at most seven, and marks the parts", () => {
  const long = Array.from({ length: 12 }, (_, i) => unit(`l${i}`, "Change talk", `Change talk statement number ${i} about reasons and motivations.`));
  const items = r.buildItems(long);
  assert.deepEqual(items.map((i) => i.points.length), [6, 6], "twelve points become two balanced runs");
  assert.deepEqual(items.map((i) => [i.part, i.parts]), [[1, 2], [2, 2]]);
  assert.notEqual(items[0].id, items[1].id);
  const nine = r.buildItems(long.slice(0, 9));
  assert.equal(nine.length, 1, "nine points stay one item");
});

test("buildItems leaves quoted example utterances out of the points", () => {
  const pool = [
    unit("a", EPE, "Elicit: ask permission, and find out what the client already knows"),
    unit("q", EPE, "\"What does 'eating better' look like to you?\""),
    unit("b", EPE, "Provide: share the most relevant information in small doses"),
    unit("c", EPE, "The coach says \"would it be OK if I share some information?\" before providing."),
  ];
  const items = r.buildItems(pool);
  assert.deepEqual(items[0].points.map((p) => p.id), ["a", "b", "c"], "a line that is only a quotation is an example, not a point");
});

test("buildItems drops passages that cannot carry a point and keeps two notes apart", () => {
  const pool = [
    unit("h", "Rapport", "Rapport"),
    unit("a", "Rapport", "Rapport is a relationship of trust and mutual understanding."),
    unit("b", "Rapport", "Receptors bind drugs with high affinity at the membrane.", "wiki/concepts/Receptors.md", "Receptors"),
  ];
  const items = r.buildItems(pool);
  assert.deepEqual(items.map((i) => [i.noteTitle, i.points.map((p) => p.id)]), [["Coaching", ["a"]], ["Receptors", ["b"]]]);
});

test("resolveRecallPool: a note is every section of it; all and query cap by sections, not passages", () => {
  const units = coaching();
  const note = r.resolveRecallPool("this", "", units, COACHING, () => null, 2);
  assert.equal(note.items.length, 4, "the note scope is the whole note, whatever the cap");
  assert.equal(note.label, "Coaching");
  const all = r.resolveRecallPool("all", "", units, null, () => null, 2);
  assert.equal(all.items.length, 2, "the whole-vault scope samples sections");
  assert.equal(all.items.every((i) => i.points.length >= 1), true);
  const query = r.resolveRecallPool("query", "permission", units, null, (t) => (/permission/.test(t) ? 1 : null), 3);
  assert.equal(query.items.length, 3, "query takes whole notes in rank order, then the first sections");
});

// ---- cue -----------------------------------------------------------------------

test("checkQuestion accepts a question on the section's idea and maps expects to its points", () => {
  const item = r.buildItems(coaching())[2];
  const ok = r.checkQuestion({ question: "What are the steps of elicit-provide-elicit, in order?", shape: "procedure", expects: [2, 3, 4] }, item);
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(ok.expects, ["p3", "p4", "p5"]);
  assert.equal(ok.cue, "What are the steps of elicit-provide-elicit, in order?");
});

test("checkQuestion keeps at most four expected points, once each, and drops numbers the section does not have", () => {
  const long = Array.from({ length: 6 }, (_, i) => unit(`l${i}`, "Initial session › Rapport", `Rapport statement number ${i} about trust and understanding.`));
  const item = r.buildItems(long)[0];
  const ok = r.checkQuestion({ question: "How does a coach build rapport in the first session?", shape: "concept", expects: [0, 2, 2, 1, 3, 4, 5, 9] }, item);
  assert.equal(ok.ok, true, ok.reason);
  assert.deepEqual(ok.expects, ["l1", "l0", "l2", "l3"]);
});

test("checkQuestion rejects a question that expects nothing the section has", () => {
  const item = r.buildItems(coaching())[2];
  for (const expects of [[], [9], undefined]) {
    const bad = r.checkQuestion({ question: "What are the steps of elicit-provide-elicit?", shape: "procedure", expects }, item);
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /expects/);
  }
});

test("checkQuestion rejects a question that states a point it expects", () => {
  const item = r.buildItems(coaching())[2];
  const bad = r.checkQuestion(
    { question: "Elicit-provide-elicit: after you share the most relevant information in small doses, what comes next?", shape: "procedure", expects: [3, 4] },
    item,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /states point 3/);
});

test("checkQuestion lets a question use the subject's own words when the point is a long passage", () => {
  const para =
    "The biopsychosocial approach, a term introduced by George Engel, insists that mental illness cannot be understood through biology alone but must include psychological and social factors as well. The course organizes its coverage of psychopathology around three major themes: a behavioral and experiential perspective, a neuroscience perspective, and an evolutionary perspective.";
  const item = r.buildItems([unit("d0", "Definition", para, "wiki/concepts/Biopsychosocial Model.md", "Biopsychosocial Model")])[0];
  const ok = r.checkQuestion({ question: "What does the biopsychosocial model say mental illness must be understood through, and who introduced the term?", shape: "concept", expects: [1] }, item);
  assert.equal(ok.ok, true, ok.reason);
});

test("checkQuestion rejects a yes/no question, an empty one, and a write-everything prompt", () => {
  const item = r.buildItems(coaching())[2];
  const q = (question) => r.checkQuestion({ question, shape: "concept", expects: [1] }, item);
  assert.equal(q("Is elicit-provide-elicit used with permission?").ok, false);
  assert.equal(q("  ").ok, false);
  const dump = q("Elicit-provide-elicit: write down everything you remember.");
  assert.equal(dump.ok, false);
  assert.match(dump.reason, /everything/);
});

test("fallbackQuestion asks for a few sentences on the heading and never states a point", () => {
  const items = r.buildItems(coaching());
  assert.equal(r.fallbackQuestion(items[2]), "Elicit-provide-elicit (Motivational interviewing): explain it in a few sentences.");
  assert.equal(r.fallbackQuestion(items[0]), "Coaching: explain it in a few sentences.", "the lead is named by the note");
  const def = r.buildItems([unit("d0", "Definition", "The biopsychosocial model holds that mental illness cannot be understood through biology alone.", "wiki/concepts/Biopsychosocial Model.md", "Biopsychosocial Model")])[0];
  assert.equal(r.fallbackQuestion(def), "Biopsychosocial Model: explain it in a few sentences.", "a generic heading is replaced by the note's name");
  assert.deepEqual(r.fallbackExpects(items[2]), ["p2", "p3", "p4", "p5"]);
});

test("renderQuestionMarkdown's header names the section and asks for a few sentences", () => {
  let s = session();
  const item = s.items[2];
  s = r.acceptQuestion(s, item, "What are the steps of elicit-provide-elicit, in order?", "procedure", false, ["p3", "p4", "p5"], 1);
  const md = r.renderQuestionMarkdown(s.current, item);
  assert.equal(md.split("\n")[0], "**Question 1 · Elicit-provide-elicit** *(procedure · answer in a few sentences)*");
  assert.ok(md.endsWith("What are the steps of elicit-provide-elicit, in order?"));
});

test("a question is marked only on the points it expects", () => {
  let s = session();
  const item = s.items[2];
  s = r.acceptQuestion(s, item, "What are the steps of elicit-provide-elicit, in order?", "procedure", false, ["p3", "p4", "p5"], 1);
  assert.deepEqual(r.questionPoints(s).map((p) => p.id), ["p3", "p4", "p5"]);
  const skipped = r.skipRecall(s, "");
  assert.equal(skipped.results[0].marks.length, 3, "the point the question did not ask for is not held against the reader");
});

test("nextLevel rises after a full answer, falls after a miss, and holds on a partial one", () => {
  const items = r.buildItems(coaching());
  let s = session(items);
  assert.equal(r.nextLevel(s), 1, "the first question states the ground");
  const ask = (level) => (s = r.acceptQuestion(s, r.nextItem(s), "Q?", "concept", false, undefined, level));
  const answer = (statuses) => {
    const pts = r.questionPoints(s);
    const words = "the client centered partnership approach";
    const said = pts.map(() => words);
    const { marks } = r.checkRecallGrade(grade(statuses, { said }), pts, words);
    s = r.afterFirstAttempt(s, words, marks, "");
  };
  ask(1);
  answer(["recalled"]);
  assert.equal(r.nextLevel(s), 2);
  ask(2);
  answer(["recalled"]);
  assert.equal(r.nextLevel(s), 3);
  ask(3);
  s = r.skipRecall(s, "");
  assert.equal(r.nextLevel(s), 2, "a miss steps back down");
});

// ---- grade -----------------------------------------------------------------------

test("checkRecallGrade gives every point one mark, missing entries as missed", () => {
  const item = r.buildItems(coaching())[2];
  const answer = "you ask permission first and find out what they know, then share info";
  const draft = { points: [{ n: 2, status: "recalled", said: "ask permission first", note: "", cue: "" }], feedback: "" };
  const { marks } = r.checkRecallGrade(draft, item.points, answer);
  assert.deepEqual(marks.map((m) => m.status), ["missed", "recalled", "missed", "missed"]);
  assert.equal(marks[1].verified, true);
});

test("checkRecallGrade counts a recalled point as missed when its words are not in the answer, and keeps the cue", () => {
  const item = r.buildItems(coaching())[2];
  const draft = grade(["recalled", "missed", "missed", "missed"], { said: ["only with permission"], cue: ["when it is used", "", "", ""] });
  const { marks } = r.checkRecallGrade(draft, item.points, "you use it when they ask");
  assert.equal(marks[0].status, "missed");
  assert.equal(marks[0].verified, false, "the badge still says unverified");
  assert.equal(marks[0].cue, "when it is used");
});

test("an unverified recalled mark is not counted: the review's reproduction", () => {
  let s = session();
  const item = r.nextItem(s);
  s = r.acceptQuestion(s, item, "Recall it.", "concept", true);
  const answer = "I have no idea at all";
  const { marks } = r.checkRecallGrade(grade(["recalled"], { said: ["receptors bind ligands with high affinity"] }), item.points, answer);
  assert.equal(marks[0].status, "missed");
  s = r.afterFirstAttempt(s, answer, marks, "");
  assert.equal(r.resultVerdict(s.results[0]), "incorrect");
  assert.equal(r.recallMisses(s).length, 1);
});

test("an unverified partial mark counts as missed", () => {
  const item = r.buildItems(coaching())[2];
  const draft = grade(["partial", "missed", "missed", "missed"], { said: ["only with permission"], note: ["left out the permission", "", "", ""], cue: ["when it is used", "", "", ""] });
  const { marks } = r.checkRecallGrade(draft, item.points, "no idea");
  assert.equal(marks[0].status, "missed");
  assert.equal(marks[0].verified, false);
  assert.equal(marks[0].cue, "when it is used");
});

test("an unverified wrong mark counts as missed and sends no misconception", () => {
  let s = session();
  const item = r.nextItem(s);
  s = r.acceptQuestion(s, item, "Recall it.", "concept", true);
  const answer = "I have no idea at all";
  const draft = grade(["wrong"], { said: ["coaching is telling people what to do"], note: ["thinks coaching is directive"] });
  const { marks } = r.checkRecallGrade(draft, item.points, answer);
  assert.equal(marks[0].status, "missed");
  assert.equal(marks[0].verified, false);
  s = r.afterFirstAttempt(s, answer, marks, "");
  assert.equal(r.resultCounts(s.results[0]).wrong, 0);
  const misses = r.recallMisses(s);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].gap, "detail");
  assert.equal(misses[0].verdict, "skipped");
  assert.doesNotMatch(misses[0].gapNote, /directive/, "the unverified wrong belief is not passed on");
});

test("checkRecallGrade blanks a cue that gives its point away", () => {
  const item = r.buildItems(coaching())[2];
  const cues = ["", "the first step", "share the most relevant information in small doses", ""];
  const { marks } = r.checkRecallGrade(grade(["recalled", "missed", "missed", "missed"], { said: ["asks"], cue: cues }), item.points, "when a client asks");
  assert.equal(marks[1].cue, "the first step");
  assert.equal(marks[2].cue, "", "a cue that is the point is no cue");
});

test("checkRecallGrade flags a missed point whose words the answer plainly has", () => {
  const item = r.buildItems(coaching())[2];
  const answer = "Provide: share the most relevant information in small doses";
  const { marks } = r.checkRecallGrade(grade(["missed", "missed", "missed", "missed"]), item.points, answer);
  assert.equal(marks[2].dispute, true);
  assert.equal(marks[0].dispute, false);
});

// ---- the two attempts ---------------------------------------------------------------

function onEpe() {
  let s = session();
  const item = s.items[2];
  s = r.acceptQuestion(s, item, "Walk through elicit-provide-elicit.", "procedure", false);
  return { s, item };
}

test("a first attempt with points missing and cues to give arms the cued attempt", () => {
  const { s, item } = onEpe();
  const answer = "when the client asks. ask permission first";
  const { marks } = r.checkRecallGrade(
    grade(["recalled", "partial", "missed", "missed"], { said: ["when the client asks", "ask permission first"], cue: ["", "", "what the coach does second", "the last step"] }),
    item.points,
    answer,
  );
  const next = r.afterFirstAttempt(s, answer, marks, "");
  assert.equal(next.attempt, 2);
  assert.deepEqual(r.openPoints(next).map((p) => p.id), ["p3", "p4", "p5"], "partial and missed points are open");
  const md = r.renderCuedMarkdown(next);
  assert.match(md, /Your answer has 1 of 4 parts/);
  assert.match(md, /what the coach does second/);
  assert.match(md, /the last step/);
});

test("a first attempt that recalls everything reveals at once", () => {
  const { s, item } = onEpe();
  const answer = "when a client asks. ask permission. share in small doses. check understanding";
  const said = ["when a client asks", "ask permission", "share in small doses", "check understanding"];
  const { marks } = r.checkRecallGrade(grade(["recalled", "recalled", "recalled", "recalled"], { said }), item.points, answer);
  const next = r.afterFirstAttempt(s, answer, marks, "All four.");
  assert.equal(next.current, null);
  assert.equal(next.results.length, 1);
  assert.equal(next.results[0].marks.every((m) => m.status === "recalled"), true);
});

test("points produced only under cue count as cued, not recalled", () => {
  const { s, item } = onEpe();
  const first = "when the client asks";
  const m1 = r.checkRecallGrade(grade(["recalled", "missed", "missed", "missed"], { said: [first], cue: ["", "the first step", "the second step", "the last step"] }), item.points, first).marks;
  let next = r.afterFirstAttempt(s, first, m1, "");
  const second = "ask permission. share information in small doses";
  const m2 = r.checkRecallGrade(grade(["recalled", "recalled", "missed"], { said: ["ask permission", "share information in small doses"] }), r.openPoints(next), second).marks;
  next = r.afterCuedAttempt(next, second, m2, "");
  const statuses = next.results[0].marks.map((m) => m.status);
  assert.deepEqual(statuses, ["recalled", "cued", "cued", "missed"]);
  assert.deepEqual(next.results[0].answers, [first, second]);
});

test("a first attempt with no usable cue reveals instead of asking again", () => {
  const { s, item } = onEpe();
  const { marks } = r.checkRecallGrade(grade(["recalled", "missed", "missed", "missed"], { said: ["asks"] }), item.points, "asks");
  const next = r.afterFirstAttempt(s, "asks", marks, "");
  assert.equal(next.current, null, "nothing to cue with, so the section is revealed");
});

test("skipRecall marks every open point missed and closes the section", () => {
  const { s } = onEpe();
  const next = r.skipRecall(s, "/skip");
  assert.equal(next.current, null);
  assert.equal(next.results[0].skipped, true);
  assert.equal(next.results[0].marks.every((m) => m.status === "missed"), true);
});

test("the quiz ends when every section is asked, or at the cap", () => {
  let s = session(r.buildItems(coaching()), 2);
  for (let i = 0; i < 2; i++) {
    const item = r.nextItem(s);
    s = r.acceptQuestion(s, item, "Recall it.", "concept", true);
    s = r.skipRecall(s, "");
  }
  assert.equal(s.finished, true, "the cap");
  let all = session();
  while (r.nextItem(all)) {
    all = r.acceptQuestion(all, r.nextItem(all), "Recall it.", "concept", true);
    all = r.skipRecall(all, "");
  }
  assert.equal(all.finished, true);
  assert.equal(all.results.length, 4);
  assert.match(r.recallSummary(all).line, /every section asked/);
});

// ---- reveal, summary, misses -------------------------------------------------------

test("renderRevealMarkdown lists every point with its mark and links the section", () => {
  const { s, item } = onEpe();
  const answer = "when the client asks. elicit what they think";
  const { marks } = r.checkRecallGrade(
    grade(["recalled", "partial", "missed", "wrong"], { said: ["when the client asks", "elicit what they think", "", "elicit what they think"], note: ["", "", "", "thinks the last step asks for permission again"] }),
    item.points,
    answer,
  );
  const next = r.afterFirstAttempt(s, answer, marks, "You had when it is used.");
  const md = r.renderRevealMarkdown(next.results[0], item);
  assert.match(md.split("\n")[0], /^Recalled 1 of 4/);
  assert.match(md, /You had when it is used\./);
  assert.match(md, /✓ Used when a client asks/);
  assert.match(md, /△ Elicit: ask permission/);
  assert.match(md, /✗ Provide: share/);
  assert.match(md, /⚠ Elicit: check understanding and response — thinks the last step asks for permission again/);
  assert.match(md, /\[\[wiki\/concepts\/Coaching#Elicit-provide-elicit\|Coaching › Elicit-provide-elicit\]\]/);
});

test("recallSummary counts points across sections and lists the weakest first", () => {
  let s = session();
  // Section 1 (lead): recalled. Section 2: skipped. Section 3: 1 of 4.
  let item = r.nextItem(s);
  s = r.acceptQuestion(s, item, "Recall it.", "concept", true);
  s = r.afterFirstAttempt(s, "a partnership", r.checkRecallGrade(grade(["recalled"], { said: ["a partnership"] }), item.points, "a partnership").marks, "");
  item = r.nextItem(s);
  s = r.acceptQuestion(s, item, "Recall it.", "concept", true);
  s = r.skipRecall(s, "");
  item = r.nextItem(s);
  s = r.acceptQuestion(s, item, "Recall it.", "procedure", true);
  s = r.afterFirstAttempt(s, "when a client asks", r.checkRecallGrade(grade(["recalled", "missed", "missed", "missed"], { said: ["when a client asks"] }), item.points, "when a client asks").marks, "");
  const { line, weak } = r.recallSummary(s);
  assert.equal(line, "Recalled 2 of 6 points across 3 sections");
  assert.deepEqual(weak.map((w) => [w.item.section, w.recalled, w.total]), [["Motivational interviewing", 0, 1], [EPE, 1, 4]]);
  const md = r.renderRecallSummaryMarkdown(s);
  assert.match(md, /\*\*Weakest sections:\*\*/);
  assert.match(md, /Motivational interviewing — 0 of 1/);
});

test("recallMisses sends every point not freely recalled, with the cue as context and the point as title", () => {
  const { s, item } = onEpe();
  const first = "when the client asks. elicit what they think";
  const m1 = r.checkRecallGrade(
    grade(["recalled", "missed", "missed", "wrong"], { said: ["when the client asks", "", "", "elicit what they think"], cue: ["", "the first step", "", ""], note: ["", "", "", "thinks it asks permission"] }),
    item.points,
    first,
  ).marks;
  let next = r.afterFirstAttempt(s, first, m1, "");
  const m2 = r.checkRecallGrade(grade(["recalled", "missed"], { said: ["permission"] }), r.openPoints(next), "permission").marks;
  next = r.afterCuedAttempt(next, "permission", m2, "");
  const misses = r.recallMisses(next);
  assert.deepEqual(misses.map((m) => m.unit.id), ["p3", "p4", "p5"]);
  assert.deepEqual(misses.map((m) => m.verdict), ["partial", "skipped", "incorrect"]);
  assert.deepEqual(misses.map((m) => m.gap), ["detail", "detail", "misconception"]);
  assert.equal(misses[0].gapNote, "recalled it only when cued");
  assert.equal(misses[2].gapNote, "thinks it asks permission");
  assert.equal(misses[0].question, "Walk through elicit-provide-elicit.");
  assert.equal(misses[0].title, "Elicit: ask permission, and find out what the client already knows");
  assert.equal(misses[0].shape, "procedure");
});

// ---- a long paragraph is several points ---------------------------------------

test("buildItems splits a long paragraph into its sentences, so a question can expect one idea of it", () => {
  const para =
    "The biopsychosocial approach, a term introduced by George Engel, insists that mental illness cannot be understood through biology alone but must include psychological and social factors as well. The course organizes its coverage of psychopathology around three major themes: a behavioral and experiential perspective, a neuroscience perspective, and an evolutionary perspective. These themes map onto different levels of analysis, from relationships and the individual down to genetics.";
  const items = r.buildItems([unit("d0", "Definition", para, "wiki/concepts/Biopsychosocial Model.md", "Biopsychosocial Model")]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].points.map((p) => p.id), ["d0#s1", "d0#s2", "d0#s3"]);
  assert.ok(items[0].points[0].text.startsWith("The biopsychosocial approach"));
  assert.ok(items[0].points[1].text.startsWith("The course organizes"));
  assert.equal(items[0].points[0].notePath, "wiki/concepts/Biopsychosocial Model.md", "a sentence keeps its note");
});

test("buildItems leaves a short point and a one-sentence point whole", () => {
  const one = "A long single sentence that runs on and on about the biopsychosocial approach and its many themes and levels of analysis, from relationships and the individual all the way down to psychological processes, cortical networks, and the genetics underneath them all, without ever stopping";
  const items = r.buildItems([unit("a", "S", "Short point about rapport. Second short one."), unit("b", "S", one)]);
  assert.deepEqual(items[0].points.map((p) => p.id), ["a", "b"]);
});
