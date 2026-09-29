// source-lemma.ts — does the source note's own topic have a node?
//
// `analyzeSource` extracts entities/concepts *from* a text. That the text is
// itself *about* something is not a category of the extraction prompt, so the
// note's own lemma is regularly absent from both lists — the page a reader
// would look for first is the one that does not get written.
//
// This module answers the *whether* deterministically: no IO, no LLM, no
// side effects. The caller owns the *what* (type choice, body). Every helper
// is a pure function so the decision can be unit-tested without a vault.

import { slugKeys } from './slug';

/** An extracted candidate as far as lemma matching is concerned. */
export interface NamedCandidate {
  name: string;
  aliases?: string[];
}

/** What the caller should do about the source note's own lemma. */
export type LemmaDecision =
  | { action: 'skip'; reason: 'no-title' | 'already-extracted' }
  | { action: 'add'; name: string };

/**
 * True when any extracted candidate already claims one of `keys` — by its own
 * name or by an alias the extraction pre-generated.
 *
 * This is the S45 "Papain" guard: the lemma is frequently extracted on its
 * own, and re-adding it would create a duplicate candidate for a page that is
 * already on its way.
 *
 * Note: the canonical `slugKeys` from `./slug` already filters degenerate
 * `untitled-<Date.now()>` outputs (`core/slug.ts:92`), so punctuation-only
 * names cannot produce a coincidental match via millisecond collisions.
 */
export function isLemmaExtracted(
  keys: ReadonlySet<string>,
  extracted: readonly NamedCandidate[],
): boolean {
  for (const item of extracted) {
    for (const key of slugKeys(item.name, item.aliases ?? [])) {
      if (keys.has(key)) return true;
    }
  }
  return false;
}

/**
 * Decide whether the source note's own lemma must be added as a candidate.
 *
 * Conservative by construction: every branch that is not clearly "missing and
 * wanted" returns `skip`. A node that is not created costs nothing; a wrongly
 * created one is permanent.
 *
 * Note: a previous `domain-container` skip reason was removed in PR #357
 * review. That rule read `customEntityTags`/`customConceptTags` as a domain
 * list, conflating two unrelated settings (entity/concept subtype vocabulary,
 * not "field of study" names) and silently firing for any user on the
 * built-in vocabulary whose notes happened to share a slug with a subtype
 * like "method" or "place". Wait for #328 Phase 2 to land a real
 * folder/domain registry before reintroducing this guard.
 */
export function decideSourceLemma(params: {
  /** Title the analysis recorded for the source (falls back to the filename). */
  sourceTitle: string | null | undefined;
  /** Curated `aliases:` from the source note's frontmatter (Issue #185). */
  sourceAliases?: readonly string[];
  entities: readonly NamedCandidate[];
  concepts: readonly NamedCandidate[];
}): LemmaDecision {
  const title = (params.sourceTitle ?? '').trim();
  if (title.length === 0) return { action: 'skip', reason: 'no-title' };

  const keys = slugKeys(title, params.sourceAliases ?? []);

  if (isLemmaExtracted(keys, params.entities) || isLemmaExtracted(keys, params.concepts)) {
    return { action: 'skip', reason: 'already-extracted' };
  }
  return { action: 'add', name: title };
}