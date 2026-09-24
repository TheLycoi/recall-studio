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
      passages: z
        .array(
          z.object({
            highlight_id: z.string().describe('The id of one highlight that belongs to this topic, e.g. "H03". Every id must appear in the input.'),
            label: z
              .string()
              .describe("At most six words naming the fact this highlight carries; it becomes the text of the link that opens the PDF there."),
            text: z
              .string()
              .describe(
                "One to three sentences of digested knowledge in your own words, drawing on the highlight, the reader's notes under it and the paper, and on nothing outside the paper. Empty when verbatim is true.",
              ),
            verbatim: z
              .boolean()
              .describe(
                "True when the highlight's exact wording is itself what the page should keep — a formula, a definition, a list of criteria — in which case the plugin quotes it and ignores text.",
              ),
            coverage: z
              .enum(["defined", "discussed", "named"])
              .describe(
                "How the source treats this highlight: defined when it says what the thing is, discussed when it says something substantive about it, named when it is only a title, a label or a passing mention. A named highlight is kept out of the page.",
              ),
          }),
        )
        .describe("The highlights that belong to this topic, one entry each. At least one."),
      related: z.array(z.string()).describe("Titles of other notes in this response or of the existing notes listed. Empty when none."),
      kind: z
        .enum(["concept", "entity"])
        .describe(
          "entity: a named person, organisation, agency, product, drug or event that is itself what the reader would look up; concept: a mechanism, method, theory, classification, phenomenon, or term. When unsure, prefer concept.",
        ),
      aliases: z
        .array(z.string())
        .describe(
          "One or two other names a reader would search for this note under: an abbreviation, the expanded form, a variant spelling. Empty only when the subject has one name.",
        ),
      tag: z
        .string()
        .describe(
          "The note's subtype, one word. For a concept: method, theory, term, phenomenon, standard, field, or other. For an entity: product, person, organization, project, event, place, or other.",
        ),
      closest_existing: z
        .string()
        .describe(
          "For a title not in the existing notes: the existing note this subject is most nearly part of, copied exactly; empty only when no listed note is related at all. Naming one means the highlights belong in that note under a heading. Empty for a title that is itself an existing note.",
        ),
      why_new: z
        .string()
        .describe(
          "For a title not in the existing notes: one sentence on the decision — why no listed note can hold it, or what makes it part of closest_existing. Empty for an existing title.",
        ),
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
  gap: z
    .enum(["none", "slip", "vocabulary", "detail", "misconception"])
    .describe(
      "What the answer reveals about the reader's understanding. none: nothing wrong worth recording. slip: they know it, the answer was careless or a typo. vocabulary: the idea is right but the term is missing or wrong. detail: the shape is right and a specific fact is missing. misconception: they hold a belief the evidence contradicts.",
    ),
  gapNote: z
    .string()
    .describe(
      "When gap is not none, one short clause naming the specific wrong belief or missing piece — what to probe next. Empty when gap is none.",
    ),
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
 *
 * A span may also name the section of an existing note it belongs under. The
 * model is shown each note's headings, and a subtopic of a note is filed
 * inside it — under a heading the note has, or one the plugin creates — rather
 * than founded as a second note beside it.
 *
 * A new note is the exception, reached only when nothing existing is related.
 * Each one names the closest existing note and says why it cannot live there,
 * so the decision is visible — and checkable: a "new" note that names a home
 * is filed into it by the planner rather than created.
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
        .describe(
          "entity: a named person, organisation, project, place or event, or a named product, drug or instrument that is itself what the reader would look up; concept: a mechanism, method, theory, classification, phenomenon, or any term explaining how something works — a named thing mentioned only as a tool or an example is a concept of its role, and when unsure prefer concept.",
        ),
      note_section: z
        .string()
        .describe(
          "The section of that note this span belongs under: one of the note's listed headings copied exactly, or a short new heading in Title Case when the span is a subtopic none of them covers. Empty when the span is about the note as a whole, and always empty for a note in new_notes.",
        ),
    }),
  ),
  new_notes: z.array(
    z.object({
      title: z.string().describe("Title of a note that does not exist yet, a short noun phrase in Title Case, unique in this response."),
      kind: z.enum(["concept", "entity"]).describe("Same two kinds as a span's note_kind, describing the note as a whole."),
      summary: z
        .string()
        .describe("Three to five sentences about this note drawn from the paper, in the reader's language; no links, ids, or page numbers."),
      closest_existing: z
        .string()
        .describe(
          "The existing note this subject is most nearly part of — a parent topic, a broader note, one whose headings it would sit under — copied exactly; empty only when no listed note is related at all. Naming one means the wall was not reached: the spans belong in that note, and the plugin files them there under a heading.",
        ),
      why_new: z
        .string()
        .describe(
          "One sentence on the decision: when closest_existing is empty, why no listed note can hold this subject; when it is set, what makes the subject part of that note.",
        ),
      aliases: z
        .array(z.string())
        .describe(
          "One or two other names a reader would search for this note under: an abbreviation, the expanded form, a variant spelling. Empty only when the subject has one name.",
        ),
      tag: z
        .string()
        .describe(
          "The note's subtype, one word. For a concept: method, theory, term, phenomenon, standard, field, or other. For an entity: product, person, organization, project, event, place, or other.",
        ),
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

/**
 * Aliases and a subtype tag for pages that lack them.
 *
 * The lint finds pages reachable only under their exact title and pages with
 * no subtype tag; this is the one model call the fixer makes, a batch of
 * pages in and one proposal per page out. Nothing here is written: every
 * proposal becomes a row in the fix plan that the reader ticks or leaves,
 * which is why the tag is a plain string rather than an enum — a tag outside
 * the kind's vocabulary is dropped to `other` and shown as such, and an enum
 * would make the whole batch fail to parse over one bad word.
 */
export const AliasesTagsOut = z.object({
  pages: z.array(
    z.object({
      title: z.string().describe("The page title, copied exactly from the input."),
      aliases: z
        .array(z.string())
        .describe(
          "One or two other names a reader would search for this page under — an abbreviation, the expanded form, a variant spelling — taken from the excerpt or common usage, never coined. Empty when the subject has one name.",
        ),
      tag: z.string().describe("The page's subtype, one word from the vocabulary given for its kind; other when none fits."),
    }),
  ),
});

export type AliasesTagsDraft = z.infer<typeof AliasesTagsOut>;
