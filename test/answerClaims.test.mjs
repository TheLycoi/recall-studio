// Run with: npm test  (bundles src/answerClaims.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let ac;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "answerClaims.mjs");
  await build({ entryPoints: ["src/answerClaims.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  ac = await import(pathToFileURL(out).href);
});

// ---- splitClaims

test("splitClaims splits prose on sentence ends", () => {
  const claims = ac.splitClaims("Receptors bind ligands with high affinity. Albumin binds drugs without transducing. Only a receptor transduces a signal.");
  assert.deepEqual(claims, [
    "Receptors bind ligands with high affinity.",
    "Albumin binds drugs without transducing.",
    "Only a receptor transduces a signal.",
  ]);
});

test("splitClaims splits on ! and ? as well as ., and on a digit starting the next sentence", () => {
  const claims = ac.splitClaims("So is albumin a receptor, or a reversible carrier? It binds drugs but transduces no signal whatever! 12 studies report the same affinity constant.");
  assert.deepEqual(claims, [
    "So is albumin a receptor, or a reversible carrier?",
    "It binds drugs but transduces no signal whatever!",
    "12 studies report the same affinity constant.",
  ]);
});

test("splitClaims does not split on e.g., i.e., vs., etc., Fig. or Eq.", () => {
  assert.deepEqual(
    ac.splitClaims("Plasma proteins, e.g. albumin, bind drugs reversibly across the circulation."),
    ["Plasma proteins, e.g. albumin, bind drugs reversibly across the circulation."],
  );
  assert.deepEqual(
    ac.splitClaims("The bound fraction, i.e. Drug bound to albumin, is pharmacologically inactive in plasma."),
    ["The bound fraction, i.e. Drug bound to albumin, is pharmacologically inactive in plasma."],
  );
  assert.deepEqual(
    ac.splitClaims("Receptors vs. Plasma proteins is the distinction the lecture draws about signal transduction."),
    ["Receptors vs. Plasma proteins is the distinction the lecture draws about signal transduction."],
  );
  // `etc.` ends a list, so a capital after it starts a new sentence: this one splits.
  assert.deepEqual(
    ac.splitClaims("Binding, transduction and receptor desensitisation etc. Describe the receptor lifecycle in the deck."),
    ["Binding, transduction and receptor desensitisation etc.", "Describe the receptor lifecycle in the deck."],
  );
  // A lowercase continuation after `etc.` is the same sentence running on.
  assert.deepEqual(
    ac.splitClaims("Binding, transduction, desensitisation etc. and so on through the receptor lifecycle."),
    ["Binding, transduction, desensitisation etc. and so on through the receptor lifecycle."],
  );
  assert.deepEqual(
    ac.splitClaims("Affinity rises with occupancy, see Fig. 3 in the receptor pharmacology lecture."),
    ["Affinity rises with occupancy, see Fig. 3 in the receptor pharmacology lecture."],
  );
  assert.deepEqual(
    ac.splitClaims("Impulse equals the change in momentum, given by Eq. 4 of the kinematics deck."),
    ["Impulse equals the change in momentum, given by Eq. 4 of the kinematics deck."],
  );
});

// Each first half below carries four or more significant tokens on purpose: a
// thinner one is dropped by MIN_TOKENS, which would look like a failure to
// split even once the split is right.
test("splitClaims splits after a terminator followed by a closing quote, keeping the closer with the first sentence", () => {
  assert.deepEqual(
    ac.splitClaims('The pharmacology author calls this the "therapeutic window." Beyond it toxicity rises sharply in most patients.'),
    ['The pharmacology author calls this the "therapeutic window."', "Beyond it toxicity rises sharply in most patients."],
  );
  assert.deepEqual(
    ac.splitClaims("The pharmacology author calls this the \u201ctherapeutic window.\u201d Beyond it toxicity rises sharply in most patients."),
    ["The pharmacology author calls this the \u201ctherapeutic window.\u201d", "Beyond it toxicity rises sharply in most patients."],
  );
});

test("splitClaims splits after a terminator followed by a closing paren that closes an aside opened earlier in the same sentence", () => {
  assert.deepEqual(
    ac.splitClaims("Receptor occupancy saturates at the higher dose (see the deck.) Toxicity rises sharply beyond that window."),
    ["Receptor occupancy saturates at the higher dose (see the deck.)", "Toxicity rises sharply beyond that window."],
  );
});

test("splitClaims splits an abbreviation-shaped word ending, where the abbreviation is part of a longer word", () => {
  assert.deepEqual(
    ac.splitClaims("The investigator recorded trial answer was no. The trial continued at the same escalating dose."),
    ["The investigator recorded trial answer was no.", "The trial continued at the same escalating dose."],
  );
  assert.deepEqual(
    ac.splitClaims("The effect on heart rate was minimal. Dosing continued unchanged for a week."),
    ["The effect on heart rate was minimal.", "Dosing continued unchanged for a week."],
  );
  // The real abbreviations, preceded by a non-letter or start of text, still hold.
  assert.deepEqual(
    ac.splitClaims("Smith et al. showed the effect on receptor occupancy in plasma."),
    ["Smith et al. showed the effect on receptor occupancy in plasma."],
  );
  assert.deepEqual(
    ac.splitClaims("The bound fraction rises, see e.g. albumin and globulin binding in plasma."),
    ["The bound fraction rises, see e.g. albumin and globulin binding in plasma."],
  );
});

test("splitClaims does not split on an initial, a single capital letter before a period", () => {
  assert.deepEqual(
    ac.splitClaims("The affinity constant was first reported by A. V. Hill for oxygen binding curves."),
    ["The affinity constant was first reported by A. V. Hill for oxygen binding curves."],
  );
});

test("splitClaims does not split a decimal number", () => {
  assert.deepEqual(
    ac.splitClaims("The sprinter reaches 3.5 m/s within the first two strides of the acceleration phase."),
    ["The sprinter reaches 3.5 m/s within the first two strides of the acceleration phase."],
  );
});

test("splitClaims does not split inside parentheses", () => {
  assert.deepEqual(
    ac.splitClaims("Velocity is a vector (change in position. Speed and direction both matter) across the movement."),
    ["Velocity is a vector (change in position. Speed and direction both matter) across the movement."],
  );
});

test("splitClaims makes each markdown list item one claim, with the marker stripped", () => {
  const claims = ac.splitClaims(
    ["- Receptors bind ligands with high affinity", "* Albumin binds drugs without transducing", "1. Only a receptor transduces a signal"].join("\n"),
  );
  assert.deepEqual(claims, [
    "Receptors bind ligands with high affinity",
    "Albumin binds drugs without transducing",
    "Only a receptor transduces a signal",
  ]);
});

test("splitClaims keeps a two-sentence list item as one claim", () => {
  const claims = ac.splitClaims("- Receptors bind ligands with high affinity. Only a receptor transduces a signal.");
  assert.deepEqual(claims, ["Receptors bind ligands with high affinity. Only a receptor transduces a signal."]);
});

test("splitClaims strips emphasis, backticks and wikilinks to their display text", () => {
  assert.deepEqual(
    ac.splitClaims("**Receptors** bind *ligands* with _high_ affinity and `transduce` a signal."),
    ["Receptors bind ligands with high affinity and transduce a signal."],
  );
  assert.deepEqual(
    ac.splitClaims("A [[Receptors|receptor]] transduces a signal, unlike a [[Plasma Proteins]] binder."),
    ["A receptor transduces a signal, unlike a Plasma Proteins binder."],
  );
});

test("splitClaims drops a heading line rather than checking it", () => {
  const claims = ac.splitClaims(["## Receptors and plasma proteins", "Only a receptor transduces a signal after binding."].join("\n"));
  assert.deepEqual(claims, ["Only a receptor transduces a signal after binding."]);
});

test("splitClaims drops claims with fewer than four significant tokens", () => {
  assert.deepEqual(ac.splitClaims("Yes."), []);
  assert.deepEqual(ac.splitClaims("See below."), []);
  // The short answer is dropped, the substantive sentence is kept.
  assert.deepEqual(
    ac.splitClaims("Yes. Only a receptor transduces a signal after binding its ligand."),
    ["Only a receptor transduces a signal after binding its ligand."],
  );
});

test("splitClaims trims whitespace, returns no empty strings and preserves order", () => {
  const claims = ac.splitClaims("   Receptors bind ligands with high affinity.   \n\n   Only a receptor transduces a signal.   \n");
  assert.deepEqual(claims, ["Receptors bind ligands with high affinity.", "Only a receptor transduces a signal."]);
  for (const c of claims) assert.ok(c.length > 0 && c === c.trim(), JSON.stringify(c));
});

test("splitClaims returns nothing for an empty or whitespace answer", () => {
  assert.deepEqual(ac.splitClaims(""), []);
  assert.deepEqual(ac.splitClaims("   \n\t  \n "), []);
});

// ---- verifyClaims

const unit = (id, text) => ({
  id,
  notePath: `wiki/concepts/${id}.md`,
  noteTitle: id,
  pdfBasename: null,
  target: null,
  page: null,
  text,
  kind: "claim",
  classCodes: [],
});

const UNITS = [
  unit("Receptors", "Receptors bind ligands with high affinity and transduce a signal into the cell"),
  unit("Plasma Proteins", "Albumin binds drugs reversibly but does not transduce a signal"),
  unit("Kinematics", "Velocity is the change in position in a given change in time, a vector with speed and direction"),
];

test("verifyClaims marks a verbatim claim supported and carries the best unit", () => {
  const [v] = ac.verifyClaims(["Receptors bind ligands with high affinity and transduce a signal into the cell"], UNITS);
  assert.equal(v.status, "supported");
  assert.equal(v.best.id, "Receptors");
  assert.equal(v.score, 1);
});

test("verifyClaims marks a strongly overlapping paraphrase supported", () => {
  const [v] = ac.verifyClaims(["Velocity is a vector: the change in position over a given change in time, carrying both speed and direction"], UNITS);
  assert.equal(v.status, "supported", `scored ${v.score}`);
  assert.equal(v.best.id, "Kinematics");
});

test("verifyClaims marks an unrelated claim unmatched", () => {
  const [v] = ac.verifyClaims(["Conduct disorder involves persistent disregard for the rights of others"], UNITS);
  assert.equal(v.status, "unmatched");
  assert.ok(v.score < 0.6, `score ${v.score}`);
});

test("verifyClaims never alters the claims and preserves their order", () => {
  const claims = ["Albumin binds drugs reversibly but does not transduce a signal", "Conduct disorder involves disregard for others"];
  const verdicts = ac.verifyClaims(claims, UNITS);
  assert.deepEqual(verdicts.map((v) => v.text), claims);
  assert.deepEqual(verdicts.map((v) => v.status), ["supported", "unmatched"]);
});

test("verifyClaims with no units marks every claim unmatched with score zero", () => {
  const verdicts = ac.verifyClaims(["Receptors bind ligands with high affinity and transduce a signal"], []);
  assert.deepEqual(verdicts, [{ text: "Receptors bind ligands with high affinity and transduce a signal", status: "unmatched", score: 0, best: null }]);
});

test("verifyClaims of nothing is nothing", () => {
  assert.deepEqual(ac.verifyClaims([], UNITS), []);
});

// ---- checkClaims

test("checkClaims splits then verifies in one call", () => {
  const answer = "Receptors bind ligands with high affinity and transduce a signal into the cell. Conduct disorder involves persistent disregard for others.";
  const verdicts = ac.checkClaims(answer, UNITS);
  assert.equal(verdicts.length, 2);
  assert.deepEqual(verdicts.map((v) => v.status), ["supported", "unmatched"]);
  assert.deepEqual(
    verdicts.map((v) => v.text),
    ac.splitClaims(answer),
  );
});

test("checkClaims of an empty answer is nothing", () => {
  assert.deepEqual(ac.checkClaims("", UNITS), []);
});

// ---- supportedBy: titles, and a sentence that joins two passages (A4) ----

const PK = [
  unit("Half-life", "Elimination half-life is the time for plasma concentration to fall by half"),
  unit("Clearance", "Clearance measures the volume of plasma cleared of drug per unit time"),
  unit("Kinematics", "Velocity is the change in position over time, a vector with speed and direction"),
];

test("supportedBy passes a sentence synthesized from two passages that neither states alone", () => {
  const claim = "Half-life depends on clearance: the time for plasma concentration to fall by half grows as the volume cleared per unit time shrinks.";
  const got = ac.supportedBy(claim, PK);
  assert.equal(got.supported, true, `scored ${got.score}`);
  assert.ok(got.score >= 0.6, `pair score ${got.score}`);
  // The best single passage is still the one reported.
  assert.ok(["Half-life", "Clearance"].includes(got.best.id));
  const [v] = ac.verifyClaims([claim], PK);
  assert.equal(v.status, "supported");
});

test("supportedBy leaves a sentence drawing on none of the passages unmatched", () => {
  const got = ac.supportedBy("Conduct disorder involves persistent disregard for the rights of others", PK);
  assert.equal(got.supported, false);
});

test("supportedBy passes a sentence one passage states, on the single-passage test", () => {
  const got = ac.supportedBy("Velocity is the change in position over time, a vector with speed and direction", PK);
  assert.equal(got.supported, true);
  assert.equal(got.score, 1);
  assert.equal(got.best.id, "Kinematics");
});

test("supportedBy counts a passage's note title as part of it", () => {
  const units = [unit("Bioavailability", "the dose fraction reaching circulation unchanged")];
  // Five words: the short-claim rule wants every one, and "bioavailability" is only in the title.
  const got = ac.supportedBy("Bioavailability is the dose fraction reaching circulation", units);
  assert.equal(got.supported, true);
  assert.equal(got.best, units[0]);
});

test("supportedBy does not let a second passage adding one word carry a sentence over the bar", () => {
  const units = [unit("Note", "alpha beta gamma delta epsilon"), unit("Other", "alpha beta gamma delta zeta")];
  // The union holds 6 of 10 words, exactly the bar, but the second passage
  // adds only "zeta" and the first only "epsilon" beyond what they share.
  const got = ac.supportedBy("alpha beta gamma delta epsilon zeta theta iota kappa lambda", units);
  assert.equal(got.supported, false);
  assert.equal(got.score, 0.5);
});

test("supportedBy pairs the top passage with the one adding the words it lacks, not the runner-up that overlaps it (S5)", () => {
  // A and B share four words, so each adds only one the other lacks; C adds
  // two A lacks. A+C holds 7 of 10 words and qualifies; A+B would not.
  const A = unit("A", "alpha beta gamma delta epsilon");
  const B = unit("B", "alpha beta gamma delta zeta");
  const C = unit("C", "zeta theta");
  const claim = "alpha beta gamma delta epsilon zeta theta iota kappa lambda";
  const withB = ac.supportedBy(claim, [A, B, C]);
  assert.equal(withB.supported, true, `with B scored ${withB.score}`);
  assert.equal(withB.score, 0.7);
  const withoutB = ac.supportedBy(claim, [A, C]);
  assert.equal(withoutB.supported, true, `without B scored ${withoutB.score}`);
  assert.equal(withoutB.score, 0.7);
});

test("supportedBy tries the second-best passage as the anchor when the top one's best pair fails", () => {
  // A tops at 5 hits, but X and B each add only one word A lacks, so no pair
  // with A passes the own-words rule. X (4 hits) is next: B adds three words
  // X lacks, X adds four B lacks, and together they hold 7 of 10.
  const A = unit("A", "alpha beta gamma delta epsilon");
  const B = unit("B", "alpha beta zeta");
  const X = unit("X", "gamma delta epsilon theta");
  const claim = "alpha beta gamma delta epsilon zeta theta iota kappa lambda";
  const got = ac.supportedBy(claim, [A, B, X]);
  assert.equal(got.supported, true, `scored ${got.score}`);
  assert.equal(got.score, 0.7);
  assert.equal(got.best, A);
});

test("supportedBy keeps the short-claim rule: one word missing everywhere fails a short sentence", () => {
  const units = [unit("Note", "albumin binds drugs"), unit("Other", "receptors transduce signals")];
  // Four words, three of them in one passage: 0.75 would pass a long claim's bar, not a short one's.
  assert.equal(ac.supportedBy("Albumin binds drugs reversibly", units).supported, false);
});

test("supportedBy with nothing to search is unsupported at score zero", () => {
  assert.deepEqual(ac.supportedBy("Receptors bind ligands with high affinity", []), { supported: false, score: 0, best: null });
});
