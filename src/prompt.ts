/**
 * Message assembly for the highlighter. Kept out of llm.ts so the block order
 * can be tested without a backend or an Obsidian runtime: this file must stay
 * free of `obsidian` imports.
 */

export interface HighlighterMessageArgs {
  noteTitle: string;
  body: string;
  transcript: string | null;
  maxSpans: number;
  standingInstructions: string;
  instruction: string;
}

/**
 * Build the user message for a highlight request.
 *
 * Block order follows Anthropic's long-context guidance: the long inputs (note,
 * then transcript) go at the top and the instructions come last, so the model
 * reads the task with the material already in view.
 */
export function buildHighlighterMessage(a: HighlighterMessageArgs): string {
  const transcript = a.transcript?.trim() ? a.transcript.trim() : "";
  const standing = a.standingInstructions.trim();
  const instruction = a.instruction.trim();
  const limit = transcript
    ? `The transcript is a recording of the lecture that accompanies this note. Select at most ${a.maxSpans} spans, and fewer when the transcript supports fewer.`
    : `Select at most ${a.maxSpans} spans.`;
  return [
    `<note title="${a.noteTitle}">\n${a.body}\n</note>`,
    transcript ? `<transcript>\n${transcript}\n</transcript>` : "",
    limit,
    standing ? `Standing instructions: ${standing}` : "",
    instruction ? `Instructions for this note: ${instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One highlight as the digest prompt sees it. `text` may be empty (a rectangle whose text could not be read). */
export interface DigestHighlightIn {
  id: string;
  page: number;
  text: string;
}

export interface DigestMessageArgs {
  pdfTitle: string;
  classCode: string;
  paperText: string;
  highlights: DigestHighlightIn[];
  existingTitles: string[];
  maxNotes: number;
  standingInstructions: string;
  instruction: string;
}

/**
 * Build the user message for a digest request.
 *
 * Same order as the highlighter: the two long inputs come first (the paper,
 * then the highlights made in it), the shorter lists next, and the
 * instructions last, so the model reads the task with the material in view.
 * A highlight with no text is still listed, because it can be assigned to a
 * topic by its page and its neighbours even when the rectangle carried no
 * readable text.
 */
export function buildDigestMessage(a: DigestMessageArgs): string {
  const paper = a.paperText.trim();
  const titles = a.existingTitles.map((t) => t.trim()).filter(Boolean);
  const standing = a.standingInstructions.trim();
  const instruction = a.instruction.trim();
  const highlights = a.highlights
    .map((h) => `<highlight id="${h.id}" page="${h.page}">${h.text}</highlight>`)
    .join("\n");
  return [
    paper ? `<paper title="${a.pdfTitle}" class="${a.classCode}">\n${paper}\n</paper>` : "",
    `<highlights>\n${highlights}\n</highlights>`,
    titles.length ? `<existing_notes>\n${titles.join("\n")}\n</existing_notes>` : "",
    `Write at most ${a.maxNotes} topic notes.`,
    standing ? `Standing instructions: ${standing}` : "",
    instruction ? `Instructions for this PDF: ${instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** One numbered piece of evidence for Ask. `page` is null for a claim that carries no page. */
export interface AskEvidenceIn {
  n: number;
  noteTitle: string;
  page: number | null;
  text: string;
}

export interface AskHistoryTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AskMessageArgs {
  question: string;
  evidence: AskEvidenceIn[];
  history: AskHistoryTurn[];
  standingInstructions: string;
}

/**
 * Build the user message for an Ask request.
 *
 * The evidence is the long input, so it goes first; the conversation so far
 * follows it; the question comes last. The evidence line carries the note
 * title and page in parentheses so the model can name its source in prose
 * without being handed a link to copy. The reader's standing instructions sit
 * just before the question, the same place the highlighter and digest messages
 * put theirs.
 *
 * The last line restates the order of work the schema expects (quotes first,
 * then one sentence at a time with its numbers). It sits after the question
 * rather than before the evidence because it is the task, and the task reads
 * last for the same reason the question does.
 */
export function buildAskMessage(a: AskMessageArgs): string {
  const lines = askEvidenceLines(a.evidence);
  const history = a.history.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n\n");
  const standing = a.standingInstructions.trim();
  return [
    `<evidence>\n${lines}\n</evidence>`,
    history ? `<history>\n${history}\n</history>` : "",
    standing ? `Standing instructions: ${standing}` : "",
    `Question: ${a.question.trim()}`,
    `Extract the passages you will rely on first, then write the answer one sentence at a time, each claim with the numbers of the evidence that states it.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The numbered evidence lines, shared by the ask and verify messages so the judge sees exactly what the writer saw. */
function askEvidenceLines(evidence: AskEvidenceIn[]): string {
  return evidence.map((e) => `[${e.n}] (${e.noteTitle}${e.page === null ? "" : `, p.${e.page}`}) ${e.text}`).join("\n");
}

/** One drafted sentence as the verify prompt sees it: its index in the draft, its text, and the numbers it cited. */
export interface VerifyMessageArgs {
  evidence: AskEvidenceIn[];
  sentences: Array<{ i: number; text: string; cited: number[] }>;
}

/**
 * Build the user message for the optional verify pass.
 *
 * Same order as the ask message: the evidence first, then the material to
 * judge, then the task. The citations are printed as `[1][3]` after each
 * sentence, the same shape the assembled answer shows the reader, so the model
 * is judging the sentence in the form it will be read in. A sentence that
 * cited nothing prints `[]`, which is visibly not a citation.
 */
export function buildVerifyMessage(a: VerifyMessageArgs): string {
  const draft = a.sentences
    .map((s) => `${s.i}. ${s.text} ${s.cited.length ? s.cited.map((n) => `[${n}]`).join("") : "[]"}`)
    .join("\n");
  return [
    `<evidence>\n${askEvidenceLines(a.evidence)}\n</evidence>`,
    `<draft>\n${draft}\n</draft>`,
    `Judge each sentence: supported only if the cited evidence states it.`,
  ].join("\n\n");
}
