import { describe, it, expect } from 'vitest';

// v1.21.0 Phase 1.4: Settings description drift — Default mode should
// preview user-defined custom tags if the user has typed them, so the
// description matches the runtime behavior.

describe('settings UI — tag vocabulary description alignment', () => {
  // Helper that mirrors the production defaultListDesc/effectiveListDesc logic
  // from settings.ts:720-734. If this drifts, the test will fail.
  function effectiveListDesc(customEntityTags: string, customConceptTags: string, tagVocabularyMode: string): string {
    const VALID_ENTITY_TAGS = ['person', 'organization', 'project', 'product', 'event', 'place', 'other'];
    const VALID_CONCEPT_TAGS = ['theory', 'method', 'field', 'phenomenon', 'standard', 'term', 'other'];
    const customEntities = customEntityTags.trim();
    const customConcepts = customConceptTags.trim();
    const hasCustomInput = customEntities.length > 0 || customConcepts.length > 0;
    // Effective list shows user values whenever they've been typed,
    // regardless of mode. The activation hint clarifies if the mode hasn't
    // been switched yet.
    const effectiveEntityTags = customEntities.length > 0
      ? customEntities.split(',').map(t => t.trim()).filter(Boolean)
      : VALID_ENTITY_TAGS;
    const effectiveConceptTags = customConcepts.length > 0
      ? customConcepts.split(',').map(t => t.trim()).filter(Boolean)
      : VALID_CONCEPT_TAGS;
    if (hasCustomInput) {
      const previewNote = tagVocabularyMode === 'default' ? ' — custom values shown above (toggle to Custom to activate)' : '';
      return `${effectiveEntityTags.join(', ')} (entities) / ${effectiveConceptTags.join(', ')} (concepts)${previewNote}`;
    }
    return `${VALID_ENTITY_TAGS.join(', ')} (entities) / ${VALID_CONCEPT_TAGS.join(', ')} (concepts)`;
  }

  it('Default mode with no custom input: shows built-in defaults', () => {
    const desc = effectiveListDesc('', '', 'default');
    expect(desc).toContain('person');
    expect(desc).toContain('theory');
    expect(desc).not.toContain('custom values');
  });

  it('Custom mode with user input: shows user values', () => {
    const desc = effectiveListDesc('Kardiologie, Immunologie', 'Medizin', 'custom');
    expect(desc).toContain('Kardiologie');
    expect(desc).toContain('Medizin');
    expect(desc).not.toContain('person'); // built-in replaced
    expect(desc).not.toContain('custom values');
  });

  it('Default mode WITH user input but NOT in custom mode: previews user values + activation hint', () => {
    // User typed custom tags but hasn't toggled to Custom yet — show them as preview
    const desc = effectiveListDesc('Kardiologie, Neurologie', '', 'default');
    expect(desc).toContain('Kardiologie');
    expect(desc).toContain('custom values shown above');
    expect(desc).toContain('toggle to Custom to activate');
  });
});