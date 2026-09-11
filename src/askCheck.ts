/**
 * Assembly and grounding checks for an Ask answer.
 *
 * The model no longer writes the answer as prose with citations inside it. It
 * returns a draft — the passages it leaned on, then one sentence at a time with
 * the evidence numbers that state each one — and this file turns that draft
 * into the text the reader sees. Everything here is a rule you can check by
 * counting, in the spirit of `ungroundedClozes` in src/util.ts: a quote is kept
 * only when it is really in the evidence it claims to come from, and a claim is
 * kept only when it cites evidence that exists. Nothing trusts the prose to
 * have policed itself.
 *
 * Pure: imports `normalizePlain` and three types, so `test/askCheck.test.mjs`
 * can bundle it without an Obsidian runtime or a backend.
 */
import { normalizePlain } from "./util";
import type { AskDraft, VerifyDraft } from "./schemas";
import type { AskEvidenceIn } from "./prompt";

/** What the checks found: what was kept, what was dropped, and whether anything had to be dropped at all. */
export interface GroundingReport {
  coverage: "full" | "partial" | "none";
  kept: number;
  removed: number;
  quotesVerified: Array<{ n: number; quote: string }>;
  quotesRejected: Array<{ n: number; quote: string }>;
  cited: number[];
  verified: boolean;
}

/** Shown when every sentence the model drafted was dropped. */
const NOTHING_SUPPORTED = "Your notes don't say. None of the sentences the model drafted was supported by the evidence.";

/**
 * Check a draft against its evidence and assemble the answer.
 *
 * Quotes are verified by normalised substring: a paraphrase is rejected even
 * when its meaning is in the evidence, which is the point — the check is on the
 * words, not on the sense. Claims that cite nothing valid are removed and
 * counted, so an answer can shrink to nothing and say so.
 */
export function checkAnswer(draft: AskDraft, evidence: AskEvidenceIn[]): { answer: string; report: GroundingReport } {
  const max = evidence.length;

  const quotesVerified: Array<{ n: number; quote: string }> = [];
  const quotesRejected: Array<{ n: number; quote: string }> = [];
  for (const q of draft.quotes) {
    const needle = normalizePlain(q.quote);
    const inRange = Number.isInteger(q.n) && q.n >= 1 && q.n <= max;
    const ok = inRange && needle.length > 0 && normalizePlain(evidence[q.n - 1].text).includes(needle);
    (ok ? quotesVerified : quotesRejected).push(q);
  }

  // A `none` answer may only state what the notes do not cover; any claim it
  // carries contradicts its own coverage, so it goes.
  const noneCoverage = draft.coverage === "none";
  const kept: Array<{ text: string; cited: number[] }> = [];
  let removed = 0;
  for (const s of draft.sentences) {
    const cited = cleanCitations(s.cited, max);
    if (s.kind === "claim") {
      if (noneCoverage || cited.length === 0) {
        removed++;
        continue;
      }
      kept.push({ text: stripMarkers(s.text), cited });
      continue;
    }
    kept.push({ text: stripMarkers(s.text), cited: [] });
  }

  const answer = renderAnswer(kept);
  const empty = answer.length === 0;

  const cited = new Set<number>();
  if (!empty) for (const s of kept) for (const n of s.cited) cited.add(n);

  return {
    answer: empty ? NOTHING_SUPPORTED : answer,
    report: {
      coverage: empty ? "none" : draft.coverage,
      kept: empty ? 0 : kept.length,
      removed,
      quotesVerified,
      quotesRejected,
      cited: [...cited].sort((a, b) => a - b),
      verified: removed === 0 && quotesRejected.length === 0,
    },
  };
}

/** Citations that point at evidence that exists, each once, in order. */
function cleanCitations(cited: number[], max: number): number[] {
  const out = new Set<number>();
  for (const n of cited) if (Number.isInteger(n) && n >= 1 && n <= max) out.add(n);
  return [...out].sort((a, b) => a - b);
}

/**
 * Remove `[n]` markers the model wrote inside a sentence despite being told not
 * to, and close the gap they leave behind: the software appends the citations
 * itself, and two of them in the same sentence would be worse than none.
 */
function stripMarkers(text: string): string {
  return text
    .replace(/\[\d+\]/g, "")
    .replace(/ {2,}/g, " ")
    .replace(/\s+([.,])/g, "$1")
    .trim();
}

/** Kept sentences in order; list items start their own line so consecutive ones read as a list. */
function renderAnswer(kept: Array<{ text: string; cited: number[] }>): string {
  let out = "";
  for (const s of kept) {
    if (!s.text) continue;
    const piece = s.cited.length ? `${s.text} ${s.cited.map((n) => `[${n}]`).join("")}` : s.text;
    if (!out) out = piece;
    else out += (s.text.startsWith("- ") ? "\n" : " ") + piece;
  }
  return out.trim();
}

/**
 * Fold the verify pass's verdicts into a draft.
 *
 * An unsupported claim has its citations cleared rather than being spliced out
 * here, so `checkAnswer` stays the one place that decides what a missing
 * citation means and the one place that counts it.
 */
export function applyVerdicts(draft: AskDraft, verdicts: VerifyDraft): AskDraft {
  const unsupported = new Set<number>();
  for (const v of verdicts.verdicts) {
    if (!v.supported && Number.isInteger(v.i) && v.i >= 0 && v.i < draft.sentences.length) unsupported.add(v.i);
  }
  return {
    ...draft,
    sentences: draft.sentences.map((s, i) => (s.kind === "claim" && unsupported.has(i) ? { ...s, cited: [] } : { ...s })),
  };
}

/**
 * The answer for a question retrieval found nothing for. No model is called:
 * there is nothing for it to read, and a model with no evidence is exactly the
 * situation that invents an answer.
 */
export function noEvidenceAnswer(question: string): { answer: string; report: GroundingReport } {
  return {
    answer: `Your notes don't cover this: no highlight or claim under the topic notes matches “${question.trim()}”. Digest the lecture that covers it, then ask again.`,
    report: {
      coverage: "none",
      kept: 1,
      removed: 0,
      quotesVerified: [],
      quotesRejected: [],
      cited: [],
      verified: true,
    },
  };
}

/** One line under the answer saying what the checks did. Zero parts are left out, except "kept". */
export function renderGroundingLine(r: GroundingReport): string {
  const parts = [
    r.coverage === "full" ? "full coverage" : r.coverage === "partial" ? "partial coverage" : "no coverage",
    `${r.kept} ${plural(r.kept, "sentence")} kept`,
  ];
  if (r.removed > 0) parts.push(`${r.removed} unsupported removed`);
  if (r.quotesVerified.length > 0) parts.push(`${r.quotesVerified.length} ${plural(r.quotesVerified.length, "quote")} verified`);
  if (r.quotesRejected.length > 0) parts.push(`${r.quotesRejected.length} ${plural(r.quotesRejected.length, "quote")} rejected`);
  return `Grounding: ${parts.join(" · ")}`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
