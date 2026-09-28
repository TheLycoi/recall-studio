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
 *
 * A quiz is a sweep: one question per passage, every passage once, and it ends
 * when the pool is covered. Its job is to find which passages the reader
 * cannot produce from memory so those become cards (the vault's
 * retrieval-practice and redundancy pages: learning comes from the effortful
 * recall, and a fact the reader already knows earns no card). A passage is
 * never asked twice in a session: every grade shows the expected answer and
 * the passage itself, so a second question on it would be answered by
 * scrolling up, which is exactly the false-positive the litmus test for
 * prompts warns about.
 */
import { normalizePlain } from "./util";
import { numberEvidence, renderEvidenceMarkdown, type EvidenceUnit, significantTokens } from "./retrieval";
import type { QuizQuestionDraft } from "./schemas";
import type { AskEvidenceIn } from "./prompt";

// ---- types -------------------------------------------------------------------

/** Where a quiz draws its evidence from, and what to call that in a sentence. */
export interface QuizScope {
  kind: "all" | "note" | "query";
  label: string;
}

/**
 * How one answer was judged. `skipped` is deliberately not `incorrect`: it
 * covers every answer the reader declined to give, whether they said so (`/idk`)
 * or moved on (`/skip`). It lowers the tier like a miss does, because a passage
 * the reader would not attempt is as much a gap as a wrong answer, and it is
 * carded the same way.
 */
export type Verdict = "correct" | "partial" | "incorrect" | "skipped";

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
  /** What the answer revealed about the reader's understanding. */
  gap: Gap;
  /** The specific belief or missing piece behind `gap`; "" when there is none. */
  gapNote: string;
  /** The answer came on the second attempt, after the hint. Never a miss when correct; never starts a streak. */
  hinted: boolean;
};

/**
 * What an answer revealed, beyond right or wrong.
 *
 * The reference system's point about distractors: which wrong answer someone
 * picks tells you which nuance is off, and that is worth more than the binary.
 * Free recall has no distractors to choose between, so the grader names the
 * kind of error instead. The quiz uses it to decide what deserves to become a
 * flashcard, and the card writer uses it to decide what the card should test.
 */
export type Gap = "none" | "slip" | "vocabulary" | "detail" | "misconception";

export interface QuizSession {
  scope: QuizScope;
  /** The words the reader typed after `/quiz`, kept so "Quiz again" can repeat the same quiz. */
  query: string;
  pool: EvidenceUnit[];
  /** `numberEvidence(pool)`, computed once: the numbering is frozen for the session. */
  numbered: AskEvidenceIn[];
  /** Unit ids the model could not turn into a grounded question. Skipped, never removed. */
  dropped: string[];
  /**
   * A safety ceiling, not the intended length. The quiz ends when every usable
   * passage has been asked; this only stops a session on a pool bigger than
   * the reader wants to sit through in one go, and the summary says how many
   * passages were left.
   */
  cap: number;
  asked: AskedQuestion[];
  current: QuizQuestion | null;
  difficulty: 1 | 2 | 3;
  correct: number;
  partial: number;
  wrong: number;
  skipped: number;
  hintShown: boolean;
  /** 1 on a fresh question; 2 after the hint bought one more try. */
  attempt: 1 | 2;
  finished: boolean;
}

// ---- commands ----------------------------------------------------------------

export type QuizCommand =
  | { kind: "start"; scope: "all" | "this" | "query"; query: string }
  | { kind: "stop" }
  | { kind: "skip" }
  | { kind: "hint" };

/**
 * Recognise the chat-local quiz commands, with or without a slash. These are
 * not registry commands (src/chatCommands.ts), so the panel tries this first
 * while a quiz runs and falls through to `matchIntent` on null — which is what
 * keeps `/skpi` an ordinary line rather than something the quiz swallows.
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
    if (name === "skip" || name === "next" || name === "idk") return { kind: "skip" };
    if (name === "hint") return { kind: "hint" };
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

/**
 * What a `quiz` line is about. A bare "quiz me" means the note in front of the
 * reader, which is what they are looking at when they ask; "everything" and
 * "all" are how the whole vault is asked for, and anything else is a query.
 */
