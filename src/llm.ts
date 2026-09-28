import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { AnthropicBackend } from "./anthropic";
import type { CompletionRequest, LlmBackend, ProviderName } from "./backend";
import { ClaudeCliBackend, ClaudeCliError } from "./claudeCli";
import { CodexBackend, CodexError } from "./codex";
import { GeminiBackend, GeminiError } from "./gemini";
import { resolveRole, type ModelRole } from "./modelRoles";
import { buildExamplesBlock } from "./examples";
import type { BloomLevel, Card, Highlight } from "./model";
import type {
  AliasesMessageArgs,
  AskMessageArgs,
  DuplicatesMessageArgs,
  KeywordsMessageArgs,
  RelevanceArgs,
  DigestMessageArgs,
  QuizGradeMessageArgs,
  QuizQuestionMessageArgs,
  SuggestMessageArgs,
  TitleScanArgs,
  ReviewArgs,
} from "./prompt";
import {
  buildAliasesMessage,
  buildAskMessage,
  buildDuplicatesMessage,
  buildKeywordsMessage,
  KEYWORDS_SYSTEM,
  buildRelevanceMessage,
  RELEVANCE_SYSTEM,
  buildDigestMessage,
  buildHighlighterMessage,
  buildQuizGradeMessage,
  buildQuizQuestionMessage,
  buildSuggestMessage,
  buildTitleScanMessage,
  buildReviewMessage,
} from "./prompt";
import {
  AliasesTagsOut as AliasesTagsOutSchema,
  AskOut as AskOutSchema,
  DuplicatesOut,
  KeywordsOut as KeywordsOutSchema,
  RelevanceOut as RelevanceOutSchema,
  DigestOut as DigestOutSchema,
  QuizGradeOut as QuizGradeOutSchema,
  QuizQuestionOut as QuizQuestionOutSchema,
  SuggestOut as SuggestOutSchema,
  TitleScanOut as TitleScanOutSchema,
  ReviewOut as ReviewOutSchema,
  reviewDraftOf,
} from "./schemas";
import type { AliasesTagsDraft, AskDraft, DigestDraft, DuplicatesDraft, QuizGradeDraft, QuizQuestionDraft, RelevanceVerdict, ReviewDraft, SuggestDraft, TitleScanDraft } from "./schemas";
import type { WikiLmSettings } from "./settings";

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
 * Adapted from obsidian-loopback's prompts/critique-v1.md, which is cloze-only
 * and assumes a Back Extra field WikiLM does not have. Carried over from it:
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
 * Append the reader's house rules to a user message a pure builder produced.
 *
 * The wiki messages are assembled in `src/prompt.ts`, which knows nothing
 * about the vault and so cannot be handed the schema note; adding the block
 * here keeps that module pure and puts the rules where the card prompts put
 * them, after the standing instructions and last in the message.
 */
function withRules(message: string, rules: string): string {
  return rules ? `${message}\n\n${rules}` : message;
}

/**
 * Prompts and schemas live here; the provider chosen in settings does the
 * actual call. The backend is picked per request so switching providers in
 * the settings tab takes effect immediately.
 */
