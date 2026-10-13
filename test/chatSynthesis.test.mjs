// Run with: npm test
//
// The synthesis-verification contract for selected-source chat.
//
// The extractive check (test/reviewChat.test.mjs) only ever accepts a claim
// whose words appear character for character in a verified quote. This file
// covers the one relaxation the repair allows: a supported paraphrase may be
// kept, but ONLY after an independent, evidence-only model check approves it,
// and never on the model's assurance alone — the quote stays mandatory and is
// still checked literally, the citation still has to name real evidence the
// verifier agrees with, and a contradiction or a missing verdict falls back to
// the extractive refusal. The last block reads src/llm.ts as text and checks
// the provider wiring for the two new LlmClient methods.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let rc;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-chat-synth-test-"));
  const out = path.join(dir, "reviewChat.mjs");
  await build({ entryPoints: ["src/reviewChat.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  rc = await import(pathToFileURL(out).href);
});

const LLM = () => readFileSync("src/llm.ts", "utf8");

const ev = (n, over = {}) => ({ n, title: "A", page: null, path: "notes/a.md", line: 1, text: "", ...over });
const claim = (text, cited) => ({ text, kind: "claim", cited });
const draft = (coverage, quotes, sentences) => ({ coverage, quotes, sentences });
const verification = (claims) => ({ claims });

const EVIDENCE = [
  ev(1, { text: "Receptors bind ligands with high affinity." }),
  ev(2, { text: "Albumin binds drugs but does not transduce a signal.", line: 2 }),
];

// A paraphrase: the meaning is in evidence 1, the words are not.
const PARAPHRASE = "Ligands are bound by receptors with high affinity.";
const LITERAL_QUOTE = [{ n: 1, quote: "Receptors bind ligands with high affinity." }];
const PARAPHRASE_DRAFT = draft("full", LITERAL_QUOTE, [claim(PARAPHRASE, [1])]);

// --- supported paraphrase ----------------------------------------------------

test("a supported paraphrase is kept when the verifier approves it", () => {
  const v = verification([{ index: 0, supported: true, cited: [1] }]);
  const { answer, report } = rc.checkChatAnswer(PARAPHRASE_DRAFT, EVIDENCE, v);
  assert.equal(answer, `${PARAPHRASE} [1]`);
  assert.equal(report.kept, 1);
  assert.equal(report.refused, false);
  assert.equal(report.paraphrases, 1);
});

test("the paraphrase is refused with no verification: extractive stays the default", () => {
  const { answer, report } = rc.checkChatAnswer(PARAPHRASE_DRAFT, EVIDENCE);
  assert.equal(report.refused, true);
  assert.equal(answer, rc.CHAT_REFUSAL);
  assert.equal(report.paraphrases, 0);
});

test("an exact quote keeps its claim even when the verifier is silent about it", () => {
  // Exact quotes are the strongest evidence: the verifier only extends reach
  // to paraphrases, it never withdraws a claim the source states verbatim.
  const d = draft("full", LITERAL_QUOTE, [claim("Receptors bind ligands with high affinity.", [1])]);
  const { answer, report } = rc.checkChatAnswer(d, EVIDENCE, verification([{ index: 0, supported: false, cited: [] }]));
  assert.equal(answer, "Receptors bind ligands with high affinity. [1]");
  assert.equal(report.refused, false);
  assert.equal(report.paraphrases, 0);
});

// --- the verifier never overrides a forged quote -----------------------------

test("a forged quote is rejected even when the verifier approves the claim", () => {
  const forged = draft("full", [{ n: 1, quote: "Receptors bind enzymes with low affinity." }], [claim(PARAPHRASE, [1])]);
  const v = verification([{ index: 0, supported: true, cited: [1] }]);
  const { answer, report } = rc.checkChatAnswer(forged, EVIDENCE, v);
  assert.equal(report.quotesVerified, 0);
  assert.equal(report.quotesRejected, 1);
  assert.equal(report.kept, 0);
  assert.equal(report.refused, true);
  assert.equal(answer, rc.CHAT_REFUSAL);
});

test("a paraphrased claim with no quoted passage at all is not passed on the verdict alone", () => {
  const noQuote = draft("full", [], [claim(PARAPHRASE, [1])]);
  const v = verification([{ index: 0, supported: true, cited: [1] }]);
  const { report } = rc.checkChatAnswer(noQuote, EVIDENCE, v);
  assert.equal(report.kept, 0);
  assert.equal(report.refused, true);
});

// --- citations the verifier names --------------------------------------------

test("a claim citing a valid number the verifier did not name is removed", () => {
  // The claim leans on evidence 2, but the verifier says the support is 1: the
  // citation has to be both real and the one the check agreed to.
  const d = draft("full", LITERAL_QUOTE, [claim(PARAPHRASE, [2])]);
  const v = verification([{ index: 0, supported: true, cited: [1] }]);
  const { report } = rc.checkChatAnswer(d, EVIDENCE, v);
  assert.equal(report.kept, 0);
  assert.equal(report.refused, true);
});

test("a verifier citation that names no evidence is dropped", () => {
  const v = verification([{ index: 0, supported: true, cited: [9] }]);
  const { report } = rc.checkChatAnswer(PARAPHRASE_DRAFT, EVIDENCE, v);
  assert.equal(report.kept, 0);
  assert.equal(report.refused, true);
});

test("a verifier annotation for an out-of-range sentence index cannot salvage a claim", () => {
  const v = verification([{ index: 9, supported: true, cited: [1] }]);
  const { report } = rc.checkChatAnswer(PARAPHRASE_DRAFT, EVIDENCE, v);
  assert.equal(report.kept, 0);
  assert.equal(report.refused, true);
});

test('verification cannot silently drop part of a multi-source justification',()=>{
 const v=verification([{index:0,supported:true,cited:[1,2]}]);
 assert.equal(rc.checkChatAnswer(PARAPHRASE_DRAFT,EVIDENCE,v).report.refused,true);
});
test('mixed real and nonexistent verifier citations refuse a paraphrase',()=>{
 const v=verification([{index:0,supported:true,cited:[1,99]}]);
 assert.equal(rc.checkChatAnswer(PARAPHRASE_DRAFT,EVIDENCE,v).report.refused,true);
});
test('conflicting duplicate verdicts fail closed',()=>{
 const v=verification([{index:0,supported:false,cited:[]},{index:0,supported:true,cited:[1]}]);
 assert.equal(rc.checkChatAnswer(PARAPHRASE_DRAFT,EVIDENCE,v).report.refused,true);
});

// --- contradiction -----------------------------------------------------------

test("a claim the verifier marks unsupported is removed even with a real quote", () => {
  const v = verification([{ index: 0, supported: false, cited: [] }]);
  const { answer, report } = rc.checkChatAnswer(PARAPHRASE_DRAFT, EVIDENCE, v);
  assert.equal(report.kept, 0);
  assert.equal(report.refused, true);
  assert.equal(answer, rc.CHAT_REFUSAL);
});

test("a supported paraphrase beside a contradicted one keeps only the supported claim", () => {
  const d = draft("partial", [
    { n: 1, quote: "Receptors bind ligands with high affinity." },
    { n: 2, quote: "Albumin binds drugs but does not transduce a signal." },
  ], [
    claim(PARAPHRASE, [1]),
    claim("Albumin turns ATP into cAMP.", [2]),
  ]);
  const v = verification([
    { index: 0, supported: true, cited: [1] },
    { index: 1, supported: false, cited: [] },
  ]);
  const { answer, report } = rc.checkChatAnswer(d, EVIDENCE, v);
  assert.equal(answer, `${PARAPHRASE} [1]`);
  assert.equal(report.kept, 1);
  assert.equal(report.removed, 1);
  assert.equal(report.paraphrases, 1);
});

// --- verification schema + query bounds (pure) -------------------------------

test("the verification schema is strict and shaped as index / supported / cited", () => {
  const parsed = rc.ChatVerificationOut.safeParse({ claims: [{ index: 0, supported: true, cited: [1] }] });
  assert.equal(parsed.success, true);
  assert.equal(rc.ChatVerificationOut.safeParse({ claims: [{ index: 0, supported: true }] }).success, false);
});

test("generated search phrases are capped to five short strings", () => {
  const out = rc.boundChatQueries(["alpha one", "beta two", "gamma three", "delta four", "epsilon five", "zeta six", "eta seven"]);
  assert.equal(out.length, 5);
  assert.ok(out.every((q) => typeof q === "string"));
});

test("generated search phrases never exceed 200 characters in total", () => {
  const long = Array.from({ length: 5 }, (_, i) => `${i} `.repeat(40).trim());
  const out = rc.boundChatQueries(long);
  assert.ok(out.reduce((n, q) => n + q.length, 0) <= 200);
});

test("blank generated search phrases are dropped", () => {
  assert.deepEqual(rc.boundChatQueries(["  ", "receptors", ""]), ["receptors"]);
});

// --- provider wiring (src/llm.ts as text) ------------------------------------

test("verifySelected is a method on LlmClient routed through the backend", () => {
  const s = LLM();
  assert.match(s, /async verifySelected\(args: ChatAnswerArgs, draft: ChatAskDraft\): Promise<ChatVerification>/);
  const m = /async verifySelected\(args: ChatAnswerArgs, draft: ChatAskDraft\)[\s\S]*?\n  \}/.exec(s);
  assert.ok(m, "verifySelected body not found");
  const body = m[0];
  assert.ok(/this\.backend\(\)\.complete\(/.test(body), "does not use the configured backend");
  assert.ok(/schema:\s*ChatVerificationOut/.test(body), "does not send the strict verification schema");
  assert.ok(/system:\s*CHAT_VERIFY_SYSTEM/.test(body), "does not send the verification prompt");
  assert.equal(/tools|function_call|readFile|vault/i.test(body), false);
});

test("verifySelected validates the annotation index against the draft", () => {
  const s = LLM();
  const body = /async verifySelected\(args: ChatAnswerArgs, draft: ChatAskDraft\)[\s\S]*?\n  \}/.exec(s)[0];
  assert.ok(/Number\.isInteger\(c\.index\)/.test(body), "index is not checked for integer");
  assert.ok(/draft\.sentences\.length/.test(body), "index is not bounded to the draft");
});

