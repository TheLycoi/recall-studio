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

/**
 * What narrowing did, for the route label: the judge kept some, kept none,
 * was never asked, or failed and was worked around.
 */
export type NarrowState = "kept" | "nothing" | "skipped" | "failed";

/** The evidence the drafter will read, how it was arrived at, and the pool size before. */
export interface Narrowed<T> {
  evidence: T[];
  state: NarrowState;
  before: number;
}

/**
 * Narrow a pool with the judge's verdict, or with the error it threw.
 *
 * A pool under `RELEVANCE_MIN_CANDIDATES` is `skipped` (the caller need not
 * have called the judge). A thrown judge is `failed`, and so is a verdict made
 * only of numbers outside the pool: that is a broken answer, not the judge
 * saying nothing is relevant, and reporting it as "none relevant" would refuse
 * a question the notes may well answer. Both fall back to the first `k`, the
 * retriever's order. An empty verdict is `nothing`: the judge read the pool
 * and kept none of it.
 *
 * With `notePathOf`, the fallback keeps the retriever's per-note cap for `k`
 * (at most `ceil(k / 2)` from one note, the rule of `rankEvidence` in
 * src/retrieval.ts): the pool was capped for its own wider size, so its first
 * `k` can all come from one note. It may then return fewer than `k`. A `kept`
 * verdict is not capped; the judge's choice stands.
 */
export function narrowEvidence<T>(
  candidates: T[],
  verdict: { relevant: number[] } | Error,
  k: number,
  notePathOf?: (c: T) => string,
): Narrowed<T> {
  const before = candidates.length;
  const fallback = () => topK(candidates, k, notePathOf);
  if (before < RELEVANCE_MIN_CANDIDATES) return { evidence: fallback(), state: "skipped", before };
  if (verdict instanceof Error) return { evidence: fallback(), state: "failed", before };
  const { kept, invalid } = applyRelevance(candidates, verdict, k);
  if (kept.length > 0) return { evidence: kept, state: "kept", before };
  if (invalid > 0) {
    console.debug(`WikiLM: relevance verdict had ${invalid} number(s) outside 1…${before} and none inside; using the top ${k}`);
    return { evidence: fallback(), state: "failed", before };
  }
  return { evidence: [], state: "nothing", before };
}

/** The first `k` in order, at most `ceil(k / 2)` per note when the note is known. */
function topK<T>(candidates: T[], k: number, notePathOf?: (c: T) => string): T[] {
  if (!notePathOf) return candidates.slice(0, k);
  const perNoteCap = Math.ceil(k / 2);
  const perNote = new Map<string, number>();
  const out: T[] = [];
  for (const c of candidates) {
    if (out.length >= k) break;
    const path = notePathOf(c);
    const used = perNote.get(path) ?? 0;
    if (used >= perNoteCap) continue;
    perNote.set(path, used + 1);
    out.push(c);
  }
  return out;
}

/**
 * The route label for a narrowing, or "" when there is nothing to say.
 *
 * Nothing to say is a skipped judge or one that kept the whole pool. A failure
 * is always named, even when the fallback happened to keep every passage: the
 * reader should know the evidence was not judged.
 */
export function describeNarrowing(n: Narrowed<unknown>): string {
  switch (n.state) {
    case "skipped":
      return "";
    case "failed":
      return `judge failed, top ${n.evidence.length} of ${n.before}`;
    case "nothing":
      return `${n.before} found, none relevant`;
    case "kept":
      return n.before === n.evidence.length ? "" : `${n.before} → ${n.evidence.length} kept`;
  }
}