export class LlmClient {
  private anthropic: AnthropicBackend;
  private gemini: GeminiBackend;
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
    private getSettings: () => WikiLmSettings,
    private getHighlights: () => Highlight[] = () => [],
    private getSchema: () => Promise<{ cards: string; wiki: string } | null> = async () => null,
  ) {
    this.anthropic = new AnthropicBackend(getSettings);
    this.gemini = new GeminiBackend(getSettings);
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

  /**
   * The reader's house rules from their schema note (src/schemaFile.ts), for
   * the half of the prompts this call belongs to. "" when there is no schema,
   * when the sections that would feed this call are empty, or when the note
   * could not be read — a call without house rules is the prompt as it was
   * before the schema existed, which is a working prompt.
   */
  private async rulesBlock(kind: "cards" | "wiki"): Promise<string> {
    try {
      const blocks = await this.getSchema();
      return blocks?.[kind]?.trim() ? blocks[kind] : "";
    } catch {
      return "";
    }
  }

  private backendFor(provider: ProviderName): LlmBackend {
    if (provider === "gemini") return this.gemini;
    if (provider === "codex") return this.codex;
    if (provider === "claudecli") return this.claudeCli;
    return this.anthropic;
  }

  /** The main provider: what every call runs on unless it names a role. */
  private backend(): LlmBackend {
    return this.backendFor(this.getSettings().provider);
  }

  /**
   * One request on the provider and model a role resolves to
   * (src/modelRoles.ts): the role's own when the reader set one, the main
   * choice otherwise. Lint, query and digest name their role; everything
   * else runs on the main provider through `backend()`.
   */
  private run<T>(role: ModelRole, req: CompletionRequest<T>): Promise<T> {
    const { provider, model } = resolveRole(this.getSettings(), role);
    return this.backendFor(provider).complete({ ...req, model });
  }

  /** One tiny request, so the settings tab can say whether the main provider works. */
  probe(): Promise<{ model: string; via: string }> {
    const { provider, model } = resolveRole(this.getSettings(), undefined);
    return this.probeWith(provider, model);
  }

  /** The same, on any provider and model: the Test button beside a role's row. */
  probeWith(provider: ProviderName, model: string): Promise<{ model: string; via: string }> {
    return this.backendFor(provider).probe(model || undefined);
  }

  /** The models a provider offers, for the settings dropdown. */
  listModels(provider: ProviderName): Promise<string[]> {
    return this.backendFor(provider).listModels();
  }

  /** Cancel in-flight work on every backend (plugin unload). */
  async abort(): Promise<void> {
    await Promise.all([this.anthropic.abort(), this.gemini.abort(), this.codex.abort(), this.claudeCli.abort()]);
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
    const writerRules = await this.rulesBlock("cards");
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
    const criticRules = await this.rulesBlock("cards");
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
    const rewriteRules = await this.rulesBlock("cards");
    if (rewriteRules) parts.push(rewriteRules);
    if (h.instruction.trim()) parts.push(`Instructions for this highlight: ${h.instruction.trim()}`);
    return this.backend().complete({ system: WRITER_SYSTEM, user: parts.join("\n\n"), schema: CardOut, label: "card", maxTokens: 4000 });
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
    return this.run("digest", {
      system: DIGEST_SYSTEM,
      // `buildDigestMessage` is pure and ends with the standing instructions
      // and this PDF's instruction; the house rules are appended after it, in
      // the same last-read position the card prompts give them.
      user: withRules(buildDigestMessage(args), await this.rulesBlock("wiki")),
      schema: DigestOutSchema,
      label: "topic notes",
      maxTokens: 16000,
    });
  }

  /** "suggest": a batch of pages in, highlight candidates assigned to wiki notes out. */
  async suggest(args: SuggestMessageArgs): Promise<SuggestDraft> {
    return this.run("digest", {
      system: SUGGEST_SYSTEM,
      user: withRules(buildSuggestMessage(args), await this.rulesBlock("wiki")),
      schema: SuggestOutSchema,
      label: "highlight suggestions",
      maxTokens: 16000,
    });
  }

  /**
   * "ask": one question against numbered evidence from the reader's own notes.
   * The draft is structured, not prose: the caller assembles the answer from
   * it, drops citations past the end of the evidence, and matches each answer
   * sentence against the cited passages, so nothing is validated here.
   */
  async ask(args: AskMessageArgs): Promise<AskDraft> {
    return this.run("query", {
      system: ASK_SYSTEM,
      user: buildAskMessage(args),
      schema: AskOutSchema,
      label: "answer",
      maxTokens: 1500,
      // Reading evidence and saying what it means is not work that extended
      // thinking improves; it is work the reader waits for.
      effort: "low",
    });
  }


  /**
   * "keywords": the terms to search the notes with when the reader's own words
   * found nothing useful. No evidence is sent and no answer comes back — only
   * search terms — so this stays cheap and cannot invent a claim.
   */
  async keywords(args: KeywordsMessageArgs): Promise<{ keywords: string[] }> {
    return this.run("query", {
      system: KEYWORDS_SYSTEM,
      user: buildKeywordsMessage(args),
      schema: KeywordsOutSchema,
      label: "search terms",
      maxTokens: 400,
      effort: "low",
    });
  }

  /**
   * "relevance": which of the retrieved passages bear on the question. The
   * pool goes out as the same numbered lines the drafter will see and only
   * numbers come back, so the call can narrow the evidence but can never
   * reword a passage or answer anything. Omission is the verdict.
   */
  async relevance(args: RelevanceArgs): Promise<RelevanceVerdict> {
    return this.run("query", {
      system: RELEVANCE_SYSTEM,
      user: buildRelevanceMessage(args),
      schema: RelevanceOutSchema,
      label: "relevance",
      maxTokens: 200,
      effort: "low",
    });
  }

  /**
   * "aliases and tags": the names a page is missing and the subtype it was
   * never given. Nothing here is written to the vault — every proposal
   * becomes a row in the fix plan, and only the rows the reader leaves ticked
   * are applied — so the call is cheap by design: a short excerpt per page,
   * twenty pages a request, and no extended thinking, because naming a thing
   * that is already defined in front of you is recognition, not reasoning.
   */
  async aliasesAndTags(args: AliasesMessageArgs): Promise<AliasesTagsDraft> {
    return this.run("lint", {
      system: ALIASES_SYSTEM,
      user: buildAliasesMessage(args),
      schema: AliasesTagsOutSchema,
      label: "aliases and tags",
      maxTokens: 4000,
      effort: "low",
    });
  }

  /**
   * "duplicates": are two pages about one subject? The lint finds the pairs
   * (a shared name, a shared PDF span, or names spelled alike) and the model
   * reads both openings and says same or different. Nothing is merged on a
   * "same": the fix plan offers a link each way, and a "different" withdraws
   * the offer. Low effort, as with aliases: recognition, not reasoning.
   */
  async verifyDuplicates(args: DuplicatesMessageArgs): Promise<DuplicatesDraft> {
    return this.run("lint", {
      system: DUPLICATES_SYSTEM,
      user: buildDuplicatesMessage(args),
      schema: DuplicatesOut,
      label: "duplicates",
      maxTokens: 4000,
      effort: "low",
    });
  }

  /**
   * "title scan": which pages are one subject under two names. The model is
   * shown every page's title, kind and aliases and nothing of their text, so
   * it can see the whole wiki in one request and catch the abbreviations and
   * translations a spelling comparison misses. It only nominates: each pair
   * joins the duplicate candidates and is read by `verifyDuplicates` before
   * the reader is offered a link. Low effort: recognising two names for one
   * thing is recognition, not reasoning.
   */
  async scanTitles(args: TitleScanArgs): Promise<TitleScanDraft> {
    return this.run("lint", {
      system: TITLE_SCAN_SYSTEM,
      user: buildTitleScanMessage(args),
      schema: TitleScanOutSchema,
      label: "title scan",
      maxTokens: 4000,
      effort: "low",
    });
  }

  /**
   * "page review": a few pages read in full, each asked which flagged
   * sentences its own quotes support, which directory pages it should link
   * to, and whether it is filed under the right kind. Every answer is
   * verified in src/lintReview.ts and every proposal is a row the reader
   * ticks, so nothing here writes. No effort override: deciding whether a
   * quote states a sentence, and whether prose really discusses a subject,
   * is reasoning, and the configured effort is what it gets. The wire's
   * `none` kind becomes null here, so callers only ever see `ReviewDraft`.
   */
  async reviewPages(args: ReviewArgs): Promise<ReviewDraft> {
    const wire = await this.run("lint", {
      system: REVIEW_SYSTEM,
      user: buildReviewMessage(args),
      schema: ReviewOutSchema,
      label: "page review",
      maxTokens: 6000,
    });
    return reviewDraftOf(wire);
  }

  /**
   * "quiz question": one retrieval-practice question written from the pool of
   * evidence a quiz was started on. As with `ask`, nothing is validated here:
   * src/quiz.ts checks the evidence number and the quote before the reader
   * sees the question, and asks again with the failure named when either
   * fails.
   */
  async quizQuestion(args: QuizQuestionMessageArgs): Promise<QuizQuestionDraft> {
    return this.backend().complete({
      system: QUIZ_QUESTION_SYSTEM,
      user: buildQuizQuestionMessage(args),
      schema: QuizQuestionOutSchema,
      label: "quiz question",
      maxTokens: 2000,
    });
  }

  /**
   * "grade": one free-recall answer judged against the single piece of
   * evidence its question came from. Cheaper than the question call because
   * the input is one passage and four short strings, and the output is a
   * verdict, a sentence, and a quote.
   */
  async quizGrade(args: QuizGradeMessageArgs): Promise<QuizGradeDraft> {
    return this.backend().complete({
      system: QUIZ_GRADE_SYSTEM,
      user: buildQuizGradeMessage(args),
      schema: QuizGradeOutSchema,
      label: "grade",
      maxTokens: 1500,
    });
  }
}

