/**
 * Splitting prose into sentences. Moved out of the answer checker so the quiz
 * can use it alone.
 *
 * Pure: no `obsidian` import (test/sentences.test.mjs bundles it standalone).
 */

/**
 * Abbreviations that end in a period mid-sentence. Splitting after them is the
 * classic sentence-splitter bug, and here it would cut a claim in half and
 * then report both halves as unmatched for being too thin.
 *
 * Each is matched on a word boundary, never as a suffix: `endsWith` on the
 * lowercased text made every word ending in these letters an abbreviation, so
 * "the answer was no." and "the effect was minimal." (ending `no.` and `al.`)
 * glued themselves to the sentence after them.
 */
const ABBREVIATIONS = ["e.g.", "i.e.", "vs.", "fig.", "eq.", "cf.", "al.", "approx."];

/**
 * `no.` is only the abbreviation for "number" when a numeral follows it
 * ("No. 4"). As a plain member of the list above it swallowed the far commoner
 * English word: "the answer was no. The trial continued…" became one claim.
 */
const NUMBER_ABBR = "no.";

/**
 * `etc.` is an abbreviation too, but it behaves the other way round: it *ends*
 * a list rather than introducing one, so unlike `e.g.`/`i.e.` — which always
 * have their example after them, on the same sentence — a capital letter after
 * `etc.` starts a new sentence. Treating it like the others merged
 * "…desensitisation etc. Describe the lifecycle." into a single claim. It only
 * holds the sentence together when the continuation is lowercase
 * ("…etc. and so on").
 */
const ETC = "etc.";

/**
 * Closing marks that belong to the sentence they end, not to the next one: a
 * quote or bracket may sit between the terminator and the space. Requiring
 * whitespace immediately after the period meant a sentence ending in a quoted
 * phrase ("…the “therapeutic window.” Beyond it…") never ended at all, and the
 * merged pair then failed the overlap bar that each half passes on its own.
 */
const CLOSERS = "\"'”’)]";

/**
 * How many closers sit at `i` in `text`, i.e. where the split point goes.
 *
 * The character is tested for `undefined` rather than defaulted to `""`,
 * because `String.includes("")` is true and past the end of the text that
 * spins forever.
 */
function closerRun(text: string, i: number): number {
  let n = 0;
  for (;;) {
    const ch = text[i + n];
    if (ch === undefined || !CLOSERS.includes(ch)) return n;
    n++;
  }
}

/** How many brackets the closer run at `i` shuts. */
function closingDepth(text: string, i: number): number {
  let n = 0;
  for (let j = i; j < text.length && CLOSERS.includes(text[j]); j++) {
    if (text[j] === ")" || text[j] === "]") n++;
  }
  return n;
}

/**
 * Whether an abbreviation ends at `i`, on a word boundary.
 *
 * The boundary is what makes it an abbreviation rather than a word that merely
 * ends in the same letters: `abbr` must be preceded by the start of the text or
 * by a non-letter, so "et al." and "e.g." match while "minimal." and "was no."
 * do not.
 */
function endsAbbreviation(text: string, i: number, abbr: string): boolean {
  const end = i + 1;
  const start = end - abbr.length;
  if (start < 0) return false;
  if (text.slice(start, end).toLowerCase() !== abbr) return false;
  const prev = text[start - 1];
  return prev === undefined || !/\p{L}/u.test(prev);
}

/**
 * Whether the period at `i` in `text` ends a sentence.
 *
 * The cases that must say no are the ones that would split a claim: an
 * abbreviation, an initial ("A. V. Hill"), a decimal ("3.5 m/s"), and any
 * position inside a parenthesis — a parenthetical aside is part of the
 * sentence that carries it, and checking half of one against the passages
 * would mark a supported claim unmatched on a technicality.
 */
function endsSentence(text: string, i: number, depth: number): boolean {
  // Inside an aside the terminator belongs to the aside, unless the closers
  // that follow it shut every open bracket: "(…reported in the deck.) Toxicity"
  // ends a sentence, while "(change in position. Speed…)" is still mid-aside.
  if (depth > closingDepth(text, i + 1)) return false;
  const ch = text[i];

  if (ch === ".") {
    // A decimal point: digit on each side.
    if (/\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "")) return false;
    for (const abbr of ABBREVIATIONS) if (endsAbbreviation(text, i, abbr)) return false;
    // "No. 4" is an abbreviation; "the answer was no." is a sentence.
    if (endsAbbreviation(text, i, NUMBER_ABBR) && /^\s*\p{N}/u.test(text.slice(i + 1))) return false;
    // `etc.` holds only while the sentence runs on in lowercase; a capital after
    // it is the next sentence, because `etc.` closes the list it ends.
    if (endsAbbreviation(text, i, ETC) && !/^\s+[\p{Lu}\p{N}]/u.test(text.slice(i + 1))) return false;
    // An initial: one letter, and what precedes it is not a word.
    if (/(^|[^\p{L}])\p{Lu}\.$/u.test(text.slice(Math.max(0, i - 2), i + 1))) return false;
  }

  // Closing quotes and brackets stay with this sentence; look past them.
  const rest = text.slice(i + 1 + closerRun(text, i + 1));
  // The end of the text ends the sentence whatever follows.
  if (rest.trim() === "") return true;
  // Otherwise: whitespace, then something that starts a sentence.
  return /^\s+["'“(]?[\p{Lu}\p{N}]/u.test(rest);
}

/** Split one run of prose into sentences, leaving abbreviations and asides whole. */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if ((ch === "." || ch === "!" || ch === "?") && endsSentence(text, i, depth)) {
      // Run on through `?!` and `...` so the punctuation stays with its sentence.
      let end = i;
      while (end + 1 < text.length && ".!?".includes(text[end + 1])) end++;
      // Then past any closing quote or bracket, which closes this sentence too.
      end += closerRun(text, end + 1);
      out.push(text.slice(start, end + 1).trim());
      start = end + 1;
      i = end;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter((s) => s.length > 0);
}
