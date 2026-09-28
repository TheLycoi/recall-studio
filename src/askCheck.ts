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
  /**
   * The text was written by this file, not the model: a refusal, a fallback,
   * a "nothing found". It is not an answer, so it is never sent to the inbox,
   * replayed to the model as something it said, or given a route.
   */
  canned?: boolean;
}

/** How many sources are shown under an answer. Two is enough to confirm one; more is a wall. */
export const MAX_SOURCES = 2;

/** Shown when the model answered with nothing at all. */
const NOTHING_SAID = "The model returned an empty answer. Ask again, or rephrase the question.";

/**
 * Shown instead of a general-knowledge answer when the reader has turned
 * general knowledge off. The prompt may still offer the model that option
 * (it cannot know the setting when evidence survives), so the setting is
 * enforced here, on the draft, where it cannot be talked around.
 */
export function generalKnowledgeRefusal(): string {
  return "The notes don't cover this, and answering from general knowledge is off in settings.";
}

/** Options for `checkAnswer`. */
export interface CheckOptions {
  /** False turns a general-knowledge draft into `generalKnowledgeRefusal()`. Absent means allowed. */
  allowGeneralKnowledge?: boolean;
}

/**
 * Assemble the answer and the sources under it.
 *
 * A citation outside `1…evidence.length` is dropped and counted: the model
 * naming evidence 9 of 6 would otherwise render a link that opens nothing.
 * Sources are capped at `MAX_SOURCES` because the point is to confirm the
 * answer, not to reprint the search results — the reader who wants the rest
 * can open the note.
 */
export function checkAnswer(
  draft: AskDraft,
  evidence: AskEvidenceIn[],
  opts?: CheckOptions,
): { answer: string; report: GroundingReport } {
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
  // An empty draft is not one either: the banner would sit over the
  // empty-answer notice.
  const fromGeneralKnowledge = draft.from_general_knowledge && sources.length === 0 && answer.length > 0;

  // The model claimed sources and not one of them checked out. Whatever it
  // says about its own coverage, nothing in the notes stands behind this
  // answer, so it must not be labelled as answered from them.
  const allCitationsDropped = draft.used.length > 0 && sources.length === 0;

  if (fromGeneralKnowledge && opts?.allowGeneralKnowledge === false) {
    return {
      answer: generalKnowledgeRefusal(),
      report: { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false, canned: true },
    };
  }

  const report: GroundingReport = {
    coverage: answer.length > 0 && !allCitationsDropped ? draft.coverage : "none",
    sources,
    dropped,
    fromGeneralKnowledge,
  };
  if (answer.length === 0) report.canned = true;
  return { answer: answer.length > 0 ? answer : NOTHING_SAID, report };
}

/**
 * The answer for a question retrieval found nothing for. No model is called:
 * there is nothing for it to read, and a model with no evidence is exactly the
 * situation that invents an answer.
 */
export function noEvidenceAnswer(question: string): { answer: string; report: GroundingReport } {
  return {
    answer: `Your notes don't cover this: nothing under the topic notes matches “${question.trim()}”. Digest the lecture that covers it, then ask again.`,
    report: { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false, canned: true },
  };
}

/**
 * The answer when retrieval found passages and the relevance judge kept none.
 *
 * Distinct from `noEvidenceAnswer`: there, nothing shared the question's
 * words. Here `n` passages did, and the judge read them and said none answers
 * it, so "nothing matches" would be false. No model is called to draft: the
 * drafter would be reading an empty list.
 */
export function filteredOutAnswer(n: number, question: string): { answer: string; report: GroundingReport } {
  const q = question.trim();
  const found =
    n === 1
      ? `1 passage shares words with “${q}”, but it doesn't answer it.`
      : `${n} passages share words with “${q}”, but none of them answers it.`;
  return {
    answer: `${found} Try other words, or digest the lecture that covers it.`,
    report: { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false, canned: true },
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
    report: { coverage: "none", sources: [], dropped: 0, fromGeneralKnowledge: false, canned: true },
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
  // A general-knowledge answer rests on no passage: there are no citations to
  // count and no sentences checked against the notes worth reporting.
  if (r.fromGeneralKnowledge) return "General knowledge, not your notes";
  // The model says it answered from the notes, and not one of its sentences
  // matched a passage: say both, rather than let the model's word stand alone.
  const noneMatched = !!r.claims && r.claims.total > 0 && r.claims.unmatched.length === r.claims.total;
  const coverage =
    r.coverage !== "none" && noneMatched
      ? "Answered, but no sentence matched your notes"
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
 * The retrieval route to print after the grounding line, or "" for none.
 *
 * A general-knowledge report already says where the answer came from, and a
 * route label of "general knowledge" after it says it twice; a canned report
 * came from no route at all.
 */
export function routeForReport(report: GroundingReport, route: string): string {
  return report.fromGeneralKnowledge || report.canned ? "" : route;
}

/**
 * Whether an answer may be sent to the inbox.
 *
 * The contract (2026-09-27 ask cleanup plan): the model's own text, not
 * empty, that either rests on the notes or is a general-knowledge answer the
 * inbox row will label as unverified. A canned refusal is not an answer.
 */
export function canSendAnswer(report: GroundingReport, answer: string): boolean {
  if (report.canned) return false;
  if (answer.trim().length === 0) return false;
  return report.coverage !== "none" || report.fromGeneralKnowledge;
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

/** The `why` of a stand-in source: the top-ranked passage the model did not cite. */
export const STAND_IN_WHY = "top match, not cited";

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
 * A "none" or general-knowledge answer gets nothing, even if it cited a
 * passage: it says the notes do not answer the question, so no passage is
 * what it rested on.
 *
 * The stand-in must not appear when the model named sources that all failed
 * verification: there is no honest source to show, and showing one would
 * dress an unsupported answer in a citation the model never made. When it
 * does appear, its `why` says it was not cited, so the row can say so.
 */
export function pickSources<U>(evidence: U[], report: GroundingReport): Array<PickedSource<U>> {
  if (report.fromGeneralKnowledge || report.coverage === "none") return [];
  const picked = report.sources
    .map((s) => ({ unit: evidence[s.n - 1], why: s.why }))
    .filter((p): p is PickedSource<U> => !!p.unit);
  if (picked.length > 0) return picked;
  const allCitationsDropped = report.dropped > 0 && report.sources.length === 0;
  if (allCitationsDropped || !evidence[0]) return [];
  return [{ unit: evidence[0], why: STAND_IN_WHY }];
}
