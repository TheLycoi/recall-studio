/**
 * The parts of a quiz shared by every question shape: the chat-local
 * commands, the pool of passages a quiz draws on, the word arithmetic its
 * checks count with, and the instruction a missed point carries to the card
 * writer. The quiz itself, a free-response question on one section of a note at a
 * time, is src/recall.ts.
 *
 * Pure by construction, so test/quiz.test.mjs bundles it without an Obsidian
 * runtime.
 */
import { significantTokens, type EvidenceUnit } from "./pageIndex";
import type { CueShape } from "./schemas";

// ---- types -------------------------------------------------------------------

/** Where a quiz draws its evidence from, and what to call that in a sentence. */
export interface QuizScope {
  kind: "all" | "note" | "query";
  label: string;
}

/**
 * How a missed point is described to the card writer. `skipped` is not
 * `incorrect`: it covers every point the reader did not produce, and
 * `incorrect` one they contradicted.
 */
export type Verdict = "correct" | "partial" | "incorrect" | "skipped";

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
  allUnits: EvidenceUnit[],
  activePath: string | null,
  scorer: (text: string) => number | null,
  poolSize: number,
): { pool: EvidenceUnit[]; label: string } {
  const units = allUnits.filter(quizzable);
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

/**
 * Whether a passage can carry a quiz question at all.
 *
 * The wiki's minimum information principle: an item tests one fact, so it has
 * to contain one. A note's index also yields things that are not statements —
 * a section heading ("Segment Angles"), a table row, the "Digested from …"
 * provenance line a digest leaves at the top — and each of those cost the
 * quiz two model calls and a "Skipped a passage" line before it was set
 * aside. A statement is at least a short sentence: five words, three of which
 * mean something, and not a table row or a provenance note. Ask keeps
 * indexing everything; only the quiz pool is narrowed.
 */
export function quizzable(unit: Pick<EvidenceUnit, "text">): boolean {
  const text = unit.text.trim();
  if (!text || text.startsWith("|") || text.startsWith("#")) return false;
  if (/^digested from\b/i.test(text)) return false;
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words.length >= 5 && significantTokens(text).length >= 3;
}

/** The file name without its folder or extension — the fallback label for an empty note. */
function basename(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}


// ---- word arithmetic ----------------------------------------------------------

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


// ---- misses --------------------------------------------------------------------

/**
 * One point the reader did not produce, as the inbox receives it: the passage,
 * the cue they were answering, and what the grader made of the failure.
 */
export interface QuizMiss {
  unit: EvidenceUnit;
  /** The cue the reader was answering: what they were asked to recall. */
  question: string;
  /** What the card should end up testing: the point itself. */
  answer: string;
  verdict: Verdict;
  gap: Gap;
  gapNote: string;
  /** The shape the section was asked in — the lens the card should take. */
  shape?: CueShape;
  /** The inbox label, when it should not be the question. */
  title?: string;
}

/**
 * The per-highlight instruction the card writer reads.
 *
 * It names the cue and the point so the card tests what the reader failed to
 * produce rather than whichever fact in the passage the writer would have
 * picked, and it passes the diagnosis on: a misconception wants a card whose
 * front rules the wrong belief out, a partial wants only the missing half.
 *
 * This is where the flashcard rules belong. The quiz asks for whole sections,
 * because free recall tests how a section holds together; the card written
 * from a miss is reviewed for years one detail at a time, so it is focused,
 * precise, consistent and effortful (the wiki's five properties), and the
 * lens comes from the shape of the section the point was in.
 */
export function renderMissInstruction(miss: QuizMiss): string {
  const how =
    miss.verdict === "incorrect"
      ? "stated something the note contradicts"
      : miss.verdict === "partial"
        ? "produced only part of it, or only when cued"
        : "did not produce it";
  const lines = [
    `The reader missed this point when asked to recall a section of their notes from memory; they ${how}.`,
    `They were asked: ${miss.question}`,
    `The point: ${miss.answer}`,
  ];
  if (miss.gap !== "none" && miss.gapNote.trim()) lines.push(`What went wrong — ${miss.gap}: ${miss.gapNote.trim()}`);
  lines.push(missLens(miss));
  lines.push(
    "Write the card that tests this point and not another fact from the passage. The card is focused on one thing, precise about what it asks, answered the same way every time, and demands real recall: not a yes/no, and not a blank the shape of the sentence fills in.",
  );
  return lines.join("\n");
}

/** Which way to card the miss, from what the reader failed at and the shape of the section. */
function missLens(miss: QuizMiss): string {
  if (miss.gap === "misconception") {
    return "They hold a wrong belief, so the front must rule it out: ask what separates the point from what they said, and keep the wrong belief out of the visible text so nothing on the card suggests it.";
  }
  if (miss.gap === "vocabulary") {
    return "They had the idea but not the word: put the role or definition on the front and make the term itself the answer, so the retrieval is the word.";
  }
  if (miss.verdict === "partial") {
    return "Card only the part they left out: narrow the question to what the point has that their answer lacked, rather than re-asking the whole.";
  }
  if (miss.shape === "procedure") {
    return "This point is a step in a procedure: give its position on the front (what comes after the step before it, or when it applies) and make the step the answer. One step per card, never the whole sequence.";
  }
  if (miss.shape === "classification") {
    return "This point is one member of a set: put what the member is or does on the front and make its name the answer, or the reverse. One member per card, never the list.";
  }
  if (miss.shape === "mechanism") {
    return "This point is part of a mechanism: card it in one direction, cause on the front and effect as the answer, so the reader produces the link rather than recognises it.";
  }
  return "Card the fact itself, and if the passage says why it holds, a second card from that reason to the fact, so the fact has a hook and is not a bare pairing.";
}

const TITLE_MAX = 80;

/** The highlight's label in the inbox: the question, cut to fit a title. */
export function missTitle(miss: Pick<QuizMiss, "question" | "title">): string {
  const q = (miss.title || miss.question).trim().replace(/\s+/g, " ");
  if (q.length <= TITLE_MAX) return q;
  return q.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, "") + "…";
}

