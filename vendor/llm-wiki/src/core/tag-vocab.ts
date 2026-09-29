import { VALID_ENTITY_TAGS, VALID_CONCEPT_TAGS, VALID_SOURCE_TAGS, LLMWikiSettings } from '../types';
import { fold } from './domain-axis';

export function getActiveEntityTags(settings: LLMWikiSettings): string[] {
  const custom = (settings.customEntityTags ?? '').trim();
  if (settings.tagVocabularyMode === 'custom' && custom.length > 0) {
    const userTags = custom.split(',').map(t => t.trim()).filter(t => t.length > 0);
    return Array.from(new Set(userTags));
  }
  return [...VALID_ENTITY_TAGS];
}

export function getActiveConceptTags(settings: LLMWikiSettings): string[] {
  const custom = (settings.customConceptTags ?? '').trim();
  if (settings.tagVocabularyMode === 'custom' && custom.length > 0) {
    const userTags = custom.split(',').map(t => t.trim()).filter(t => t.length > 0);
    return Array.from(new Set(userTags));
  }
  return [...VALID_CONCEPT_TAGS];
}

/**
 * The type a source extracted, as a tag that may be merged into an existing
 * page — or nothing, when the active vocabulary does not admit it.
 *
 * With the default vocabulary the two coincide: `VALID_ENTITY_TAGS` IS the
 * `EntityInfo['type']` enum, so the extracted type is always a member. With a
 * custom vocabulary it is not, and writing it into `tags:` anyway would put a
 * value there that `runRetagViolations` exists to remove.
 *
 * When the domain vocabulary is active (non-empty harvest), THAT is the test —
 * the settings type lists are the second vocabulary this series retires, and
 * checking against them here let the merge writers re-admit exactly what
 * `enforceFrontmatterConstraints` strips (S139: `phenomenon` back on two pages
 * one ingest after the cleanup, via the related-page merge).
 */
export function incomingTypeTag(
  settings: LLMWikiSettings,
  kind: 'entity' | 'concept',
  type: string | undefined,
  domainVocabulary?: readonly string[]
): string[] | undefined {
  if (!type) return undefined;
  if (domainVocabulary && domainVocabulary.length > 0) {
    const k = fold(type);
    const match = domainVocabulary.find(v => fold(v) === k);
    return match ? [match] : undefined;
  }
  const active = kind === 'entity' ? getActiveEntityTags(settings) : getActiveConceptTags(settings);
  return active.includes(type) ? [type] : undefined;
}

export function getActiveSourceTags(settings: LLMWikiSettings): string[] {
  return [...VALID_SOURCE_TAGS];
}

/**
 * Issue #527 — deterministic fold of a model-emitted type onto the active
 * vocabulary: exact match, then case-insensitive, then diacritic-insensitive.
 * Returns the vocabulary's own spelling, or null when nothing matches.
 * Plural and inflection are deliberately not folded: `Aminosäuren` is not
 * `Aminosäure` by any rule this function could state safely across the
 * languages a vocabulary may be written in — those go to the model.
 */
export function foldToVocabulary(value: string, vocab: readonly string[]): string | null {
  const v = value.trim();
  if (!v) return null;
  if (vocab.includes(v)) return v;
  const key = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const k = key(v);
  return vocab.find(t => key(t) === k) ?? null;
}

export function normalizeVocabularyCsv(csv: string): string {
  if (!csv) return '';
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of csv.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result.join(', ');
}
