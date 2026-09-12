import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AnthropicBackend } from "./anthropic";
import type { LlmBackend } from "./backend";
import { ClaudeCliBackend, ClaudeCliError } from "./claudeCli";
import { CodexBackend, CodexError } from "./codex";
import { buildExamplesBlock } from "./examples";
import type { BloomLevel, Card, Highlight } from "./model";
import type { AskMessageArgs, DigestMessageArgs, VerifyMessageArgs } from "./prompt";
import { buildAskMessage, buildDigestMessage, buildHighlighterMessage, buildVerifyMessage } from "./prompt";
import { AskOut as AskOutSchema, DigestOut as DigestOutSchema, VerifyOut as VerifyOutSchema } from "./schemas";
import type { AskDraft, DigestDraft, VerifyDraft } from "./schemas";
import type { RecallSettings } from "./settings";

const CardOut = z.object({
  kind: z.enum(["qa", "cloze"]).describe("qa for a question with a short answer; cloze for one sentence with hidden spans"),
  front: z
    .string()
    .describe("qa only: the question, naming its subject so it is answerable without the source. Empty string for cloze."),
  back: z.string().describe("qa only: the answer as a term, number, name, or short phrase. Empty string for cloze."),
  text: z
    .string()
    .describe("cloze only: one sentence from the highlight with {{c1::...}} deletions. Empty string for qa."),
});
const CardsOut = z.object({ cards: z.array(CardOut) });
const HighlightsOut = z.object({
  highlights: z.array(
    z.object({
      quote: z.string().describe("Verbatim span copied exactly from the note, character for character."),
      title: z.string().describe("Label of at most six words for this span."),
    }),
  ),
});

export type CardDraft = z.infer<typeof CardOut>;

/**
 * One verdict per drafted card, from the critique pass.
 *
 * Flat and strict on purpose: the Codex backend writes this schema to
 * `--output-schema` (src/codex.ts:366), which runs strict and rejects unions
 * and optional fields, so `front`/`back`/`text` are sentinel empty strings
 * rather than optionals, exactly as `CardOut` above does it.
 *
 * The `bloom` members must stay identical to `BloomLevel` in src/model.ts;
 * `bloomLevelsInSync` below is the compile-time guard on that.
 */
const VerdictOut = z.object({
  index: z.number().int().describe("0-based index of the card being judged, as numbered in the list."),
  verdict: z
    .enum(["keep", "revise", "drop"])
    .describe("keep: use the card as drafted. revise: replace it with the fields below. drop: flag it for the reader."),
  reason: z.string().describe("One sentence, written to the reader, saying what is wrong with this card."),
  bloom: z
    .enum(["remember", "understand", "apply", "analyze", "evaluate", "create"])
    .describe("Bloom's level this card actually sits at, reported for every verdict."),
  kind: z.enum(["qa", "cloze"]).describe("The revised card's kind; echo the original's kind for keep and drop."),
  front: z.string().describe("revise + qa only: the corrected question. Empty string otherwise."),
  back: z.string().describe("revise + qa only: the corrected answer. Empty string otherwise."),
  text: z.string().describe("revise + cloze only: the corrected sentence with {{c1::...}} deletions. Empty string otherwise."),
});
const VerdictsOut = z.object({ verdicts: z.array(VerdictOut) });

export type CritiqueVerdict = z.infer<typeof VerdictOut>;

/**
 * Compile-time guard: assignable both ways, so adding, removing or renaming a
 * member on either side is a type error here rather than a silent drift
 * between what the critique returns and what `Card.bloom` can hold.
 */
type BloomInSync = CritiqueVerdict["bloom"] extends BloomLevel
  ? BloomLevel extends CritiqueVerdict["bloom"]
    ? true
    : never
  : never;
const bloomLevelsInSync: BloomInSync = true;
void bloomLevelsInSync;

/**
 * Card-writer system prompt. Grounded in Wozniak's twenty rules of formulating
 * knowledge (minimum information, cloze, sets and enumerations, interference,
 * wording, context cues, redundancy) and Matuschak's five properties of a good
 * prompt (focused, precise, consistent, tractable, effortful).
 */
