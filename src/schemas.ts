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
 * One Ask response, structured so the software assembles the answer itself.
 *
 * The model no longer writes a paragraph with `[n]` markers inside it. It
 * reports the passages it leaned on, then the answer one sentence at a time,
 * each sentence carrying the evidence numbers that state it. That lets the
 * caller check every quote against the evidence it claims to come from, append
 * the citations, and remove a claim nobody cited, instead of trusting prose to
 * have cited itself.
 */
export const AskOut = z.object({
  coverage: z
    .enum(["full", "partial", "none"])
    .describe("full: the evidence answers the question; partial: it answers part; none: it does not touch the question."),
  quotes: z
    .array(
      z.object({
        n: z.number().describe("Evidence number the quote is copied from."),
        quote: z
          .string()
          .describe("A verbatim passage copied character for character from that evidence, the words the answer rests on."),
      }),
    )
    .describe("The passages the answer relies on, extracted before writing. Empty when coverage is none."),
  sentences: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "One sentence of the answer, in the reader's wording, with no [n] markers, links, or ids; the software appends the citations.",
          ),
        kind: z
          .enum(["claim", "gap"])
          .describe("claim: asserts something the evidence supports; gap: says what the evidence does not cover."),
        cited: z.array(z.number()).describe("Evidence numbers supporting this sentence. Required for a claim; empty for a gap."),
      }),
    )
    .describe("The answer, one sentence per entry, in order. A list item starts with '- '."),
});

/**
 * One verdict per drafted sentence, from the optional verify pass.
 *
 * `supported` is a plain boolean, which serializes as `{"type":"boolean"}` down
 * the same strict path as everything else in this file; `test/prompt.test.mjs`
 * proves that by running `z.toJSONSchema` over both schemas.
 */
export const VerifyOut = z.object({
  verdicts: z.array(
    z.object({
      i: z.number().describe("Index of the sentence in the draft, from 0."),
      supported: z.boolean().describe("true only when the cited evidence states what the sentence says."),
      reason: z.string().describe("One clause: which words are or are not in the evidence."),
    }),
  ),
});

export type DigestDraft = z.infer<typeof DigestOut>;
export type AskDraft = z.infer<typeof AskOut>;
export type VerifyDraft = z.infer<typeof VerifyOut>;
