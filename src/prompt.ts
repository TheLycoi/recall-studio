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
  /** The heading the reader filed this highlight under in their own note, when it came from one. */
  heading?: string;
  /** The reader's own words under the link, when there are any (src/pdflink.ts `PdfReference.notes`). */
  notes?: string;
}

/** One page the digest may file highlights into, as the prompt lists it. */
export interface DigestExistingNote {
  title: string;
  kind: "concept" | "entity";
  aliases: string[];
  /** The page's `##` headings, in order; the first twenty are shown. */
  sections: string[];
  /** The first sentence of its summary, or "". */
  summary: string;
  classCodes: string[];
  /** For a page in the run's class: each heading with the first sentence beneath it, so the model sees what the page already says. */
  outline?: Array<{ heading: string; lead: string }>;
}

export interface DigestMessageArgs {
  pdfTitle: string;
  classCode: string;
  paperText: string;
  highlights: DigestHighlightIn[];
  existingNotes: DigestExistingNote[];
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
  const notes = a.existingNotes
    .map((n) => {
      const parts: string[] = [n.kind];
      if (n.aliases.length) parts.push(`aliases: ${n.aliases.join(", ")}`);
      if (n.classCodes.length) parts.push(`class ${n.classCodes.join(", ")}`);
      const lines = [`${n.title.trim()} (${parts.join("; ")})`];
      const leads = new Map((n.outline ?? []).map((o) => [o.heading, o.lead.trim()]));
      for (const s of n.sections.slice(0, 20)) {
        const lead = leads.get(s);
        lines.push(lead ? `  ## ${s} — ${lead}` : `  ## ${s}`);
      }
      if (n.summary.trim()) lines.push(`  summary: ${n.summary.trim()}`);
      return lines.join("\n");
    })
    .join("\n");
  const standing = a.standingInstructions.trim();
  const instruction = a.instruction.trim();
  const highlights = a.highlights.map(renderDigestHighlight).join("\n");
  return [
    paper ? `<paper title="${a.pdfTitle}" class="${a.classCode}">\n${paper}\n</paper>` : "",
    `<highlights>\n${highlights}\n</highlights>`,
    notes ? `<existing_notes>\n${notes}\n</existing_notes>` : "",
    `Write at most ${a.maxNotes} topic notes.`,
    standing ? `Standing instructions: ${standing}` : "",
    instruction ? `Instructions for this PDF: ${instruction}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * One highlight as the model reads it. A highlight the reader wrote nothing
 * under is one line, as before. One with notes is a block: the quote, then the
 * reader's own words in their own markup, so the model sees both what the
 * slide said and what the reader made of it, and can tell the two apart.
 */
function renderDigestHighlight(h: DigestHighlightIn): string {
  const heading = h.heading?.trim();
  const attrs = `id="${h.id}" page="${h.page}"${heading ? ` heading="${heading.replace(/"/g, "&quot;")}"` : ""}`;
  const notes = h.notes?.trim();
  if (!notes) return `<highlight ${attrs}>${h.text}</highlight>`;
  return [`<highlight ${attrs}>`, `<quote>${h.text}</quote>`, "<reader_notes>", notes, "</reader_notes>", "</highlight>"].join("\n");
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

/** One page shown beside the evidence: what it is about and its subtopic headings. Context, never a citation target. */
export interface AskPageIn {
  title: string;
  summary: string;
  sections: string[];
}

export interface AskMessageArgs {
  question: string;
  evidence: AskEvidenceIn[];
  history: AskHistoryTurn[];
  standingInstructions: string;
  /** The pages the top evidence came from, when the caller loaded them. */
  pages?: AskPageIn[];
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
  // The pages go first: they are the longest input and the widest frame, and
  // the evidence that may be cited is read against them.
  const pages = (a.pages ?? [])
    .map((pg) =>
      [`Page: ${pg.title.trim()}`, pg.summary.trim() ? `Summary: ${pg.summary.trim()}` : "", pg.sections.length ? `Sections: ${pg.sections.join("; ")}` : ""]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  return [
    pages ? `<pages>\n${pages}\n</pages>` : "",
    `<evidence>\n${lines}\n</evidence>`,
    history ? `<history>\n${history}\n</history>` : "",
    standing ? `Standing instructions: ${standing}` : "",
    `Question: ${a.question.trim()}`,
    `Answer from the evidence above, then name in used the one or two pieces the answer rests on.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The numbered evidence lines, shared by the ask, quiz and relevance messages so the relevance judge sees exactly what the writer saw. */
function askEvidenceLines(evidence: AskEvidenceIn[]): string {
  return evidence.map((e) => `[${e.n}] (${e.noteTitle}${e.page === null ? "" : `, p.${e.page}`}) ${e.text}`).join("\n");
}


/** A quiz question is written from the same numbered evidence Ask answers from, so the two share one shape. */
export type QuizEvidenceIn = AskEvidenceIn;

export interface QuizQuestionMessageArgs {
  evidence: QuizEvidenceIn[];
  difficulty: 1 | 2 | 3;
  askedQuestions: string[];
  /** Expected answers already shown to the reader in earlier grades; the model must not ask for them again. */
  revealed: string[];
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
 * first, the questions already asked and the answers already shown follow it
 * so the model can see what not to repeat, and the instructions narrow from
 * there — the tier, then the reader's standing instructions, then the reason
 * the last attempt was rejected. The closing line is one sentence, because by
 * then everything it needs is above it.
 *
 * `already_asked` is omitted rather than printed empty: an empty block reads
 * as "nothing has been asked", which is true, but it also invites the model to
 * fill it, and an omitted block cannot be misread at all.
 */
export function buildQuizQuestionMessage(a: QuizQuestionMessageArgs): string {
  const asked = a.askedQuestions.map((q) => q.trim()).filter(Boolean);
  const standing = a.standingInstructions.trim();
  const failure = a.failure.trim();
  const revealed = a.revealed.map((r) => r.trim()).filter(Boolean);
  return [
    `<evidence>\n${askEvidenceLines(a.evidence)}\n</evidence>`,
    asked.length ? `<already_asked>\n${asked.join("\n")}\n</already_asked>` : "",
    // Every grade shows its expected answer, so these are on the reader's
    // screen; a question they answer is a scroll, not a recall.
    revealed.length ? `Already shown to the reader as answers, so do not ask for any of them again: ${revealed.join("; ")}` : "",
    `Difficulty ${a.difficulty}: ${QUIZ_DIFFICULTY[a.difficulty]}.`,
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
    ? `The transcript is a recording of the lecture, or a study guide the reader was given, that accompanies these pages. Select at most ${a.perPage} spans per page and at most ${a.remaining} in this batch, and fewer when the transcript supports fewer.`
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

/* --------------------------------------------------- relevance */

/** One question and the pool of passages retrieved for it, for the relevance call. */
export interface RelevanceArgs {
  question: string;
  candidates: AskEvidenceIn[];
  history: AskHistoryTurn[];
}

/** Counts entries, so one exchange: the previous question and its answer (the pending question is not in the history; `historyFor` drops it), which is enough for the judge to resolve a follow-up like "why is that". */
const RELEVANCE_HISTORY_ENTRIES = 2;

/**
 * The relevance call's system prompt.
 *
 * The judge is shown the same numbered lines the drafter will see and asked
 * only for numbers, so there is no opening for it to answer the question or
 * to paraphrase a passage on the way past. The hard part is the empty list:
 * a model asked "which of these is relevant" will reach for the closest miss
 * rather than say none, and the closest miss is exactly what makes an answer
 * look grounded when the notes do not cover the question.
 */
export const RELEVANCE_SYSTEM = `You judge which passages from a reader's own notes bear on a question.

The passages are lines from a student's notes and highlights: definitions, claims, formulas, and things they marked while reading. They are not an encyclopedia and they are not complete. Another model will write the answer from whichever passages you keep.

Your job is to judge, and only to judge. Do not answer the question. Do not summarize, rewrite, translate, or correct a passage. Return numbers.

<relevant>
A passage is relevant when it:
- states or defines what is asked about,
- gives the formula, mechanism, cause, or procedure that is asked for,
- gives an example, value, or case of the thing asked about,
- or directly bears on the question in some other way, such as contrasting the thing asked about with what it is being distinguished from.

When the question refers back to the conversation — "why is that", "what about the second one" — read it in the light of the history and judge against what it is actually asking.
</relevant>

<not_relevant>
- Sharing a word with the question is not relevance. A passage that mentions the term in passing, with nothing said about what was asked, is a miss.
- A passage about a different sense of the same word is not relevant: "a drug's half-life" does not answer a question about the half-life of an isotope. Being from the right subject area is not enough; the question is the test.
</not_relevant>

Order the numbers best first: the passage that most directly answers the question comes first.

When nothing bears on the question, return an empty list. Do not fall back on the closest miss. An empty list is what tells the reader their notes do not cover this, which is a true and useful thing to learn; a near-miss dressed up as evidence is not.

Never write a number that is not in the list you were given.

<examples>
Question: What does albumin do to a drug in the blood?
[1] (Pharmacology, p.1) Pharmacology is the study of the action of drugs.
[2] (Plasma Proteins, p.4) Albumin binds drugs in plasma; only the unbound fraction is active.
[3] (Plasma Proteins, p.5) Bound drug acts as a reservoir and is released as free drug is cleared.
relevant: [2, 3]. Passage 1 shares the vocabulary of the question and says nothing about albumin or binding, so it is dropped.

Question: What is the therapeutic index?
[1] (Receptors, p.2) Receptors transduce a signal to produce a biological effect.
[2] (Receptors, p.3) Affinity is how tightly a ligand binds its receptor.
[3] (Pharmacology, p.1) Pharmacology is the study of the action of drugs.
relevant: []. All three are from the right subject and none of them states, defines, or bears on the therapeutic index.
</examples>`;

/**
 * Build the user message for a relevance request.
 *
 * The candidates are rendered by `askEvidenceLines`, the same function that
 * renders them for the drafter, so number 7 means one line across both calls
 * and a verdict can be applied by position. The history comes first and short:
 * it is there to resolve a question that refers back, not to be reasoned with,
 * so only the last couple of turns are sent. The question and then the task
 * read last, as they do in the ask message.
 */
export function buildRelevanceMessage(args: RelevanceArgs): string {
  const history = args.history
    .slice(-RELEVANCE_HISTORY_ENTRIES)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n\n");
  const candidates = askEvidenceLines(args.candidates);
  return [
    history ? `<history>\n${history}\n</history>` : "",
    candidates ? `<candidates>\n${candidates}\n</candidates>` : "",
    `Question: ${args.question.trim()}`,
    `Name in relevant the numbers of the passages that bear on the question, best first. Name none if none does.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* --------------------------------------------------- aliases and tags */

/** One page the aliases call is asked about: what it is called, what kind it is, and enough of it to tell. */
export interface AliasesPageIn {
  title: string;
  kind: "concept" | "entity";
  excerpt: string;
}

export interface AliasesMessageArgs {
  pages: AliasesPageIn[];
  /** The closed vocabulary a concept's tag comes from, in the order the reader sees it. */
  conceptTags: readonly string[];
  /** The same for an entity. */
  entityTags: readonly string[];
}

/**
 * How much of a page's definition the model is shown.
 *
 * The first paragraph of a page says what it is, and what it is called is
 * almost always in its first sentence — "the anterior cruciate ligament
 * (ACL)". Sending the whole page would pay for the rest of it to learn
 * nothing more, so the excerpt stops here and the cut is marked so the model
 * reads a truncated sentence as truncated rather than as the page's own
 * phrasing.
 */
export const ALIASES_EXCERPT_CHARS = 400;

/**
 * Build the user message for the aliases-and-tags request.
 *
 * The pages come first, because the vocabularies only mean anything once
 * there is something to apply them to, and both vocabularies are always sent
 * whichever kinds the batch happens to contain: the model reads each page's
 * `kind` and picks from that page's list, and seeing the other list is what
 * makes the boundary between the two legible. The lists arrive as arguments
 * rather than as an import, so this module stays free of the plugin's model
 * code and a test can pass its own.
 */
/** One side of a candidate pair, as the model sees it. */
export interface DuplicatePageIn {
  title: string;
  kind: "concept" | "entity";
  aliases: string[];
  excerpt: string;
}

export interface DuplicatePairIn {
  /** The number the verdict comes back under. */
  n: number;
  a: DuplicatePageIn;
  b: DuplicatePageIn;
  /** What the lint found the two pages share, in its own words. */
  shared: string;
}

export interface DuplicatesMessageArgs {
  pairs: DuplicatePairIn[];
}

/**
 * Build the user message for the duplicate-verification request: every pair
 * numbered, both pages with their kind, aliases and the opening of their own
 * definition (cut at `ALIASES_EXCERPT_CHARS`, the cut marked), then the fact
 * the lint found them sharing. The verdict is matched back by number, never
 * by position, so a skipped pair cannot shift the rest.
 */
export function buildDuplicatesMessage(a: DuplicatesMessageArgs): string {
  const page = (pg: DuplicatePageIn): string => {
    const excerpt = pg.excerpt.trim();
    const cut = excerpt.length > ALIASES_EXCERPT_CHARS ? `${excerpt.slice(0, ALIASES_EXCERPT_CHARS)}…` : excerpt;
    return `<page title="${pg.title.trim()}" kind="${pg.kind}" aliases="${pg.aliases.map((x) => x.trim()).filter(Boolean).join(", ")}">\n${cut}\n</page>`;
  };
  const pairs = a.pairs.map((p) => `<pair n="${p.n}">\n${page(p.a)}\n${page(p.b)}\n<shared>${p.shared.trim()}</shared>\n</pair>`).join("\n");
  return [`<pairs>\n${pairs}\n</pairs>`, "Return one verdict per pair, by its number."].join("\n\n");
}

export function buildAliasesMessage(a: AliasesMessageArgs): string {
  const pages = a.pages
    .map((pg) => {
      const excerpt = pg.excerpt.trim();
      const cut = excerpt.length > ALIASES_EXCERPT_CHARS ? `${excerpt.slice(0, ALIASES_EXCERPT_CHARS)}…` : excerpt;
      return `<page title="${pg.title.trim()}" kind="${pg.kind}">\n${cut}\n</page>`;
    })
    .join("\n");
  return [
    `<pages>\n${pages}\n</pages>`,
    `Concept tags: ${a.conceptTags.join(", ")}\nEntity tags: ${a.entityTags.join(", ")}`,
    "Return one entry per page, in the same order, with the title copied exactly.",
  ].join("\n\n");
}

/** One wiki page as the title scan sees it: its names, never its text. */
export interface TitleScanPageIn {
  title: string;
  kind: string;
  aliases: string[];
}

export interface TitleScanArgs {
  pages: TitleScanPageIn[];
}

/**
 * Build the user message for the title scan: every page as one self-closing
 * line of title, kind and aliases, and nothing of its body. The scan is over
 * names on purpose — it is the one pass that sees the whole wiki at once, and
 * it can only afford to because a line per page is all it sends. The pairs
 * come back as titles, so the closing line asks for them copied exactly: a
 * title the model retypes is one the code cannot resolve to a page.
 */
export function buildTitleScanMessage(a: TitleScanArgs): string {
  const pages = a.pages
    .map((pg) => `<page title="${pg.title.trim()}" kind="${pg.kind}" aliases="${joinNames(pg.aliases)}" />`)
    .join("\n");
  return [
    `<pages>\n${pages}\n</pages>`,
    "Return the pairs of pages that are one subject under two names, both titles copied exactly as they appear above. Return no pairs when there are none.",
  ].join("\n\n");
}

/** One numbered sentence from a page's prose that no quote on the page was found to cover. */
export interface ReviewClaimIn {
  n: number;
  text: string;
}

/** One page sent for review: its attributes, its (possibly clamped) body, its residue claims, and the link keys it already has. */
export interface ReviewPageIn {
  /** Where the page lives, for matching the verdict back; never rendered, since the model answers by title. */
  path?: string;
  title: string;
  kind: "concept" | "entity";
  tags: string[];
  aliases: string[];
  body: string;
  /** Headings of the sections cut from `body` to fit the budget; empty when the body is whole. */
  omitted: string[];
  claims: ReviewClaimIn[];
  /** Link keys the page already links to, so a nomination can skip them. */
  linked: string[];
}

/** One page of the wiki, as the directory lists it: the set a link nomination must choose from. */
export interface DirectoryEntry {
  /** Where the page lives; never rendered, for the same reason as `ReviewPageIn.path`. */
  path?: string;
  title: string;
  kind: string;
  aliases: string[];
}

export interface ReviewArgs {
  pages: ReviewPageIn[];
  directory: DirectoryEntry[];
}

/**
 * Build the user message for the page review.
 *
 * The directory comes first, once per request, so that every link the model
 * nominates is a choice from pages that exist rather than a name it expects
 * to exist. Then each page whole: attributes, the body as the caller clamped
 * it (with the cut sections named after it, so a missing section reads as
 * cut rather than absent), the residue claims under the numbers the verdicts
 * come back under, and the link keys the page already has. The claims are
 * matched back by number and the pages by title, never by position.
 */
export function buildReviewMessage(a: ReviewArgs): string {
  const directory = a.directory
    .map((d) => {
      const names = joinNames(d.aliases);
      return `${d.title.trim()} (${d.kind})${names ? `: ${names}` : ""}`;
    })
    .join("\n");
  const pages = a.pages
    .map((pg) => {
      const lines = [
        `<page title="${pg.title.trim()}" kind="${pg.kind}" tags="${joinNames(pg.tags)}" aliases="${joinNames(pg.aliases)}">`,
        `<body>\n${pg.body}\n</body>`,
      ];
      if (pg.omitted.length) lines.push(`Sections not shown: ${pg.omitted.join(", ")}`);
      const claims = pg.claims.map((c) => `<claim n="${c.n}">${c.text.trim()}</claim>`).join("\n");
      lines.push(claims ? `<claims>\n${claims}\n</claims>` : "<claims></claims>");
      lines.push(`<linked>${pg.linked.join(", ")}</linked>`);
      lines.push("</page>");
      return lines.join("\n");
    })
    .join("\n");
  return [
    `<directory>\n${directory}\n</directory>`,
    `<pages>\n${pages}\n</pages>`,
    "Return one entry per page, with its title copied exactly. Answer every claim by its number. Copy each link target exactly from the directory, and set kind to none unless the page is plainly filed wrong.",
  ].join("\n\n");
}

/** Names for an attribute: trimmed, blanks dropped, comma-separated. */
function joinNames(names: string[]): string {
  return names
    .map((x) => x.trim())
    .filter(Boolean)
    .join(", ");
}