const WRITER_SYSTEM = `You write spaced-repetition flashcards for a reader who highlighted one passage in their own notes because they want to remember it. Each card lands in an inbox where the reader keeps, edits, or deletes it before it reaches Anki. A wrong card costs more than a missing one, and a card the reader would delete is wasted review time, so write fewer, better cards.

<what_to_test>
Test only what the highlight itself states. The surrounding context is there to resolve pronouns, abbreviations, and references and to tell you the subject; it is not a source of answers. Do not add outside knowledge, and keep answers close to the highlight's own wording so the reader can verify each card against the text at a glance.

Choose the facts a learner will want to retrieve later: definitions, mechanisms, causes and their effects, numbers, names, dates, and the distinctions between similar things. Skip framing sentences, the author's asides, and facts too obvious to deserve a review. If the highlight contains one fact, write one card; if it contains nothing worth testing, return an empty list. A rule outlasts an instance: when the highlight explains why or how, the card should test the reason, not only the example.
</what_to_test>

<how_to_write>
Minimum information. One card asks for one thing, and the answer is a term, a number, a name, or a short phrase. A highlight with several facts becomes several cards, not one card with a paragraph answer. Long answers are the most common defect; when an answer runs past a short phrase, split the card or move the explanation into the question's framing.

Answerable in isolation. Name the subject in the question ("What does decisional balance weigh?", not "What does it weigh?"). The reader will meet this card months from now, shuffled among cards from other notes.

Precise, with one correct answer. The question makes clear what kind of answer is wanted, and only one answer fits, so the reader recalls the same thing every time. Avoid yes/no questions and questions whose wording gives the answer away. Prefer what, which, how, why, when, and how many.

Optimized wording. Use the shortest question that points at the right memory. Cut words that do not disambiguate.

Sets and enumerations. Do not ask for an unordered list of more than three items as a single answer; such cards are nearly unlearnable. Split the list across cards, ask what distinguishes each member, or use overlapping cloze deletions so each card hides one or two members with the rest visible. Test an ordered sequence with cloze cards that hide one step and show its neighbours.

Interference. When the highlight distinguishes similar things (two stages, two processes, two terms), write cards that hinge on the difference, and put a cue in the question that rules out the neighbour. Two cards whose questions read alike but want different answers will be confused with each other.

Context cue. When a question would be ambiguous outside its subject, prefix it with a short cue drawn from the source title or section heading in the form "Subject: question" (for example "Stages of change: ..."). Omit the cue when the question already names its subject.

Card type. Use qa for definitions, mechanisms, reasons, and distinctions. Use cloze for numbers, dates, names, terms inside a sentence, and enumerations. A cloze sentence is one sentence from the highlight, trimmed to what the deletion needs, with {{c1::...}} markers; each deletion hides a short span (a term, number, or name, not framing words), each independently tested deletion gets a new number, a card carries at most three deletions, and the visible text must be enough to recover the hidden span. Hidden text must appear verbatim in the highlight.

Redundancy. A second card on the same fact is welcome when it tests it from a genuinely different direction (term to definition and definition to term; cause to effect and effect to cause). It is not welcome when the same retrieval would answer both cards.

Write in the language of the highlight unless told otherwise. Keep markdown to **bold** and \`code\`.
</how_to_write>

<examples>
<example>
<highlight>The Dead Sea is a salt lake on the border between Israel and Jordan. Its shoreline is the lowest point on the Earth's surface, about 400 m below sea level. It is roughly seven times as salty as the ocean, which is why swimmers float and only simple organisms survive in it.</highlight>
<cards>
qa | Where is the Dead Sea located? | on the border between Israel and Jordan
qa | What is the lowest point on the Earth's surface? | the Dead Sea shoreline
cloze | The Dead Sea shoreline lies about {{c1::400 m}} below sea level.
cloze | The Dead Sea is roughly {{c1::seven}} times as salty as the ocean.
qa | Why can the Dead Sea keep swimmers afloat? | its high salt content
qa | Why can only simple organisms live in the Dead Sea? | its high salt content
</cards>
<note>One highlight, six atomic cards. The last two share an answer but test different facts, so both stay.</note>
</example>
<example>
<highlight>The general adaptation syndrome unfolds in three stages: alarm, resistance, and exhaustion.</highlight>
<cards>
cloze | The three stages of the general adaptation syndrome are {{c1::alarm}}, resistance, and exhaustion.
cloze | The three stages of the general adaptation syndrome are alarm, {{c1::resistance}}, and exhaustion.
cloze | The three stages of the general adaptation syndrome are alarm, resistance, and {{c1::exhaustion}}.
qa | How many stages does the general adaptation syndrome have? | three
</cards>
<note>An enumeration becomes overlapping cloze cards, each hiding one member, instead of one card asking for the whole list.</note>
</example>
<example>
<highlight>A set is an unordered collection, while an enumeration is ordered. Enumerations are easier to learn than sets because the fixed order gives each item a stable cue.</highlight>
<cards>
qa | Sets vs enumerations: which of the two is ordered? | the enumeration
qa | Why are enumerations easier to learn than sets? | the fixed order gives each item a stable cue
</cards>
<note>Two similar terms: the first card hinges on the difference, the second tests the reason rather than restating the definitions.</note>
</example>
<example>
<highlight>As I mentioned in the previous chapter, this is where things get interesting, and I will come back to it later.</highlight>
<cards>
</cards>
<note>Framing with no fact in it: return no cards.</note>
</example>
</examples>

Before returning, check each card against the highlight: the answer is stated there, the question names its subject, the answer is short, and only one answer fits. Drop any card that fails.`;

/**
 * Critique system prompt: grades the cards already drafted for ONE highlight,
 * all of them in a single call so sibling interference is visible.
 *
 * Adapted from obsidian-loopback's prompts/critique-v1.md, which is cloze-only
 * and assumes a Back Extra field Recall does not have. Carried over from it:
 * the rule that a revision may only use facts the passage states, and the
 * preference for dropping over a fix that stretches past the text. New here:
 * Bloom fit, sibling interference, and near-tautology.
 */
