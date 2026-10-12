import { z } from "zod";
import type { LlmBackend } from "./backend";
import { CodexBackend, CodexError } from "./codex";
import { DeepSeekBackend } from "./deepseek";
import { OpenCodeBackend, OpenCodeError } from "./opencode";
import { DeepSeekError } from "./deepseekError";
import { buildExamplesBlock } from "./examples";
import type { BloomLevel, Card, Highlight } from "./model";
import type { QuizQuestionMessageArgs, QuizRecallGradeMessageArgs } from "./prompt";
import { buildQuizQuestionMessage, buildQuizRecallGradeMessage } from "./prompt";
import { QuizQuestionOut as QuizQuestionOutSchema, QuizRecallGradeOut as QuizRecallGradeOutSchema } from "./schemas";
import type { QuizQuestionDraft, QuizRecallGradeDraft } from "./schemas";
import type { RecallSettings } from "./settings";
import {
  CHAT_ANSWER_SYSTEM,
  ChatAskOut,
  buildChatAnswerMessage,
  CHAT_VERIFY_SYSTEM,
  ChatVerificationOut,
  buildChatVerifyMessage,
  CHAT_EXPAND_SYSTEM,
  ChatExpandOut,
  buildChatExpandMessage,
  boundChatQueries,
  type ChatAnswerArgs,
  type ChatAskDraft,
  type ChatVerification,
} from "./reviewChat";

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

export type CardDraft = z.infer<typeof CardOut>;

/**
 * One verdict per drafted card, from the critique pass.
 *
 * Flat and strict on purpose: the Codex backend writes this schema to
 * `--output-schema` (`toStrictSchema` in src/codex.ts), which runs strict
 * and rejects unions and optional fields, so `front`/`back`/`text` are
 * sentinel empty strings rather than optionals, exactly as `CardOut` above
 * does it.
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
 *
 * The five properties and the twenty rules are each stated as a rule below, not
 * merely cited here: "tractable" and "effortful" were named in this comment for
 * a long time without appearing in the prompt at all. The vault's wiki notes on
 * how-to-write-good-prompts, litmus-tests-for-prompts, cloze-deletion and
 * combat-interference are the reference; the litmus tests in particular are the
 * authoring heuristic the rest of the rules are checked with, which is why they
 * appear in both this prompt and the critique's.
 *
 * Three things the wiki recommends are left out on purpose, so nobody "fixes"
 * their absence: interpretation (reading past the literal text to a ratio or
 * a rule it implies) loses to the grounding rule, because the linter checks
 * every deletion by substring and a card the reader cannot verify against the
 * highlight at a glance is the failure this pipeline exists to prevent;
 * mnemonics and personal examples are the reader's to add in the extra field,
 * since a mnemonic works by being the reader's own; and creative, salience and
 * context-laden prompts want a different answer each review, which no
 * consistent grading can hold, and Matuschak himself calls them experimental.
 *
 * Every example card below is run through src/lint.ts by test/prompt-examples
 * .test.mjs, because an example the pipeline would badge teaches the model to
 * write cards the pipeline then flags.
 */
