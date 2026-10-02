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
          "The page's opening: two to five sentences defining or describing the topic, drawn from the highlights, the reader's notes and the paper. Cite a highlight after the sentence it supports as [H03] or [H03, H04]; mention another page as {{Its Title}} copied exactly; never write brackets or links yourself.",
        ),
      sections: z
        .array(
          z.object({
            heading: z.string().describe("A subtopic of this page, a short noun phrase in Title Case; unique within the note."),
            prose: z
              .string()
              .describe(
                "One lead sentence that says what this branch is, then a newline and a markdown bullet list, never a paragraph: one claim per bullet, its term in bold at the front (\"- **Epimysium** covers the whole muscle [H03]\"), a sub-point nested with a tab under its parent, two levels at most. Digested knowledge in your own words from the highlights filed here, the reader's notes under them and the paper, nothing from outside it. Cite a highlight after every bullet as [H03]; mention another page as {{Its Title}}.",
              ),
            quote_ids: z
              .array(z.string())
              .describe(
                'The highlights this section quotes verbatim beneath its prose, e.g. ["H03","H04"]: every highlight filed under this page goes in exactly one section, except slide titles and logistics, which go in unused_ids.',
              ),
          }),
        )
        .describe("One to four sections, each a subtopic with prose and the highlights it rests on. At least one."),
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
 * Grounding now starts in the prompt, which tells the model to answer from
 * the given notes and nothing else, and in the sources it names; the panel
 * then drops citations that point at no evidence and matches each sentence
 * of the answer against the cited notes (src/askCheck.ts,
 * src/answerClaims.ts), listing the unmatched ones rather than deleting them.
 * `used` is short on purpose — the one or two notes that actually carry the
 * answer, not everything retrieval happened to return.
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
 * The shape of what a free-recall cue asks for. It follows the knowledge in
 * the section, not a difficulty: a procedure is recalled in order, a
 * classification by its members, a mechanism by its causes, a concept by what
 * it is and what follows from it.
 */
export const CueShape = z.enum(["concept", "procedure", "classification", "mechanism"]);
export type CueShape = z.infer<typeof CueShape>;

/** One free-recall cue for one section of a note. */
export const QuizCueOut = z.object({
  cue: z
    .string()
    .describe(
      "One question naming the section's subject and the shape of what to recall, in the reader's vocabulary; it states none of the points. No [n] markers, links, or ids.",
    ),
  shape: CueShape.describe(
    "concept: what it is and what follows from it; procedure: its steps in order; classification: its members and what each is; mechanism: why or how it happens.",
  ),
});

/**
 * One free-recall grade: a mark for every numbered point of the section, and
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
    .describe("One or two sentences in the notes' own words on what the recall held together and which idea is missing. No new facts."),
});

export type QuizCueDraft = z.infer<typeof QuizCueOut>;
export type QuizRecallGradeDraft = z.infer<typeof QuizRecallGradeOut>;


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
      label: z.string().describe("At most six words naming the fact this span carries; it becomes the text of the link that opens the PDF there."),
      text: z
        .string()
        .describe(
          "One to three sentences of digested knowledge in your own words, drawn from the span and the page around it and from nothing outside the paper: what a reader revising later wants under that link. Empty when verbatim is true.",
        ),
      verbatim: z
        .boolean()
        .describe(
          "True when the span's exact wording is itself what the page should keep — a formula, a definition, a list of criteria — in which case the plugin quotes it and ignores text.",
        ),
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
 * Which of the retrieved passages bear on the question.
 *
 * Reimplemented from the per-result relevance filter in stanford-oval/WikiChat,
 * batched into one call: the model is shown the whole numbered pool and names
 * the numbers worth keeping, best first. Omission is the verdict — a number it
 * does not name is dropped — so the model never has to write "no" about a
 * passage, and an empty list is the honest answer when the notes do not cover
 * what was asked. Numbers only: nothing here can rewrite a passage or put a
 * model's words between the reader and their own note.
 */
export const RelevanceOut = z.object({
  relevant: z.array(z.number()).describe("Numbers of the passages that bear on the question, best first. Empty when none does."),
});

