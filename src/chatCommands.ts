// Deciding what a line typed into the Ask box means: a command to run, a
// command to offer, or a question for the model. Pure — no `obsidian` import —
// so the whole decision table is testable; the fuzzy scorer is injected.
//
// Policy (plan decision, 2026-09-10): a slash line or an exact name/alias runs
// at once; a plain sentence that merely resembles a command shows a one-click
// Run chip rather than guessing; everything else is a question.

export interface CommandLike {
  id: string;
  name: string;
  aliases: string[];
}

export type CommandMatch =
  | { kind: "help" }
  | { kind: "run"; id: string }
  | { kind: "offer"; id: string; score: number }
  | { kind: "unknown"; query: string }
  | { kind: "question" };

/** A scorer built from a query: higher is a better match, null is no match. */
export type FuzzyScorer = (query: string) => (text: string) => number | null;

// How good a plain sentence's resemblance to a command must be before the chat
// offers a Run chip, counted in shared content words: the panel injects
// `tokenOverlapScorer` (src/chatPanel.ts:411), the same scorer the tests use,
// so this constant means the same thing in both.
//
// Two, and it stays two, because an offer *replaces* the answer rather than
// sitting beside it (src/chatPanel.ts:427-443). At one, "what does the wiki
// say about hallucination" shares the word "wiki" with a command and would get
// a chip instead of an answer — swallowing a real question, which is worse
// than missing a chip. Filler no longer counts toward it (COMMAND_STOPWORDS),
// so the two words that reach this bar are two words that mean something.
export const OFFER_THRESHOLD = 2;

/**
 * Shared content words before a slash line runs its best match outright.
 *
 * Running the wrong command unasked is worse than one extra click, and at one
 * shared word "/wikilint" and "/wiki notes about lint" are indistinguishable.
 */
const SLASH_RUN_SCORE = 2;

/**
 * Shared content words before a slash line offers its best match.
 *
 * Lower than `OFFER_THRESHOLD` because a slash cannot swallow a question: the
 * reader has already said they want to run something, so the only choice is
 * which command — or the dead end this replaced.
 */
const SLASH_OFFER_SCORE = 1;

/**
 * Tie-break weight for an alias hit over a name hit of the same size.
 *
 * A fraction rather than a whole point: it settles which command a score of 1
 * belongs to without ever pushing that score up to `SLASH_RUN_SCORE`, so
 * breaking a tie can never turn an offer into something that runs unasked.
 */
const ALIAS_BONUS = 0.5;

/**
 * Words that open a question rather than an instruction.
 *
 * Deliberately only the opening word: "lint the wiki" is a command and "how do
 * I lint the wiki" is not, and the difference is entirely at the front. A
 * command phrased as a request ("show me the inbox") does not start with one
 * of these, so it can still be offered.
 */
const QUESTION_OPENERS = new Set("what which who whom whose when where why how is are was were do does did can could should would will am".split(" "));

/** Whether a line opens with an interrogative, so it reads as a question even without a "?". */
function opensLikeQuestion(s: string): boolean {
  const first = s.trim().toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)[0];
  return first !== undefined && QUESTION_OPENERS.has(first);
}

/** Only short lines are considered command-like; longer ones read as prose. */
const MAX_OFFER_WORDS = 8;

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Fold the trailing ellipsis and punctuation the palette names carry. */
function normName(s: string): string {
  return norm(s)
    .replace(/[…\s]+$/, "")
    .replace(/[.!?,;:]+$/, "")
    .trim();
}

function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Best-scoring command under `score`, or null when nothing scores above zero. */
function best<T>(items: T[], score: (item: T) => number | null): { item: T; score: number } | null {
  let winner: { item: T; score: number } | null = null;
  for (const item of items) {
    const s = score(item);
    if (s === null || s <= 0) continue;
    if (!winner || s > winner.score) winner = { item, score: s };
  }
  return winner;
}