const WRITER_SYSTEM = `You write spaced-repetition flashcards for a reader who highlighted one passage in their own notes because they want to remember it. Each card lands in an inbox where the reader keeps, edits, or deletes it before it reaches Anki. A wrong card costs more than a missing one, and a card the reader would delete is wasted review time, so write fewer, better cards.

<what_to_test>
Test only what the highlight itself states. The surrounding context is there to resolve pronouns, abbreviations, and references and to tell you the subject; it is not a source of answers. Do not add outside knowledge, and keep answers close to the highlight's own wording so the reader can verify each card against the text at a glance.

Choose the facts a learner will want to retrieve later: definitions, mechanisms, causes and their effects, numbers, names, dates, and the distinctions between similar things. Skip framing sentences, the author's asides, and facts too obvious to deserve a review. If the highlight contains one fact, write one card; if it contains nothing worth testing, return an empty list. A rule outlasts an instance: when the highlight explains why or how, the card should test the reason, not only the example. A figure the highlight dates ("as of 2025", "in the 2019 survey") keeps its date in the card: the date is part of the fact, and the number will change.
</what_to_test>

<how_to_write>
Minimum information. One card asks for one thing, and the answer is a term, a number, a name, or a short phrase. A highlight with several facts becomes several cards, not one card with a paragraph answer. Long answers are the most common defect, and an answer over twelve words fails the linter; when an answer runs past a short phrase, split the card or move the explanation into the question's framing.

Answerable in isolation. Name the subject in the question ("What does decisional balance weigh?", not "What does it weigh?"). The reader will meet this card months from now, shuffled among cards from other notes.

Precise, with one correct answer. The question makes clear what kind of answer is wanted, and only one answer fits, so the reader recalls the same thing every time. Avoid yes/no and this-or-that questions, which are right by luck half the time, and questions whose wording gives the answer away. Prefer what, which, how, why, when, and how many.

Optimized wording. Use the shortest question that points at the right memory. Cut words that do not disambiguate.

Tractable and effortful. A card should be almost always answerable by a reader who has studied this highlight, and should still require actually retrieving the fact. A card that is unanswerable without a detail the highlight never stated is not hard, it is broken; a card whose answer is inferable from its own phrasing is not easy, it is empty.

Run both litmus tests on every card before you return it. False positive: how could a reader produce the right answer without knowing the fact? Grammar is the usual leak — an article, a singular or plural verb, or a number word left visible next to the blank hands over the answer. So does a deletion whose length or capitalisation is the only candidate the sentence admits, and so does any card whose answer is already sitting in its own question. False negative: how could a reader who knows the fact still answer wrongly? This is nearly always missing context — a question that does not name its subject, a deletion with too little left visible to say which of several facts is wanted, or a cue that fits the neighbouring card just as well. Fix the card, or drop it; a card that fails either test is worse than no card, because it will be reviewed for years.

Sets and enumerations. Do not ask for an unordered list of more than three items as a single answer; such cards are nearly unlearnable. Split the list across cards, ask what distinguishes each member, or use overlapping cloze deletions so each number hides one member with the rest visible. Test an ordered sequence with numbers that each hide one step and show its neighbours.

Closed and open lists. A closed list has a fixed, complete membership that the highlight states in full: the stages of a model, the steps of a process, the ingredients of a recipe. The rules above are written for it, because there the list really is the answer. An open list is a category whose members the highlight only samples, signalled by words like "include", "such as", "for example", and "among others"; the sample is not the set, so asking for the list as an answer or clozing its members in turn would teach the reader an arbitrary subset as though it were complete. Ask instead for what generalizes: when the highlight states a criterion for membership, test the criterion, and test each named example in the direction example to category, which has one answer, never category to list.

Interference. For an experienced reviewer this is the single greatest cause of forgetting, so it outranks the preferences below it. When the highlight distinguishes similar things (two stages, two processes, two terms), write cards that hinge on the difference, and put a cue in the question that rules out the neighbour. Two cards whose questions read alike but want different answers will be confused with each other, and so will two cards that share an answer unless their questions could never be mistaken for one another; the linter flags a shared answer for the reader regardless.

Context cue. When a question or a cloze sentence would be ambiguous outside its subject, prefix it with a short cue drawn from the source title or section heading in the form "Subject: question" (for example "Stages of change: ..."). Omit the cue when the question already names its subject.

Card type. Cloze is the default. Use qa when the answer is not a span sitting in a sentence but something the reader must produce (a reason, a mechanism, a comparison), or when the cue has to be phrased to rule out a confusable neighbour. The reader can convert either kind from the inbox, so prefer cloze and let them switch. A cloze card carries at least two deletion numbers; a sentence that gives you only one span worth hiding is a qa card, with the sentence as the question and the span as the answer, because one blank is one item and a question says that more plainly.

How a cloze card reviews. A cloze card is one sentence from the highlight with {{c1::...}} markers, trimmed, and reworded only as far as resolving a pronoun or grammar needs, so the visible text stays the highlight's own wording; each deletion number becomes its own review: when the reader is tested on c2, the c1 and c3 spans are shown filled in. So a sentence with three numbered deletions is three minimal items sharing one stem, not one compound item, and the sentence is the right unit to work in: when it states two or three short, independent facts, hide each under its own number instead of writing a card per fact on the same stem. An enumeration is the same move, {{c1::alarm}}, {{c2::resistance}}, and {{c3::exhaustion}} giving three reviews that each hide one member with the rest visible in a fixed order. Reuse a number only when two spans are one fact tested in two places. At most three numbers; split a sentence that wants more.

Each deletion hides a short span, a term, number, name, or phrase of up to six words (the linter rejects longer) and never framing words; it appears verbatim in the highlight; and it is recoverable from what stays visible, which includes the sibling spans. That last point is where a dense card fails the false-positive test: a visible sibling that all but names the hidden one ("the ___ point on Earth, about 400 m below sea level") has given it away, so hide only what the rest of the sentence cues without spelling out, and leave the rest as framing.

Keep cloze sentences short. A deletion lifted out of a long passage is the format's characteristic failure: the reader learns the shape of the surrounding text and fills the blank from the pattern rather than from memory, and the card keeps scoring correct while teaching nothing. Trim the sentence to the clause the deletions need and cut context that is only there because it was adjacent in the highlight. A short sentence with two deletions beats a long one with the same two.

Procedures. A step lives in its verb and its condition (simmer, at low heat, until the fat rises), not in its nouns, so those are the spans to hide, with the neighbouring steps left visible as the cue. When the highlight says why a step is done, write a qa card for the reason; that is the card that keeps the procedure from being learned by rote.

Lenses for a concept. When the highlight defines or explains a concept rather than stating a bare fact, a card on its label alone is thin evidence of understanding, so choose cards that trace the concept's edges: what is always, sometimes, or never true of it; what it is easily confused with and what separates them; what it contains and what larger thing it belongs to; what it does and why; why it matters. Use only the lenses the highlight itself supports. The rule that every answer is stated in the highlight is unchanged here: a lens is a way of choosing which stated fact to test, not a licence to add one the highlight leaves unsaid. One good card per supported lens is worth more than several on the label.

Redundancy. A second card on the same fact is welcome when it tests it from a genuinely different direction (term to definition and definition to term; cause to effect and effect to cause); numbered deletions on one sentence are the cloze form of this. It is not welcome when the same retrieval would answer both cards.

Write in the language of the highlight unless told otherwise. Keep markdown to **bold** and \`code\`.
</how_to_write>

<examples>
<example>
<highlight>The Dead Sea is a salt lake on the border between Israel and Jordan. Its shoreline is the lowest point on the Earth's surface, about 400 m below sea level. It is roughly seven times as salty as the ocean, which is why swimmers float and only simple organisms survive in it.</highlight>
<cards>
cloze | The Dead Sea is a salt lake on the border between {{c1::Israel}} and {{c2::Jordan}}.
qa | What is the lowest point on the Earth's surface? | the Dead Sea shoreline
qa | How far below sea level is the Dead Sea shoreline? | about 400 m
qa | How many times as salty as the ocean is the Dead Sea? | roughly seven times
qa | Why do swimmers float in the Dead Sea? | its high salt content
qa | Dead Sea: what can survive its salinity? | only simple organisms
</cards>
<note>The lowest-point fact is qa rather than a cloze hiding "Dead Sea shoreline": the highlight says "its shoreline", so that span is not in it verbatim, and hiding "shoreline" alone after "The Dead Sea's" leaves one candidate. The next card keeps the sentence's wording with "its" resolved, and "lowest" is not a deletion: with "400 m below sea level" visible beside it, the blank would spell itself out. The last two cards run in opposite directions, effect to cause and cause to effect, so they are not the same retrieval; a second card answered "its high salt content" would have been, and would have interfered with the first.</note>
</example>
<example>
<highlight>The general adaptation syndrome unfolds in three stages: alarm, resistance, and exhaustion.</highlight>
<cards>
cloze | The three stages of the general adaptation syndrome are {{c1::alarm}}, {{c2::resistance}}, and {{c3::exhaustion}}.
qa | How many stages does the general adaptation syndrome have? | three
</cards>
<note>One cloze card, three reviews: each number hides one member with the other two visible in their fixed order, which is what an enumeration needs. Three cards each hiding one member under c1 would review the same sentence three times and drift apart as soon as one was edited. The count card stays: reading "three" in the framing of every review is exposure, not retrieval.</note>
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
<highlight>## Proposed factors that influence self-efficacy
**Bandura (1997)**:
- **Mastery Experiences**</highlight>
<cards>
cloze | {{c1::Bandura}} ({{c2::1997}}) proposed {{c3::Mastery Experiences}} as a factor that influences self-efficacy.
</cards>
<note>One card, not three. The name, the year, and the factor are three short independent facts in one sentence, each recoverable from the framing left visible, so they are three numbered deletions on a single card. Writing "…were published in {{c1::1997}}" and "…is {{c1::Mastery Experiences}}" as separate cards would build two cards on the same stem and review the same sentence twice.</note>
</example>
<example>
<highlight>Modifiable risk factors for hypertension include obesity, high sodium intake, and physical inactivity; a risk factor is modifiable when the patient can change it.</highlight>
<cards>
qa | Obesity, high sodium intake, and physical inactivity are what kind of risk factor for hypertension? | modifiable
qa | What makes a risk factor for hypertension modifiable? | the patient can change it
</cards>
<note>"include" marks an open list, so no card asks for the list and no deletion hides a member: the three named factors are a sample, not the set, and they are the cue, not the answer. The first card tests example to category with all three examples visible, in the highlight's own words. A card per example ("is obesity modifiable or non-modifiable?") would be three this-or-that questions with the answer in their own wording and the same answer three times over. The criterion is the fact with lasting use, since it decides cases the highlight never named.</note>
</example>
<example>
<highlight>As I mentioned in the previous chapter, this is where things get interesting, and I will come back to it later.</highlight>
<cards>
</cards>
<note>Framing with no fact in it: return no cards.</note>
</example>
</examples>

Before returning, run both litmus tests on each card and check it against the highlight: every answer and every deletion is stated there, the question names its subject or the visible text cues the deletion without spelling it out, the answer is short, and only one answer fits. Drop any card that fails.`;

