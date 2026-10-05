/**
 * Message assembly for the quiz. Kept out of llm.ts so the block order can be
 * tested without a backend or an Obsidian runtime: this file must stay free
 * of `obsidian` imports.
 */

/** One section of a note as the quiz sends it: where it sits and its points, in note order. */
export interface QuizSectionIn {
  noteTitle: string;
  /** The heading path, "" for the note's lead. */
  section: string;
  /** Which run of a split section this is, of how many. */
  part: number;
  parts: number;
  points: string[];
}

export interface QuizQuestionMessageArgs extends QuizSectionIn {
  /** 1 state it, 2 explain it, 3 connect it: set by src/recall.ts from the answer before. */
  level: 1 | 2 | 3;
  /** The questions already asked in this sitting, oldest first. */
  asked: string[];
  standingInstructions: string;
  failure: string;
}

export interface QuizRecallGradeMessageArgs extends QuizSectionIn {
  question: string;
  answer: string;
  /** The second attempt, after a cue for each of these points. */
  cued: boolean;
}

/** Attribute values are single-line; a quote in a heading would close the attribute early. */
function attr(v: string): string {
  return v.replace(/"/g, "'").replace(/\s+/g, " ").trim();
}

/** The section block both quiz messages open with. */
function sectionBlock(a: QuizSectionIn): string {
  const part = a.parts > 1 ? ` part="${a.part} of ${a.parts}"` : "";
  const head = `<section note="${attr(a.noteTitle)}" path="${attr(a.section)}"${part} points="${a.points.length}">`;
  const lines = a.points.map((t, i) => `[${i + 1}] ${t}`).join("\n");
  return `${head}\n${lines}\n</section>`;
}

const LEVEL_NAME: Record<1 | 2 | 3, string> = { 1: "state it", 2: "explain it", 3: "connect it" };

/**
 * Build the user message for one quiz question.
 *
 * The section is the long input and goes first. The questions already asked,
 * the level, the reader's standing instructions and the reason the last
 * draft was rejected follow, each omitted when empty, and the task closes the
 * message in one line.
 */
export function buildQuizQuestionMessage(a: QuizQuestionMessageArgs): string {
  const standing = a.standingInstructions.trim();
  const failure = a.failure.trim();
  const asked = a.asked.map((q) => q.trim()).filter(Boolean);
  return [
    sectionBlock(a),
    asked.length ? `<already_asked>\n${asked.map((q) => `- ${q}`).join("\n")}\n</already_asked>` : "",
    `Level: ${a.level} (${LEVEL_NAME[a.level]}).`,
    standing ? `Standing instructions: ${standing}` : "",
    failure ? `The previous question was rejected: ${failure}. Fix that.` : "",
    "Write the question.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Build the user message for one quiz grade.
 *
 * The grader sees the points the question expects, the question the reader
 * saw, and the answer, which comes last of the three, directly above the
 * task, because it is the thing being judged. On the second attempt the
 * points are only the ones still open, and the message says so.
 */
export function buildQuizRecallGradeMessage(a: QuizRecallGradeMessageArgs): string {
  return [
    sectionBlock(a),
    `<question>\n${a.question.trim()}\n</question>`,
    a.cued
      ? "This is the student's second attempt, after a hint for each of the points above; they are the points the first attempt did not produce. Mark only these."
      : "",
    `<student_answer>\n${a.answer.trim()}\n</student_answer>`,
    "Mark every point.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