function startFor(rest: string): QuizCommand {
  const r = rest.trim();
  if (!r) return { kind: "start", scope: "this", query: "" };
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
 * The query case goes through `rankQueryPool` rather than `rankEvidence`: Ask
 * is looking for the passage that answers a question, a quiz for the notes that
 * cover a subject, and the second is a different search. Nothing is shuffled:
 * which unit gets asked is the model's choice, steered by `already_asked`, and
 * a deterministic pool is what makes a session reproducible when a question has
 * to be regenerated.
 */
/**
 * The pool for a subject the reader named, gathered by note rather than by
 * passage.
 *
 * Ranking passages directly is what `rankEvidence` does, and for a question it
 * is right: the passage that answers it is the one that shares its words. A
 * subject is different. Asked for "stages of change", passage ranking filled
 * half the pool with the wrong subject — a kinematics note mentioning a rate of
 * change scored, while "Unaware or under-aware of the problem", prime quiz
 * material sitting in the Stages of Change note, scored nothing at all because
 * it happens to contain neither word. The best passages on a topic are usually
 * the ones that never restate its name.
 *
 * So relevance is decided one level up. A note's score is its best passage plus
 * a smaller share of the rest, which rewards a note that returns to the subject
 * over one that mentions it once; the winning notes then contribute *all* their
 * passages, in their own order, because a passage's neighbours are evidence for
 * it in a way its own wording is not. Notes scoring far below the best are
 * dropped outright rather than left to pad the pool.
 *
 * The pool can come back smaller than `k`, and that is the honest answer: a
 * subject the notes cover in four places should be quizzed on those four.
 */
export function rankQueryPool(
  units: EvidenceUnit[],
  query: string,
  scorer: (text: string) => number | null,
  k: number,
): EvidenceUnit[] {
  const byNote = new Map<string, { units: EvidenceUnit[]; scores: number[] }>();
  for (const u of units) {
    let e = byNote.get(u.notePath);
    if (!e) byNote.set(u.notePath, (e = { units: [], scores: [] }));
    e.units.push(u);
    const text = scorer(u.text);
    if (text !== null) e.scores.push(text);
  }

  const ranked: Array<{ path: string; score: number; units: EvidenceUnit[] }> = [];
  for (const [path, e] of byNote) {
    if (e.scores.length === 0) continue;
    e.scores.sort((a, b) => b - a);
    // Best passage, plus a fifth of the others: a note that comes back to the
    // subject outranks one that names it once and moves on.
    const body = e.scores[0] + 0.2 * e.scores.slice(1).reduce((n, v) => n + v, 0);
    // The title breaks ties toward the note the reader would have opened. It
    // stays small on purpose: a note whose title matches is usually also full
    // of the word, so a heavy title bonus counts the same evidence twice and
    // pushes the floor up past notes that genuinely cover the subject.
    const title = scorer(e.units[0].noteTitle) ?? 0;
    ranked.push({ path, score: body + 0.3 * title, units: e.units });
  }
  if (ranked.length === 0) return [];

  ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path < b.path ? -1 : 1));

  // A note scoring under a third of the best is about something else that
  // happens to share a word.
  const floor = ranked[0].score / 3;
  const out: EvidenceUnit[] = [];
  for (const note of ranked) {
    if (out.length >= k) break;
    if (note.score < floor) break;
    for (const u of note.units) {
      if (out.length >= k) break;
      out.push(u);
    }
  }
  return out;
}

