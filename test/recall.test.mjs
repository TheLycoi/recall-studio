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
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
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

test("checkCue accepts a cue that names the subject and none of its points", () => {
  const item = r.buildItems(coaching())[2];
  const ok = r.checkCue({ cue: "Walk through elicit-provide-elicit: when a coach uses it, and each step in order.", shape: "procedure" }, item);
  assert.equal(ok.ok, true, ok.reason);
});

test("checkCue rejects a cue that states one of the points", () => {
  const item = r.buildItems(coaching())[2];
  const bad = r.checkCue({ cue: "Elicit-provide-elicit: after you share the most relevant information in small doses, what comes next?", shape: "procedure" }, item);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /states point 3/);
});

test("checkCue rejects a yes/no cue and an empty one", () => {
  const item = r.buildItems(coaching())[2];
  assert.equal(r.checkCue({ cue: "Is elicit-provide-elicit used with permission?", shape: "concept" }, item).ok, false);
  assert.equal(r.checkCue({ cue: "  ", shape: "concept" }, item).ok, false);
});

test("fallbackCue is written from the heading path and never from the points", () => {
  const items = r.buildItems(coaching());
  assert.equal(r.fallbackCue(items[2]), "Elicit-provide-elicit (Motivational interviewing): write down everything you remember.");
  assert.equal(r.fallbackCue(items[0]), "Coaching: write down everything you remember.", "the lead is named by the note");
  const long = Array.from({ length: 12 }, (_, i) => unit(`l${i}`, "Initial session › Rapport", `Rapport statement number ${i} about trust and understanding.`));
  assert.equal(r.fallbackCue(r.buildItems(long)[1]), "Rapport (Initial session), part 2 of 2: write down everything you remember.");
});

test("renderCueMarkdown's header names the section, the shape and the point count", () => {
  let s = session();
  const item = s.items[2];
  s = r.acceptCue(s, item, "Walk through elicit-provide-elicit.", "procedure", false);
  const md = r.renderCueMarkdown(s.current, item);
  assert.equal(md.split("\n")[0], "**Question 1 · Elicit-provide-elicit** *(procedure · 4 points)*");
  assert.ok(md.endsWith("Walk through elicit-provide-elicit."));
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

test("checkRecallGrade marks a recalled point unverified when its words are not in the answer", () => {
  const item = r.buildItems(coaching())[2];
  const { marks } = r.checkRecallGrade(grade(["recalled", "missed", "missed", "missed"], { said: ["only with permission"] }), item.points, "you use it when they ask");
  assert.equal(marks[0].status, "recalled");
  assert.equal(marks[0].verified, false);
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
  s = r.acceptCue(s, item, "Walk through elicit-provide-elicit.", "procedure", false);
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
  assert.match(md, /You recalled 1 of 4/);
  assert.match(md, /what the coach does second/);
  assert.match(md, /the last step/);
});

test("a first attempt that recalls everything reveals at once", () => {
  const { s, item } = onEpe();
  const answer = "a b c d";
  const { marks } = r.checkRecallGrade(grade(["recalled", "recalled", "recalled", "recalled"]), item.points, answer);
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
    s = r.acceptCue(s, item, "Recall it.", "concept", true);
    s = r.skipRecall(s, "");
  }
  assert.equal(s.finished, true, "the cap");
  let all = session();
  while (r.nextItem(all)) {
    all = r.acceptCue(all, r.nextItem(all), "Recall it.", "concept", true);
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
  s = r.acceptCue(s, item, "Recall it.", "concept", true);
  s = r.afterFirstAttempt(s, "x", r.checkRecallGrade(grade(["recalled"]), item.points, "x").marks, "");
  item = r.nextItem(s);
  s = r.acceptCue(s, item, "Recall it.", "concept", true);
  s = r.skipRecall(s, "");
  item = r.nextItem(s);
  s = r.acceptCue(s, item, "Recall it.", "procedure", true);
  s = r.afterFirstAttempt(s, "x", r.checkRecallGrade(grade(["recalled", "missed", "missed", "missed"]), item.points, "x").marks, "");
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