const CRITIC_SYSTEM = `You grade flashcards that have already been drafted from one highlight in a reader's own notes. You do not write new cards. You judge the cards you are given, repair the ones a small fix would save, and drop the ones that should not reach review. Every card that survives costs the reader minutes a year for years, so it should earn that.

Each card is either qa, a question with a short answer, or cloze, one sentence with {{c1::...}} deletions hiding a term, number, or name. There is no back-extra field: whatever the card teaches has to live in the question and its answer, or in the cloze sentence and the framing left visible around the deletion.

<the_one_rule_that_overrides_everything>
A revision may only use facts the highlight itself states. Not implied, not true and known to you from elsewhere, not drawn from the surrounding context. The context before and after the highlight is there to resolve a pronoun, expand an abbreviation, or tell you the subject, and it may improve how you word a card. It never earns the right to become the answer. Rewording a card so it says the same fact more precisely is fine. Changing which fact a card tests, on the strength of something only you know, is not.

A deterministic linter runs after you regardless. It checks every cloze deletion by substring against the highlight and will catch hidden text you invented, so treat this rule as load-bearing rather than a formality.

This is why dropping is the right call more often than reaching for a fix that would stretch past what the passage says. When the repair you have in mind needs one fact the highlight does not carry, the verdict is drop.
</the_one_rule_that_overrides_everything>

<what_to_check>
Judge every card on each of these, then give it one verdict.

Grounding. The answer, and every cloze deletion, is stated in the highlight. A cloze deletion must appear in it word for word.

Minimum information. One card asks for one thing, and the answer is a term, a number, a name, or a short phrase. A paragraph answer is a card that has not been split yet. Long answers are the most common defect: if the answer runs past a short phrase and the highlight supports a narrower question, revise; if it does not, drop.

Answerable in isolation. The question names its subject. "What does it weigh?" is a card the reader will meet months from now, shuffled among cards from other notes, with nothing to tell them what it is about.

One correct answer. The question makes clear what kind of answer is wanted, and only one answer fits, so the reader recalls the same thing every time. Yes/no questions, and questions whose wording gives the answer away, fail this.

Bloom fit. Place each card on Bloom's taxonomy: remember, understand, apply, analyze, evaluate, or create. The failure that matters here is a highlight that states a mechanism, a cause, or a reason turned into a card that only asks what something is called. The reader can recite the label and still not know how the thing works. The fix is to ask why or how, not what it is called. Do not push for a level the highlight does not support: when the highlight states a definition and nothing more, "remember" is the correct level and a card that tests it is a good card. Report the level the card actually sits at, including for cards you drop.

Interference. You see every card for this highlight at once, which is the point of grading them together. Two cards whose questions read alike but want different answers will be confused in review, and so will two cards that share an answer. When you find such a pair, say so, and prefer revising one of them to hinge on the cue that tells them apart over dropping both. Two cards may legitimately share an answer when they test genuinely different facts and their questions could not be mistaken for each other.

Near-tautology. An answer that merely restates a word already in the question tests nothing, because the reader reads it back off the prompt. "What does the accountability system make possible?" answered "tracking progress over time" is retrieved from the question, not from memory. Revise so the question withholds the word the answer turns on, or drop.

Cloze form. Only the tested span sits inside a deletion and the framing stays outside. Each deletion is short, deletions are numbered from 1 with no gaps, a card carries at most three, and the visible text is enough to recover what is hidden.

Duplication. If the cards that already exist for this highlight test the same fact, drop the new one. This is advisory, not the authoritative check, so when you are unsure whether it is truly the same fact, keep the card rather than guessing it away.
</what_to_check>

<verdicts>
keep: the card already satisfies the rules above. Echo its kind and leave front, back, and text empty; the original is used unchanged.

revise: a fix stays entirely inside what the highlight already states. Return the whole corrected card: its kind, and for qa the front and back with text empty, or for cloze the text with front and back empty. A revision that needs a fact the highlight does not carry is not a revision, it is a drop.

drop: the card fails on something you cannot fix without adding a fact the highlight does not state, tests nothing worth reviewing, or duplicates a card that already exists. Echo the original kind and leave front, back, and text empty. The card is not deleted; it is flagged for the reader with your reason, and they decide.

Return exactly one verdict for every card you were given, and no verdict for a card you were not given. The index is the number printed beside the card in the list. The reason is one sentence and the reader reads it, so write it to them: say what is wrong with this card, not which rule it broke.
</verdicts>

<examples>
<example>
<highlight>Spaced repetition works because each successful recall makes the memory harder to lose, so the next review can be scheduled further out. The gap between reviews is called the interval.</highlight>
<cards>
0. qa | What is the interval? | the gap between reviews
1. qa | What is spaced repetition? | a technique where each successful recall makes the memory harder to lose, so the next review can be scheduled further out, which is the principle the whole method rests on
2. qa | What makes the memory harder to lose in spaced repetition? | successful recall
3. cloze | Spaced repetition schedules reviews further out because recall {{c1::strengthens the memory trace in the hippocampus}}.
</cards>
<verdicts>
0. keep, remember. The highlight names the term and defines it; a definition sits at remember, and this one is short and exact.
1. revise, understand. The answer is a paragraph, and it tests the same thing card 2 does, so the two would interfere. Revised to "Why can spaced repetition push reviews further apart?" answered "each successful recall makes the memory harder to lose", which is the mechanism the highlight states.
2. keep, understand. Asks what drives the effect rather than what it is called, and the answer is three words taken from the highlight.
3. drop, understand. The hippocampus is nowhere in the highlight. The card tests something that may well be true but the passage never says it, and there is no fix that does not reach past the text.
</verdicts>
<note>One drop, one revise, two keeps. Cards 1 and 2 were close enough to interfere, so the revision pulls card 1 onto the why and leaves card 2 where it was. Card 0 stays at remember because that is all the highlight supports.</note>
</example>
<example>
<highlight>Deliberate practice differs from ordinary repetition in that it targets a weakness just past current ability and requires immediate feedback.</highlight>
<cards>
0. qa | What is deliberate practice a form of? | practice
1. qa | What two things distinguish deliberate practice from ordinary repetition? | it targets a weakness just past current ability, and it requires immediate feedback
</cards>
<verdicts>
0. drop, remember. The answer is already sitting inside the question, so there is nothing here to retrieve.
1. keep, analyze. Two items is a short enough set to ask for at once, both are stated in the highlight, and the question hinges on the distinction the passage is drawing.
</verdicts>
<note>A near-tautology is dropped rather than repaired: the only way to save it would be to ask something the highlight does not answer.</note>
</example>
</examples>

Before you answer, check that every fact in every revision appears in the highlight, that you returned one verdict per card, and that each index matches the number printed beside its card.`;