export function resolvePool(
  scope: "all" | "this" | "query",
  query: string,
  units: EvidenceUnit[],
  activePath: string | null,
  scorer: (text: string) => number | null,
  poolSize: number,
): { pool: EvidenceUnit[]; label: string } {
  if (scope === "query") {
    return { pool: rankQueryPool(units, query, scorer, poolSize), label: query.trim() };
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

export function startSession(scope: QuizScope, query: string, pool: EvidenceUnit[], cap: number): QuizSession {
  return {
    scope,
    query,
    pool,
    numbered: numberEvidence(pool),
    dropped: [],
    cap,
    asked: [],
    current: null,
    difficulty: 1,
    correct: 0,
    partial: 0,
    wrong: 0,
    skipped: 0,
    hintShown: false,
    attempt: 1,
    finished: false,
  };
}

/**
 * The units a next question could still come from: the pool minus the dropped
 * ones minus the ones already asked, whatever the verdict was. An asked
 * passage has been shown in full under its grade, so nothing about it can be
 * recalled rather than read.
 *
 * The panel uses an empty result to end the quiz rather than spending a model
 * call that has nothing left to write about.
 */
export function usableUnits(session: QuizSession): EvidenceUnit[] {
  return remainingUnits(session.pool, session.dropped, session.asked);
}

function remainingUnits(pool: EvidenceUnit[], droppedIds: string[], asked: AskedQuestion[]): EvidenceUnit[] {
  const dropped = new Set(droppedIds);
  const askedIds = new Set(asked.map((a) => a.unitId));
  return pool.filter((u) => !dropped.has(u.id) && !askedIds.has(u.id));
}

export type QuestionCheck =
  | { ok: true; question: Omit<QuizQuestion, "n" | "difficulty"> }
  | { ok: false; reason: string };

// ---- grounding arithmetic -----------------------------------------------------

/** A crude root so "binds", "binding", "bound"-free forms compare: strip ing/ed/es/s from longer words. */
function root(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return undouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith("ed")) return undouble(w.slice(0, -2));
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** "plott" (from plotted, plotting) is "plot": a consonant doubled before the suffix is one consonant in the root. */
function undouble(w: string): string {
  return w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/[aeiou]/.test(w[w.length - 1]) ? w.slice(0, -1) : w;
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
  if (session.asked.some((a) => a.unitId === unit.id)) {
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

  // Leakage across questions. Every grade shows the reader the expected answer
  // and the quoted wording, so a later question whose answer is among them is
  // answered by scrolling up, not by recall — "what abbreviation names the SR's
  // calcium pumps?" one turn after "Answer: Ca2+ ATPases (SERCAs)". Passages
  // in one note restate each other, so this is checked across passages, not
  // only within one. Only what was called out counts, not the whole displayed
  // passage: a neighbouring passage shares a subject, not its facts.
  const shown = session.asked.map((a) => `${a.answer} ${a.quote} ${a.gradeQuote}`).join(" ");
  const shownCov = wordCoverage(answer, shown);
  if (shown.trim() && (normalizePlain(shown).includes(normalizePlain(answer)) || (shownCov.total >= 1 && shownCov.fraction === 1))) {
    return { ok: false, reason: "the answer was already shown to the reader in an earlier grade; ask for a fact that has not been revealed" };
  }
  // Sets and enumerations: one member per question.
  if (SET_QUESTION.test(question) || /, and /.test(answer) || answer.split(",").length >= 3) {
    return { ok: false, reason: "asks for a set; ask about one member of it" };
  }

  const needle = normalizePlain(draft.quote);
  if (!needle) return { ok: false, reason: "empty quote" };
  // A quote made only of stopwords ("a", "is", "the") is a substring of nearly
  // any passage, so it would verify without showing anything. It has to carry
  // at least one word that means something.
  if (significantTokens(draft.quote).length === 0) {
    return { ok: false, reason: "the quote carries no significant word; quote the wording that answers the question" };
  }
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
      // A hint has to touch the passage, and it must not be the answer: a hint
      // that names it turns the second attempt into copying.
      hint:
        wordCoverage(draft.hint, unit.text).count > 0 &&
        !normalizePlain(draft.hint).includes(normalizePlain(answer)) &&
        wordCoverage(answer, draft.hint).fraction < 1
          ? draft.hint.trim()
          : "",
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
  // Same rule as checkQuestion: stopwords alone match everything and prove
  // nothing, so they do not count as a verified quote.
  if (significantTokens(quote).length === 0) return "";
  return normalizePlain(evidenceText).includes(needle) ? quote.trim() : "";
}

/** Put a checked question on the session as the one being asked. */
export function acceptQuestion(session: QuizSession, q: Omit<QuizQuestion, "n" | "difficulty">): QuizSession {
  return {
    ...session,
    current: { ...q, n: session.asked.length + 1, difficulty: session.difficulty },
    hintShown: false,
    attempt: 1,
  };
}

/**
 * The reader's rule: a first wrong or partial answer buys the question's hint
 * and one more attempt before anything is recorded. Nothing about the tier or
 * the score moves here; the second answer decides. This is the same question
 * asked again with the answer still hidden — not a new question on a passage
 * already shown, which the quiz never does.
 */
export function armRetry(session: QuizSession): QuizSession {
  return { ...session, attempt: 2, hintShown: true };
}

/** What the panel says between the first miss and the second attempt. */
export function retryLine(q: QuizQuestion): string {
  const hint = q.hint.trim();
  return hint ? `Not quite. Hint: ${hint} — try once more, or say skip.` : "Not quite. Try once more, or say skip.";
}

/**
 * Record a grade and decide what tier the next question is written at.
 *
 * The escalation is the reference quiz's: a correct answer raises the tier,
 * two in a row jump to the top, and a wrong or declined answer comes back
 * down. The tier is about keeping each question at a level the reader can
 * reach; it never decides when the quiz ends. The quiz ends when every usable
 * passage has been asked (or the cap fires), because its purpose is to find
 * the passages the reader cannot produce from memory, and it cannot know that
 * about a passage it never asked.
 *
 * No passage is asked twice. The grade below a miss shows the expected answer
 * and the passage, so a second question on it would test reading, not recall;
 * the miss is recorded once, with its diagnosis, and becomes one card.
 */
/**
 * How many questions the reader has just got right in a row.
 *
 * Only the unbroken tail counts: two correct answers separated by a miss are
 * not a streak, because the miss is the more informative of the three — it is
 * the one that said where the tier was too high.
 */
function correctStreak(asked: AskedQuestion[]): number {
  let n = 0;
  for (let i = asked.length - 1; i >= 0; i--) {
    if (asked[i].verdict !== "correct" || asked[i].hinted) break;
    n++;
  }
  return n;
}

export function applyGrade(
  session: QuizSession,
  verdict: Verdict,
  feedback: string,
  gradeQuote: string,
  userAnswer: string,
  extras: {
    gradeQuoteRejected?: boolean;
    feedbackGrounded?: boolean;
    dispute?: string;
    gap?: Gap;
    gapNote?: string;
  } = {},
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
      gap: extras.gap ?? "none",
      gapNote: extras.gapNote ?? "",
      hinted: session.attempt === 2,
    },
  ];

  let difficulty = session.difficulty;

  if (verdict === "correct") {
    if (session.attempt === 2) {
      // Right with the hint proves the floor is somewhere near, not that the
      // tier is cleared: hold it, and let the next question say more.
      difficulty = session.difficulty;
    } else {
      // Jump, don't inch. A right answer proves only a floor — that the reader
      // knows *at least* this much — and asking one notch up learns almost
      // nothing new. Going straight to the top tier after two in a row finds the
      // ceiling in the few questions a quiz has, which is the whole point of the
      // escalation: a quiz that never misses never found the edge.
      const streak = correctStreak(session.asked) + 1;
      difficulty = (streak >= 2 ? 3 : Math.min(3, session.difficulty + 1)) as 1 | 2 | 3;
    }
  } else if (verdict === "incorrect" || verdict === "skipped") {
    // Something below the tier that just failed is where the reader can
    // reach, so come back down for the next passage rather than asking a
    // second question they cannot answer either. A skip is a declined answer,
    // not a wrong one, but it says the same thing about the tier.
    difficulty = Math.max(1, session.difficulty - 1) as 1 | 2 | 3;
  }

  return {
    ...session,
    asked,
    current: null,
    difficulty,
    correct: session.correct + (verdict === "correct" ? 1 : 0),
    partial: session.partial + (verdict === "partial" ? 1 : 0),
    wrong: session.wrong + (verdict === "incorrect" ? 1 : 0),
    skipped: session.skipped + (verdict === "skipped" ? 1 : 0),
    hintShown: false,
    attempt: 1,
    // Covering the pool is the reason to stop; the cap only catches a pool
    // longer than one sitting.
    finished: asked.length >= session.cap || remainingUnits(session.pool, session.dropped, asked).length === 0,
  };
}

/**
 * The evidence the next question may be written from: the open passages only,
 * each still carrying its frozen number. Showing the writer passages that are
 * already asked or set aside only invites it to cite one, which `checkQuestion`
 * then rejects.
 */
export function nextEvidence(session: QuizSession): AskEvidenceIn[] {
  const open = new Set(usableUnits(session).map((u) => u.id));
  return session.numbered.filter((_, i) => open.has(session.pool[i].id));
}

/**
 * What a second failed draft does. A draft citing an open passage sets that
 * passage aside, which is progress: one fewer passage to try. A draft citing a
 * passage that is already closed (asked, set aside, or outside the pool) cannot
 * be set aside again, so nothing would change and the next attempt would be
 * the same call; that is `stuck`, and the panel ends the quiz instead of
 * looping.
 */
export function failedDraft(session: QuizSession, evidenceN: number): { session: QuizSession; stuck: boolean } {
  const unit = Number.isInteger(evidenceN) ? session.pool[evidenceN - 1] : undefined;
  if (!unit || !usableUnits(session).some((u) => u.id === unit.id)) return { session, stuck: true };
  return { session: dropUnit(session, unit.id), stuck: false };
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
  /** Expected answers the reader has already been shown, so the model does not ask for them again. */
  revealed: string[];
} {
  return {
    difficulty: session.difficulty,
    askedQuestions: session.asked.map((a) => a.question),
    revealed: [...new Set(session.asked.map((a) => a.answer.trim()).filter(Boolean))],
  };
}

// ---- summary and rendering ---------------------------------------------------

/**
 * The score line and what to re-read.
 *
 * A partial and a skip are misses as much as a wrong answer is: all three mark
 * a passage the reader could not produce from memory, which is exactly the
 * material the inbox chip should offer to turn into cards.
 */
export function summary(session: QuizSession): { line: string; misses: AskedQuestion[] } {
  // Scored against what was actually asked: the pool's usable passages when
  // the quiz ran to the end, fewer when the cap or "stop" cut it short.
  const askedCount = session.asked.length;
  const left = usableUnits(session).length;
  const setAside = session.dropped.length;
  const line = [
    `${session.correct} of ${askedCount} correct`,
    `${session.partial} partial`,
    `${session.wrong} wrong`,
    `${session.skipped} skipped`,
  ]
    .join(" · ")
    // Say why it ended. Covering the pool is the intended ending, so it is
    // named as the result it is; hitting the cap means passages went unasked,
    // and saying how many is more honest than implying the note was covered.
    .concat(
      left === 0
        ? ` — every passage asked${setAside ? `, ${setAside} set aside` : ""}`
        : askedCount >= session.cap
          ? ` — stopped at the question cap with ${left} passage${left === 1 ? "" : "s"} not asked`
          : "",
    );
  // One entry per passage, guarded even though a passage is asked at most once.
  //
  // What counts as a miss is the diagnosis, not the verdict. A card costs the
  // reader minutes a year for years, so the question is not "was this wrong"
  // but "is there something here they do not know". A slip is not — they had
  // it, and the answer came out wrong anyway; carding it would schedule review
  // for a typo. Everything else is a real gap, and a passage the reader could
  // not produce at all is the strongest card candidate there is.
  const seen = new Set<string>();
  const misses = session.asked.filter((a) => {
    if (!(a.verdict === "incorrect" || a.verdict === "partial" || a.verdict === "skipped")) return false;
    if (a.gap === "slip") return false;
    if (seen.has(a.unitId)) return false;
    seen.add(a.unitId);
    return true;
  });
  return { line, misses };
}

/**
 * One missed passage as the inbox receives it: the passage, the question the
 * reader failed on it, and what the grader made of the failure.
 *
 * The passage alone was what the inbox used to get, and the writer then chose
 * for itself which fact in it to card — often a different one from the fact
 * the reader had just shown they did not know. The point of sending a miss is
 * that specific gap, so the question travels with the passage.
 */
export interface QuizMiss {
  unit: EvidenceUnit;
  question: string;
  answer: string;
  verdict: Verdict;
  gap: Gap;
  gapNote: string;
}

/**
 * The misses in the form the inbox wants.
 *
 * Built on `summary` so the two never disagree about what counts as a miss:
 * the chip says "Send 3 missed" and three is what gets sent. A retried passage
 * keeps its first missed question, because that is the one the reader failed;
 * the retry only confirmed the gap from another angle.
 */
export function missesForInbox(session: QuizSession): QuizMiss[] {
  const unitById = new Map(session.pool.map((u) => [u.id, u]));
  const out: QuizMiss[] = [];
  for (const m of summary(session).misses) {
    const unit = unitById.get(m.unitId);
    if (!unit) continue;
    out.push({ unit, question: m.question, answer: m.answer, verdict: m.verdict, gap: m.gap, gapNote: m.gapNote });
  }
  return out;
}

/**
 * The per-highlight instruction the card writer reads (src/llm.ts:413).
 *
 * It names the question and the expected answer so the card tests the fact the
 * reader missed rather than whichever fact in the passage the writer would
 * have picked, and it passes the diagnosis on, because a misconception wants a
 * card whose cue rules the wrong belief out and a missing detail wants the
 * detail. The writer's own rules still apply on top: it may shorten the answer
 * or turn the question into a cloze, but not change what is being asked.
 */
export function renderMissInstruction(miss: QuizMiss): string {
  const how =
    miss.verdict === "skipped"
      ? "could not answer it"
      : miss.verdict === "partial"
        ? "answered it only partly"
        : "answered it wrong";
  const lines = [
    `The reader missed this question in a quiz on their notes; they ${how}.`,
    `Question: ${miss.question}`,
    `Expected answer: ${miss.answer}`,
  ];
  if (miss.gap !== "none" && miss.gapNote.trim()) lines.push(`What went wrong — ${miss.gap}: ${miss.gapNote.trim()}`);
  lines.push(
    "Write the card that tests exactly this: keep the question's subject and its expected answer (shortened or as a cloze deletion is fine), and do not card a different fact from the passage instead.",
  );
  return lines.join("\n");
}

const TITLE_MAX = 80;

/** The highlight's label in the inbox: the question, cut to fit a title. */
export function missTitle(miss: Pick<QuizMiss, "question">): string {
  const q = miss.question.trim().replace(/\s+/g, " ");
  if (q.length <= TITLE_MAX) return q;
  return q.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, "") + "…";
}

