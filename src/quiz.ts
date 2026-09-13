/**
 * The quiz engine: everything about a quiz that is a rule rather than a
 * rendering or a model call.
 *
 * Pure by construction — it imports `normalizePlain` (src/util.ts:180) and
 * three functions from `src/retrieval.ts`, and nothing else at runtime — so
 * `test/quiz.test.mjs` bundles it without an Obsidian runtime and the chat
 * panel is left with only the parts that need one: the vault, the LLM, and the
 * DOM.
 *
 * Two ideas carry the file. First, the session is immutable: `acceptQuestion`,
 * `applyGrade` and `dropUnit` each return a new `QuizSession`, so the panel can
 * hold one field and never reason about half-applied state. Second, grounding
 * is checked by counting, in the spirit of `checkAnswer` (src/askCheck.ts:50):
 * a question is shown only when its quote is really inside the evidence it
 * claims to come from, and `checkQuestion` is the one place that decides.
 *
 * The pool and its numbering are frozen at session start. `numbered` is
 * computed once in `startSession`, and a unit that the model cannot turn into
 * a question is added to `dropped` rather than removed from `pool`, so
 * `evidenceN` means the same thing on question five as it did on question one.
 * `unitId` is the source of truth on every question; `evidenceN` is only the
 * number the prompt and the rendered evidence use.
 */
import { normalizePlain } from "./util";
import { numberEvidence, rankEvidence, renderEvidenceMarkdown, type EvidenceUnit, significantTokens } from "./retrieval";
import type { QuizQuestionDraft } from "./schemas";
import type { AskEvidenceIn } from "./prompt";

// ---- types -------------------------------------------------------------------

/** Where a quiz draws its evidence from, and what to call that in a sentence. */
export interface QuizScope {
  kind: "all" | "note" | "query";
  label: string;
}

/**
 * How one answer was judged. `dontknow` is deliberately not `incorrect`: the
 * reference quiz treats "I don't know" as its own signal, and so does the
 * escalation here — it neither raises the difficulty nor triggers a retry.
 */
export type Verdict = "correct" | "partial" | "incorrect" | "dontknow" | "skipped";

/** One question, after its grounding has been checked and it has been numbered. */
export interface QuizQuestion {
  n: number;
  unitId: string;
  evidenceN: number;
  question: string;
  answer: string;
  quote: string;
  hint: string;
  difficulty: 1 | 2 | 3;
  kind: "recall" | "why" | "distinguish";
}

/** A question the reader has answered, with the grade. */
export type AskedQuestion = QuizQuestion & {
  userAnswer: string;
  verdict: Verdict;
  feedback: string;
  /** The grader's quote, kept only when it verified against the evidence; "" otherwise. */
  gradeQuote: string;
  /** The grader returned a quote and it was not found in the evidence. */
  gradeQuoteRejected: boolean;
  /** The feedback's own words (minus the student's and grading vocabulary) are in the evidence. */
  feedbackGrounded: boolean;
  /** A note when the verdict contradicts plain word overlap; "" otherwise. */
  dispute: string;
};

export interface QuizSession {
  scope: QuizScope;
  /** The words the reader typed after `/quiz`, kept so "Quiz again" can repeat the same quiz. */
  query: string;
  pool: EvidenceUnit[];
  /** `numberEvidence(pool)`, computed once: the numbering is frozen for the session. */
  numbered: AskEvidenceIn[];
  /** Unit ids the model could not turn into a grounded question. Skipped, never removed. */
  dropped: string[];
  total: number;
  asked: AskedQuestion[];
  current: QuizQuestion | null;
  difficulty: 1 | 2 | 3;
  correct: number;
  partial: number;
  wrong: number;
  dontKnow: number;
  skipped: number;
  /** The unit the next question must re-probe from another angle, or null. */
  retryOf: string | null;
  /** The question that unit was already asked, so the next one can differ from it. */
  retryAngle: string;
  hintShown: boolean;
  finished: boolean;
}

// ---- commands ----------------------------------------------------------------

