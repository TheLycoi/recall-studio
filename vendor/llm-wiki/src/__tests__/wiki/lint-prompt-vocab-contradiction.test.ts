import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../../wiki/system-prompts';
import { FIX_PROMPTS } from '../../wiki/prompts/fixes';
import { getActiveEntityTags, getActiveConceptTags } from '../../core/tag-vocab';
import { VALID_ENTITY_TAGS, VALID_CONCEPT_TAGS } from '../../types';
import type { LLMWikiSettings } from '../../types';

// Issue #328 Phase 1 made the runtime injection (buildSystemPrompt ->
// "Active Tag Vocabulary") the single source of truth for allowed tag values.
// A lint prompt that restates the default taxonomy re-creates the dual source:
// with a custom vocabulary the two layers travel in the same call and forbid
// each other's values, so every answer the model can give violates one of them.

function makeSettings(overrides: Partial<LLMWikiSettings> = {}): LLMWikiSettings {
  return {
    wikiFolder: 'wiki',
    wikiLanguage: 'de',
    extractionGranularity: 'standard',
    customEntityTags: '',
    customConceptTags: '',
    tagVocabularyMode: 'default',
    ...overrides,
  } as LLMWikiSettings;
}

// A vocabulary that shares no value with the defaults — the case that makes
// the contradiction observable (see #368, where the custom list was the
// default list plus one term and therefore agreed with the baked-in copy).
const customSettings = makeSettings({
  tagVocabularyMode: 'custom',
  customEntityTags: 'Mineralstoffe, Biochemie, Physiologie, Mikrobiom',
  customConceptTags: 'Mineralstoffe, Biochemie, Physiologie, Mikrobiom',
});

const DEFAULT_TAXONOMY = [...VALID_ENTITY_TAGS, ...VALID_CONCEPT_TAGS];

/** Lines that enumerate three or more default-taxonomy values — a baked-in enum. */
function linesRestatingTheDefaultTaxonomy(prompt: string): string[] {
  return prompt.split('\n').filter(line => {
    const hits = DEFAULT_TAXONOMY.filter(t =>
      new RegExp(`\\b${t}\\b`).test(line),
    );
    return new Set(hits).size >= 3;
  });
}

describe('lint prompts vs. the active tag vocabulary', () => {
  it('the system layer carries the active vocabulary on the lint task', async () => {
    const system = await buildSystemPrompt(customSettings, async () => undefined, 'lint');
    expect(system).toBeDefined();
    expect(system).toContain('Active Tag Vocabulary');
    for (const tag of getActiveEntityTags(customSettings)) {
      expect(system).toContain(tag);
    }
    for (const tag of getActiveConceptTags(customSettings)) {
      expect(system).toContain(tag);
    }
  });

  it('no lint prompt restates the default taxonomy as a fixed list', () => {
    for (const [name, prompt] of Object.entries(FIX_PROMPTS)) {
      expect(
        linesRestatingTheDefaultTaxonomy(prompt),
        `${name} hardcodes tag values that a custom vocabulary forbids`,
      ).toEqual([]);
    }
  });
});