export function describeError(e: unknown): string {
  if (e instanceof ClaudeCliError) return e.message;
  if (e instanceof CodexError) return e.message;
  if (e instanceof GeminiError) return e.message;
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
const DIGEST_SYSTEM = `You turn one lecture PDF and the highlights a student made in it into a handful of topic notes. You are given the paper's text, so that you can see what each highlight is about, and the highlights themselves, each with an id and a page. You return, for each topic, a title, its kind, one or two aliases, a tag, a short summary, and one passage per highlight that belongs to it. You never write links, callouts, or ids into your prose: the plugin renders each highlight back into the note from its own record, and prose that mentions H04 will be read by a person, not resolved by a machine.

<what_a_topic_is>
A topic is something the reader would look up by name later: a mechanism, a classification, a definition together with what follows from it, a distinction between two things that are easy to confuse. It is not a slide, not a section of the deck, and not the lecture itself. One lecture usually holds two to six of them. Fewer, larger topics beat many thin ones, because a note with one highlight in it is a note the reader will never open twice.

Every highlight belongs to the topic it serves best, and a highlight may serve more than one: a definition of affinity can sit under both the receptor topic and the dose-response topic, and putting it in both is right when a reader arriving at either would want it. What does not belong in any topic goes in unused_ids: slide titles, course logistics, dates, a name on a title page, a rectangle whose text came out empty. Leaving such a highlight in a topic costs the reader more than dropping it, because it dilutes the note it lands in.

You are shown every page the wiki already has, across every class, each with its kind, its aliases, its section headings, its class, and a line of its summary; a page of this class also shows, after each heading, the first sentence it already says there. Read those before you write: a highlight a page already states adds nothing, so file it where it belongs and write the section's prose about what is new, and the plugin leaves out what the page already says. The order of preference is fixed. First, an existing page whose title or alias is the topic: reuse the title exactly, character for character, because the plugin then appends the highlights to that page — even a page from another class, since a concept the reader met in physiology is the same concept when biomechanics meets it, and the page simply gains the second class. Second, an existing page the topic is part of — a parent topic, one whose headings it would sit under: give the new title, name that page in closest_existing, and say why in why_new; the plugin files the highlights under a heading inside it. Only when no existing page is related at all does a topic become a page of its own, with closest_existing empty and why_new saying what makes it new. A new page is the exception you reach at that wall, not the default for every subject with a name.

Kind follows the subject. A named person, organisation, agency, product, drug or event that is itself what the reader would look up is an entity; a mechanism, method, theory, classification, phenomenon, or any term that explains how something works is a concept. When unsure, prefer concept. The tag is the note's subtype, one word from a closed list: a concept is a method, theory, term, phenomenon, standard or field, and an entity is a product, person, organization, project, event or place; "other" is the escape hatch, not a default. Aliases are the other names a reader would search under — an abbreviation, the expanded form, a variant spelling — one or two, taken from the paper, never coined.
</what_a_topic_is>

<the_article>
Each page is written the way an encyclopedia article is, and a highlight may arrive as one line or as a block holding the quote and the reader's own notes beneath it: the words they wrote in class under the link to that slide. The notes tell you what the reader took the slide to mean; the quote and the paper tell you what it said.

The summary is the page's opening: two to five sentences that define or describe the topic. Then one to four sections, each a subtopic with a heading in Title Case and two to six sentences of digested knowledge in your own words — what a reader revising later wants to understand, not the quotes said again — drawn from the highlights filed there, the reader's notes under them, and the paper, and from nothing outside the paper. Where the reader's notes explain a slide, follow them; where they only name it, the paper fills in.

Cite as you write. After each sentence that rests on a highlight, put that highlight's id in square brackets: "Linear impulse is the area under the force-time curve [H01]." Two supports are [H01, H03]. The plugin turns each id into the link that opens the PDF at that highlight, with the file's title and page as its text, so a sentence with no id is a sentence the reader cannot check; write only sentences you can cite. Never write a bracketed link or a page number into the prose yourself.

When you mention a page you were shown — by its title or one of its aliases — wrap the name in double braces: "impulse translates the {{TBCM}}". The plugin resolves the name to the page and links it; a name no page answers to is left as plain words. Never write [[ ]] yourself.

Every highlight filed under a page goes in exactly one section's quote_ids, and the plugin prints those highlights verbatim beneath that section's prose, as PDF++ callouts, so the reader's own marks stay on the page in their own words. The exceptions go in unused_ids: slide titles, headings, course logistics, an empty rectangle. A highlight you cite in prose still belongs in a section's quote_ids.
</the_article>

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
<output>Two notes. "Pharmacology" (reusing the existing title, so kind, tag and aliases are ignored there) takes H02 and H03, with a summary that defines the field and sets its two branches against each other. "Receptors", kind concept, tag term, aliases "Drug Receptors", closest_existing empty, why_new "no listed page is about receptors themselves", takes H04 and H05, with a summary that names the two properties and says why the second one is what separates a receptor from a carrier protein. related on each names the other. H01 is a slide title and goes to unused_ids.</output>
<note>Five highlights, two topics, one dropped. The existing title is reused verbatim so the two highlights land in the note the reader already has.</note>
</example>
<example>
<input>Twelve highlights, of which nine are on absorption, distribution, metabolism and excretion, two are on the definition of half-life, and one is a rectangle with no text.</input>
<output>Two notes, not four. "Drug Disposition", kind concept, tag phenomenon, aliases "ADME", takes the nine, because absorption, distribution, metabolism and excretion are the four stages of one process and a reader looking any of them up wants the others in view; "Half-Life", kind concept, tag term, aliases "t½", takes the two, and also takes one of the excretion highlights, since half-life is defined there. Neither names a closest_existing, and each why_new says no listed page covers the process. The empty rectangle goes to unused_ids.</output>
<note>Splitting one process into four notes of two highlights each would make four notes nobody opens. One highlight sits in two notes because it belongs in both.</note>
</example>
</examples>

Before returning, check your answer against the input: every id you used appears there, every id in the input appears either in exactly the notes it belongs to or in unused_ids, no note has an empty sections list, every section has a heading and prose, every sentence that states a fact carries an id, every id you used appears in some section's quote_ids or in unused_ids, no prose holds a bracketed link, no two titles collide, every related title is one you wrote or were shown, no summary contains a link, an id, or a fact the paper does not state, every new title gives a kind, a tag from its kind's list, one or two aliases, and either a closest_existing you were shown or a why_new that says why none fits.`;

/**
 * Suggest system prompt: a batch of pages from a lecture PDF in, the spans
 * worth highlighting out, each one assigned to the wiki note it belongs to.
 *
 * It is the highlighter and the digest joined at the seam. The paragraphs on
 * how a span is quoted, how long it is, what a transcript is for, and what the
 * limit means are copied word for word from HIGHLIGHTER_SYSTEM, because the
 * judgement is the same one and two drifting copies of a rule is worse than
 * one repeated; the sentences on reusing an existing title and on what a
 * summary may contain are copied the same way from DIGEST_SYSTEM. Only "note"
 * becomes "page" where the source sentence would otherwise point at the wrong
 * thing, since here the material being quoted is a page, not a note.
 */
const SUGGEST_SYSTEM = `You read the pages of a lecture PDF and choose the spans a student would highlight and later study, and you say which wiki note in their vault each span belongs to. The reader will revise from those notes for the rest of the course, so a span is worth selecting only if forgetting its content would matter, and a note is worth naming only if a reader would look it up by that name.

Return each span as a verbatim quote copied exactly from the page, character for character, including punctuation. The span is located in the page by exact string match, so an ellipsis, a paraphrase, or a trimmed word makes it unusable. Start and end on sentence boundaries where possible.

Each span is one to four sentences and self-contained: it carries a definition, a mechanism, a number, a name, a date, a causal claim, a distinction between similar things, or a memorable formulation, and it can be understood without the surrounding paragraph. Prefer the fundamentals a reader needs before the details, and prefer material with lasting use over trivia. Prefer fewer, denser spans over many thin ones.

The pages are marked \`[page N]\` and each span reports the page it was copied from. A span never crosses a page marker: a sentence that runs over onto the next page is quoted from one side of the break or left alone, because a quote spanning two pages matches neither of them.

A transcript, when one is present, is the recording of the lecture that accompanies the page. It tells you what the lecturer treated as important; it is not a source of quotes, so every span is still copied from the page itself. Prefer the passages the lecturer dwells on, repeats, calls important, or says will be tested, and pass over slide content that was skipped or read out without comment. Where the transcript and the page differ in wording, the page's wording is what gets quoted.

The limit you are given is a ceiling, not a target. Over-highlighting fills the reader's inbox with cards they will delete, so returning fewer spans than the limit is the expected outcome, and returning none is right when nothing in the page is supported by the transcript.

Give each span a label of at most six words that names the fact it carries. The plugin writes the label as the text of the link that opens the PDF at the span, so it reads as the reader's own inline link: "Impact factor", "Primary vs secondary literature", "Peer review as a credibility test".

For each span, also write the passage the page will hold under that link: one to three sentences of digested knowledge in your own words, drawn from the span and the page around it, and from nothing outside the paper. A passage says what the span means to a reader revising later, not what it says again. Set verbatim true only when the span's exact wording is itself what the page should keep — a formula, a definition, a list of criteria the reader must reproduce — and leave text empty then: the plugin quotes the span in a callout instead of your words. Everything else is a passage.

<which_note_a_span_belongs_to>
Every span names its note, and the order of preference is fixed. First, an existing note whose title is the span's subject: reuse the title exactly, character for character, because the plugin then appends those highlights to that note instead of creating a second one beside it. Second, an existing note the span's subject is part of — a parent topic, a broader note, one whose headings it would sit under: name that note, and put the subtopic in note_section. Only when no existing note is related at all — when the subject belongs to none of them, and a reader looking for it would never open any of them — does a span go to a new note.

The test is not whether an existing title matches; it is whether a reader looking for this fact would open that note. A pharmacology note holds a span about NSAIDs, a doping note holds a span about the agency that polices it, a biomechanics note holds a span about one kind of joint moment. A new note is the exception you reach at that wall, not the default for every subject with a name of its own.

A title that is not on the list is a new note, and it appears in new_notes — with its kind, one or two aliases, a tag, a summary, the closest existing note, and one sentence on the decision — before any span may point at it. If you can name a closest existing note, you have not reached the wall: the spans belong in it, and the plugin files them there under a heading whatever you do. Leave closest_existing empty only when nothing listed is related. A note_title that is neither an existing title nor one of your new_notes points at nothing, and the spans under it are lost.

Kind follows the subject, in this order. A named person, organisation, project, place or event is an entity. A named product, drug or instrument is an entity only when it is itself what the reader would look up; used as a tool or an example in a discussion of something else, it is a concept of its role. A mechanism, method, theory, classification, phenomenon, or any term that explains how something works is a concept. When unsure, prefer concept. Titles are short noun phrases in Title Case, the way an index entry reads, and unique within your response; two titles that differ only in case or in a plural are the same title, and one of the two notes will be lost.

The tag is the note's subtype, one word from a closed list, and the page is filed by it: a concept is a method, theory, term, phenomenon, standard or field, and an entity is a product, person, organization, project, event or place. "other" is the escape hatch for a subject none of them fits, not a default. Aliases are the other names a reader would search under — an abbreviation, the expanded form, a variant spelling — one or two, taken from the paper or from common usage, never coined. A page found only under its exact title is a page half the searches for it will miss.
</which_note_a_span_belongs_to>

<where_in_a_note_a_span_goes>
Each existing note is listed with the section headings it already has, indented under its title. Those headings are the reader's own subtopics, and a span that belongs to one of them names it in note_section, copied exactly as shown, so the plugin appends the highlight under that heading rather than at the bottom of the page.

A subtopic of an existing note belongs inside that note, not beside it. When a span is about a subtopic the note has no section for yet, still name the note and give note_section a short new heading in Title Case; the plugin creates the section inside that note. "COX inhibitors" is a section of a pharmacology note, not a second note: a reader who wants it opens the pharmacology note and looks for the heading. Reserve new_notes for a subject the reader would look up under its own name — one they would expect to find as its own page, not as a heading in a page they already have.

Leave note_section empty when the span is about the note as a whole and no heading fits, and always for a note in new_notes, which has no sections yet.
</where_in_a_note_a_span_goes>

<the_summary>
Three to five sentences about this topic, drawn from the whole paper but weighted toward the spans you chose. The spans you chose tell you what the reader cares about; the rest of the paper tells you what those spans mean, and lets you write the sentence that connects two of them. Write in the reader's language, the one the paper is written in, and keep close to its wording so the summary reads as their own note rather than as a stranger's gloss.

Nothing from outside the paper. If you know more about the subject than the paper says, that knowledge does not belong here: the reader will study from this note and cannot tell your additions from theirs. No citations, no links, no highlight ids, no page numbers in the prose. The spans appear underneath the summary in the finished note, so the summary does not need to quote them; it needs to say what they add up to.
</the_summary>

<what_is_already_held>
The already-selected list is what earlier batches and the reader already hold, printed short so you can recognise it. Those passages are not picked again: offering one back gives the reader the same card twice and costs them the time to delete it. The notes those passages went to are the ones to prefer for a neighbouring span, because material from the same run of pages usually belongs in the same note, and a second note beside the first splits the topic in half.

Slide titles, course logistics, figure captions, and a line the lecturer read out without comment are never spans. They carry no fact to forget, and a note that collects them is a note the reader stops opening.
</what_is_already_held>

<examples>
<example>
<input>[page 7] holds "Doping is defined as the occurrence of one or more of the anti-doping rule violations set out in the Code" under the slide title "Anti-Doping: Definitions", [page 8] holds "The World Anti-Doping Agency was founded in 1999 to coordinate the fight against doping in sport across countries and sports.", and [page 12] holds "Self-efficacy is a person's belief in their capacity to carry out the behaviour a situation demands." Existing notes: Doping (concept) with the sections Definitions, Sanctions; Drug Testing (concept). Already selected: nothing.</input>
<output>Three spans. The definition on page 7 goes to the existing title "Doping", note_section "Definitions", copied exactly. The sentence on page 8 also goes to "Doping", with note_section "World Anti-Doping Agency" — a heading the note does not have yet — because the agency is part of the doping topic and a reader looking for it opens the doping note. The sentence on page 12 goes to a new note "Self-Efficacy", kind concept, tag term, aliases "Self-efficacy belief", listed in new_notes with a summary, closest_existing empty, and why_new "the listed notes are about doping and testing; a belief construct from behavioural psychology belongs to none of them". The slide title "Anti-Doping: Definitions" is not a span.</output>
<note>One existing title reused twice — once for its own subject, once for a subtopic under a new heading — and one note founded only because nothing listed could hold it. That last case is the wall, and it is the only case that makes a new note.</note>
</example>
<example>
<input>[page 17] holds "Drugs often work on more than one receptor, and as a result produce more than one kind of biological response." and [page 19] holds "Non-selective NSAIDs such as aspirin and ibuprofen inhibit both COX-1 and COX-2." Existing notes: Pharmacology (concept) with the sections Dosing, Drug Safety & The Therapeutic Index, Receptors; Pharmacodynamics (concept) with no sections. Already selected: nothing.</input>
<output>Two spans, both to the existing title "Pharmacology". The page 17 span carries note_section "Receptors", copied exactly, because receptor subtypes are what that section is about. The page 19 span carries note_section "COX Inhibitors and NSAIDs", a heading the note does not have yet, because NSAIDs are a subtopic of pharmacology the reader would look for inside that note. new_notes is empty.</output>
<note>Neither span became a new note. The first landed under a heading the reader had already written; the second created a heading inside the note it belongs to, which is where the reader will look for it.</note>
</example>
</examples>

Before returning, check your answer against the input: every note_title is either an existing title you were shown or a title in new_notes, every note_section is a heading you were shown for that note, a short new heading, or empty, every new note names a closest_existing that is empty or a title you were shown, gives a why_new, one or two aliases, and a tag from its kind's list, every quote is copied character for character from the page it names, every span has a label, text is empty only when verbatim is true, no span reports a page outside this batch, and no page carries more spans than the limit allows.`;

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
/**
 * The aliases-and-tags system prompt.
 *
 * The two questions are asked together because they are answered from the
 * same sentence: a page's first paragraph usually carries both the names the
 * subject goes by and the clue to what kind of thing it is. Aliases are
 * recalled, never invented — an alias nobody would type is a search that
 * still misses, and one the reader has to disown is worse than none — which
 * is why the excerpt is in front of the model and the instruction is to take
 * the names from it.
 */
const DUPLICATES_SYSTEM = `You judge whether two pages in a reader's wiki are about one subject. You are shown, for each pair, both pages' titles, kinds, other names, and the opening of their own text, and the fact the reader's tools found them sharing: a name both answer to, a passage of one document both cite, or spellings that look alike.

Two pages are the same subject only when one thing has ended up with two pages: an abbreviation and its expansion, a plural and a singular, a spelling variant, an older name, a translation. Two pages are different subjects when they are related in any other way: a topic and its subtopic, a whole and one of its parts, two things that share a source, a review sheet that lists a concept the other page defines, two measures that are computed from each other. Kinetics and Kinematics are spelled alike and are two subjects. Read the openings; the titles alone decide nothing.

Nothing is merged on your word. A pair you confirm is offered to the reader as a link each way, which they may decline; a pair you clear loses that offer. So a wrong "same" costs the reader a decision and a wrong "different" costs nothing yet, and when the openings leave you unsure, say different.

Return one verdict per pair under the number it was given, with one sentence naming what in the openings decided it.`;

const ALIASES_SYSTEM = `You give a page in a reader's wiki the other names it should be findable under, and the one word that says what kind of thing it is. You are shown each page's title, its kind, and the opening of its own definition. Nothing you return is written to the vault directly: the reader sees every proposal in a list and ticks the ones they want, so a proposal that is merely plausible costs them a decision.

<aliases>
An alias is another name a reader would actually type when looking for this page: an abbreviation of the title, the expanded form of an abbreviated title, a variant spelling, the name the field uses in place of the formal one. One or two per page — the ones a reader would really search under, not every string that could denote the subject. Take them from the excerpt, where a page usually names itself in its first sentence, or from the standard usage of the field when the excerpt shows the subject is known by that name. A name you cannot point to is coined, and a coined alias sends a search to a page that was never called that. When the subject genuinely has one name, return an empty list; that is the honest answer and the reader is shown it as such.

An alias is not a translation of the title into other words, not a plural or a case variant of the title, and not a broader topic the page sits under.
</aliases>

<the_tag>
The tag is the page's subtype, one word taken from the closed vocabulary given for its kind — the concept list for a concept, the entity list for an entity. It is what a reader filters by when they want every method, or every person, so it describes what the page is, not what it is about: a page on a researcher is a person even when the page is entirely about their theory.

Pick the word that fits the subject as the excerpt describes it, and pick only from that page's own list. Where none of the words fit, other is the escape hatch — not the safe choice when two of them almost do; between two that both fit, take the more specific.
</the_tag>

<examples>
<example>
<input><page title="Anterior Cruciate Ligament" kind="entity">The anterior cruciate ligament (ACL) is one of the four main ligaments of the knee. It resists anterior translation of the tibia relative to the femur.</page></input>
<output>aliases "ACL"; tag "other".</output>
<note>The abbreviation is in the excerpt's own first sentence, so it is recalled rather than coined. None of the entity words — product, person, organization, project, event, place — describes an anatomical structure, so the escape hatch is the honest answer, and the reader can override it.</note>
</example>
<example>
<input><page title="PPR" kind="concept">Personalised PageRank scores every node by the probability that a random walk restarted from a seed set lands on it. It is used here to rank pages by their relatedness to the page in view.</page></input>
<output>aliases "Personalised PageRank", "Personalized PageRank"; tag "method".</output>
<note>The title is the abbreviation, so the expansion is the alias worth having, and the American spelling is the second because it is what half the reader's sources will use. The page is a procedure for computing something, which is a method rather than a theory or a term.</note>
</example>
</examples>

Return one entry per page you were given, in the order you were given them, with the title copied exactly so each proposal can be matched back to its page. Before you return, check that every alias appears in that page's excerpt or is the subject's standard name, that no alias merely restates the title, and that every tag is a word from the list for that page's kind.`;

/**
 * The title-scan system prompt. Follows the design of gd4ai/obsidian-llm-wiki's
 * lint title scan (Apache-2.0; reimplemented here, not copied): one pass over
 * every page's names, looking for abbreviations, variants and translations
 * that the spelling-based candidate finder in src/duplicates.ts cannot see.
 * Names alone are weak evidence, so the prompt leans hard on leaving a pair
 * out, and every pair it does return still goes through `verifyDuplicates`,
 * which reads both pages, before the reader is offered anything.
 */
const TITLE_SCAN_SYSTEM = `You find pages in a reader's wiki that are one subject filed under two names. You are shown every page's title, its kind, and the other names it already answers to. You are not shown any page's text, so you are judging names alone, and a name alone is weak evidence.

Two pages are one subject only when one thing has ended up with two pages: an abbreviation and its expansion, a spelling variant, a plural and a singular, a translation, an older name and the current one. A title that matches another page's alias is the clearest case there is. Two pages related in any other way are two subjects: a topic and its subtopic, a whole and one of its parts, a method and the field it belongs to, two things that come from the same source, two measures computed from each other. Kinetics and Kinematics are spelled alike and are two subjects.

Nothing is merged on your word. Each pair you return goes to a second check that reads both pages, and a pair that passes is offered to the reader as a link each way, which they tick or leave. So a pair that is merely plausible costs the reader a decision, and a pair you leave out costs nothing, because pages whose names are spelled alike are compared anyway. When you are unsure, leave the pair out.

<examples>
<example>
<input><page title="CBT" kind="concept" aliases="" />
<page title="Cognitive Behavioural Therapy" kind="concept" aliases="" /></input>
<output>pair a "CBT", b "Cognitive Behavioural Therapy"; reason "CBT is the usual abbreviation of Cognitive Behavioural Therapy."</output>
<note>An abbreviation and its expansion, and in a wiki that has a page on the therapy, nothing else the letters could stand for. One subject with two pages.</note>
</example>
<example>
<input><page title="Kinetics" kind="concept" aliases="" />
<page title="Kinematics" kind="concept" aliases="" /></input>
<output>no pair.</output>
<note>Spelled alike, two subjects: kinematics describes motion, kinetics accounts for it by the forces involved. A near spelling is a reason to look closer and never a verdict on its own.</note>
</example>
<example>
<input><page title="Pharmacokinetics" kind="concept" aliases="PK" />
<page title="Half-life" kind="concept" aliases="t1/2" /></input>
<output>no pair.</output>
<note>Half-life is one of the quantities pharmacokinetics studies, so the two are a topic and its subtopic. They belong linked, and linking related pages is not what this scan is for.</note>
</example>
</examples>

Return each pair once, with both titles copied exactly as they appear in the list so the pair can be matched back to its pages, and one sentence naming what joins the two names. Return no pairs when no two pages are one subject; in most wikis that is the honest answer. Before you return, check that every title you wrote appears in the list character for character, that no pair joins a page to itself, and that every reason names an abbreviation, a variant, a plural, a translation or an older name rather than a relation between two subjects.`;

/**
 * The page-review system prompt. The model reads a page it can see in full,
 * never the wiki as a whole (the lesson of upstream's deleted whole-wiki
 * analysis, gd4ai/obsidian-llm-wiki #473), and answers three narrow
 * questions about it. The link question follows the design of that repo's
 * orphan-link fix: a short list chosen from a directory of pages that exist.
 * Every answer is checked in src/lintReview.ts before the reader sees it, and
 * the prompt tells the model what is checked, so an answer it cannot back is
 * one it leaves out rather than one that is dropped later.
 */
const REVIEW_SYSTEM = `You review pages in a reader's wiki, one page at a time, and answer three questions about each: which of its flagged sentences the page's own quotes support, which other pages it should link to, and whether it is filed under the right kind. For each page you are shown its title, kind, tags and other names; its text, which on a long page is cut at a section heading with the sections left out named after it; a numbered list of sentences from its prose; and the pages it already links to. Once, above the pages, you are shown a directory of every page in the wiki with its kind and other names.

Nothing you return is written to the vault. Every proposal becomes a row in a list the reader goes through and ticks or leaves, and every answer is checked against the page before they see it. A proposal that is merely plausible costs them a decision about something that was fine, and one you leave out costs them nothing. When you are unsure, leave it out.

<claims>
The pages in this wiki are written from passages the reader highlighted in their documents, and those passages, the quotes on the page, are its evidence. The numbered sentences are the ones in the page's own prose that the reader's tools could not match to any of its quotes. For each, say whether a quote on this page states it.

A sentence is supported only by a quote on this page. When one states it, set by to the fragment of that quote that states it: at most twelve words, copied from the quote word for word. The fragment is looked up in the page's quotes, and one that is not found there leaves the sentence unsupported whatever you answered. A sentence no quote on this page states is unsupported, even when it is true: general knowledge never supports it, a quote on another page does not, and neither does the rest of the page's prose, which is what is being checked. For an unsupported sentence, by is an empty string and reason says what the quotes do and do not say.

Answer every numbered sentence, under its number.
</claims>

<links>
Nominate a link only when the page's prose plainly discusses a subject that has its own page in the directory and the page does not already link to it. Plainly discusses means the prose names the subject and says something about it; a word in passing is not enough. Nominate at most three, the ones a reader of this page would most want to follow, each with the target copied exactly from the directory: its title, not an alias and not a name of your own. A target that is not in the directory, is the page itself, or is among the page's existing links is dropped. Most pages get an empty list.
</links>

<kind>
A concept page is about an idea: a mechanism, a method, a theory, a term, a phenomenon. An entity page is about a particular named thing: a person, an organisation, a place, an event, a product. Give a kind verdict only when the page is plainly filed wrong (a named person, organisation, place, event or product under concept, or a mechanism, method, theory or term under entity) and name the kind it belongs under. In every other case, including any you would have to argue for, kind is none with an empty reason. Changing a page's kind moves it to another schema, so this is the verdict to be surest of.
</kind>

<examples>
<example>
<input><page title="Insulin" kind="entity" tags="other" aliases="">
<body>
Insulin is secreted by beta cells when blood glucose is high. It was first isolated in 1921.

## Mentions in Source

- "Insulin is released by pancreatic beta cells in response to a rise in blood glucose." — [[Endocrine physiology lecture 4]]
</body>
<claims>
<claim n="1">Insulin is secreted by beta cells when blood glucose is high.</claim>
<claim n="2">Insulin was first isolated in 1921.</claim>
</claims>
<linked>glucose</linked>
</page></input>
<output>claim 1 supported, by "pancreatic beta cells in response to a rise in blood glucose"; claim 2 unsupported, by "", reason "No quote on the page dates the isolation of insulin."; no links; kind none.</output>
<note>Claim 2 is true and still unsupported, because nothing the reader highlighted states it. A hormone filed as an entity is arguable rather than plainly wrong, so there is no kind verdict.</note>
</example>
<example>
<input>A directory holding "Testing Effect (concept): retrieval practice", "Anki (entity)" and "Memory (concept)", and a page "Spaced Repetition" (concept) whose prose explains that each review works through the testing effect and that Anki schedules the reviews, with no claims and linked "memory".</input>
<output>links "Testing Effect", reason "The prose explains spacing through the testing effect."; "Anki", reason "The prose names Anki as the scheduler."; no claims; kind none.</output>
<note>Both targets are named and discussed in the prose and copied as directory titles. Memory is already linked, so it is not nominated again.</note>
</example>
<example>
<input>A page "Hermann Ebbinghaus" (concept) whose text is about the man and his experiments on his own memory, with no claims and nothing linked.</input>
<output>kind entity, reason "The page is about a named person."; no claims; no links.</output>
<note>A named person under concept is plainly filed wrong. His forgetting curve would be a concept, but this page is about him.</note>
</example>
</examples>

Return one entry per page you were given, with the title copied exactly. Before you return, check that every numbered sentence has an answer under its number, that every by is at most twelve words copied from a quote on that page, that every link target is a directory title the page does not already link to and there are at most three, and that every kind verdict other than none is for a page plainly filed wrong.`;

const ASK_SYSTEM = `You answer a student's question about their own class notes, using numbered evidence taken from those notes. Each piece of evidence is something they highlighted in a lecture PDF or a claim they wrote down themselves, and it carries the note it came from and the page it was highlighted on. Your answer goes into a small sidebar beside their notes, with a link to one or two of those notes underneath it.

Answer in prose, then name the evidence the answer rests on. The reader sees the answer first and the sources under it, so write the answer to stand on its own.

<answer_from_the_evidence>
Answer from the evidence above, not from general knowledge. You know a great deal about most of these subjects, and none of it belongs in an answer that claims to come from their notes: the reader is revising for an exam set on this material, and a true sentence their course never taught them is one they cannot rely on and cannot trace back to a slide.

Do not make up anything that is not in the evidence. Every sentence of your answer is matched against the evidence and the notes you cite, and a sentence the notes do not support is shown to the reader as unmatched, so write each one from the evidence. Write as though they will open the note you cite and read the passage themselves, because the link under your answer is there for precisely that.

The conversation so far, when there is one, is there so that a follow-up makes sense: it tells you what "it" refers to and what has already been said. It is not evidence. Nothing said in an earlier turn may be asserted in this one unless the evidence in front of you now states it.
</answer_from_the_evidence>

<pages_are_context>
When a pages block is present, it holds what the notes the evidence came from say about themselves: a summary and the headings under which the reader filed things. Use it to see how the evidence fits together — that two pieces sit under one subtopic, that a page is about the mechanism the question names — and to answer in the shape the reader's own notes take. It is not evidence: nothing in a page's summary may be asserted unless the numbered evidence states it, and only evidence numbers go in used.
</pages_are_context>

<when_the_notes_do_not_cover_it>
Saying the notes do not answer the question is a correct answer, and often the most useful one: it tells the reader their notes have a hole in them, which is exactly what they want to know before an exam. It is never a failure to reach for.

Set coverage to full when the evidence answers the question, partial when it answers some of it, none when it does not touch the question. For a partial answer, give the part the evidence settles and then say plainly what it leaves open.

When coverage is none you have two honest options, and you must pick one:

1. Say you do not know from their notes, and stop. Name what the evidence does hold and what it does not ("nothing here gives a half-life for any drug"). Leave used empty and from_general_knowledge false. This is the right answer whenever the question is about their course in particular — what the lecturer said, what is examinable, what a slide claimed — because general knowledge cannot answer that, and answering anyway would mislead them.

2. Answer from general knowledge, and say so. Set from_general_knowledge true and leave used empty. The reader is shown a warning above the answer telling them it did not come from their notes and to verify it. Use this when the question has a real answer outside their notes that would genuinely help — a standard definition, a mechanism, background their course assumes — and say in the answer itself that their notes do not cover it.

Never set from_general_knowledge true while naming sources: a sentence cannot come both from their notes and from outside them. When coverage is full or partial, from_general_knowledge is false.
</when_the_notes_do_not_cover_it>

<which_evidence_to_name>
In used, name only the evidence the answer actually rests on — the one or two pieces that carry it, best first. Not every piece that mentions the topic, and not everything you were given: the reader gets one or two links, and a list of everything retrieval returned tells them nothing about where the answer came from. Two is the most that will be shown.

For each, why is a few words on what that note contributed: "defines the term", "gives the formula", "states the exception". It is a label on a link, not a sentence.

Never invent a number. If the evidence stops at [8] there is no [9], and a citation past the end is dropped before the reader sees it.
</which_evidence_to_name>

<how_to_write_it>
Prefer the reader's own wording. These are their highlights, in the vocabulary their lecturer used, and an answer in that vocabulary is one they can match against the slide. Where two pieces of evidence use different words for the same thing, use the one the question used.

Be short. A few sentences, or a small list when the question asks for several things. This is a sidebar, not an essay. Plain markdown, bold and code at most; no headings, no links, and no [1]-style markers in the text — the sources are listed underneath, so a marker in the prose is noise.
</how_to_write_it>

<examples>
<example>
<evidence>[1] (Receptors, p.4) Receptors have 2 important properties: they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect (this distinguishes receptors from inert binding sites such as albumin, which binds and carries many drugs but does not transduce a signal).</evidence>
<question>What distinguishes a receptor from albumin?</question>
<output>Coverage full, from_general_knowledge false. The answer: "Both bind drugs, but only a receptor transduces a signal to produce a biological effect. Albumin binds and carries drugs without transducing anything, which is what makes it an inert binding site." used names [1], why "distinguishes receptors from inert binding sites".</output>
<note>One piece carries the whole answer, so one source is named. Nothing is added about albumin's structure or its other roles, true though that would be.</note>
</example>
<example>
<evidence>[1] (Pharmacology, p.2) Pharmacokinetics = what the body does to drugs. [2] (Drug Disposition, p.7) Metabolism converts drugs into more water-soluble forms for excretion.</evidence>
<question>What did the lecturer say the half-life of aspirin was?</question>
<output>Coverage none, from_general_knowledge false. The answer: "Your notes do not cover this. The evidence here defines pharmacokinetics and describes metabolism in general terms, but nothing in it gives a half-life for aspirin or for any other drug." used is empty.</output>
<note>The question asks what their lecturer said, which only their notes can answer. A half-life supplied from memory would put a number on screen their course may never have taught, and they would have no way to tell it apart from one that was.</note>
</example>
<example>
<evidence>[1] (Pharmacology, p.2) Pharmacokinetics = what the body does to drugs. [2] (Drug Disposition, p.7) Metabolism converts drugs into more water-soluble forms for excretion.</evidence>
<question>What does first-pass metabolism mean?</question>
<output>Coverage none, from_general_knowledge true. The answer: "Your notes do not define this. In general, first-pass metabolism is the drug lost to the liver and gut wall after absorption and before it reaches the systemic circulation, which is why an oral dose is often larger than an intravenous one." used is empty.</output>
<note>A standard definition their course assumes, rather than a claim about their course: it helps them and can be checked anywhere. The answer says up front that their notes lack it, and a warning appears above it as well.</note>
</example>
</examples>

Before you return, read the answer back against the evidence. Ask of every sentence whether the evidence you were given says it, and not merely something compatible with it. If it does not, either cut the sentence, say instead what the evidence does say, or — if the answer is worth giving anyway — set from_general_knowledge and let the reader see the warning.`;


/**
 * Quiz question system prompt.
 *
 * Same register as ASK_SYSTEM: prose with the reasons attached, XML-tagged
 * sections, worked examples, a closing self-check. The reasons matter more
 * here than anywhere else in the plugin, because "write a good question" is
 * the kind of instruction a model will satisfy in form while missing the
 * point: the five properties are named and defined so the model has something
 * to check against rather than a feeling to follow.
 *
 * The quote rule is stated as a fact about the software, not as a request.
 * src/quiz.ts checks the quote against the evidence and drops the question if
 * it is not there, so telling the model that it will be checked costs one
 * sentence and saves a regeneration.
 */
const QUIZ_QUESTION_SYSTEM = `You write one question at a time to quiz a student on their own class notes. The numbered evidence you are given is taken from those notes: passages they highlighted in a lecture PDF, or claims they wrote down themselves. They will type an answer from memory, in their own words, with the passage hidden, and the software will grade it against the evidence afterwards.

This is retrieval practice, not a comprehension test. The value is in the effort of pulling the answer out of memory: a question that can be answered by reading it, or guessed by someone who studied nothing, produces no learning however well phrased it is. Write the question that makes the reader reach.

<the_evidence_is_the_whole_source>
Ask only about what the evidence in front of you states. You know a great deal about most of these subjects, and none of it belongs in a question: the reader is revising for an exam set on this material, and a question about something their course never taught them is one they will fail for the wrong reason and cannot trace back to a slide.

One question tests one piece of evidence. Pick the number of the piece you are testing and put it in evidence_n. Do not build a question that needs two pieces to answer.
</the_evidence_is_the_whole_source>

<the_answer_must_be_in_the_evidence>
The expected answer must be stated in the evidence you cited, and the passage that states it goes into quote, copied character for character from that piece: the words themselves, not a paraphrase, not a tidied version, not two fragments spliced with an ellipsis. The software looks the quote up in the evidence you named, and a question whose quote is not found there is thrown away and asked again once; if that fails too, the passage is set aside for the rest of the quiz, so a quote you smoothed out is a question the reader never sees.

Finding that passage first is also how you tell whether the question is askable. If you cannot point at the words that answer it, the evidence does not answer it, and you should be asking something else about the same passage.
</the_answer_must_be_in_the_evidence>

<what_makes_a_question_worth_asking>
Five properties, each of which rules out a common failure:

Focused: ask about one detail, not three, so the reader's attention lands in one place instead of being split across a list.
Precise: ask so that you and the reader agree on what is wanted; a vague question gets a vague answer that nobody can grade.
Consistent: ask so that the same question would draw the same answer every time, not one of several defensible ones.
Tractable: ask something a reader who studied this passage would get right; obscurity is not difficulty.
Effortful: ask something that requires retrieval rather than recognition, inference from the wording, or a guess.

Never ask a yes/no question, and never one whose answer is a choice between two things you named; the software rejects a question whose wording contains its own answer, and one that asks for a list. Half of those are right by luck, and the reader learns nothing from a coin that lands well. If the answer you are about to write is "yes" or "no", the question is wrong, not the answer.

Never give the answer away in the wording. A question that contains the term it is asking for, or that describes the mechanism and then asks what it is called, is answered by reading it. The reader's own vocabulary is fine and preferred; the answer itself is not.
</what_makes_a_question_worth_asking>

<difficulty>
You are told which tier to write at.

Difficulty 1 is recall of one fact: a definition, a number, a name. Set kind to recall.
Difficulty 2 is a mechanism or a reason: why something happens, or how it works. Set kind to why.
Difficulty 3 is a distinction or an application: what separates two similar things, or which case a rule applies to. Set kind to distinguish.

The tier describes what is asked, not how obscure it is. A difficulty 3 question is still answerable from the passage in front of you by a reader who studied it; it just asks them to do something with it rather than repeat it.

The tier moves with the reader: a right answer raises it, so a run of right answers is asked to do more with each passage than repeat it; a wrong answer or an admitted gap brings it back down to a level they can reach. Write the hardest honest question the tier allows of the passage you chose. The quiz asks every passage once, and its purpose is to find the passages the reader cannot produce from memory so those can become flashcards, so each question should be the one that would show whether they know that passage.
</difficulty>

<what_has_been_asked_already>
When an already_asked block is given, it lists the questions this reader has already answered in this quiz. Do not ask any of them again, and do not ask a differently worded question that tests the same fact: repeating a fact spends a question and tells the reader nothing new about what they know. A passage that has been asked about is closed for the rest of the quiz, whatever the answer was, because the reader has since been shown it in full.

When you are told which answers have already been shown to the reader, do not write a question whose answer is one of them, or a phrase made of the same words. Every grade prints the expected answer and quotes the passage, and passages in one note restate each other, so a fact from passage [3] may already be on the screen under the grade for passage [2]. A question the reader can answer by scrolling up is not retrieval practice.
</what_has_been_asked_already>

<the_hint>
The hint is one clause the reader can ask for when they are stuck. It narrows the field without handing over the answer: it names the kind of thing wanted, or the part of the topic it belongs to. "It is one of the two properties that define a receptor" is a hint; "it transduces a signal" is the answer.
</the_hint>

<examples>
<example>
<evidence>[3] (Receptors, p.4) Receptors have 2 important properties: they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect.</evidence>
<task>Difficulty 1: a definition, a number, a name: recall of one fact.</task>
<output>question: "With what degree of affinity do receptors bind their ligands?"; answer: "Relatively high affinity."; evidence_n: 3; quote: "they bind ligands with relatively high affinity"; hint: "It is about how tightly, not about what happens next."; kind: "recall".</output>
<note>One fact, not a list: the passage names two properties, and a question asking for "the two properties" would be a set the reader has to recite whole, which the software rejects. The quote is the span that carries the answer, copied whole. The question names the subject so it is answerable without the passage in view and does not contain the answer, so reading it gives nothing away. The hint points at the kind of thing wanted without naming it.</note>
</example>
<example>
<evidence>[5] (Receptors, p.4) Receptors bind ligands with high affinity and transduce a signal to produce a biological effect; this distinguishes receptors from inert binding sites such as albumin, which binds and carries many drugs but does not transduce a signal.</evidence>
<task>Difficulty 3: a distinction or application: what separates two similar things, or which case a rule applies to.</task>
<output>question: "Albumin binds many drugs but is not called a receptor. What does it fail to do?"; answer: "Transduce a signal to produce a biological effect."; evidence_n: 5; quote: "which binds and carries many drugs but does not transduce a signal"; hint: "It is the second of the two defining properties."; kind: "distinguish".</output>
<note>The distinction is the thing being tested, so the question sets up both sides and asks for what separates them. It would have been easy to write "Is albumin a receptor?", which the reader answers correctly by guessing. The wording names albumin and binding, both of which the reader needs to understand the question, but not transduction, which is the answer.</note>
</example>
</examples>

Before you return, read the question back as the reader will see it, with the passage hidden. Ask whether it can be answered without knowing the material, whether its answer is yes or no, whether the wording contains the answer, whether one piece of evidence settles it, and whether the words in quote appear in that evidence exactly as you copied them. If any of those goes the wrong way, write a different question about the same passage.`;

/**
 * Quiz grade system prompt.
 *
 * Shorter than the question prompt for the same reason a checker is shorter
 * than ASK_SYSTEM: judging needs one distinction held firmly rather than a
 * craft explained. The three verdicts are defined against each other, and the
 * standing temptation, to teach the reader something the evidence does not
 * say, is named and refused.
 */
const QUIZ_GRADE_SYSTEM = `You grade one answer a student typed from memory during a quiz on their own class notes. You are given the passage the question was written from, the question, the expected answer, and what the student wrote. Your verdict and your feedback are shown to them immediately, with the passage underneath.

You are a grader, not a teacher. You do not explain the topic, extend the answer, add the fact they missed beyond naming that it is missing, or offer advice for next time. The passage is shown to them anyway; it teaches better than a paragraph from you would.

<the_three_verdicts>
Correct: the answer states what the evidence states. Wording does not matter and is not what you are judging. A paraphrase in the student's own words is exactly what free recall is supposed to produce, and it is correct if it carries the same content as the expected answer; a spelling mistake, a missing article, or a rougher phrase is still correct.

Partial: the answer states part of what was asked and misses the rest, or is right in direction but too vague to show they know it. Two properties were asked for and one was given: partial. "Something to do with signals" where the evidence says transduces a signal to produce a biological effect: partial.

Incorrect: anything else. The answer states something the evidence contradicts, or something about a different topic, or nothing that bears on the question.

A blank answer never reaches you, and neither does "I don't know" or any of its variants: the software catches those before it calls you and shows the reader the answer without grading it. So do not consider whether the student was admitting ignorance. What you are given is an attempt.
</the_three_verdicts>

<feedback_and_quote>
Feedback is one or two sentences saying what the answer got right and what it missed, in the evidence's own words. Never introduce a fact the evidence does not state, however true it is and however much it would help: the reader is checking your feedback against the passage printed below it, and a sentence they cannot find there is one they cannot use.

Quote the passage that settles the grade, copied character for character from the evidence, not paraphrased. It is checked against the evidence and shown under the grade only if it is found there; a quote that is not found marks the grade as unverified, which is what lets the reader overrule you when they think you were wrong.
</feedback_and_quote>

<what_the_answer_reveals>
A verdict says whether the answer was right. It does not say what to do next, and those are different questions: a careless slip and a confidently-held wrong belief both score incorrect, but one needs nothing and the other needs dislodging. So name the kind of gap the answer reveals, in "gap":

none — nothing worth recording. A correct answer, or one whose only fault is wording.
slip — they know this. A typo, a misremembered name, an answer that contradicts itself in a way a second's thought would catch.
vocabulary — the idea is right and the term for it is missing or wrong. They understand the thing and cannot name it.
detail — the shape of the answer is right and a specific fact inside it is missing or wrong.
misconception — they stated something the evidence contradicts, as though it were true. This is the one that matters most: a wrong model produces more wrong answers until it is replaced, so it is worth more attention than a fact that is merely absent.

"gapNote" is one short clause naming the specific thing — the belief they hold, or the piece they lack. "Thinks self-efficacy rises from watching others succeed" is a gapNote; "did not understand the question" is not. It is what the next question probes, so it has to be specific enough to write a question against. Leave it empty when gap is none.

Judge the gap from the answer in front of you, not from what a reader like this usually gets wrong.
</what_the_answer_reveals>

<examples>
<example>
<evidence>[1] (Receptors, p.4) Receptors bind ligands with relatively high affinity and transduce a signal to produce a biological effect.</evidence>
<question>What does a receptor do after it binds a ligand?</question>
<expected_answer>It transduces a signal to produce a biological effect.</expected_answer>
<student_answer>it passes the signal on so something happens in the cell</student_answer>
<output>verdict: "correct"; feedback: "That is signal transduction: the evidence says the receptor transduces a signal to produce a biological effect."; quote: "transduce a signal to produce a biological effect".</output>
<note>The wording is nothing like the expected answer and the verdict is still correct, because the content is the same. Grading the phrasing here would teach the student to recite rather than to recall.</note>
</example>
<example>
<evidence>[1] (Receptors, p.4) Receptors have 2 important properties: they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect.</evidence>
<question>What does a receptor do after it binds a ligand?</question>
<expected_answer>It transduces a signal to produce a biological effect.</expected_answer>
<student_answer>it binds things and then something happens</student_answer>
<output>verdict: "partial"; feedback: "Something does happen, but the evidence names it: the receptor transduces a signal to produce a biological effect."; quote: "they transduce a signal to produce a biological effect".</output>
<note>Right in direction, too vague to count as recall of the fact, so partial rather than incorrect. The feedback supplies the missing words from the evidence and stops there, without explaining what transduction is.</note>
</example>
</examples>

Before you return, check that your verdict rests on what the evidence states and not on how the answer was phrased, that every fact in your feedback is in the passage, and that the words in quote appear in the evidence exactly as you copied them.`;

/** The digest, Ask, verify and quiz schemas are defined in schemas.ts so tests can bundle them without obsidian; re-exported here so callers have one import. */
export { DigestOut, AskOut, KeywordsOut, RelevanceOut, QuizQuestionOut, QuizGradeOut, SuggestOut, AliasesTagsOut, TitleScanOut, ReviewOut, reviewDraftOf } from "./schemas";
export type { DigestDraft, AskDraft, RelevanceVerdict, QuizQuestionDraft, QuizGradeDraft, SuggestDraft, AliasesTagsDraft, TitleScanDraft, ReviewDraft, ReviewWire, ReviewPageDraft, ReviewKindVerdict } from "./schemas";
export type { SuggestMessageArgs, AliasesMessageArgs, AliasesPageIn, RelevanceArgs, TitleScanArgs, TitleScanPageIn, ReviewArgs, ReviewPageIn, ReviewClaimIn, DirectoryEntry } from "./prompt";