export type QuizCommand =
  | { kind: "start"; scope: "all" | "this" | "query"; query: string }
  | { kind: "stop" }
  | { kind: "skip" }
  | { kind: "hint" }
  | { kind: "dontknow" };

/**
 * Recognise the chat-local quiz commands, with or without a slash. These are
 * not registry commands (src/chatCommands.ts), so the panel must try this
 * first and fall through to `matchCommand` on null — which is what makes
 * `/skpi` still get the ordinary "no command matches" line instead of being
 * swallowed by the quiz.
 *
 * Plain phrases: "quiz me", "quiz me on receptors", "test me on this note",
 * "start a quiz about affinity" start a quiz whether or not one is running.
 * Control words ("stop", "skip", "next", "hint", "give me a hint") count only
 * while a quiz is `active`, so outside a quiz "next" stays an ordinary
 * question for the model.
 */
export function parseQuizCommand(text: string, active = false): QuizCommand | null {
  const t = text.trim();
  if (t.startsWith("/")) {
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(t);
    if (!m) return null;
    const name = m[1].toLowerCase();
    const rest = m[2].trim();
    if (name === "quiz") return startFor(rest);
    if (name === "stop" || name === "end") return { kind: "stop" };
    if (name === "skip" || name === "next") return { kind: "skip" };
    if (name === "hint") return { kind: "hint" };
    if (name === "idk") return { kind: "dontknow" };
    return null;
  }

  const plain = t.toLowerCase().replace(/[.!?,;:]+$/g, "").replace(/\s+/g, " ").trim();
  if (!plain) return null;

  // Starting phrases work any time.
  const lead = /^(?:please |ok |okay |hey )?(?:(?:quiz|test|drill|question) me|(?:start|begin|run|do|give me|let'?s do|lets do) (?:a |the |another )?(?:quick |short |new )?quiz|quiz)(?: (?:on|about|from|over) (.+))?$/;
  const m = lead.exec(plain);
  if (m) return startFor(m[1] ?? "");

  if (!active) return null;
  if (/^(?:stop|end|quit|done|enough|i'?m done|stop (?:the )?quiz|end (?:the )?quiz|finish)$/.test(plain)) return { kind: "stop" };
  if (/^(?:skip|next|skip (?:it|this|this one)|next question|next one|move on)$/.test(plain)) return { kind: "skip" };
  if (/^(?:hint|a hint|give me a hint|clue|give me a clue|help me out|any hints?)$/.test(plain)) return { kind: "hint" };
  return null;
}

/** "this" / "this note" / "the active note" mean the active note; anything else is a query; nothing means everything. */
function startFor(rest: string): QuizCommand {
  const r = rest.trim();
  if (!r) return { kind: "start", scope: "all", query: "" };
  if (/^(?:this|this note|the active note|the open note|the current note|everything|all)$/i.test(r)) {
    return /^(?:everything|all)$/i.test(r) ? { kind: "start", scope: "all", query: "" } : { kind: "start", scope: "this", query: "" };
  }
  return { kind: "start", scope: "query", query: r };
}

const DONT_KNOW = new Set([
  "idk",
  "i don't know",
  "i dont know",
  "dont know",
  "don't know",
  "no idea",
  "not sure",
  "?",
  "pass",
]);

/**
 * Whether a typed answer is a "don't know" rather than an attempt.
 *
 * Empty and whitespace-only count: the grader's system prompt promises that a
 * blank answer never reaches it, and this is where that promise is kept. The
 * match is on the whole message, so "not sure how receptors bind" is an
 * attempt and gets graded, while "Not sure." is not.
 */
export function isDontKnow(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (t === "?") return true;
  const plain = t
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^[\s.,!?;:"'()\[\]-]+|[\s.,!?;:"'()\[\]-]+$/g, "")
    .trim();
  if (!plain) return true;
  return DONT_KNOW.has(plain) || DONT_KNOW.has(plain.replace(/^\//, ""));
}

// ---- pool --------------------------------------------------------------------

/**
 * The evidence a quiz will draw from, and the phrase that names it.
 *
 * The query case reuses `rankEvidence` (src/retrieval.ts:135) unchanged, so a
 * quiz and an Ask see the same units in the same order for the same words,
 * including its per-note cap. Nothing is shuffled: which unit gets asked is the
 * model's choice, steered by `already_asked`, and a deterministic pool is what
 * makes a session reproducible when a question has to be regenerated.
 */
export function resolvePool(
  scope: "all" | "this" | "query",
  query: string,
  units: EvidenceUnit[],
  activePath: string | null,
  scorer: (text: string) => number | null,
  poolSize: number,
): { pool: EvidenceUnit[]; label: string } {
  if (scope === "query") {
    return { pool: rankEvidence(units, query, scorer, poolSize), label: query.trim() };
  }
  if (scope === "this") {
    if (!activePath) return { pool: [], label: "this note" };
    const pool = units.filter((u) => u.notePath === activePath);
    const label = pool[0]?.noteTitle || basename(activePath);
    return { pool, label };
  }
  // Cap the whole-vault pool the way the query scope is capped, spread evenly so every note is represented.
  if (units.length > poolSize && poolSize > 0) {
    const step = units.length / poolSize;
    const pool: EvidenceUnit[] = [];
    for (let i = 0; i < poolSize; i++) pool.push(units[Math.floor(i * step)]);
    return { pool, label: "all topic notes" };
  }
  return { pool: units.slice(), label: "all topic notes" };
}

/** The file name without its folder or extension — the fallback label for an empty note. */
function basename(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

// ---- session -----------------------------------------------------------------

export function startSession(scope: QuizScope, query: string, pool: EvidenceUnit[], total: number): QuizSession {
  return {
    scope,
    query,
    pool,
    numbered: numberEvidence(pool),
    dropped: [],
    total,
    asked: [],
    current: null,
    difficulty: 1,
    correct: 0,
    partial: 0,
    wrong: 0,
    dontKnow: 0,
    skipped: 0,
    retryOf: null,
    retryAngle: "",
    hintShown: false,
    finished: false,
  };
}

/**
 * The units a next question could still come from: the pool minus the dropped
 * ones minus the ones already asked — except the unit a retry is pending on,
 * which is asked precisely because it was already asked once.
 *
 * The panel uses an empty result to end the quiz early rather than spending a
 * model call that has nothing left to write about.
 */
export function usableUnits(session: QuizSession): EvidenceUnit[] {
  const dropped = new Set(session.dropped);
  const asked = new Set(session.asked.map((a) => a.unitId));
  return session.pool.filter((u) => {
    if (dropped.has(u.id)) return false;
    if (session.retryOf === u.id) return true;
    return !asked.has(u.id);
  });
}

export type QuestionCheck =
  | { ok: true; question: Omit<QuizQuestion, "n" | "difficulty"> }
  | { ok: false; reason: string };

// ---- grounding arithmetic -----------------------------------------------------

/** A crude root so "binds", "binding", "bound"-free forms compare: strip ing/ed/es/s from longer words. */
function root(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

function rootTokens(text: string): string[] {
  return [...new Set(significantTokens(text).map(root))];
}

/** How many of `needle`'s distinct significant words appear in `hay`, and the fraction. */
export function wordCoverage(needle: string, hay: string): { count: number; total: number; fraction: number } {
  const tokens = rootTokens(needle);
  const have = new Set(rootTokens(hay));
  const count = tokens.filter((t) => have.has(t)).length;
  return { count, total: tokens.length, fraction: tokens.length ? count / tokens.length : 0 };
}

const SET_QUESTION = /\b(two|three|four|five|six|both|all of the|list the)\b/i;

/** Words a grader uses about the grading itself; they never need to appear in the passage. */
const GRADING_LIST =
  "evidence notes passage answer states stated mentions mention mentioned says said correct right wrong missing part partly exactly matches match matched not does did only also your you student expected instead rather however but";
/** Normalised through the same tokeniser as the feedback, so "matches" and "match" compare equal. */
const GRADING_WORDS = new Set(rootTokens(GRADING_LIST));

/**
 * Is the grader's feedback made of the passage's words? The student's own
 * words and grading vocabulary are set aside first; what remains must mostly
 * be in the evidence, or the feedback is teaching something the notes do not
 * say (external-knowledge restriction, verify-with-citations).
 */
export function feedbackGrounded(feedback: string, evidenceText: string, userAnswer: string): boolean {
  const student = new Set(rootTokens(userAnswer));
  const remaining = rootTokens(feedback).filter((t) => !student.has(t) && !GRADING_WORDS.has(t));
  if (remaining.length === 0) return true;
  const have = new Set(rootTokens(evidenceText));
  const hits = remaining.filter((t) => have.has(t)).length;
  return hits / remaining.length >= 0.5;
}

/**
 * A verdict the reader should look at twice: "incorrect" although the student
 * wrote the expected wording, or "correct" with no overlap and no verified
 * quote to back it. The grade stands; the note is what lets the reader
 * overrule it (properties of effective prompts: consistent).
 */
export function disputeGrade(userAnswer: string, expected: string, verdict: Verdict, gradeQuoteVerified: boolean): string {
  const cov = wordCoverage(expected, userAnswer);
  if (verdict === "incorrect" && cov.total > 0 && cov.fraction >= 0.8) {
    return "Your answer contains the expected wording; the grade may be too strict.";
  }
  if (verdict === "correct" && cov.count === 0 && !gradeQuoteVerified) {
    return "The grade is not backed by a verified quote.";
  }
  return "";
}


/**
 * Check one generated question against the frozen evidence before the reader
 * ever sees it.
 *
 * The quote check is the one in `checkAnswer` (src/askCheck.ts:50): normalise
 * both sides and require a substring, so a paraphrase of the evidence is
 * rejected even when it is true. The yes/no rule is on the model's own
 * `answer`, never on the question's first word — "Does a competitive
 * antagonist shift the curve?" is a fine question when the stated answer is a
 * phrase, and the Design pinned that down.
 *
 * `reason` is fed straight back into the next attempt's prompt as the
 * `failure` line, so each one names what to fix.
 */
export function checkQuestion(draft: QuizQuestionDraft, session: QuizSession): QuestionCheck {
  const n = draft.evidence_n;
  if (!Number.isInteger(n) || n < 1 || n > session.numbered.length) {
    return { ok: false, reason: `evidence_n ${n} is not one of 1…${session.numbered.length}` };
  }
  const unit = session.pool[n - 1];
  if (!unit) return { ok: false, reason: `evidence_n ${n} is not one of 1…${session.numbered.length}` };

  if (session.dropped.includes(unit.id)) {
    return { ok: false, reason: `evidence [${n}] was already skipped; use another passage` };
  }
  const alreadyAsked = session.asked.some((a) => a.unitId === unit.id);
  if (alreadyAsked && session.retryOf !== unit.id) {
    return { ok: false, reason: `evidence [${n}] was already asked about; use another passage` };
  }

  const question = draft.question.trim();
  if (!question) return { ok: false, reason: "empty question" };

  const answer = draft.answer.trim();
  if (!answer) return { ok: false, reason: "empty answer" };
  const plainAnswer = answer.toLowerCase().replace(/[.!?]+$/, "").trim();
  if (plainAnswer === "yes" || plainAnswer === "no") return { ok: false, reason: "yes/no answer" };

  // The expected answer is shown to the reader as fact, so it must be in the passage too.
  const answerCov = wordCoverage(answer, unit.text);
  const answerStated =
    answerCov.total >= 2
      ? answerCov.fraction >= 0.6
      : answerCov.count === answerCov.total || normalizePlain(unit.text).includes(normalizePlain(answer));
  if (!answerStated) return { ok: false, reason: `the expected answer is not stated in evidence [${n}]` };

  // Answer leakage (litmus test for false positives): the wording must not contain the answer.
  // One shared word ("bind" in both) is normal; the whole answer, or most of a
  // longer one, appearing in the wording is what gives it away.
  const leak = wordCoverage(answer, question);
  if (normalizePlain(question).includes(normalizePlain(answer)) || (leak.total >= 3 && leak.fraction >= 0.67)) {
    return { ok: false, reason: "the question contains its own answer" };
  }

  // Sets and enumerations: one member per question.
  if (SET_QUESTION.test(question) || /, and /.test(answer) || answer.split(",").length >= 3) {
    return { ok: false, reason: "asks for a set; ask about one member of it" };
  }

  const needle = normalizePlain(draft.quote);
  if (!needle) return { ok: false, reason: "empty quote" };
  if (!normalizePlain(unit.text).includes(needle)) {
    return { ok: false, reason: `the quote is not in evidence [${n}] word for word` };
  }

  return {
    ok: true,
    question: {
      unitId: unit.id,
      evidenceN: n,
      question,
      answer,
      quote: draft.quote.trim(),
      hint: wordCoverage(draft.hint, unit.text).count > 0 ? draft.hint.trim() : "",
      kind: draft.kind,
    },
  };
}

/**
 * The grader's quote when it is really in the evidence, "" otherwise — the
 * same check the question's quote gets, because a grade that cites words the
 * passage does not contain is exactly what the reader needs to spot.
 */
export function verifyGradeQuote(quote: string, evidenceText: string): string {
  const needle = normalizePlain(quote);
  if (!needle) return "";
  return normalizePlain(evidenceText).includes(needle) ? quote.trim() : "";
}

/** Put a checked question on the session as the one being asked. */
export function acceptQuestion(session: QuizSession, q: Omit<QuizQuestion, "n" | "difficulty">): QuizSession {
  return {
    ...session,
    current: { ...q, n: session.asked.length + 1, difficulty: session.difficulty },
    hintShown: false,
  };
}

/**
 * Record a grade and decide what the next question should be.
 *
 * The escalation is the reference quiz's: a correct answer raises the tier, so
 * an all-correct run keeps getting harder until a gap appears; a wrong answer
 * holds the tier and probes the same passage once more from another angle,
 * because one miss is not yet evidence of a gap. A second miss on that same
 * passage ends the probing — two attempts is the limit, not a loop.
 *
 * A retry is one of the `total` graded questions, so a five-question quiz is
 * five graded turns however many retries it contains.
 */
export function applyGrade(
  session: QuizSession,
  verdict: Verdict,
  feedback: string,
  gradeQuote: string,
  userAnswer: string,
  extras: { gradeQuoteRejected?: boolean; feedbackGrounded?: boolean; dispute?: string } = {},
): QuizSession {
  const current = session.current;
  if (!current) return session;

  const asked: AskedQuestion[] = [
    ...session.asked,
    {
      ...current,
      userAnswer,
      verdict,
      feedback,
      gradeQuote,
      gradeQuoteRejected: extras.gradeQuoteRejected ?? false,
      feedbackGrounded: extras.feedbackGrounded ?? true,
      dispute: extras.dispute ?? "",
    },
  ];

  let difficulty = session.difficulty;
  let retryOf: string | null = null;
  let retryAngle = "";

  if (verdict === "correct") {
    difficulty = Math.min(3, session.difficulty + 1) as 1 | 2 | 3;
  } else if (verdict === "incorrect") {
    // Already a retry on this unit? Then the probe is spent; move on.
    if (session.retryOf !== current.unitId) {
      retryOf = current.unitId;
      retryAngle = current.question;
    }
  }

  return {
    ...session,
    asked,
    current: null,
    difficulty,
    correct: session.correct + (verdict === "correct" ? 1 : 0),
    partial: session.partial + (verdict === "partial" ? 1 : 0),
    wrong: session.wrong + (verdict === "incorrect" ? 1 : 0),
    dontKnow: session.dontKnow + (verdict === "dontknow" ? 1 : 0),
    skipped: session.skipped + (verdict === "skipped" ? 1 : 0),
    retryOf,
    retryAngle,
    hintShown: false,
    finished: asked.length >= session.total,
  };
}

/** Mark a unit as unusable for the rest of the session, keeping the numbering intact. */
export function dropUnit(session: QuizSession, unitId: string): QuizSession {
  if (session.dropped.includes(unitId)) return session;
  return { ...session, dropped: [...session.dropped, unitId] };
}

/** The parts of the next question's prompt that come from the session's state. */
export function nextRequest(session: QuizSession): {
  difficulty: 1 | 2 | 3;
  askedQuestions: string[];
  retryOfN: number | null;
  retryAngle: string;
} {
  let retryOfN: number | null = null;
  if (session.retryOf) {
    const i = session.pool.findIndex((u) => u.id === session.retryOf);
    if (i >= 0) retryOfN = i + 1;
  }
  return {
    difficulty: session.difficulty,
    askedQuestions: session.asked.map((a) => a.question),
    retryOfN,
    retryAngle: retryOfN === null ? "" : session.retryAngle,
  };
}

// ---- summary and rendering ---------------------------------------------------

/**
 * The score line and what to re-read.
 *
 * A partial and a "don't know" are misses as much as a wrong answer is: all
 * three mark a passage the reader could not produce from memory, which is
 * exactly the material the inbox chip should offer to turn into cards. A skip
 * is not a miss — nothing was attempted, so nothing was learned about it.
 */
export function summary(session: QuizSession): { line: string; misses: AskedQuestion[] } {
  const line = [
    `${session.correct} of ${session.total} correct`,
    `${session.partial} partial`,
    `${session.wrong} wrong`,
    `${session.dontKnow} passed`,
    `${session.skipped} skipped`,
  ].join(" · ");
  // One entry per passage: a retried passage was asked twice, but it is one
  // thing to review and one thing to send to the inbox.
  const seen = new Set<string>();
  const misses = session.asked.filter((a) => {
    if (!(a.verdict === "incorrect" || a.verdict === "partial" || a.verdict === "dontknow")) return false;
    if (seen.has(a.unitId)) return false;
    seen.add(a.unitId);
    return true;
  });
  return { line, misses };
}

/**
 * One question as the reader sees it: the header, then the question.
 *
 * The header carries the number and the kind and not the difficulty tier — the
 * tier is an instruction to the model, and printing "difficulty 1" next to a
 * question you just got wrong reads as a judgement rather than information.
 */
export function renderQuestionMarkdown(q: QuizQuestion, total: number): string {
  return `**Question ${q.n}/${total}** *(${q.kind})*\n\n${q.question}`;
}

const VERDICT_LINE: Record<Verdict, string> = {
  correct: "✓ Correct",
  partial: "△ Partly",
  incorrect: "✗ Not quite",
  dontknow: "– You passed",
  skipped: "→ Skipped",
};

/**
 * One grade: the verdict, the model's feedback, the expected answer, and the
 * passage itself. The passage is shown after every answer, right or wrong —
 * the reference quiz's rule, and the thing that lets the reader overrule a
 * grade they disagree with.
 */
export function renderGradeMarkdown(asked: AskedQuestion, unit: EvidenceUnit): string {
  const parts = [VERDICT_LINE[asked.verdict]];
  if (asked.dispute) parts.push(`*${asked.dispute}*`);
  const feedback = asked.feedback.trim();
  if (feedback) parts.push(feedback);
  parts.push(`**Answer:** ${asked.answer}`);
  if (asked.gradeQuote) parts.push(`> “${asked.gradeQuote}”`);
  parts.push(renderEvidenceMarkdown(unit, asked.evidenceN));
  return parts.join("\n\n");
}

/** The closing turn: the score, then the questions worth re-reading, each linked to its note. */
export function renderSummaryMarkdown(session: QuizSession): string {
  const { line, misses } = summary(session);
  if (misses.length === 0) return `${line}\n\nNo misses.`;
  const unitById = new Map(session.pool.map((u) => [u.id, u]));
  const items = misses.map((m) => {
    const unit = unitById.get(m.unitId);
    if (!unit) return `- ${m.question}`;
    const linkPath = unit.notePath.replace(/\.md$/i, "");
    return `- ${m.question} — [[${linkPath}|${unit.noteTitle}]]`;
  });
  return `${line}\n\n**Missed:**\n${items.join("\n")}`;
}
