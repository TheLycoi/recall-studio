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
import { numberEvidence, rankEvidence, renderEvidenceMarkdown, type EvidenceUnit } from "./retrieval";
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
 * Recognise the chat-local quiz commands. These are not registry commands
 * (src/chatCommands.ts), so the panel must try this first and fall through to
 * `matchCommand` on null — which is what makes `/skpi` still get the ordinary
 * "no command matches" line instead of being swallowed by the quiz.
 */
export function parseQuizCommand(text: string): QuizCommand | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(t);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const rest = m[2].trim();

  if (name === "quiz") {
    if (!rest) return { kind: "start", scope: "all", query: "" };
    if (rest.toLowerCase() === "this") return { kind: "start", scope: "this", query: "" };
    return { kind: "start", scope: "query", query: rest };
  }
  if (name === "stop" || name === "end") return { kind: "stop" };
  if (name === "skip" || name === "next") return { kind: "skip" };
  if (name === "hint") return { kind: "hint" };
  if (name === "idk") return { kind: "dontknow" };
  return null;
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
      hint: draft.hint.trim(),
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
): QuizSession {
  const current = session.current;
  if (!current) return session;

  const asked: AskedQuestion[] = [...session.asked, { ...current, userAnswer, verdict, feedback, gradeQuote }];

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
  const misses = session.asked.filter(
    (a) => a.verdict === "incorrect" || a.verdict === "partial" || a.verdict === "dontknow",
  );
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
  const feedback = asked.feedback.trim();
  if (feedback) parts.push(feedback);
  parts.push(`**Answer:** ${asked.answer}`);
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