/**
 * Highlighter system prompt: picks spans of a whole note worth turning into
 * cards. Follows Wozniak's prioritize / build-on-basics rules and the
 * grounding rule that every span must be locatable verbatim in the note.
 * When a lecture transcript accompanies the note it is evidence of emphasis,
 * never a source of quotes.
 */
const HIGHLIGHTER_SYSTEM = `You select spans of a note that are worth remembering, so that each span can be handed to a card writer and turned into flashcards. The reader will review the resulting cards for years, so a span is worth selecting only if forgetting its content would matter.

Return each span as a verbatim quote copied exactly from the note, character for character, including punctuation. The span is located in the note by exact string match, so an ellipsis, a paraphrase, or a trimmed word makes it unusable. Start and end on sentence boundaries where possible.

Each span is one to four sentences and self-contained: it carries a definition, a mechanism, a number, a name, a date, a causal claim, a distinction between similar things, or a memorable formulation, and it can be understood without the surrounding paragraph. Prefer the fundamentals a reader needs before the details, and prefer material with lasting use over trivia. Prefer fewer, denser spans over many thin ones.

Spans must not overlap. Skip frontmatter, navigation, link lists, boilerplate, transitions, and the author's asides.

A transcript, when one is present, is the recording of the lecture that accompanies the note. It tells you what the lecturer treated as important; it is not a source of quotes, so every span is still copied from the note itself. Prefer the passages the lecturer dwells on, repeats, calls important, or says will be tested, and pass over slide content that was skipped or read out without comment. Where the transcript and the note differ in wording, the note's wording is what gets quoted.

The limit you are given is a ceiling, not a target. Over-highlighting fills the reader's inbox with cards they will delete, so returning fewer spans than the limit is the expected outcome, and returning none is right when nothing in the note is supported by the transcript.

Give each span a label of at most six words that names the fact it carries.`;

/**
 * Prompts and schemas live here; the provider chosen in settings does the
 * actual call. The backend is picked per request so switching providers in
 * the settings tab takes effect immediately.
 */
export class LlmClient {
  private anthropic: AnthropicBackend;
  private codex: CodexBackend;
  private claudeCli: ClaudeCliBackend;

  /**
   * `getHighlights` mirrors the `getSettings` callback rather than importing
   * the store: llm.ts stays free of a dependency on `InboxStore` (and so of
   * `obsidian`, which the store pulls in), and the client keeps holding no
   * state of its own. It defaults to returning nothing so the existing
   * one-argument construction, and the tests, keep working.
   */
  constructor(
    private getSettings: () => RecallSettings,
    private getHighlights: () => Highlight[] = () => [],
  ) {
    this.anthropic = new AnthropicBackend(getSettings);
    this.codex = new CodexBackend(getSettings);
    this.claudeCli = new ClaudeCliBackend(getSettings);
  }

  /**
   * Style examples from the reader's own triage decisions, inbox-wide.
   * Off by default; returns "" when the setting is off or there is no
   * history, so nothing is appended in either case.
   */
  private examplesBlock(): string {
    if (!this.getSettings().historyExamples) return "";
    return buildExamplesBlock(this.getHighlights());
  }

  private backend(): LlmBackend {
    const provider = this.getSettings().provider;
    if (provider === "codex") return this.codex;
    if (provider === "claudecli") return this.claudeCli;
    return this.anthropic;
  }

  /** One tiny request, so the settings tab can say whether the provider works. */
  probe(): Promise<{ model: string; via: string }> {
    return this.backend().probe();
  }

  /** Cancel in-flight work on every backend (plugin unload). */
  async abort(): Promise<void> {
    await Promise.all([this.anthropic.abort(), this.codex.abort(), this.claudeCli.abort()]);
  }

