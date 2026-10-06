/**
 * Output schemas for the quiz calls.
 *
 * They live here rather than in llm.ts so a test that only wants to
 * `safeParse` a pasted JSON object can bundle a file with no backend and no
 * class to construct. This file imports nothing but zod, so
 * `test/prompt.test.mjs` bundles it the same way it bundles `src/prompt.ts`.
 *
 * Serialized strictly (`z.toJSONSchema` in src/codex.ts:150), which means
 * every field is required: no `.optional()`, no `.default()`, no `z.record`,
 * no unions of objects. Same shape as `CardsOut` in src/llm.ts.
 */
import { z } from "zod";

/**
 * The shape of what a free-recall cue asks for. It follows the knowledge in
 * the section, not a difficulty: a procedure is recalled in order, a
 * classification by its members, a mechanism by its causes, a concept by what
 * it is and what follows from it.
 */
export const CueShape = z.enum(["concept", "procedure", "classification", "mechanism"]);
export type CueShape = z.infer<typeof CueShape>;

/** One free-response quiz question on one section of a note, with the points a full answer contains. */
export const QuizQuestionOut = z.object({
  question: z
    .string()
    .describe(
      "One free-response question about the section's main idea, answerable from memory in two to four sentences, in the reader's vocabulary. Never yes/no, multiple choice, fill in the blank, or a request to write everything down. It states none of the points it expects. No [n] markers, links, or ids.",
    ),
  shape: CueShape.describe(
    "concept: what it is and what follows from it; procedure: its steps in order; classification: its members and what each is; mechanism: why or how it happens.",
  ),
  expects: z
    .array(z.number().int())
    .describe("The numbers of the points a full answer contains, e.g. [2, 3, 4]: at least one, at most four. The grader marks the answer against exactly these."),
});

/**
 * One quiz grade: a mark for every numbered point the question expects, and
 * a sentence of feedback. `said` is the reader's own words for the point,
 * copied from their answer, which is what the software checks.
 */
export const QuizRecallGradeOut = z.object({
  points: z
    .array(
      z.object({
        n: z.number().describe("The number of the point being marked."),
        status: z
          .enum(["recalled", "partial", "missed", "wrong"])
          .describe(
            "recalled: the answer carries the point, in any wording; partial: it has the point's shape and misses a part; missed: absent; wrong: the answer states something this point contradicts.",
          ),
        said: z
          .string()
          .describe("For recalled, partial or wrong: the words of the student's answer that carry it, copied character for character. Empty when missed."),
        note: z.string().describe("For partial or wrong: one short clause naming the missing part or the wrong belief. Empty otherwise."),
        cue: z
          .string()
          .describe(
            "For partial or missed: a few words that point at where the point sits without stating it, such as 'the step after asking permission'. Empty for recalled or wrong.",
          ),
      }),
    )
    .describe("One entry per numbered point, in order."),
  feedback: z
    .string()
    .describe("Two or three sentences in the notes' own words: what the answer got right, then what a full answer adds and how it ties to what the student said. No new facts."),
});

export type QuizQuestionDraft = z.infer<typeof QuizQuestionOut>;
export type QuizRecallGradeDraft = z.infer<typeof QuizRecallGradeOut>;
