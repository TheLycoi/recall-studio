// Run with: npm test  (bundles src/preferences.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let p;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "preferences.mjs");
  await build({ entryPoints: ["src/preferences.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  p = await import(pathToFileURL(out).href);
});

// ---- builders ----------------------------------------------------------------

const snap = (init = {}) => ({ kind: "qa", front: "", back: "", text: "", extra: "", ...init });

let clock = 0;
/** Each revision gets a later timestamp than the last, so "newest first" is the reverse of construction order. */
function rev(before, after, init = {}) {
  clock += 1;
  return {
    cardId: `c${clock}`,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString(),
    via: "edit",
    instruction: "",
    before: snap(before),
    after: snap(after),
    ...init,
  };
}

/** A Q&A revision that trims the answer from `before` words to `after` words. */
const words = (n, seed = "alpha") => Array.from({ length: n }, (_, i) => `${seed}${i}`).join(" ");
const shorten = (from, to, front = "What is the treaty?") =>
  rev({ kind: "qa", front, back: words(from) }, { kind: "qa", front, back: words(to) });

const find = (obs, id) => obs.find((o) => o.id === id);

// ---- thresholds and empty input ---------------------------------------------

test("no revisions produce no observations", () => {
  assert.deepEqual(p.observe([]), []);
});

test("the published thresholds are the ones the spec fixed", () => {
  assert.deepEqual(p.THRESHOLDS, {
    "shorter-answers": 4,
    "prefer-kind": 4,
    "drop-opening": 3,
    "extra-field": 4,
    instruction: 3,
  });
});

// ---- 1. shorter-answers ------------------------------------------------------

test("four shortened answers reach the threshold and propose a word cap", () => {
  const obs = p.observe([shorten(20, 6), shorten(20, 7), shorten(20, 5), shorten(20, 8)]);
  const o = find(obs, "shorter-answers");
  assert.ok(o, "expected a shorter-answers observation");
  assert.equal(o.pattern, "shorter-answers");
  assert.equal(o.count, 4);
  // N is the largest kept answer, so the rule never contradicts an edit the reader made.
  assert.equal(o.rule, "Keep answers to at most 8 words.");
  assert.equal(o.summary, "You shortened 4 answers to 8 words or fewer.");
});

test("three shortened answers stay silent, one below the threshold", () => {
  const obs = p.observe([shorten(20, 6), shorten(20, 7), shorten(20, 5)]);
  assert.equal(find(obs, "shorter-answers"), undefined);
});

test("lengthenings at half the shortenings contradict the pattern and silence it", () => {
  const obs = p.observe([
    shorten(20, 6),
    shorten(20, 7),
    shorten(20, 5),
    shorten(20, 8),
    shorten(4, 20),
    shorten(4, 21),
  ]);
  assert.equal(find(obs, "shorter-answers"), undefined);
});

test("one lengthening among four shortenings is noise, not a contradiction", () => {
  const obs = p.observe([shorten(20, 6), shorten(20, 7), shorten(20, 5), shorten(20, 8), shorten(4, 20)]);
  const o = find(obs, "shorter-answers");
  assert.ok(o);
  assert.equal(o.count, 4);
});

test("emptying an answer is a deletion, not a shortening", () => {
  const obs = p.observe([
    shorten(20, 6),
    shorten(20, 7),
    shorten(20, 5),
    rev({ kind: "qa", front: "What is the treaty?", back: words(20) }, { kind: "qa", front: "What is the treaty?", back: "" }),
  ]);
  assert.equal(find(obs, "shorter-answers"), undefined);
});

test("the word cap counts visible words, not significant tokens", () => {
  const long = "The treaty was signed in a city on the coast of the sea and it was very important indeed";
  const trimmed = "Signed at Ghent."; // 3 visible words, though only "signed" and "ghent" are significant tokens
  const r = (f) => rev({ kind: "qa", front: f, back: long }, { kind: "qa", front: f, back: trimmed });
  const obs = p.observe([r("Q1?"), r("Q2?"), r("Q3?"), r("Q4?")]);
  const o = find(obs, "shorter-answers");
  assert.ok(o);
  assert.equal(o.rule, "Keep answers to at most 3 words.");
});

test("articles and prepositions count toward the cap, so a rule never asks for fewer words than the reader kept", () => {
  // Each kept answer reads naturally with function words a reader would never drop:
  // "in the cell membrane" is 4 visible words but only 2 significant tokens
  // ("cell", "membrane") once stopwords and short words are stripped. The rule
  // must say 4, or a person or model reading "at most 2 words" would cut
  // "in the" and produce "cell membrane" -- an answer the reader never wrote.
  const long = "This happens across many different locations throughout the entire structure of the organism";
  const cases = [
    "in the cell membrane", // 4 visible words, 2 significant tokens
    "at the base of the skull", // 6 visible words, 3 significant tokens
    "on the surface of the leaf", // 6 visible words, 3 significant tokens
    "by the end of the war", // 6 visible words, 2 significant tokens
  ];
  const obs = p.observe(cases.map((after, i) => rev({ kind: "qa", front: `Q${i}?`, back: long }, { kind: "qa", front: `Q${i}?`, back: after })));
  const o = find(obs, "shorter-answers");
  assert.ok(o);
  // The largest visible count among the kept answers is 6, not the largest significant-token count (3).
  assert.equal(o.rule, "Keep answers to at most 6 words.");
});

// ---- 2. prefer-kind ----------------------------------------------------------

test("four qa-to-cloze conversions with no conversion back propose cloze", () => {
  const toCloze = () => rev({ kind: "qa", front: "Q?", back: "A" }, { kind: "cloze", text: "The {{c1::treaty}} ended it." });
  const obs = p.observe([toCloze(), toCloze(), toCloze(), toCloze()]);
  const o = find(obs, "prefer-kind:cloze");
  assert.ok(o);
  assert.equal(o.count, 4);
  assert.equal(o.rule, "Prefer cloze deletions to question-and-answer cards.");
});

test("a single conversion the other way silences prefer-kind entirely", () => {
  const toCloze = () => rev({ kind: "qa", front: "Q?", back: "A" }, { kind: "cloze", text: "The {{c1::treaty}} ended it." });
  const toQa = () => rev({ kind: "cloze", text: "The {{c1::treaty}} ended it." }, { kind: "qa", front: "Q?", back: "A" });
  const obs = p.observe([toCloze(), toCloze(), toCloze(), toCloze(), toQa()]);
  assert.equal(find(obs, "prefer-kind:cloze"), undefined);
  assert.equal(find(obs, "prefer-kind:qa"), undefined);
});

// ---- 3. drop-opening ---------------------------------------------------------

test("three dropped openings propose the rule and group case-insensitively", () => {
  const drop = (front) => rev({ kind: "qa", front, back: "Ghent" }, { kind: "qa", front: "Which city ended the war?", back: "Ghent" });
  const obs = p.observe([
    drop("What is the treaty of Ghent?"),
    drop("WHAT IS THE city that ended it?"),
    drop("What Is The reason it ended?"),
  ]);
  const o = find(obs, "drop-opening:what is the");
  assert.ok(o, `expected drop-opening, got ${obs.map((x) => x.id).join(", ")}`);
  assert.equal(o.count, 3);
  assert.equal(o.rule, 'Do not open a question with "what is the".');
});

test("an opening the reader kept once is never proposed", () => {
  const drop = (front) => rev({ kind: "qa", front, back: "Ghent" }, { kind: "qa", front: "Which city ended the war?", back: "Ghent" });
  const kept = rev(
    { kind: "qa", front: "What is the treaty called?", back: "Ghent" },
    { kind: "qa", front: "What is the treaty named?", back: "Ghent" },
  );
  const obs = p.observe([drop("What is the treaty of Ghent?"), drop("What is the city?"), drop("What is the reason?"), kept]);
  assert.equal(find(obs, "drop-opening:what is the"), undefined);
});

test("two dropped openings stay silent, one below the threshold", () => {
  const drop = (front) => rev({ kind: "qa", front, back: "Ghent" }, { kind: "qa", front: "Which city ended the war?", back: "Ghent" });
  const obs = p.observe([drop("What is the treaty of Ghent?"), drop("What is the city?")]);
  assert.equal(find(obs, "drop-opening:what is the"), undefined);
});

// ---- 4. extra-field ----------------------------------------------------------

test("four cleared extra fields with none filled propose leaving it empty", () => {
  const clear = () => rev({ kind: "qa", front: "Q?", back: "A", extra: "A supporting sentence." }, { kind: "qa", front: "Q?", back: "A", extra: "" });
  const obs = p.observe([clear(), clear(), clear(), clear()]);
  const o = find(obs, "extra-field:empty");
  assert.ok(o);
  assert.equal(o.count, 4);
  assert.equal(o.rule, "Leave the extra field empty.");
});

test("four filled extra fields propose the opposite rule", () => {
  const fill = () => rev({ kind: "qa", front: "Q?", back: "A", extra: "" }, { kind: "qa", front: "Q?", back: "A", extra: "A supporting sentence." });
  const obs = p.observe([fill(), fill(), fill(), fill()]);
  const o = find(obs, "extra-field:filled");
  assert.ok(o);
  assert.equal(o.rule, "Put a supporting sentence from the highlight in the extra field.");
});

test("one fill against four clears silences the extra-field pattern", () => {
  const clear = () => rev({ kind: "qa", front: "Q?", back: "A", extra: "Note." }, { kind: "qa", front: "Q?", back: "A", extra: "" });
  const fill = () => rev({ kind: "qa", front: "Q?", back: "A", extra: "" }, { kind: "qa", front: "Q?", back: "A", extra: "Note." });
  const obs = p.observe([clear(), clear(), clear(), clear(), fill()]);
  assert.equal(find(obs, "extra-field:empty"), undefined);
  assert.equal(find(obs, "extra-field:filled"), undefined);
});

// ---- 5. instruction ----------------------------------------------------------

test("three rewrites with the same instruction propose it, normalizing case, space and punctuation", () => {
  const ask = (instruction) =>
    rev({ kind: "qa", front: "Q?", back: "A long answer here" }, { kind: "qa", front: "Q?", back: "Short" }, { via: "rewrite", instruction });
  const obs = p.observe([ask("Make the answer shorter"), ask("make  the   answer shorter!"), ask("  MAKE THE ANSWER SHORTER.  ")]);
  const o = find(obs, "instruction:make the answer shorter");
  assert.ok(o, `expected instruction observation, got ${obs.map((x) => x.id).join(", ")}`);
  assert.equal(o.count, 3);
  assert.equal(o.rule, "Make the answer shorter.");
});

test("an instruction under eight characters is too thin to become a rule", () => {
  const ask = (instruction) =>
    rev({ kind: "qa", front: "Q?", back: "A long answer here" }, { kind: "qa", front: "Q?", back: "Short" }, { via: "rewrite", instruction });
  const obs = p.observe([ask("shorter"), ask("shorter"), ask("shorter"), ask("shorter")]);
  assert.equal(obs.filter((o) => o.pattern === "instruction").length, 0);
});

test("a hand edit carrying an instruction string is not a rewrite", () => {
  const ask = (instruction) =>
    rev({ kind: "qa", front: "Q?", back: "A long answer here" }, { kind: "qa", front: "Q?", back: "Short" }, { via: "edit", instruction });
  const obs = p.observe([ask("Make the answer shorter"), ask("Make the answer shorter"), ask("Make the answer shorter")]);
  assert.equal(obs.filter((o) => o.pattern === "instruction").length, 0);
});

// ---- shared behaviour --------------------------------------------------------

test("a revision that changed nothing contributes to nothing", () => {
  const same = () => rev({ kind: "qa", front: "Q?", back: words(9) }, { kind: "qa", front: "Q?", back: words(9) });
  const obs = p.observe([same(), same(), same(), same(), same()]);
  assert.deepEqual(obs, []);
});

test("evidence is newest first, capped at four, in the rendered card shape", () => {
  const obs = p.observe([shorten(20, 3), shorten(20, 4), shorten(20, 5), shorten(20, 6), shorten(20, 7), shorten(20, 8)]);
  const o = find(obs, "shorter-answers");
  assert.ok(o);
  assert.equal(o.count, 6);
  assert.equal(o.evidence.length, 4);
  // The last revision built is the newest, so its answer (8 words) leads.
  assert.match(o.evidence[0], /^qa \| What is the treaty\? \| alpha0 .*  →  qa \| What is the treaty\? \| alpha0 /);
  assert.ok(o.evidence[0].includes("alpha7"), "newest revision kept eight words");
  assert.ok(o.evidence[3].includes(" →  qa | What is the treaty? | alpha0 alpha1 alpha2 alpha3 alpha4"));
});

test("cloze evidence renders as cloze | text", () => {
  const toCloze = (n) =>
    rev({ kind: "qa", front: `Q${n}?`, back: "A" }, { kind: "cloze", text: `The {{c1::treaty}} number ${n}.` });
  const obs = p.observe([toCloze(1), toCloze(2), toCloze(3), toCloze(4)]);
  const o = find(obs, "prefer-kind:cloze");
  assert.ok(o);
  assert.equal(o.evidence[0], "qa | Q4? | A  →  cloze | The {{c1::treaty}} number 4.");
});

test("ids are stable across two runs over the same input", () => {
  const input = [
    shorten(20, 6),
    shorten(20, 7),
    shorten(20, 5),
    shorten(20, 8),
    rev({ kind: "qa", front: "Q?", back: "A", extra: "Note." }, { kind: "qa", front: "Q?", back: "A", extra: "" }),
  ];
  const a = p.observe(input).map((o) => o.id);
  const b = p.observe(input).map((o) => o.id);
  assert.deepEqual(a, b);
  assert.deepEqual(a, ["shorter-answers"]);
});

test("a custom threshold from opts is honoured", () => {
  const input = [shorten(20, 6), shorten(20, 7)];
  assert.equal(find(p.observe(input), "shorter-answers"), undefined);
  const o = find(p.observe(input, { thresholds: { "shorter-answers": 2 } }), "shorter-answers");
  assert.ok(o);
  assert.equal(o.count, 2);
});

test("observations are ordered by count descending, then by id", () => {
  const revisions = [];
  // Six shortenings, four clearings of the extra field, four conversions to cloze.
  for (let i = 0; i < 6; i++) revisions.push(shorten(20, 6));
  for (let i = 0; i < 4; i++)
    revisions.push(rev({ kind: "qa", front: "Q?", back: "A", extra: "Note." }, { kind: "qa", front: "Q?", back: "A", extra: "" }));
  for (let i = 0; i < 4; i++)
    revisions.push(rev({ kind: "qa", front: "Q?", back: "A" }, { kind: "cloze", text: "The {{c1::treaty}} ended it." }));
  const obs = p.observe(revisions);
  assert.deepEqual(
    obs.map((o) => [o.id, o.count]),
    [
      ["shorter-answers", 6],
      ["extra-field:empty", 4],
      ["prefer-kind:cloze", 4],
    ],
  );
});

test("every observation carries a one-sentence summary in the second person", () => {
  const revisions = [];
  for (let i = 0; i < 4; i++) revisions.push(shorten(20, 6));
  for (let i = 0; i < 4; i++)
    revisions.push(rev({ kind: "qa", front: "Q?", back: "A", extra: "Note." }, { kind: "qa", front: "Q?", back: "A", extra: "" }));
  for (const o of p.observe(revisions)) {
    assert.match(o.summary, /^You /, `summary not second person: ${o.summary}`);
    assert.match(o.summary, /\.$/, `summary not a sentence: ${o.summary}`);
    assert.match(o.rule, /\.$/, `rule missing its period: ${o.rule}`);
    assert.ok(o.evidence.length > 0 && o.evidence.length <= 4);
  }
});