/**
 * Critique system prompt: grades the cards already drafted for ONE highlight,
 * all of them in a single call so sibling interference is visible.
 *
 * Adapted from an earlier version of this plugin's prompts/critique-v1.md,
 * which is cloze-only and assumes a Back Extra field Recall does not have.
 * Carried over from it:
 * the rule that a revision may only use facts the passage states, and the
 * preference for dropping over a fix that stretches past the text. New here:
 * Bloom fit, sibling interference, and near-tautology.
 */
const CRITIC_SYSTEM = `You grade flashcards that have already been drafted from one highlight in a reader's own notes. You do not write new cards. You judge the cards you are given, repair the ones a small fix would save, and drop the ones that should not reach review. Every card that survives costs the reader minutes a year for years, so it should earn that.

Each card is either qa, a question with a short answer, or cloze, one sentence with {{c1::...}} deletions hiding a term, number, name, or short phrase. Each cloze number is its own review, with the other numbered spans shown filled in. The card's extra field belongs to the reader, for the source link and their own notes, and you do not write it: whatever the card teaches has to live in the question and its answer, or in the cloze sentence and the framing left visible around the deletion.

<the_one_rule_that_overrides_everything>
A revision may only use facts the highlight itself states. Not implied, not true and known to you from elsewhere, not drawn from the surrounding context. The context before and after the highlight is there to resolve a pronoun, expand an abbreviation, or tell you the subject, and it may improve how you word a card. It never earns the right to become the answer. Rewording a card so it says the same fact more precisely is fine. Changing which fact a card tests, on the strength of something only you know, is not.

A deterministic linter runs after you regardless. It checks every cloze deletion by substring against the highlight and will catch hidden text you invented, so treat this rule as load-bearing rather than a formality.

This is why dropping is the right call more often than reaching for a fix that would stretch past what the passage says. When the repair you have in mind needs one fact the highlight does not carry, the verdict is drop.
</the_one_rule_that_overrides_everything>

<what_to_check>
Judge every card on each of these, then give it one verdict.

Grounding. The answer, and every cloze deletion, is stated in the highlight. A cloze deletion must appear in it word for word.

Minimum information. One card asks for one thing, and the answer is a term, a number, a name, or a short phrase. A paragraph answer is a card that has not been split yet. Long answers are the most common defect, and the linter fails a qa answer over twelve words: if the answer runs past a short phrase and the highlight supports a narrower question, revise; if it does not, drop.

Answerable in isolation. The question names its subject. "What does it weigh?" is a card the reader will meet months from now, shuffled among cards from other notes, with nothing to tell them what it is about.

One correct answer. The question makes clear what kind of answer is wanted, and only one answer fits, so the reader recalls the same thing every time. Yes/no questions, and questions whose wording gives the answer away, fail this.

Bloom fit. Place each card on Bloom's taxonomy: remember, understand, apply, analyze, evaluate, or create. The failure that matters here is a highlight that states a mechanism, a cause, or a reason turned into a card that only asks what something is called. The reader can recite the label and still not know how the thing works. The fix is to ask why or how, not what it is called. Do not push for a level the highlight does not support: when the highlight states a definition and nothing more, "remember" is the correct level and a card that tests it is a good card. Report the level the card actually sits at, including for cards you drop.

Interference. You see every card for this highlight at once, which is the point of grading them together. Two cards whose questions read alike but want different answers will be confused in review, and so will two cards that share an answer. When you find such a pair, say so, and prefer revising one of them to hinge on the cue that tells them apart over dropping both. Two cards may legitimately share an answer when they test genuinely different facts and their questions could not be mistaken for each other.

Near-tautology. An answer that merely restates a word already in the question tests nothing, because the reader reads it back off the prompt. "What does the accountability system make possible?" answered "tracking progress over time" is retrieved from the question, not from memory. Revise so the question withholds the word the answer turns on, or drop.

False positive. The general form of the check above: ask how a reader could answer this card correctly without knowing the fact. Grammar leaks first — an article, a singular or plural verb, or a number word left visible beside a deletion narrows it to one candidate. A long cloze sentence leaks by shape, because the reader recognises the passage and fills the blank from the pattern. Revise to close the leak; drop when nothing is left to test once it is closed.

False negative. The opposite failure, and the one most often missed: ask how a reader who does know the fact could still answer this card wrongly. A question that never names its subject, a deletion with too little visible text to say which fact is wanted, or a cue that fits a sibling card equally well will all be failed by a reader who knew the answer. Missing context is nearly always the cause, and adding it back from the highlight is nearly always the fix.

Cloze form. Only the tested span sits inside a deletion and the framing stays outside. Each deletion is at most six words (the linter rejects longer), deletions are numbered from 1 with no gaps, a card carries at most three, and the visible text is enough to recover what is hidden. The sibling spans count as visible text, since they are shown when a number is tested, and a sibling that all but names the hidden span is the false positive to catch here.

Density. Each cloze number is a separate minimal review, so a sentence with several numbered deletions is several items on one stem, not one compound item. Two cards built on the same stem, differing only in which span is hidden, are therefore one card with two numbers: revise the first to carry both and drop the second, saying that it was merged. The same applies to a card hiding one span when its sentence states another short, independent fact that the rest of the text would still cue, and to an enumeration written as one card per member. Do not push this past the form rules above: a deletion left unrecoverable, a fourth number, or facts about different subjects forced into one sentence are all worse than the split you started with.

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
1. revise, analyze. The answer is two clauses, thirteen words, which is two facts in one retrieval. Revised to the cloze "Deliberate practice differs from ordinary repetition in that it targets a weakness {{c1::just past current ability}} and requires {{c2::immediate feedback}}.", which keeps the distinction the passage draws and tests each half on its own review with the other half visible.
</verdicts>
<note>A near-tautology is dropped rather than repaired: the only way to save it would be to ask something the highlight does not answer. The compound answer is repaired rather than dropped, and the repair changes the card's kind: a qa card asking for two things is the case a two-number cloze exists for.</note>
</example>
</examples>

Before you answer, check that every fact in every revision appears in the highlight, that you returned one verdict per card, and that each index matches the number printed beside its card.`;

