/**
 * Assembly for an Ask answer, and the sources shown under it.
 *
 * The model returns prose and the evidence numbers it drew on. This file turns
 * that into what the reader sees: the answer, then the one or two notes behind
 * it as links they can click.
 *
 * Grounding is not done here by re-reading the model's words. It is done in
 * the prompt — answer from the evidence given and say so when it does not
 * cover the question — which is where the wiki upstream
 * (gd4ai/obsidian-llm-wiki, `assembleWikiContext`) puts it too. The check that
 * remains is the one worth keeping: a citation must point at a piece of
 * evidence that exists, so the link under an answer always opens a real note.
 *
 * The verification that used to live here — every quote matched character by
 * character against its evidence, any sentence whose quote was not found
 * deleted — was strict enough to be its own failure mode. A faithful sentence
 * lost because the model tidied a quote is a worse answer than the sentence,
 * and the evidence wall it justified made the reply harder to read than the
 * notes it came from.
 *
 * Pure: imports two types, so `test/askCheck.test.mjs` can bundle it without
 * an Obsidian runtime or a backend.
 */
import type { AskDraft } from "./schemas";
import type { AskEvidenceIn } from "./prompt";

/** One note behind an answer: which evidence, and what it contributed. */
export interface AnswerSource {
  n: number;
  why: string;
}

/** What the answer was built from, for the line and the links under it. */
export interface GroundingReport {
  coverage: "full" | "partial" | "none";
  /** The evidence the answer actually drew on, in the model's order, capped. */
  sources: AnswerSource[];
  /** Citations the model gave that pointed at no evidence. */
  dropped: number;
  /**
   * The answer came from the model's general knowledge, not the notes.
   *
   * The reader is warned above it. Upstream does the same thing rather than
   * refusing to answer (gd4ai/obsidian-llm-wiki, `assembleWikiContext`): a
   * useful answer the reader knows to check beats no answer, as long as the
   * label is impossible to miss.
   */
  fromGeneralKnowledge: boolean;
  /** Sentence check (src/answerClaims.ts): how many sentences the answer had and which matched no passage. Absent when the check did not run. */
  claims?: { total: number; unmatched: string[] };
}

/** How many sources are shown under an answer. Two is enough to confirm one; more is a wall. */
export const MAX_SOURCES = 2;

/** Shown when the model answered with nothing at all. */
const NOTHING_SAID = "The model returned an empty answer. Ask again, or rephrase the question.";

/**
 * Assemble the answer and the sources under it.
 *
 * A citation outside `1…evidence.length` is dropped and counted: the model
 * naming evidence 9 of 6 would otherwise render a link that opens nothing.
 * Sources are capped at `MAX_SOURCES` because the point is to confirm the
 * answer, not to reprint the search results — the reader who wants the rest
 * can open the note.
 */
export function checkAnswer(draft: AskDraft, evidence: AskEvidenceIn[]): { answer: string; report: GroundingReport } {
  const max = evidence.length;
  const answer = draft.answer.trim();

  const seen = new Set<number>();
  const sources: AnswerSource[] = [];
  let dropped = 0;
  for (const u of draft.used) {
    if (!Number.isInteger(u.n) || u.n < 1 || u.n > max) {
      dropped++;
      continue;
    }
    if (seen.has(u.n)) continue;
    seen.add(u.n);
    if (sources.length < MAX_SOURCES) sources.push({ n: u.n, why: u.why.trim() });
  }

  // A general-knowledge answer names no source: it did not come from one.
  // Trusting the flag over the citations would let a model both cite a note
  // and disclaim it, and the reader would see a source under a warning.
  const fromGeneralKnowledge = draft.from_general_knowledge && sources.length === 0;

  // The model claimed sources and not one of them checked out. Whatever it
  // says about its own coverage, nothing in the notes stands behind this
  // answer, so it must not be labelled as answered from them.
  const allCitationsDropped = draft.used.length > 0 && sources.length === 0;

  return {
    answer: answer.length > 0 ? answer : NOTHING_SAID,
    report: {
      coverage: answer.length > 0 && !allCitationsDropped ? draft.coverage : "none",
      sources,
      dropped,
      fromGeneralKnowledge,
    },
  };
}

/**
 * The answer for a question retrieval found nothing for. No model is called:
 * there is nothing for it to read, and a model with no evidence is exactly the
 * situation that invents an answer.
 */
export function noEvidenceAnswer(question: string): { answer: string; report: GroundingReport } {
  return {
    answer: `Your notes don't cover this: nothing under the topic notes matches “${question.trim()}”. Digest the lecture that covers it, then ask again.`,
    report: { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false },
  };
}

/**
 * The answer when the topic folder holds no indexable note at all.
 *
 * Distinct from `noEvidenceAnswer`: that one says the notes do not cover a
 * question, which is a statement about the vault. This one says the search
 * never read a note, which is a statement about a setting — reporting it as
 * missing coverage sends the reader off to digest a lecture they may already
 * have digested somewhere the search is not looking.
 */
