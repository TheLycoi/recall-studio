/**
 * The sentence check: read an answer back against the passages it rested on,
 * and say which sentences no passage matched.
 *
 * This is a rebuild of an idea that failed once. A verifier used to live in
 * `src/askCheck.ts` (see its header, `:16-22`): it matched every quote
 * character by character against the evidence and **deleted** any sentence
 * whose quote it could not find. A model that tidied a quote lost a faithful
 * sentence, and the evidence wall the strictness justified made the reply
 * harder to read than the notes behind it.
 *
 * So this module never deletes and never rewrites. It **marks**: it returns a
 * verdict per sentence, and the panel lists the unmatched ones beneath the
 * answer with the answer itself untouched. The bar is softer too — token
 * overlap via `coveredBy` (src/retrieval.ts:722), the same tuned bar the
 * digest uses to decide whether a page already states a claim, rather than
 * exact quotes, with two widenings (`supportedBy`): a passage's note title
 * counts as part of it, and a sentence that joins two passages may be matched
 * against the pair. "Unmatched" is still the only honest word for the result:
 * token overlap misses paraphrase, so an unmatched sentence is one to look at,
 * never one that is false.
 *
 * Pure: `retrieval.ts` imports no `obsidian` (retrieval.ts:1-6), so this
 * module and its test bundle resolve without an Obsidian runtime.
 */
import { coveredBy, significantTokens, type EvidenceUnit } from "./retrieval";

/** One sentence of an answer, and whether a passage was found that states it. */
export interface ClaimVerdict {
  text: string;
  status: "supported" | "unmatched";
  /** The share of the claim's significant words the best passage had, or the pair that matched it. */
  score: number;
  /** The passage that matched it best, or null when nothing was searched. */
  best: EvidenceUnit | null;
}

/** Below this many significant words a sentence carries no checkable content. */
const MIN_TOKENS = 4;

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

/** A list item's marker: `- `, `* `, `+ ` or `1. `. */
const LIST_MARKER_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/**
 * Markdown the reader sees as formatting, not as words. Stripped before the
 * split so `**Receptors**.` does not read as a sentence end inside emphasis,
 * and before tokenising so a wikilink's target does not count as content the
 * passage has to match.
 */
function stripMarkdown(line: string): string {
  return line
    // `[[Target|display]]` and `[[Target]]` come down to what the reader sees.
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    // `[display](url)` likewise.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

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

/**
 * Split an answer's markdown into checkable sentences and list items.
 *
 * A list item is one claim however many sentences it holds: the reader wrote
 * the bullet as one point, and splitting it would check a fragment that only
 * means something beside its neighbour. Headings are dropped rather than
 * checked — a heading names a topic, it does not claim anything — and so is
 * anything under `MIN_TOKENS` significant words, which is how "Yes." and "See
 * below." stay out of the unmatched list they would otherwise always land in.
 */
export function splitClaims(answer: string): string[] {
  const claims: string[] = [];
  let prose: string[] = [];

  const flushProse = () => {
    if (prose.length === 0) return;
    for (const s of splitSentences(prose.join(" "))) claims.push(s);
    prose = [];
  };

  for (const raw of answer.split("\n")) {
    const line = raw.trim();
    if (line === "") {
      flushProse();
      continue;
    }
    // A heading is a label for what follows, not a claim about anything.
    if (/^#{1,6}\s/.test(line)) {
      flushProse();
      continue;
    }
    if (LIST_MARKER_RE.test(line)) {
      flushProse();
      const item = stripMarkdown(line.replace(LIST_MARKER_RE, ""));
      if (item) claims.push(item);
      continue;
    }
    prose.push(stripMarkdown(line));
  }
  flushProse();

  return claims.map((c) => c.trim()).filter((c) => c.length > 0 && significantTokens(c).length >= MIN_TOKENS);
}

/** How many of the matched words each passage of a pair must supply that the other does not. */
const PAIR_MIN_OWN = 2;

/**
 * Whether the units state a claim: one passage on its own, or two together.
 *
 * First the single-passage test, `coveredBy`, with each unit's note title
 * read as part of its text — a passage under "Bioavailability" is about
 * bioavailability even when its sentence never repeats the word.
 *
 * Then the pair: an answer's job is often to join two passages, and a
 * sentence doing that faithfully scores about half against either one
 * (measured: 0.47 best single, 0.73 best pair). The best-scoring unit is
 * joined with whichever other unit adds the most matched words it lacks
 * (ties by original order); if that pair fails, the second-best unit is tried
 * the same way. The claim is tested against the union with the same bar,
 * but only when each of the two supplies at least `PAIR_MIN_OWN` of the
 * matched words the other lacks. Without that, any passage adding one stray
 * word could lift a near-miss over the line, and "matched" would mean "most
 * of its words appear somewhere in the evidence", which is the whole-page
 * reading `coveredBy` exists to refuse.
 *
 * `best` is always the best single unit; `score` is the pair's when the pair
 * carried the claim, the single unit's otherwise.
 */
export function supportedBy(claim: string, units: EvidenceUnit[]): { supported: boolean; score: number; best: EvidenceUnit | null } {
  const titled = units.map((u) => ({ ...u, text: `${u.noteTitle} ${u.text}` }));
  const single = coveredBy(claim, titled);
  const best = single.best ? units[titled.indexOf(single.best)] : null;
  if (single.covered) return { supported: true, score: single.score, best };
  const miss = { supported: false, score: single.score, best };

  const tokens = [...new Set(significantTokens(claim))];
  if (tokens.length === 0 || units.length < 2) return miss;
  const scored = titled.map((u) => {
    const have = new Set(significantTokens(u.text));
    return { u, hits: new Set(tokens.filter((w) => have.has(w))) };
  });
  // Stable sort: ties keep the units' original order.
  const ranked = [...scored].sort((a, b) => b.hits.size - a.hits.size);
  const own = (x: Set<string>, y: Set<string>) => [...x].filter((w) => !y.has(w)).length;

  // The anchor's partner is the unit adding the most matched words the anchor
  // lacks (ties by original order), not the runner-up by hits: two passages
  // that overlap score alike, and pairing them adds little.
  for (const anchor of ranked.slice(0, 2)) {
    let partner: (typeof scored)[number] | null = null;
    let adds = -1;
    for (const x of scored) {
      if (x === anchor) continue;
      const n = own(x.hits, anchor.hits);
      if (n > adds) {
        adds = n;
        partner = x;
      }
    }
    if (!partner || adds < PAIR_MIN_OWN || own(anchor.hits, partner.hits) < PAIR_MIN_OWN) continue;
    const pair = coveredBy(claim, [{ ...anchor.u, text: `${anchor.u.text}\n${partner.u.text}` }]);
    if (pair.covered) return { supported: true, score: pair.score, best };
  }
  return miss;
}

/**
 * Check each claim against the units with `supportedBy`; never alters the claims.
 *
 * With nothing to check against every claim is unmatched at score 0: an
 * unsearched answer is not a verified one, and reporting it as supported would
 * put a mark on the line that means the opposite of what happened.
 */
export function verifyClaims(claims: string[], units: EvidenceUnit[]): ClaimVerdict[] {
  return claims.map((text) => {
    const { supported, score, best } = supportedBy(text, units);
    return { text, status: supported ? "supported" : "unmatched", score, best };
  });
}

/** Convenience: split then verify. */
export function checkClaims(answer: string, units: EvidenceUnit[]): ClaimVerdict[] {
  return verifyClaims(splitClaims(answer), units);
}