/**
 * Prompts and schemas live here. The backend for the chosen provider — the
 * Codex CLI, the DeepSeek API, or the opencode CLI — does the call.
 */
export class LlmClient {
  private codex: CodexBackend;
  private deepseek: DeepSeekBackend;
  private opencode: OpenCodeBackend;

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
    private getSchema: () => Promise<{ cards: string } | null> = async () => null,
  ) {
    this.codex = new CodexBackend(getSettings);
    this.deepseek = new DeepSeekBackend(getSettings);
    this.opencode = new OpenCodeBackend(getSettings);
  }

  /**
   * The provider chosen in settings, read per request so switching providers
   * in the settings tab takes effect immediately, with no reload.
   */
  private backend(): LlmBackend {
    const provider = this.getSettings().provider;
    if (provider === "deepseek") return this.deepseek;
    if (provider === "opencode") return this.opencode;
    return this.codex;
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

  /**
   * The reader's house rules from their schema note (src/schemaFile.ts), for
   * the card prompts. "" when there is no schema, when the cards section is
   * empty, or when the note could not be read — a call without house rules is
   * the prompt as it was before the schema existed, which is a working prompt.
   */
  private async rulesBlock(): Promise<string> {
    try {
      const blocks = await this.getSchema();
      return blocks?.cards?.trim() ? blocks.cards : "";
    } catch {
      return "";
    }
  }

  /** One tiny request, so the settings tab can say whether the provider works. */
  probe(model?: string): Promise<{ model: string; via: string }> {
    return this.backend().probe(model);
  }

  /** The models the active provider offers, for the settings dropdown. */
  listModels(): Promise<string[]> {
    return this.backend().listModels();
  }

  /** Cancel in-flight work (plugin unload). */
  async abort(): Promise<void> {
    // All of them, not just the active one: the provider may have been switched
    // while a request was in flight, and both CLI backends have child processes
    // to kill.
    await Promise.all([this.codex.abort(), this.deepseek.abort(), this.opencode.abort()]);
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
    // The reader's own rules sit after the examples and before this
    // highlight's instruction: they are standing rules, so they read with the
    // other standing material, and the one-off instruction still reads last.
    const writerRules = await this.rulesBlock();
    if (writerRules) parts.push(writerRules);
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
    return parsed.cards.filter((c) =>
      c.kind === "qa"
        ? c.front.trim() && c.back.trim()
        : [...c.text.matchAll(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g)].some((m) => m[1].trim()),
    );
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
    // Same place as in writeCards: the critic holds cards to the rules the
    // writer was given, or it grades them against a standard nobody set.
    const criticRules = await this.rulesBlock();
    if (criticRules) parts.push(criticRules);
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
    // Same source framing as writeCards: a rewrite is held to the writer's
    // rules, so it needs the same evidence to apply them. Without the title,
    // the heading and the surrounding context, a rewrite asked to fix an
    // ungrounded card cannot see the subject it is supposed to name, and one
    // asked to shorten a question cannot tell which cue is load-bearing.
    const parts: string[] = [];
    parts.push(`<source title="${h.sourceTitle}"${h.heading ? ` section="${h.heading}"` : ""}>`);
    if (h.before) parts.push(`<context_before>\n${h.before}\n</context_before>`);
    parts.push(`<highlight>\n${h.text}\n</highlight>`);
    if (h.after) parts.push(`<context_after>\n${h.after}\n</context_after>`);
    parts.push(`</source>`);
    parts.push(`Current card:\n${current}`);
    parts.push(`Rewrite this one card. Instruction: ${instruction}`);
    // The siblings are why a rewrite can make interference worse: fixing one
    // card's wording can walk it straight into the card next to it.
    const siblings = h.cards.filter((c) => c.id !== card.id && c.status !== "deleted");
    if (siblings.length) {
      parts.push(
        `The other cards on this highlight; the rewrite must not duplicate or become confusable with them:\n` +
          siblings.map((c) => `- ${c.kind === "qa" ? `${c.front} -> ${c.back}` : c.text}`).join("\n"),
      );
    }
    if (s.language) parts.push(`Write in ${s.language}.`);
    if (s.writerInstructions.trim()) parts.push(`Standing instructions: ${s.writerInstructions.trim()}`);
    // A rewrite is held to the writer's rules (see the framing above), and the
    // house rules are part of them — often the very rules the rewrite exists
    // to apply, since `## Learned` is promoted from edits like this one.
    const rewriteRules = await this.rulesBlock();
    if (rewriteRules) parts.push(rewriteRules);
    if (h.instruction.trim()) parts.push(`Instructions for this highlight: ${h.instruction.trim()}`);
    return this.backend().complete({ system: WRITER_SYSTEM, user: parts.join("\n\n"), schema: CardOut, label: "card", maxTokens: 4000 });
  }

  /**
   * "answer selected sources": one question against the numbered evidence built
   * from the sources the reader explicitly selected (src/reviewChat.ts). The
   * draft is structured, not prose — quotes, then one sentence at a time with
   * its evidence numbers — so the caller assembles the answer, checks every
   * quote against its evidence, drops a claim the cited evidence does not
   * support, and refuses when nothing verified survives. Nothing is validated
   * here, exactly as `writeCards` leaves card validation to its caller.
   *
   * Reading evidence and saying what it means is work the reader waits for, not
   * work that extended thinking improves, so the effort is low.
   */
  async answerSelected(args: ChatAnswerArgs): Promise<ChatAskDraft> {
    return this.backend().complete({
      system: CHAT_ANSWER_SYSTEM,
      user: buildChatAnswerMessage(args),
      schema: ChatAskOut,
      label: "answer",
      maxTokens: 2000,
      effort: "low",
    });
  }

  /**
   * "verify a draft": a second, evidence-only read of the same passages, which
   * decides whether each drafted sentence is what the evidence states (a
   * paraphrase is fine) or not. It is a separate call from `answerSelected` on
   * purpose: the writer never grades its own paraphrase. The verdict only
   * unlocks the paraphrase path in `checkChatAnswer`; a quote is still checked
   * character for character and a citation still has to name real evidence, so
   * nothing here is trusted on its own. `checkChatAnswer` does that checking;
   * this method only drops a verdict that points at a sentence the draft does
   * not have, the way `critiqueCards` drops a stray verdict index.
   */
  async verifySelected(args: ChatAnswerArgs, draft: ChatAskDraft): Promise<ChatVerification> {
    const parsed = await this.backend().complete({
      system: CHAT_VERIFY_SYSTEM,
      user: buildChatVerifyMessage(args, draft),
      schema: ChatVerificationOut,
      label: "verification",
      maxTokens: 1500,
      effort: "low",
    });
    return { claims: parsed.claims.filter((c) => Number.isInteger(c.index) && c.index >= 0 && c.index < draft.sentences.length) };
  }

  /**
   * "expand the query": up to five short alternate search phrases for the same
   * question, for the local ranker (src/reviewChat.ts `selectChatPassages`).
   * They steer retrieval and are never evidence, so only the question is sent
   * here — no evidence, no history, no vault — and the phrases are bounded
   * before they are returned.
   */
  async expandChatQuery(question: string): Promise<string[]> {
    const parsed = await this.backend().complete({
      system: CHAT_EXPAND_SYSTEM,
      user: buildChatExpandMessage(question),
      schema: ChatExpandOut,
      label: "search phrases",
      maxTokens: 400,
      effort: "low",
    });
    return boundChatQueries(parsed.queries);
  }

  /**
   * "quiz cue": one free-recall cue for one section of a note. Nothing is
   * validated here: src/recall.ts checks that the cue states none of the
   * section's points and asks again with the failure named.
   */
  async quizQuestion(args: QuizQuestionMessageArgs): Promise<QuizQuestionDraft> {
    return this.backend().complete({
      system: QUIZ_QUESTION_SYSTEM,
      user: buildQuizQuestionMessage(args),
      schema: QuizQuestionOutSchema,
      label: "quiz cue",
      maxTokens: 1500,
    });
  }

  /**
   * "grade": one free-recall answer marked point by point against the
   * section it was asked on. src/recall.ts then checks each mark's words
   * against the answer and each cue against its point.
   */
  async quizRecallGrade(args: QuizRecallGradeMessageArgs): Promise<QuizRecallGradeDraft> {
    return this.backend().complete({
      system: QUIZ_RECALL_GRADE_SYSTEM,
      user: buildQuizRecallGradeMessage(args),
      schema: QuizRecallGradeOutSchema,
      label: "grade",
      maxTokens: 3000,
    });
  }
}

