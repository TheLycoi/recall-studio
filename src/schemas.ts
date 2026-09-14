/**
 * Output schemas for the digest and Ask calls.
 *
 * They live here rather than in llm.ts for one reason: llm.ts imports the
 * Anthropic SDK and the backends, and the backends reach `obsidian`, so a test
 * that only wants to `safeParse` a pasted JSON object could not bundle it.
 * This file imports nothing but zod, so `test/prompt.test.mjs` bundles it the
 * same way it bundles `src/prompt.ts`. llm.ts re-exports both schemas, so
 * callers keep importing them from there.
 *
 * Both are serialized strictly (`z.toJSONSchema` in src/codex.ts:150,
 * `zodOutputFormat` in src/anthropic.ts:79), which means every field is
 * required: no `.optional()`, no `.default()`, no `z.record`, no unions of
 * objects. Same shape as `CardsOut` and `HighlightsOut` in src/llm.ts.
 */
import { z } from "zod";

/** One digest response: the topic notes to write, plus the highlights that belong to none of them. */
export const DigestOut = z.object({
  notes: z.array(
    z.object({
      title: z
        .string()
        .describe(
          "Topic note title, a short noun phrase in Title Case, unique in this response; reuse an existing title exactly when the highlights belong there.",
        ),
      summary: z
        .string()
        .describe(
          "Three to five sentences about this topic drawn from the paper, weighted toward the reader's highlights; no links, ids, or citations.",
        ),
      highlight_ids: z
        .array(z.string())
        .describe('Ids of the highlights that belong to this topic, e.g. ["H03","H04"]. At least one; every id must appear in the input.'),
      related: z.array(z.string()).describe("Titles of other notes in this response or of the existing notes listed. Empty when none."),
    }),
  ),
  unused_ids: z.array(z.string()).describe("Ids of highlights that belong to no topic (slide titles, logistics, empty rectangles)."),
});

/**
 * One Ask response: the answer, and the notes it came from.
 *
 * The model used to return the answer as a list of sentences with evidence
 * numbers attached, so the software could verify every quote character by
 * character and delete any sentence whose quote it could not find. That check
 * was strict enough to be its own failure mode — a faithful sentence lost
 * because the model tidied a quote — and it made the reply a wall of evidence
 * rather than an answer.
 *
 * The grounding is now where the wiki upstream puts it: in the prompt, which
 * tells the model to answer from the given notes and nothing else, and in the
 * sources it names. `used` is short on purpose — the one or two notes that
 * actually carry the answer, not everything retrieval happened to return.
 */
export const AskOut = z.object({
  coverage: z
    .enum(["full", "partial", "none"])
    .describe("full: the notes answer the question; partial: they answer part of it; none: they do not."),
  from_general_knowledge: z
    .boolean()
    .describe(
      "True only when the notes did not answer the question and you answered from general knowledge instead. The reader is shown a warning to verify it.",
    ),
  answer: z
    .string()
    .describe(
      "The answer in plain markdown, a few sentences or a short list. No citation markers, no links, no headings: the sources are listed separately.",
    ),
  used: z
    .array(
      z.object({
        n: z.number().describe("Evidence number this answer actually drew on."),
        why: z.string().describe("A few words on what this note contributed, e.g. 'defines the term' or 'gives the formula'."),
      }),
    )
    .describe("The one or two pieces of evidence the answer rests on, best first. Empty only when coverage is none."),
});


export type DigestDraft = z.infer<typeof DigestOut>;
export type AskDraft = z.infer<typeof AskOut>;

/**
 * One quiz question, generated from a single numbered piece of evidence.
 *
 * `evidence_n` and `quote` exist so the software can check the question before
 * the reader sees it: src/quiz.ts looks the number up in the pool it sent and
 * checks the quote is in that evidence, the same substring check Ask uses for
 * its quotes. A question whose quote fails verification is regenerated once
 * and then dropped, so the model is never the last word on whether its own
 * question is grounded.
 */