/**
 * One question as the reader sees it: the header, then the question.
 *
 * The header carries the number and the kind and not the difficulty tier — the
 * tier is an instruction to the model, and printing "difficulty 1" next to a
 * question you just got wrong reads as a judgement rather than information.
 *
 * The number stands alone, with no "/ N": the quiz runs until it finds the edge,
 * so there is no denominator to count down to. "Question 4/5" would promise an
 * ending that the bracketing rule, not the count, decides.
 */
export function renderQuestionMarkdown(q: QuizQuestion): string {
  return `**Question ${q.n}** *(${q.kind})*\n\n${q.question}`;
}

const VERDICT_LINE: Record<Verdict, string> = {
  correct: "✓ Correct",
  partial: "△ Partly",
  incorrect: "✗ Not quite",
  skipped: "→ Skipped",
};

/**
 * One grade: the verdict, the model's feedback, the expected answer, and the
 * passage itself. The passage is shown after every answer, right or wrong —
 * the reference quiz's rule, and the thing that lets the reader overrule a
 * grade they disagree with.
 */
export function renderGradeMarkdown(asked: AskedQuestion, unit: EvidenceUnit): string {
  const parts = [`${VERDICT_LINE[asked.verdict]}${asked.hinted && asked.verdict === "correct" ? " *(after a hint)*" : ""}`];
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
