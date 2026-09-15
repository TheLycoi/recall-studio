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
// offers a Run chip. obsidian.d.ts:5244-5252 documents `prepareFuzzySearch`
// only as "construct a fuzzy search callback that runs on a target string"
// returning `SearchResult | null`; `SearchResult.score` (:5593) carries no
// documented scale, sign, or range at all, so no threshold can be derived from
// the typings. The scorer is therefore injected: this constant is only ever
// compared against whatever scorer the caller supplies, and the tests pin it
// against a token-overlap scorer (one point per query token present).
//
// The live wrapper T4 installs is
//   (q) => { const f = prepareFuzzySearch(q); return (t) => f(t)?.score ?? null; }
// whose scores are on Obsidian's undocumented scale, not the token counts the
// tests use. Expect to retune this constant against the real scorer once the
// chip has been seen in the app; too low offers chips for ordinary questions,
// too high never offers one.
export const OFFER_THRESHOLD = 2;

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
    const score = fuzzy(rest);
    const hit = best(commands, (c) => score(c.name));
    if (hit) return { kind: "run", id: hit.item.id };
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
 * names such as "AI-highlight" split into their parts). Null when none do. The
 * chat panel injects this rather than Obsidian's `prepareFuzzySearch`, whose
 * score scale is undocumented (obsidian.d.ts:5244-5252), so `OFFER_THRESHOLD`
 * means "at least this many shared words" in tests and in the app alike.
 */
export function tokenOverlapScorer(query: string): (text: string) => number | null {
  const tokens = (v: string) => new Set(v.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0));
  const q = tokens(query);
  return (text) => {
    const t = tokens(text);
    let n = 0;
    for (const w of q) if (t.has(w)) n++;
    return n > 0 ? n : null;
  };
}