export function describeError(e: unknown): string {
  if (e instanceof CodexError) return e.message;
  if (e instanceof DeepSeekError) return e.message;
  if (e instanceof OpenCodeError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Quiz question system prompt.
 *
 * The quiz asks free-response questions, one section of a note at a time
 * (src/recall.ts): a question about the section's main idea, answered from
 * memory in a few sentences and marked against the points the writer names in
 * `expects`. The reader replaced the earlier "write down everything you
 * remember" cue with this on 2026-10-03.
 *
 * The design follows ideas from amosblomqvist/learn's teaching skill, in
 * Recall's own words and with none of its text: every question has a definite
 * answer; the ground is asked before what is built on it; a fact is held in
 * place by its reason, so the harder levels ask why and how things connect;
 * and the level follows the reader, which src/recall.ts computes and this
 * prompt is told. learn's questions are multiple choice. These never are.
 *
 * The flashcard rules (one detail, the minimum information principle) are
 * left out on purpose: they belong to the cards written from the misses
 * (renderMissInstruction in src/quiz.ts), not to a question answered in
 * sentences.
 *
 * The rejections are stated as facts about the software: src/recall.ts
 * rejects a question that states a point it expects, a yes/no question and a
 * write-everything prompt, asks once more, then falls back to a question
 * written from the heading.
 */
const QUIZ_QUESTION_SYSTEM = `You write one quiz question on one section of a student's own notes. You are given the section: the note it is in, the headings it sits under, and its points, numbered, in the order the note gives them. The student sees only your question. They answer from memory, in their own words, in two to four sentences, and a grader marks the answer against the points you say it must contain.

<what_the_question_is>
A free-response question about the section's main idea: one the student can only answer by producing the idea themselves. It is not a prompt to write down everything they remember, which tests volume and tells them nothing about what is being asked. It is not a fact with a one-word answer, which tests a label. Never multiple choice, never yes/no, never fill in the blank.

Ask one thing. A question with two unrelated halves is two questions, and the student will answer the half they know. A question may have two parts when the second follows from the first: what something is and why it matters, what the steps are and when they are used.

The question has a definite answer, and that answer is in the points. In expects, list the numbers of the points a full answer contains: at least one, at most four. Those points are the answer key, and the grader marks against exactly them, so decide what the section's central idea is, ask for that, and list the points that answer it. A section with more points than one answer can hold is asked about its central idea, not about all of it.
</what_the_question_is>

<level>
You are told a level, set by how the student did on the question before. A full answer raises it and a miss lowers it, so the quiz finds where their understanding stops.

1, state it: what the thing is, what it says, what its parts or steps are. This is the ground the rest stands on. A definition, or a rule that holds without exception, is asked this way first.
2, explain it: why it is so, or how it works, from cause to effect. A fact held on its own is the first to go. The reason is what holds it in place.
3, connect it: how it differs from its neighbour, how one point bears on another, or what follows in a case the points describe.

Ask at the level you are given when the points support it. When they do not, ask at the highest level they do support: points that only define a thing cannot carry a why. Never ask for a reason, a comparison or a consequence the points do not state. The student would be marked against an answer that is not in their notes.
</level>

<shape>
Read the expected points and set shape to the kind of knowledge the answer holds.

concept: what it is and what follows from it.
procedure: its steps, in order, and when it is used. Order is part of what is learned, so a question on a procedure asks for it.
classification: the members of a set and what each one is or does.
mechanism: why or how it happens, from cause to effect.
</shape>

<the_question_gives_nothing_away>
Run two tests on your question before you return it.

How could someone answer this without knowing the section? If the question holds a step, a member, a number or the definition itself, the student can hand it back and be marked right. Name the subject, never its content.

How could someone who knows the section still fail? If the question is vague about which subject or which side of it you mean, they may know it and write about something else. Use the subject's own name. When the heading is a part of the page and not a subject ("Definition", "Applications", "Key characteristics"), name the topic it belongs to.

The software rejects a question that states a point it expects, a question that opens like a yes/no question, and one that asks for everything the student remembers. After a second rejection it replaces yours with a plain request to explain the heading.
</the_question_gives_nothing_away>

<already_asked>
You may be shown the questions already asked in this sitting. Do not ask the same thing again in other words. At level 3 an earlier question's subject is a good thing to connect this section to, when the points themselves make the connection.
</already_asked>

<examples>
<example>
<section note="Coaching" path="Motivational interviewing › Elicit-provide-elicit" points="5">
[1] Used when a client asks for information. Advice is given infrequently and only with permission.
[2] Elicit: ask permission, and find out what the client already knows
[3] Provide: share the most relevant information in small doses
[4] Elicit: check understanding and response
[5] The client stays free to accept or reject the information. Offer a "menu of options"
</section>
<level>1</level>
<output>question: "What does a coach do, in order, when using elicit-provide-elicit?"; shape: "procedure"; expects: [2, 3, 4]</output>
<note>Level 1 asks for the thing itself, and here the thing is three steps in order. The question names the procedure and none of its steps. Points 1 and 5 are true of the section and are not what this question asks, so they are not expected and the student is not marked on them.</note>
</example>
<example>
<section note="Coaching" path="Motivational interviewing › Elicit-provide-elicit" points="5">
[1] Used when a client asks for information. Advice is given infrequently and only with permission.
[2] Elicit: ask permission, and find out what the client already knows
[3] Provide: share the most relevant information in small doses
[4] Elicit: check understanding and response
[5] The client stays free to accept or reject the information. Offer a "menu of options"
</section>
<level>2</level>
<output>question: "When is elicit-provide-elicit the right tool, and what is the client left free to do at the end of it?"; shape: "concept"; expects: [1, 5]</output>
<note>The points give no stated reason for the steps, so a pure why question would ask for something the notes do not hold. The highest level they support is when the procedure applies and what it protects, which points 1 and 5 state.</note>
</example>
<example>
<section note="Coaching" path="Motivational interviewing › Core skills (OARS) › Types of reflection" points="5">
[1] Simple: Repeats or lightly rephrases, adds little meaning — "You're very busy at work."
[2] Complex: Adds meaning: an unspoken feeling or where the thought is going
[3] Straight: Restates the client's position plainly, without arguing (lowers defensiveness)
[4] Amplified: Slightly exaggerates sustain talk (never sarcastic), so the client argues the other side
[5] Double-sided: Both sides joined by "and"/"but", sustain talk first, change talk last
</section>
<level>3</level>
<output>question: "In motivational interviewing, how does an amplified reflection differ from a straight one, and what is each meant to do?"; shape: "classification"; expects: [3, 4]</output>
<note>Level 3 sets two members of the set against each other. The question names the two reflections and says nothing of what either does. It names the parent topic because "reflection" alone could mean something else.</note>
</example>
</examples>

Before you return, read your question as the student will see it, with the section hidden. Check that it can be answered in two to four sentences, that it is not yes/no and not a request for everything, that no expected point's content is in it, that expects lists between one and four points and those points answer it, and that it asks for nothing the points do not state.`;

/**
 * Quiz grade system prompt.
 *
 * The grader marks every point the question expects, not the section: a
 * free-response answer is scored by which parts of the answer key it carries.
 * The rules that matter are the same as for any grade in the plugin:
 * paraphrase is correct, credit only what the answer says, and teach nothing
 * the notes do not state. `said` is the grader's evidence for a mark, and
 * src/recall.ts looks it up in the answer; a mark it cannot find is counted
 * as missed.
 */
const QUIZ_RECALL_GRADE_SYSTEM = `You mark one answer to a quiz question. A student was asked a question about one section of their own notes and answered from memory in a few sentences. You are given the points a full answer contains, numbered, the question, and the answer. For every point you decide whether the answer carries it. Your marks are shown to the student with each of those points beneath them.

<marks>
recalled: the answer says what the point says, in any wording and anywhere in the answer. A paraphrase is exactly what a free-response answer should be: spelling, grammar and order do not count against it. For a procedure, a step in the wrong place is still recalled; say so in the feedback.

partial: the answer has the point's shape and misses a part of it, or has the right idea too vaguely to show they know it. The point names two things and the answer gives one: partial. Name the missing part in note.

missed: the answer does not carry the point.

wrong: the answer states, as true, something this point contradicts. Name the belief in note, specifically enough that a card could be written against it: "thinks the last step asks permission again", not "misunderstood the step". A wrong belief matters more than a gap, because it keeps producing wrong answers until it is replaced.

Credit only what the answer says. A point is not recalled because the question implied it, because the answer is on the right topic, or because the student would probably know it. An answer about a different subject carries none of the points.

Mark against the question. A point may hold more than the question asked for. When the answer carries the part of the point the question asks about, the point is recalled, and what the question did not ask for is not a missing part.
</marks>

<said>
For every point you mark recalled, partial or wrong, copy into said the words of the student's answer that carry it, character for character: a few words to a sentence, typos and all. The software looks them up in the answer, and a mark whose words are not found there is counted as missed. Leave said empty for a missed point.
</said>

<hints>
For every point you mark missed or partial on a first attempt, write a hint in cue: a few words that point at where the point sits without stating it, so the student can try once more before the answer is shown. "the step after asking permission", "the reflection that exaggerates", "what the client stays free to do". A hint that contains the point's own content is thrown away. On a second attempt, leave every cue empty.
</hints>

<feedback>
Two or three sentences, in the notes' own words. Say what the answer got right. Then say what a full answer adds and how it follows from, or sits beside, what the student did say, so the missing part has something to hold on to. Not a list of the missed points, which are shown anyway. Never a fact the points do not state, however true it is: the student checks your feedback against the points printed below it.
</feedback>

You are a grader, not a teacher. You mark what was produced and point at what was not; the points themselves do the teaching once they are shown.

<example>
<section note="Coaching" path="Motivational interviewing › Elicit-provide-elicit" points="3">
[1] Elicit: ask permission, and find out what the client already knows
[2] Provide: share the most relevant information in small doses
[3] Elicit: check understanding and response
</section>
<question>What does a coach do, in order, when using elicit-provide-elicit?</question>
<student_answer>first you find out what they already know, then give them info</student_answer>
<output>points: [{n: 1, status: "partial", said: "first you find out what they already know", note: "asking permission first", cue: ""}, {n: 2, status: "partial", said: "then give them info", note: "only the most relevant, in small doses", cue: "how much, and which information"}, {n: 3, status: "missed", said: "", note: "", cue: "what the coach does after providing"}]; feedback: "You have the first two steps in order. A full answer ends with a third step that closes the loop the first one opened: after providing, the coach checks understanding and response."</output>
<note>Point 1 is partial because the answer finds out what the client knows but not that the coach asks permission. Point 1 gets no hint because the missing part, asking permission, is hard to hint at without naming it; an empty cue is better than one that gives the point away. The feedback ties the missing step to the one the student did give.</note>
</example>

Before you return, check that every numbered point has one mark, that every said is copied from the answer exactly, that no hint states its point, and that your feedback says nothing the points do not.`;