test("expandChatQuery is a bounded method that sends only the question", () => {
  const s = LLM();
  assert.match(s, /async expandChatQuery\(question: string\): Promise<string\[\]>/);
  const m = /async expandChatQuery\(question: string\)[\s\S]*?\n  \}/.exec(s);
  assert.ok(m, "expandChatQuery body not found");
  const body = m[0];
  assert.ok(/this\.backend\(\)\.complete\(/.test(body), "does not use the configured backend");
  assert.ok(/schema:\s*ChatExpandOut/.test(body), "does not send the phrase schema");
  assert.ok(/system:\s*CHAT_EXPAND_SYSTEM/.test(body), "does not send the expansion prompt");
  assert.ok(/boundChatQueries\(/.test(body), "does not bound the returned phrases");
  assert.equal(/evidence|history|vault/i.test(body), false, "expansion must see only the question");
});

test("the verification and expansion prompts and schemas are exported from the pure module", () => {
  const s = readFileSync("src/reviewChat.ts", "utf8");
  assert.ok(/export const CHAT_VERIFY_SYSTEM/.test(s), "missing CHAT_VERIFY_SYSTEM");
  assert.ok(/export const CHAT_EXPAND_SYSTEM/.test(s), "missing CHAT_EXPAND_SYSTEM");
  assert.ok(/export const ChatVerificationOut/.test(s), "missing ChatVerificationOut");
  assert.ok(/export const ChatExpandOut/.test(s), "missing ChatExpandOut");
  assert.ok(s.includes("export function boundChatQueries"), "missing boundChatQueries");
});
