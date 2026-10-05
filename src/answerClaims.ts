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
import { splitSentences } from "./sentences";

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