export function matchCommand(input: string, commands: CommandLike[], fuzzy: FuzzyScorer): CommandMatch {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "question" };

  if (trimmed.startsWith("/")) {
    const rest = trimmed.slice(1).trim();
    const key = normName(rest);
    if (key === "help" || key === "commands" || key === "?" || rest === "?") return { kind: "help" };

    // Exact id or alias first: "/extract" must never depend on fuzzy scores.
    for (const c of commands) {
      if (key === norm(c.id) || c.aliases.some((a) => key === norm(a))) return { kind: "run", id: c.id };
    }
    // Then the palette name, exactly or fuzzily: "/Extract PDF highlights".
    for (const c of commands) {
      if (key === normName(c.name)) return { kind: "run", id: c.id };
    }
    // Aliases count here as well as names: "/wikilint" resembles the alias
    // "wiki" and nothing in any palette name, and scoring names alone sent it
    // to the dead end below with the command one step away.
    // An alias hit outweighs a name hit of the same size: an alias is the
    // command's short name, while a palette name is a sentence that can share
    // a word by coincidence. Without this "/wikilint" matched "Read this
    // markdown source into the wiki" as readily as the alias "wiki".
    const score = fuzzy(rest);
    const hit = best(commands, (c) => {
      let top = score(c.name);
      for (const a of c.aliases) {
        const s = score(a);
        if (s === null) continue;
        const weighted = s + ALIAS_BONUS;
        if (top === null || weighted > top) top = weighted;
      }
      return top;
    });
    // A slash line that clearly names its command still runs at once, which is
    // the policy this file opened with: two or more shared content words is a
    // name being typed, not a guess. A single shared word is the new case —
    // "/wikilint" used to dead-end at "No command matches" with the command one
    // step away — and is offered rather than run, so a typo that lands on the
    // wrong command can be declined instead of firing.
    if (hit && hit.score >= SLASH_RUN_SCORE) return { kind: "run", id: hit.item.id };
    // The alias tie-break is an ordering device, not a count; the score that
    // leaves here is the shared-word count it came from.
    if (hit && hit.score >= SLASH_OFFER_SCORE) return { kind: "offer", id: hit.item.id, score: Math.floor(hit.score) };
    return { kind: "unknown", query: rest };
  }

  // Plain text. An exact name or alias is unambiguous enough to just run.
  const key = normName(trimmed);
  for (const c of commands) {
    if (key === normName(c.name) || key === norm(c.id) || c.aliases.some((a) => key === norm(a))) {
      return { kind: "run", id: c.id };
    }
  }

  // A question mark or a long sentence is prose, whatever it scores.
  if (trimmed.endsWith("?")) return { kind: "question" };
  if (wordCount(trimmed) > MAX_OFFER_WORDS) return { kind: "question" };
  // So is anything that opens like a question, mark or no mark. Word overlap
  // cannot separate "lint the wiki" from "how do I lint a wiki note" — both
  // share two words with the lint command — but the opening word can, and
  // plenty of readers never type the "?". This matters because an offer
  // replaces the answer (src/chatPanel.ts:427-443): a question read as a
  // command cannot be asked at all, while a command read as a question costs
  // one retype.
  if (opensLikeQuestion(trimmed)) return { kind: "question" };

  const score = fuzzy(trimmed);
  const byName = best(commands, (c) => score(c.name));
  const byAlias = best(commands, (c) => {
    let top: number | null = null;
    for (const a of c.aliases) {
      const s = score(a);
      if (s !== null && (top === null || s > top)) top = s;
    }
    return top;
  });
  const hit = !byName ? byAlias : !byAlias ? byName : byAlias.score > byName.score ? byAlias : byName;
  if (hit && hit.score >= OFFER_THRESHOLD) return { kind: "offer", id: hit.item.id, score: hit.score };
  return { kind: "question" };
}

/**
 * The chat-local quiz commands, which are not in the registry (src/quiz.ts:102)
 * and so have no `available` state to report — they are available exactly when
 * a quiz is running, which the lines themselves say.
 *
 * `/wiki` used to be listed here. It is a registry command now (`lint-wiki`),
 * so `renderHelp` prints it with the rest and a line here would duplicate it.
 */
export const QUIZ_HELP = [
  "- **/quiz** [this | words] — start a quiz on all topic notes, the active note, or matching passages",
  "- **/hint** — one clue for the current question",
  "- **/skip** — skip the current question",
  "- **/idk** — I don't know: show the answer without counting it wrong",
  "- **/stop** — end the quiz and show the score",
].join("\n");

/**
 * Markdown for `/help`: one line per command, with its first alias and
 * availability. `quiz` appends the chat-local block below the registry lines;
 * it is a parameter rather than unconditional so the command lines can still
 * be counted on their own.
 */
export function renderHelp(
  commands: Array<CommandLike & { hint: string; available: boolean }>,
  quiz = false,
): string {
  const lines = commands
    .map((c) => `- **/${c.aliases[0] ?? c.id}** ${c.name} — ${c.hint} (${c.available ? "available" : "not now"})`)
    .join("\n");
  return quiz ? `${lines}\n${QUIZ_HELP}` : lines;
}

/**
 * Deterministic scorer for the offer decision: how many distinct words of the
 * query appear in the text (lowercased, split on non-alphanumerics; hyphenated
 * names such as "AI-highlight" split into their parts), counting a query word
 * that contains a command word as a hit. Null when none do. The
 * chat panel injects this rather than Obsidian's `prepareFuzzySearch`, whose
 * score scale is undocumented (obsidian.d.ts:5244-5252), so `OFFER_THRESHOLD`
 * means "at least this many shared words" in tests and in the app alike.
 */
/**
 * Words that carry no signal about which command was meant.
 *
 * Every palette name is an English phrase, so a question that shares only
 * "the" and "for" with one was scoring as high as a query that actually named
 * it: "what does the wiki say about hallucination" reached the offer threshold
 * against "Check the wiki for gaps and dead links" on its filler alone.
 */
const COMMAND_STOPWORDS = new Set(
  "a an and are as at be by do does for from how in into is it its of on or that the this to what when where which who why with your".split(" "),
);

export function tokenOverlapScorer(query: string): (text: string) => number | null {
  const tokens = (v: string) =>
    new Set(v.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0 && !COMMAND_STOPWORDS.has(w)));
  const q = tokens(query);
  return (text) => {
    const t = tokens(text);
    let n = 0;
    for (const w of q) {
      if (t.has(w)) {
        n++;
        continue;
      }
      // A run-together word still names the command: "wikilint" is "wiki" and
      // "lint" typed without the space, and scoring that zero is what made the
      // Run chip unreachable for the phrasing readers actually use. Only
      // command words of three characters or more count, so a short one cannot
      // match inside an unrelated query word.
      for (const word of t) {
        if (word.length >= 3 && w.includes(word)) {
          n++;
          break;
        }
      }
    }
    return n > 0 ? n : null;
  };
}
