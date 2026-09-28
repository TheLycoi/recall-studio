/**
 * The pure half of sending an Ask answer to the inbox: which file the row
 * links to, and the text, title and writer instruction it carries. No
 * `obsidian` import, so it is tested directly (test/askCapture.test.mjs);
 * `captureAskAnswer` in src/capture.ts supplies the PDF lookup, the
 * duplicate check and the store.
 */
import { renderAnswerHighlight, renderAnswerInstruction } from "./askCheck";
import { renderPdfSubpath } from "./pdflink";
import { missTitle } from "./quiz";
import type { EvidenceUnit } from "./retrieval";
import { basenameNoExt, plainText } from "./util";

/** Finds `<pdfBasename>.pdf` as linked from `notePath`, or null when the vault has no such file. */
export type ResolvePdf = (pdfBasename: string, notePath: string) => { path: string } | null;

/** Where an inbox row built from one evidence unit points. */
export interface UnitSource {
  sourcePath: string;
  page: number | null;
  heading: string | null;
  subpath: string | undefined;
  /** The unit's note, set only when the source resolved to its PDF (the note is then the concept the row belongs to). */
  topicPath: string | undefined;
}

/**
 * The one PDF-or-note resolution for a unit, shared by quiz misses and Ask
 * answers: a unit backed by a PDF highlight whose file resolves points at the
 * exact PDF++ selection; anything else points at the note, headed by its title.
 */
export function resolveUnitSource(unit: EvidenceUnit, resolvePdf: ResolvePdf): UnitSource {
  if (unit.pdfBasename && unit.target) {
    const pdf = resolvePdf(unit.pdfBasename, unit.notePath);
    if (pdf) {
      return {
        sourcePath: pdf.path,
        page: unit.page,
        heading: `page ${unit.page}`,
        subpath: renderPdfSubpath(unit.target),
        topicPath: unit.notePath,
      };
    }
  }
  return { sourcePath: unit.notePath, page: null, heading: unit.noteTitle, subpath: undefined, topicPath: undefined };
}

/** The first sentence of a general-knowledge row's instruction, so the writer and the inbox reader both see it. */
export const GENERAL_KNOWLEDGE_NOTE =
  "This answer came from the model's general knowledge, not the notes; verify it before learning it.";

export interface AskRowArgs {
  question: string;
  answer: string;
  cited: Array<{ unit: EvidenceUnit; why: string }>;
  /** The answer rests on no note: it is carded with a visible "unverified" note, linked to `fallbackSourcePath`. */
  generalKnowledge: boolean;
  /** The note a general-knowledge row links to (the active note or the class topic note). */
  fallbackSourcePath?: string;
  resolvePdf: ResolvePdf;
}

/** Everything `makeHighlight` needs for an Ask row, besides `sourceTitle` and `origin`. */
export interface AskRow extends UnitSource {
  text: string;
  line: number;
  title: string;
  instruction: string;
}

/**
 * Build the inbox row for an answer, or say why it cannot be carded. A
 * grounded answer takes its source from its first cited passage; a
 * general-knowledge answer (nothing cited) is linked to the fallback note and
 * its instruction opens with `GENERAL_KNOWLEDGE_NOTE`.
 */
export function buildAskRow(args: AskRowArgs): AskRow | { reason: string } {
  const answer = plainText(args.answer);
  if (!answer) return { reason: "the answer is empty." };
  const title = missTitle({ question: args.question });
  const first = args.cited[0]?.unit;
  if (first) {
    const text = renderAnswerHighlight(
      answer,
      args.cited.map(({ unit }) => ({ noteTitle: unit.noteTitle, page: unit.page, text: plainText(unit.text) })),
    );
    if (text.trim().length < 3) return { reason: "the answer is empty." };
    const source = resolveUnitSource(first, args.resolvePdf);
    if (!source.sourcePath) return { reason: "this answer has no source to link a card to." };
    let instruction = renderAnswerInstruction(
      args.question,
      args.cited.map(({ unit, why }) => ({ noteTitle: unit.noteTitle, why })),
    );
    if (args.generalKnowledge) instruction = `${GENERAL_KNOWLEDGE_NOTE}\n${instruction}`;
    return { ...source, text, line: 0, title, instruction };
  }
  if (!args.generalKnowledge) return { reason: "this answer cites no note, so there is no source to link a card to." };
  const fallback = args.fallbackSourcePath?.trim() ?? "";
  if (!fallback) return { reason: "this general-knowledge answer has no note to link a card to; open a note or pick a class first." };
  if (answer.length < 3) return { reason: "the answer is empty." };
  return {
    sourcePath: fallback,
    page: null,
    heading: basenameNoExt(fallback),
    subpath: undefined,
    topicPath: undefined,
    text: answer,
    line: 0,
    title,
    instruction: [
      GENERAL_KNOWLEDGE_NOTE,
      `Question: ${args.question.trim()}`,
      "Card what answers the question. Each card is focused on one thing, precise about what it asks, answered the same way every time, and demands real recall: not a yes/no, and not a blank the shape of the sentence fills in.",
    ].join("\n"),
  };
}
