/**
 * The relevance stage: narrowing a wide pool of retrieved passages down to the
 * ones that actually bear on the question, before the drafter ever sees them.
 *
 * Reimplemented from the per-result filter in stanford-oval/WikiChat, with one
 * change: where upstream judges each retrieved result in its own call, we send
 * the whole pool as one numbered list and take back the numbers that survive.
 * A reader waits for their answer, and one call over twenty lines costs less
 * time than twenty calls over one line each.
 *
 * The contract is omission: the model names what bears on the question, and a
 * number it does not name is dropped. Nothing here rewrites or summarizes a
 * passage — the drafter reads the reader's own words, not a model's precis of
 * them. This module only moves candidates by position, so it cannot invent a
 * passage even when the verdict is nonsense; a number outside the pool is
 * counted and thrown away.
 */

/** What the filter did to a pool: what survived, how much fell away, and how much of the verdict was unusable. */
export interface RelevanceResult<T> {
  kept: T[];
  dropped: number;
  invalid: number;
}

/**
 * Below this many candidates the caller skips the call entirely: there is
 * nothing to narrow, and the round trip would cost the reader a wait for a
 * verdict that can barely change the evidence.
 */
export const RELEVANCE_MIN_CANDIDATES = 3;

/** Narrow candidates to the ones the model named, in the model's order, capped at k. */
export function applyRelevance<T>(candidates: T[], verdict: { relevant: number[] }, k: number): RelevanceResult<T> {
  const kept: T[] = [];
  const seen = new Set<number>();
  let invalid = 0;
  for (const n of verdict.relevant ?? []) {
    // The numbers are 1-based positions into `candidates`, the same numbering
    // `numberEvidence` gives, so a number the model names means the same line
    // it was shown. Anything that is not such a position is the model's error,
    // not a candidate, and is counted rather than guessed at.
    if (!Number.isInteger(n) || n < 1 || n > candidates.length) {
      invalid += 1;
      continue;
    }
    // A repeat is emphasis, not a mistake: keep the first mention's place in
    // the order and say nothing about it.
    if (seen.has(n)) continue;
    seen.add(n);
    if (kept.length >= k) continue;
    kept.push(candidates[n - 1]);
  }
  // Dropped is counted against the pool, not against the verdict: it is what
  // the reader loses, whether the model left a passage out or the cap did.
  return { kept, dropped: candidates.length - kept.length, invalid };
}