export type RelevanceVerdict = z.infer<typeof RelevanceOut>;

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

export const DuplicatesOut = z.object({
  pairs: z.array(
    z.object({
      n: z.number().int().describe("The pair's number, copied exactly from the input."),
      same: z.boolean().describe("true only when both pages are about one subject under two names; false for related, overlapping, or part-and-whole pages."),
      reason: z.string().describe("One sentence: what in the excerpts decided it."),
    }),
  ),
});
export type DuplicatesDraft = z.infer<typeof DuplicatesOut>;

/**
 * Pairs of pages the title scan reads as one subject under two names.
 *
 * Titles, not paths or numbers: the scan is shown titles only, and the code
 * resolves each one back to a page and drops a pair it cannot resolve, so a
 * title the model misspells costs one pair and never a wrong merge offer.
 */
export const TitleScanOut = z.object({
  pairs: z
    .array(
      z.object({
        a: z.string().describe("One page's title, copied exactly from the list."),
        b: z.string().describe("The other page's title, copied exactly from the list."),
        reason: z
          .string()
          .describe("One sentence naming what joins the two names: an abbreviation and its expansion, a spelling variant, a plural, a translation, or an older name."),
      }),
    )
    .describe("Pairs of pages that are one subject under two names. Empty when there are none."),
});
export type TitleScanDraft = z.infer<typeof TitleScanOut>;

/**
 * The page review, as the model returns it.
 *
 * The contract the verifier in src/lintReview.ts reads has `kind` as a
 * verdict or null. A nullable object serializes as `anyOf`, which the strict
 * serializers reject (see the note at the top of this file), so on the wire
 * "no verdict" is the sentinel `none` with an empty reason, the same way
 * `VerdictOut` in src/llm.ts uses empty strings for fields that do not apply.
 * `reviewDraftOf` turns the sentinel into null before anything else sees it,
 * so `ReviewDraft` is the contract shape and `none` never reaches a caller.
 */
export const ReviewOut = z.object({
  pages: z.array(
    z.object({
      title: z.string().describe("The page title, copied exactly from the input."),
      kind: z
        .object({
          kind: z
            .enum(["concept", "entity", "none"])
            .describe("none unless the page is plainly filed under the wrong kind; then the kind it belongs under."),
          reason: z.string().describe("One sentence on what makes the page the other kind. Empty string when kind is none."),
        })
        .describe("A verdict on the page's kind, given only when it is plainly filed wrong."),
      claims: z
        .array(
          z.object({
            n: z.number().int().describe("The claim's number, copied exactly from the input."),
            supported: z.boolean().describe("true only when a quote on this page states the claim."),
            by: z
              .string()
              .describe("The fragment of that quote that states the claim, at most twelve words, copied word for word. Empty string when unsupported."),
            reason: z.string().describe("One sentence: what the page's quotes do or do not say about the claim."),
          }),
        )
        .describe("One verdict per numbered claim sent with this page."),
      links: z
        .array(
          z.object({
            target: z.string().describe("A directory title, copied exactly, that the page's prose plainly discusses and does not already link to."),
            reason: z.string().describe("One sentence naming where the prose discusses the target."),
          }),
        )
        .describe("At most three pages to link to. Empty when none is plainly discussed."),
    }),
  ),
});
export type ReviewWire = z.infer<typeof ReviewOut>;

/** A kind verdict: the kind the page belongs under, and why. */
export interface ReviewKindVerdict {
  kind: "concept" | "entity";
  reason: string;
}

/** One page's review, with "no kind verdict" as null. */
export type ReviewPageDraft = Omit<ReviewWire["pages"][number], "kind"> & { kind: ReviewKindVerdict | null };

export interface ReviewDraft {
  pages: ReviewPageDraft[];
}

/** The wire review with the `none` kind sentinel turned into null. */
export function reviewDraftOf(wire: ReviewWire): ReviewDraft {
  return {
    pages: wire.pages.map((pg) => ({
      ...pg,
      kind: pg.kind.kind === "none" ? null : { kind: pg.kind.kind, reason: pg.kind.reason },
    })),
  };
}