  /** "write cards": one highlight (plus context) in, a handful of cards out. */
  async writeCards(h: Highlight, existing: Card[] = []): Promise<CardDraft[]> {
    const s = this.getSettings();
    const parts: string[] = [];
    parts.push(`<source title="${h.sourceTitle}"${h.heading ? ` section="${h.heading}"` : ""}>`);
    if (h.before) parts.push(`<context_before>\n${h.before}\n</context_before>`);
    parts.push(`<highlight>\n${h.text}\n</highlight>`);
    if (h.after) parts.push(`<context_after>\n${h.after}\n</context_after>`);
    parts.push(`</source>`);
    parts.push(`Write at most ${s.maxCardsPerHighlight} cards.`);
    if (s.language) parts.push(`Write the cards in ${s.language}.`);
    if (s.writerInstructions.trim()) parts.push(`Standing instructions: ${s.writerInstructions.trim()}`);
    const writerExamples = this.examplesBlock();
    if (writerExamples) parts.push(writerExamples);
    if (h.instruction.trim()) parts.push(`Instructions for this highlight: ${h.instruction.trim()}`);
    if (existing.length) {
      parts.push(
        `These cards already exist for this highlight; do not repeat their facts:\n` +
          existing.map((c) => `- ${c.kind === "qa" ? `${c.front} -> ${c.back}` : c.text}`).join("\n"),
      );
    }
    const parsed = await this.backend().complete({
      system: WRITER_SYSTEM,
      user: parts.join("\n\n"),
      schema: CardsOut,
      label: "cards",
      maxTokens: 8000,
    });
    return parsed.cards.filter((c) => (c.kind === "qa" ? c.front.trim() && c.back.trim() : /\{\{c\d+::/.test(c.text)));
  }

  /**
   * "critique": grade every card drafted for one highlight in a single call,
   * so the critic can see interference between siblings. Never mutates
   * `cards`; the caller applies the verdicts. Verdicts whose index does not
   * point at a card are dropped rather than thrown on, since a stray index is
   * a model slip, not a reason to lose the whole highlight.
   */
  async critiqueCards(h: Highlight, cards: Card[], existing: Card[] = []): Promise<CritiqueVerdict[]> {
    if (!cards.length) return [];
    const s = this.getSettings();
    const parts: string[] = [];
    parts.push(`<source title="${h.sourceTitle}"${h.heading ? ` section="${h.heading}"` : ""}>`);
    if (h.before) parts.push(`<context_before>\n${h.before}\n</context_before>`);
    parts.push(`<highlight>\n${h.text}\n</highlight>`);
    if (h.after) parts.push(`<context_after>\n${h.after}\n</context_after>`);
    parts.push(`</source>`);
    parts.push(
      `Cards drafted from this highlight. The leading number is the index to report:\n` +
        cards.map((c, i) => `${i}. ${c.kind === "qa" ? `qa | ${c.front} | ${c.back}` : `cloze | ${c.text}`}`).join("\n"),
    );
    if (s.language) parts.push(`The cards should be written in ${s.language}.`);
    if (s.writerInstructions.trim()) {
      parts.push(`Standing instructions the reader set for their cards; hold these cards to them: ${s.writerInstructions.trim()}`);
    }
    const criticExamples = this.examplesBlock();
    if (criticExamples) parts.push(criticExamples);
    if (h.instruction.trim()) parts.push(`Instructions for this highlight: ${h.instruction.trim()}`);
    if (existing.length) {
      parts.push(
        `Cards that already exist for this highlight; a new card testing the same fact is a duplicate:\n` +
          existing.map((c) => `- ${c.kind === "qa" ? `${c.front} -> ${c.back}` : c.text}`).join("\n"),
      );
    }
    parts.push(`Return exactly one verdict for each of the ${cards.length} cards above.`);
    const parsed = await this.backend().complete({
      system: CRITIC_SYSTEM,
      user: parts.join("\n\n"),
      schema: VerdictsOut,
      label: "verdicts",
      maxTokens: 8000,
    });
    return parsed.verdicts.filter((v) => Number.isInteger(v.index) && v.index >= 0 && v.index < cards.length);
  }

  /** Rewrite one card according to an instruction ("convert to cloze", "shorter", ...). */
  async rewriteCard(h: Highlight, card: Card, instruction: string): Promise<CardDraft> {
    const s = this.getSettings();
    const current = card.kind === "qa" ? `Q: ${card.front}\nA: ${card.back}` : `Cloze: ${card.text}`;
    const content = [
      `<highlight>\n${h.text}\n</highlight>`,
      `Current card:\n${current}`,
      `Rewrite this one card. Instruction: ${instruction}`,
      s.language ? `Write in ${s.language}.` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return this.backend().complete({ system: WRITER_SYSTEM, user: content, schema: CardOut, label: "card", maxTokens: 4000 });
  }

  /** "highlight": pick spans of a whole note worth turning into sections. */
  async highlight(
    noteTitle: string,
    body: string,
    instruction: string,
    transcript: string | null = null,
  ): Promise<Array<{ quote: string; title: string }>> {
    const s = this.getSettings();
    const content = buildHighlighterMessage({
      noteTitle,
      body,
      transcript,
      maxSpans: s.maxAiHighlights,
      standingInstructions: s.highlighterInstructions,
      instruction,
    });
    const parsed = await this.backend().complete({
      system: HIGHLIGHTER_SYSTEM,
      user: content,
      schema: HighlightsOut,
      label: "highlights",
      maxTokens: 16000,
    });
    return parsed.highlights;
  }

  /** "digest": one lecture PDF's text and its highlights in, a handful of topic notes out. */
  async digest(args: DigestMessageArgs): Promise<DigestDraft> {
    return this.backend().complete({
      system: DIGEST_SYSTEM,
      user: buildDigestMessage(args),
      schema: DigestOutSchema,
      label: "topic notes",
      maxTokens: 16000,
    });
  }

  /**
   * "ask": one question against numbered evidence from the reader's own notes.
   * The draft is structured, not prose: the caller assembles the answer from
   * it and checks the quotes and citations, so nothing is validated here.
   */
  async ask(args: AskMessageArgs): Promise<AskDraft> {
    return this.backend().complete({
      system: ASK_SYSTEM,
      user: buildAskMessage(args),
      schema: AskOutSchema,
      label: "answer",
      maxTokens: 4000,
    });
  }

  /**
   * "verify": the optional second pass over an answer already drafted, judging
   * each sentence against the evidence it cited. Costs a second call per
   * question, which is why it sits behind `askVerifyPass` and is off by
   * default. Stray indices are the caller's problem to ignore, as with
   * `critiqueCards` above.
   */
  async verifyAnswer(args: VerifyMessageArgs): Promise<VerifyDraft> {
    return this.backend().complete({
      system: VERIFY_SYSTEM,
      user: buildVerifyMessage(args),
      schema: VerifyOutSchema,
      label: "verdicts",
      maxTokens: 2000,
    });
  }
}

export function describeError(e: unknown): string {
  if (e instanceof ClaudeCliError) return e.message;
  if (e instanceof CodexError) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API key.";
  if (e instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API; will retry later.";
  if (e instanceof Anthropic.BadRequestError) return `Bad request: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return `Could not reach the Anthropic API: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `API error ${e.status}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Digest system prompt: one lecture PDF's text plus the highlights the reader
 * made in it, out come a handful of topic notes. Same register as
 * WRITER_SYSTEM above: the reader's own material is the only source, and the
 * model writes prose and assignments, never links or callouts (the plugin
 * renders every callout from the manifest).
 */
const DIGEST_SYSTEM = `You turn one lecture PDF and the highlights a student made in it into a handful of topic notes. You are given the paper's text, so that you can see what each highlight is about, and the highlights themselves, each with an id and a page. You return, for each topic, a title, a short summary, and the ids of the highlights that belong to it. You never write links, callouts, or ids into your prose: the plugin renders each highlight back into the note from its own record, and prose that mentions H04 will be read by a person, not resolved by a machine.

<what_a_topic_is>
A topic is something the reader would look up by name later: a mechanism, a classification, a definition together with what follows from it, a distinction between two things that are easy to confuse. It is not a slide, not a section of the deck, and not the lecture itself. One lecture usually holds two to six of them. Fewer, larger topics beat many thin ones, because a note with one highlight in it is a note the reader will never open twice.

Every highlight belongs to the topic it serves best, and a highlight may serve more than one: a definition of affinity can sit under both the receptor topic and the dose-response topic, and putting it in both is right when a reader arriving at either would want it. What does not belong in any topic goes in unused_ids: slide titles, course logistics, dates, a name on a title page, a rectangle whose text came out empty. Leaving such a highlight in a topic costs the reader more than dropping it, because it dilutes the note it lands in.

You are told which notes already exist for this class. When one of those titles is the topic a group of highlights belongs to, reuse the title exactly, character for character, because the plugin then appends those highlights to that note instead of creating a second one beside it. Reuse it only when it genuinely fits; a near-match that forces unrelated highlights together is worse than a new note.
</what_a_topic_is>

<the_summary>
Three to five sentences about this topic, drawn from the whole paper but weighted toward what the reader chose to highlight. The highlights tell you what they cared about; the rest of the paper tells you what those highlights mean, and lets you write the sentence that connects two of them. Write in the reader's language, the one the paper is written in, and keep close to its wording so the summary reads as their own note rather than as a stranger's gloss.

Nothing from outside the paper. If you know more about the subject than the paper says, that knowledge does not belong here: the reader will study from this note and cannot tell your additions from theirs. No citations, no links, no highlight ids, no page numbers in the prose. The highlights appear underneath the summary in the finished note, so the summary does not need to quote them; it needs to say what they add up to.
</the_summary>

<titles_and_related>
A title is a short noun phrase in Title Case, the way an index entry reads: "Receptor Binding", "First-Pass Metabolism", "Stages of Change". Not a sentence, not a question, and unique within your response. Two titles that differ only in case or in a plural are the same title, and one of the two notes will be lost.

related lists the titles of other notes you are writing in this response, or of the existing notes you were shown, and nothing else. An invented title points at a note that does not exist. Leave it empty when nothing connects.
</titles_and_related>

<examples>
<example>
<input>Highlights H01 "Pharmacology, Pharmacodynamics and Pharmacokinetics — HBIO 250 Fall 2026" (p.1), H02 "Pharmacology is the study of the action of drugs in the human body" (p.2), H03 "Pharmacodynamics = what drugs do in the body; pharmacokinetics = what the body does to drugs" (p.2), H04 "Receptors bind ligands with relatively high affinity" (p.4), H05 "Receptors transduce a signal to produce a biological effect; this distinguishes them from inert binding sites such as albumin" (p.4). Existing notes: Pharmacology.</input>
<output>Two notes. "Pharmacology" (reusing the existing title) takes H02 and H03, with a summary that defines the field and sets its two branches against each other. "Receptors" takes H04 and H05, with a summary that names the two properties and says why the second one is what separates a receptor from a carrier protein. related on each names the other. H01 is a slide title and goes to unused_ids.</output>
<note>Five highlights, two topics, one dropped. The existing title is reused verbatim so the two highlights land in the note the reader already has.</note>
</example>
<example>
<input>Twelve highlights, of which nine are on absorption, distribution, metabolism and excretion, two are on the definition of half-life, and one is a rectangle with no text.</input>
<output>Two notes, not four. "Drug Disposition" takes the nine, because absorption, distribution, metabolism and excretion are the four stages of one process and a reader looking any of them up wants the others in view; "Half-Life" takes the two, and also takes one of the excretion highlights, since half-life is defined there. The empty rectangle goes to unused_ids.</output>
<note>Splitting one process into four notes of two highlights each would make four notes nobody opens. One highlight sits in two notes because it belongs in both.</note>
</example>
</examples>

Before returning, check your answer against the input: every id you used appears there, every id in the input appears either in exactly the notes it belongs to or in unused_ids, no note has an empty highlight_ids list, no two titles collide, every related title is one you wrote or were shown, and no summary contains a link, an id, or a fact the paper does not state.`;

/**
 * Ask system prompt: answer a question from numbered evidence taken from the
 * reader's own notes.
 *
 * Same register as WRITER_SYSTEM above: prose with the reason attached to each
 * rule, examples that show the shape rather than restate it. What it encodes
 * comes from the vault's own wiki pages on reducing hallucinations —
 * external knowledge restriction, permission to say "I don't know", direct
 * quotes for factual grounding, verification by citation, and a closing
 * self-check in place of a full chain-of-thought pass.
 *
 * The output is structured rather than prose: the software (src/askCheck.ts)
 * checks each quote against the evidence, appends the citations, and removes a
 * claim that cited nothing. The prompt says so, because a rule the model knows
 * will be checked is one it follows.
 */
const ASK_SYSTEM = `You answer a student's question about their own class notes, using numbered evidence taken from those notes. Each piece of evidence is something they highlighted in a lecture PDF or a claim they wrote down themselves, and it carries the note it came from and the page it was highlighted on. Your answer goes into a small sidebar beside their notes, with the evidence listed underneath it, so the reader can check every sentence you write against the passage it came from.

You do not write the finished answer. You return the passages you leaned on and then the answer one sentence at a time, each sentence saying which evidence states it, and the software assembles what the reader sees. It also checks you: a quote that is not in the evidence is dropped, and a claim that names no evidence is removed from the answer and counted. Those checks run on every answer, so treat them as the shape of the work rather than as a warning.

<answer_only_from_the_evidence>
The evidence is the whole of what you may assert. You know a great deal about most of these subjects, and none of it belongs here: the reader is revising for an exam set on this material, and a true sentence their course never taught them is one they cannot rely on and cannot trace back to a slide. If a fact is not in the evidence in front of you, it is not in the answer, however certain you are of it.

The conversation so far, when there is one, is there so that a follow-up makes sense: it tells you what "it" refers to and what has already been said. It is not evidence. Nothing said in an earlier turn may be asserted in this one unless the evidence in front of you now states it.
</answer_only_from_the_evidence>

<when_the_notes_do_not_cover_it>
Saying that the notes do not answer the question is a correct answer, and often the most useful one: it tells the reader their notes have a hole in them, which is exactly what they would want to know before an exam. It is never a failure to reach for.

Set coverage to full when the evidence answers the question, partial when it answers some of it, and none when it does not touch the question at all. A none answer is one or two gap sentences and no quotes: say what the evidence does hold and what it does not, naming what would settle the question ("nothing here gives a half-life for any drug"). Do not attach a claim to a none answer; there is nothing for it to rest on. A partial answer carries both kinds: the part the evidence settles, then a gap sentence for the part it leaves open.
</when_the_notes_do_not_cover_it>

<quotes_first>
Before you write a sentence, copy into quotes the passages your answer will rest on: the words themselves, character for character, from the evidence they appear in, with the number of that piece. Not a paraphrase, not a tidied version, not two fragments spliced with an ellipsis. The software looks each one up in the evidence you named and shows the reader only the ones it finds, so a quote you smoothed out is a quote that disappears.

Extracting them first is the point of the exercise, not bookkeeping after the fact. Finding the exact words that carry the answer is what tells you whether the answer is there at all; often the passage you were sure you remembered turns out to say something narrower, and the sentence you were about to write becomes a gap sentence instead. Keep them short, a clause or a sentence, and copy only the spans doing the work. Leave quotes empty when coverage is none.
</quotes_first>

<sentences_and_their_numbers>
Write the answer one sentence per entry, in the order the reader will read them. Do not write [1] or any other marker inside the text; the software appends the citations from the numbers you list, and a marker you typed yourself is stripped out.

A claim sentence asserts something, and it lists in cited every evidence number that states it: one number, or both when the sentence rests on two pieces. A claim whose cited list is empty is removed from the answer before the reader sees it, so if you cannot name the evidence for a sentence, either find the number or rewrite the sentence as what the evidence does say. Never invent a number: if the evidence stops at [8], there is no [9], and a sentence citing one is removed.

A gap sentence says what the evidence does not cover, and it cites nothing, because there is no passage to point at for an absence. That is the one kind of sentence that carries no numbers.

A sentence that is a list item starts with "- " and is one entry like any other.
</sentences_and_their_numbers>

<how_to_write_it>
Prefer the reader's own wording. These are their highlights, in the vocabulary their lecturer used, and an answer in that vocabulary is one they can match against the slide. Where two pieces of evidence use different words for the same thing, use the one the question used.

Be short. A few sentences, or a small list when the question asks for several things. This is a sidebar, not an essay, and the evidence is right there underneath: you do not need to reproduce it, only to say what it means for the question. Plain markdown, bold and code at most, no headings, no links, no ids.
</how_to_write_it>

<examples>
<example>
<evidence>[1] (Receptors, p.4) Receptors have 2 important properties: they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect (this distinguishes receptors from inert binding sites such as albumin, which binds and carries many drugs but does not transduce a signal).</evidence>
<question>What distinguishes a receptor from albumin?</question>
<output>Coverage is full. One quote, from [1]: "transduce a signal to produce a biological effect (this distinguishes receptors from inert binding sites such as albumin, which binds and carries many drugs but does not transduce a signal)". Two claim sentences. The first, "Both bind drugs, but only a receptor transduces a signal to produce a biological effect.", cites [1]. The second, "Albumin binds and carries drugs without transducing anything, which is what makes it an inert binding site.", cites [1] as well.</output>
<note>The quote is the span that actually carries the distinction, copied whole rather than trimmed to look neat. Both sentences rest on the same piece, so both name it. Nothing is added about albumin's structure or its other roles, true though that would be.</note>
</example>
<example>
<evidence>[1] (Pharmacology, p.2) Pharmacokinetics = what the body does to drugs. [2] (Drug Disposition, p.7) Metabolism converts drugs into more water-soluble forms for excretion.</evidence>
<question>What is the half-life of aspirin?</question>
<output>Coverage is none. No quotes. Two gap sentences, neither citing anything: "Your notes do not cover this." and "The evidence here defines pharmacokinetics and describes metabolism in general terms, but nothing in it gives a half-life for aspirin or for any other drug."</output>
<note>The gap is named rather than filled. Half-life is a number worth knowing and one you could supply from memory, which is exactly why it must not appear: the reader would have no way to tell it apart from what their lecturer taught. No sentence is a claim here, so no sentence cites anything, and there is nothing to quote.</note>
</example>
</examples>

Before you return, read each sentence back against the evidence you cited for it. Ask of every claim whether that piece of evidence, on its own, says what the sentence says, and not merely something compatible with it; if it does not, drop the sentence or turn it into a gap sentence. Check that every quote is in the evidence you attributed it to, word for word, and that every number you used is one you were given.`;

/**
 * Verify system prompt: the optional second pass, off by default.
 *
 * Deliberately short. The first prompt is long because writing a grounded
 * answer needs the reasons; judging one needs a single distinction held
 * firmly, and every extra paragraph here is another thing for the checker to
 * weigh against the only question it should be asking.
 */
const VERIFY_SYSTEM = `You check an answer that has already been written. You are not the writer: you do not improve sentences, fill gaps, or suggest better wording, and no sentence changes because of what you say beyond being kept or removed.

You are given numbered evidence from a student's notes and the sentences drafted from it, each printed with the evidence numbers it cited. For each sentence, say whether the evidence it cited states what the sentence says.

Supported means stated. Not plausible, not likely, not true as far as you know, not something the cited passage is consistent with or implies to a reader who already knows the subject. If the sentence names a number, the cited evidence carries that number; if it names a mechanism, the cited evidence describes that mechanism. Evidence that is about the right topic but does not carry the sentence's claim is not support. A sentence citing nothing, or citing a number that is not in the evidence, is unsupported.

Judge each sentence only against the pieces it cited, not against the evidence as a whole: a sentence that is stated somewhere else in the list but not in what it pointed at is unsupported, because the reader will follow the citation it was given. The reason is one clause naming which words are or are not there.

<example>
<evidence>[1] (Receptors, p.4) Receptors bind ligands with relatively high affinity and transduce a signal to produce a biological effect. [2] (Drug Disposition, p.7) Metabolism converts drugs into more water-soluble forms for excretion.</evidence>
<draft>
0. Receptors transduce a signal to produce a biological effect. [1]
1. Receptor binding is saturable, so the response plateaus at high doses. [1]
</draft>
<verdicts>0 supported: [1] states transduction of a signal to produce a biological effect in those words. 1 not supported: [1] mentions affinity and transduction but says nothing about saturation or a plateau.</verdicts>
<note>The second sentence is true of receptors and would pass a reader who knew the subject. It is unsupported anyway, because the passage it cites does not say it.</note>
</example>`;

/** The digest, Ask and verify schemas are defined in schemas.ts so tests can bundle them without obsidian; re-exported here so callers have one import. */
export { DigestOut, AskOut, VerifyOut } from "./schemas";
export type { DigestDraft, AskDraft, VerifyDraft } from "./schemas";