export function emptyIndexAnswer(folderPrefix: string): { answer: string; report: GroundingReport } {
  const folder = folderPrefix.replace(/\/+$/, "");
  return {
    answer:
      `No notes were searched: the topic notes folder “${folder}” has no markdown notes in this vault. ` +
      `Point “Topic notes folder” in WikiLM's settings at the folder your notes are in, then ask again.`,
    report: { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false },
  };
}

/** The warning shown above an answer the notes did not supply. */
export const VERIFY_BANNER = "Not from your notes — answered from general knowledge. Verify this before relying on it.";

/**
 * The one line under an answer: how well the notes covered it.
 *
 * Short by design. The old line counted sentences kept, sentences removed and
 * quotes verified — numbers that only meant anything if you knew what the
 * checker did. Coverage is the part a reader can act on: "partial" means go
 * and look, "none" means the notes do not have it.
 */
export function renderGroundingLine(r: GroundingReport): string {
  const coverage = r.fromGeneralKnowledge
    ? "General knowledge, not your notes"
    : r.coverage === "full"
      ? "Answered from your notes"
      : r.coverage === "partial"
        ? "Partly answered from your notes"
        : "Not in your notes";
  const parts = [coverage];
  if (r.dropped > 0) parts.push(`${r.dropped} bad ${r.dropped === 1 ? "citation" : "citations"} dropped`);
  // "Matched no passage", never "wrong": the check is token overlap
  // (src/answerClaims.ts), and a faithful synthesis of two passages can fail a
  // single-passage bar. The count is the reader's cue to look, not a verdict.
  const unmatched = r.claims?.unmatched.length ?? 0;
  if (r.claims && unmatched > 0) {
    parts.push(`${unmatched} of ${r.claims.total} ${r.claims.total === 1 ? "sentence" : "sentences"} matched no passage`);
  }
  return parts.join(" · ");
}

/**
 * The sentences to list beneath the grounding line, so the panel makes one
 * call and cannot disagree with the count on the line about what was found.
 *
 * Empty when every sentence matched or the check did not run — there is
 * nothing to show, and an empty heading over an empty list is noise.
 */
export function renderUnmatchedClaims(r: GroundingReport): string[] {
  return r.claims ? [...r.claims.unmatched] : [];
}

/**
 * The inbox item an answer becomes: the answer itself, then every passage it
 * rested on, each with its note and page. The whole thing is the highlight
 * text, so the card writer reads the answer in full and the cloze grounding
 * check (src/lint.ts, `ungroundedClozes`) can find a deletion in either the
 * answer's words or a passage's.
 */
export function renderAnswerHighlight(answer: string, sources: Array<{ noteTitle: string; page: number | null; text: string }>): string {
  const lines = [answer.trim()];
  const rows = sources.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() })).filter((s) => s.text);
  if (rows.length > 0) {
    lines.push("", "Sources:");
    for (const s of rows) lines.push(`${s.noteTitle}${s.page ? `, p.${s.page}` : ""}: ${s.text}`);
  }
  return lines.join("\n");
}

/**
 * What to tell the card writer when an answer is sent to the inbox: the
 * question it answered, and what the model said each source contributed
 * ("defines the term", "gives the formula"), so cards aim at the question
 * and two passages do not become two cards on one fact.
 */
export function renderAnswerInstruction(question: string, sources: Array<{ noteTitle: string; why: string }>): string {
  const lines = [
    "The reader asked their notes this question, and the text is the answer they were given, with the passages it rested on listed under it.",
    `Question: ${question.trim()}`,
  ];
  const said = sources.filter((s) => s.why.trim());
  if (said.length > 0) {
    lines.push("What each source contributed:");
    for (const s of said) lines.push(`- ${s.noteTitle}: ${s.why.trim()}`);
  }
  lines.push(
    "Card what answers the question. Every card is grounded in the passages: where the answer goes further than they do, follow the passages. Each card is focused on one thing, precise about what it asks, answered the same way every time, and demands real recall: not a yes/no, and not a blank the shape of the sentence fills in.",
  );
  return lines.join("\n");
}

/** One source as it is shown under an answer, and sent to the inbox from it. */
export interface PickedSource<U = unknown> {
  unit: U;
  why: string;
}

/**
 * The sources behind an answer: the ones the model named, or the best-ranked
 * passage standing in when it named none.
 *
 * Shared by the source rows and the inbox button so the two can never
 * disagree about what an answer rested on.
 *
 * The stand-in must not appear when the model named sources that all failed
 * verification: there is no honest source to show, and showing one would
 * dress an unsupported answer in a citation the model never made.
 */
export function pickSources<U>(evidence: U[], report: GroundingReport): Array<PickedSource<U>> {
  const picked = report.sources
    .map((s) => ({ unit: evidence[s.n - 1], why: s.why }))
    .filter((p): p is PickedSource<U> => !!p.unit);
  if (picked.length > 0) return picked;
  const allCitationsDropped = report.dropped > 0 && report.sources.length === 0;
  if (report.coverage === "none" || allCitationsDropped || !evidence[0]) return [];
  return [{ unit: evidence[0], why: "" }];
}