export const QuizQuestionOut = z.object({
  question: z
    .string()
    .describe(
      "One focused, precise question with exactly one correct answer, answerable from the cited evidence alone, in the reader's own vocabulary; no [n] markers, links, or ids.",
    ),
  answer: z.string().describe("The expected answer in one short phrase or sentence, as the evidence states it. Never 'yes' or 'no'."),
  evidence_n: z.number().describe("The number of the one piece of evidence this question tests."),
  quote: z
    .string()
    .describe("The passage from that evidence which states the answer, copied verbatim, character for character."),
  hint: z.string().describe("One clause that narrows the question without giving the answer away."),
  kind: z
    .enum(["recall", "why", "distinguish"])
    .describe("recall: one fact, a definition, a number, a name; why: a mechanism or reason; distinguish: a contrast or an application."),
});

/**
 * One grade of a free-recall answer, judged against the single piece of
 * evidence the question came from.
 *
 * `quote` is checked the same way the question's is and shown only when it
 * verifies, which is what lets the reader overrule a grade they disagree with:
 * the passage that settled it is printed underneath the verdict.
 */
export const QuizGradeOut = z.object({
  verdict: z
    .enum(["correct", "partial", "incorrect"])
    .describe(
      "correct: the answer states what the evidence states, in any wording; partial: it states part of it, or is right but vague; incorrect: otherwise.",
    ),
  feedback: z
    .string()
    .describe("One or two sentences in the evidence's own words naming what the answer got right and what it missed. No new facts."),
  quote: z.string().describe("The passage from the evidence that settles the grade, copied verbatim, character for character."),
});

export type QuizQuestionDraft = z.infer<typeof QuizQuestionOut>;
export type QuizGradeDraft = z.infer<typeof QuizGradeOut>;

/**
 * One "suggest" response: the spans worth highlighting in a batch of PDF
 * pages, each assigned to the wiki note it belongs to, plus the notes that do
 * not exist yet and have to be written before those spans can land in them.
 *
 * The two arrays are returned together rather than in two calls because the
 * choice of span and the choice of note are the same judgement: a span is
 * worth keeping when it says something a named note would hold, and a note is
 * worth creating when spans keep arriving for it.
 */
export const SuggestOut = z.object({
  spans: z.array(
    z.object({
      page: z.number().int().describe("The number in the [page N] marker the quote was copied from; never a page outside this batch."),
      quote: z
        .string()
        .describe("The span itself, copied verbatim from that page, character for character, punctuation included; no ellipsis, no paraphrase."),
      label: z.string().describe("At most six words naming the fact this span carries."),
      note_title: z
        .string()
        .describe("The note this span belongs in: an existing title copied exactly, or the title of one of your new_notes."),
      note_kind: z
        .enum(["concept", "entity"])
        .describe("concept: a mechanism, a classification, a definition and what follows from it; entity: a named person, organisation, drug, instrument, or law."),
    }),
  ),
  new_notes: z.array(
    z.object({
      title: z.string().describe("Title of a note that does not exist yet, a short noun phrase in Title Case, unique in this response."),
      kind: z.enum(["concept", "entity"]).describe("Same two kinds as a span's note_kind, describing the note as a whole."),
      summary: z
        .string()
        .describe("Three to five sentences about this note drawn from the paper, in the reader's language; no links, ids, or page numbers."),
    }),
  ),
});

export type SuggestDraft = z.infer<typeof SuggestOut>;

/**
 * Keywords extracted from a question, for a second look at the notes.
 *
 * Adapted from gd4ai/obsidian-llm-wiki's query-keywords stage. The point is
 * not to answer anything: it is to turn "what makes someone stick with a new
 * habit" into the terms the notes would actually have used ("self-efficacy",
 * "maintenance", "relapse"), so a lexical search that found nothing gets a
 * second, better set of words to search with. The scan that follows is local
 * and costs nothing, so the one call buys a whole extra pass over the vault.
 */
export const KeywordsOut = z.object({
  keywords: z
    .array(z.string())
    .describe(
      "Five to ten short search terms for the reader's notes: concept names and synonyms a note would use, each one to five words, most specific first. No sentences, no question words.",
    ),
});
