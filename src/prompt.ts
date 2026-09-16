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
 * The last line restates the order of work the schema expects: answer, then
 * name the pieces it rests on. It sits after the question rather than before
 * the evidence because it is the task, and the task reads last for the same
 * reason the question does.
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
    `Answer from the evidence above, then name in used the one or two pieces the answer rests on.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The numbered evidence lines, shared by the ask and verify messages so the judge sees exactly what the writer saw. */
function askEvidenceLines(evidence: AskEvidenceIn[]): string {
  return evidence.map((e) => `[${e.n}] (${e.noteTitle}${e.page === null ? "" : `, p.${e.page}`}) ${e.text}`).join("\n");
}


/** A quiz question is written from the same numbered evidence Ask answers from, so the two share one shape. */
export type QuizEvidenceIn = AskEvidenceIn;

export interface QuizQuestionMessageArgs {
  evidence: QuizEvidenceIn[];
  difficulty: 1 | 2 | 3;
  askedQuestions: string[];
  retryOfN: number | null;
  retryAngle: string;
  standingInstructions: string;
  failure: string;
}

/** What each difficulty tier asks for, spelled out rather than left to the model's sense of "harder". */
const QUIZ_DIFFICULTY: Record<1 | 2 | 3, string> = {
  1: "a definition, a number, a name: recall of one fact",
  2: "a mechanism or reason: why or how something happens",
  3: "a distinction or application: what separates two similar things, or which case a rule applies to",
};

/**
 * Build the user message for one quiz question.
 *
 * Same order as the ask message: the evidence is the long input and goes
 * first, the questions already asked follow it so the model can see what not
 * to repeat, and the instructions narrow from there — the tier, then the retry
 * angle when there is one, then the reader's standing instructions, then the
 * reason the last attempt was rejected. The closing line is one sentence,
 * because by then everything it needs is above it.
 *
 * `already_asked` is omitted rather than printed empty: an empty block reads
 * as "nothing has been asked", which is true, but it also invites the model to
 * fill it, and an omitted block cannot be misread at all.
 */
export function buildQuizQuestionMessage(a: QuizQuestionMessageArgs): string {
  const asked = a.askedQuestions.map((q) => q.trim()).filter(Boolean);
  const standing = a.standingInstructions.trim();
  const failure = a.failure.trim();
  const angle = a.retryAngle.trim();
  return [
    `<evidence>\n${askEvidenceLines(a.evidence)}\n</evidence>`,
    asked.length ? `<already_asked>\n${asked.join("\n")}\n</already_asked>` : "",
    `Difficulty ${a.difficulty}: ${QUIZ_DIFFICULTY[a.difficulty]}.`,
    a.retryOfN === null ? "" : `Ask again about evidence [${a.retryOfN}] from a different angle than: ${angle}`,
    standing ? `Standing instructions: ${standing}` : "",
    failure ? `The previous attempt was rejected: ${failure}. Fix that.` : "",
    `Write one question.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface QuizGradeMessageArgs {
  evidence: QuizEvidenceIn;
  question: string;
  expected: string;
  userAnswer: string;
}

/**
 * Build the user message for one grade.
 *
 * The grader sees one piece of evidence, not the pool: the question was
 * written from that passage and is graded against it, and handing over the
 * rest would invite a verdict that rests on something the reader was never
 * asked about. The student's answer comes last of the four inputs, directly
 * above the task, because it is the thing being judged.
 */
export function buildQuizGradeMessage(a: QuizGradeMessageArgs): string {
  return [
    `<evidence>\n${askEvidenceLines([a.evidence])}\n</evidence>`,
    `<question>\n${a.question.trim()}\n</question>`,
    `<expected_answer>\n${a.expected.trim()}\n</expected_answer>`,
    `<student_answer>\n${a.userAnswer.trim()}\n</student_answer>`,
    `Grade the student's answer against the evidence.`,
  ].join("\n\n");
}

/** One existing wiki note as the suggest prompt sees it: its title, which of the two kinds it is, and its sections. */
export interface SuggestExistingNote {
  title: string;
  kind: "concept" | "entity";
  /** The note's `##` headings in order — its subtopics. Empty or absent for a note with none, or one not written yet. */
  sections?: string[];
}

export interface SuggestMessageArgs {
  pdfTitle: string;
  classCode: string;
  pages: Array<{ page: number; text: string }>;
  transcript: string | null;
  existingNotes: SuggestExistingNote[];
  alreadySelected: Array<{ page: number; text: string }>;
  perPage: number;
  remaining: number;
  standingInstructions: string;
  instruction: string;
}

/** How much of an already-selected passage is shown before it is cut: enough to recognise, not enough to re-quote. */
const ALREADY_SELECTED_CHARS = 80;

/** How many of a note's sections are listed. A page with more than this is an outline, not a note, and its first twenty say what it holds. */
const SECTIONS_SHOWN = 20;

/**
 * Build the user message for a suggest request.
 *
 * Same order as the digest message: the long inputs first (the pages of this
 * batch, then the transcript), the shorter lists next, and the instructions
 * last, so the model reads the task with the material already in view. Each
 * page is introduced by its own `[page N]` marker, because every span reports
 * the page it came from and a span that crossed a marker could not name one.
 *
 * Each existing note is listed with its `##` headings indented beneath it.
 * Shown titles alone, the model founded a new note for every subtopic it met
 * — "Receptor Subtypes" beside a pharmacology note that already had a
 * Receptors section — because it could not see that the subtopic had a home.
 * The headings are what let a span be filed inside the note it belongs to.
 *
 * The already-selected passages are printed cut to their first eighty
 * characters. They are there so the model does not offer the same passage
 * twice and can see which notes the earlier batches fed; printing them in full
 * would make the block rival the pages themselves for length and invite the
 * model to quote from it rather than from the paper.
 */
export function buildSuggestMessage(a: SuggestMessageArgs): string {
  const transcript = a.transcript?.trim() ? a.transcript.trim() : "";
  const standing = a.standingInstructions.trim();
  const instruction = a.instruction.trim();
  const body = a.pages.map((p) => `[page ${p.page}]\n${p.text}`).join("\n\n");
  const first = a.pages.length ? a.pages[0].page : 0;
  const last = a.pages.length ? a.pages[a.pages.length - 1].page : 0;
  const notes = a.existingNotes
    .map((n) => [`${n.title} (${n.kind})`, ...(n.sections ?? []).slice(0, SECTIONS_SHOWN).map((s) => `  ## ${s}`)].join("\n"))
    .join("\n");
  const selected = a.alreadySelected.map((s) => `p.${s.page}: ${cut(s.text, ALREADY_SELECTED_CHARS)}`).join("\n");
  const cap = transcript
    ? `The transcript is a recording of the lecture that accompanies these pages. Select at most ${a.perPage} spans per page and at most ${a.remaining} in this batch, and fewer when the transcript supports fewer.`
    : `Select at most ${a.perPage} spans per page and at most ${a.remaining} in this batch; fewer is the expected outcome.`;
  return [
    `<paper title="${a.pdfTitle}" class="${a.classCode}" pages="${first}-${last}">\n${body}\n</paper>`,
    transcript ? `<transcript>\n${transcript}\n</transcript>` : "",
    notes ? `<existing_notes>\n${notes}\n</existing_notes>` : "",
    selected ? `<already_selected>\n${selected}\n</already_selected>` : "",
    cap,
    standing ? `Standing instructions: ${standing}` : "",
    instruction ? `Instructions for this PDF: ${instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Cut a passage to `n` characters, marking the cut so a truncated line is never mistaken for the whole passage. */
function cut(text: string, n: number): string {
  const t = text.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** One question to turn into search terms for the reader's own notes. */
export interface KeywordsMessageArgs {
  question: string;
  /** Note titles in the vault, so the terms can be aimed at what is actually there. */
  noteTitles: string[];
}

/**
 * The keyword call's system prompt.
 *
 * Language-agnostic on purpose, as upstream: the model detects the question's
 * language and answers in it, rather than a hardcoded pair of languages that
 * breaks for everyone else. Concept names, not question words — "what is the
 * therapeutic index" searched for "what" and "index" finds nothing; searched
 * for "therapeutic index", "safety margin", "LD50" it finds the passage.
 */
export const KEYWORDS_SYSTEM = `You turn a reader's question into search terms for their own notes.

The notes are study notes: lecture highlights, definitions, and claims, written in the reader's own words. A plain keyword search over them has already failed or done badly, which is why you are being asked. Your job is to guess the words the notes themselves would use for the thing being asked about.

Rules:
- Detect the question's language and give terms in that language. Add the English equivalent as well when the concept has a standard English term, because study notes often keep the English name.
- Concept names and noun phrases, not questions. "contrastive learning", not "what is contrastive learning".
- Include synonyms, abbreviations and expansions: an abbreviation the question uses should appear spelled out, and a spelled-out term should appear abbreviated.
- Include the narrower terms a note would use for the thing asked about, not just the broad topic.
- If the question names something exactly, include that term verbatim.
- Five to ten terms, each one to five words, most specific first.`;

export function buildKeywordsMessage(a: KeywordsMessageArgs): string {
  const titles = a.noteTitles.slice(0, 200);
  const parts = [`<question>\n${a.question.trim()}\n</question>`];
  if (titles.length > 0) {
    // The titles are a hint, not a menu: a term that matches none of them is
    // still useful, because the passages inside a note carry words its title
    // never mentions.
    parts.push(`<note_titles>\n${titles.join("\n")}\n</note_titles>`);
  }
  parts.push("Give the search terms as JSON.");
  return parts.join("\n\n");
}
