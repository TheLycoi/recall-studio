import { describe, it, expect } from 'vitest';
import { parseSchemaSuggestion, extractBodyFromFull } from '../../schema/parse-suggestion';

// v1.22.0 #97: parse the LLM's JSON response into a structured
// SchemaSuggestion. The prompt is documented to return either:
//   { changes_needed: true,  new_schema_body: "<full markdown>", suggestions: "..." }
//   { changes_needed: false, suggestions: "..." }
//
// We tolerate:
//   - Missing new_schema_body (legacy prompts before v1.22.0)
//   - new_schema_body includes the YAML frontmatter (we strip it — only the
//     body is what applySchemaSuggestion needs to splice in)
//   - Trailing/leading whitespace
//   - LLM accidentally including ``` fences around the markdown

describe('parseSchemaSuggestion (#97)', () => {
  it('parses a full v1.22.0 response with new_schema_body', () => {
    const raw = JSON.stringify({
      changes_needed: true,
      new_schema_body: '# Wiki Schema\n\n## Wiki Structure\n- updated\n',
      suggestions: 'Updated Wiki Structure to be more flexible.',
    });
    const result = parseSchemaSuggestion(raw);
    expect(result.changes_needed).toBe(true);
    expect(result.newSchemaBody).toBe('# Wiki Schema\n\n## Wiki Structure\n- updated\n');
    expect(result.suggestions).toBe('Updated Wiki Structure to be more flexible.');
  });

  it('parses a v1.21.x response without new_schema_body (legacy compat)', () => {
    const raw = JSON.stringify({
      changes_needed: true,
      suggestions: 'Add new entity type "drug".',
    });
    const result = parseSchemaSuggestion(raw);
    expect(result.changes_needed).toBe(true);
    expect(result.newSchemaBody).toBeUndefined();
    expect(result.suggestions).toBe('Add new entity type "drug".');
  });

  it('returns changes_needed=false for a no-op response', () => {
    const raw = JSON.stringify({ changes_needed: false, suggestions: '' });
    const result = parseSchemaSuggestion(raw);
    expect(result.changes_needed).toBe(false);
    expect(result.newSchemaBody).toBeUndefined();
  });

  it('strips ``` fences if the LLM accidentally wraps the body in code', () => {
    const raw = JSON.stringify({
      changes_needed: true,
      new_schema_body: '```markdown\n# Wiki Schema\n```',
      suggestions: '...',
    });
    const result = parseSchemaSuggestion(raw);
    // The fences are gone; the body content remains
    expect(result.newSchemaBody).toBe('# Wiki Schema\n');
  });

  it('strips embedded YAML frontmatter from new_schema_body (apply-path splice only needs body)', () => {
    const raw = JSON.stringify({
      changes_needed: true,
      new_schema_body: '---\nversion: 1\nupdated: 2026-06-22\n---\n\n# Wiki Schema\n\nbody\n',
      suggestions: '...',
    });
    const result = parseSchemaSuggestion(raw);
    expect(result.newSchemaBody).toBe('# Wiki Schema\n\nbody\n');
    // Frontmatter-free body is what applySchemaSuggestion's spliceBody() expects
  });

  it('tolerates invalid JSON without throwing — returns no-op result', () => {
    const result = parseSchemaSuggestion('not json at all');
    expect(result.changes_needed).toBe(false);
    expect(result.newSchemaBody).toBeUndefined();
  });

  it('tolerates empty string without throwing', () => {
    const result = parseSchemaSuggestion('');
    expect(result.changes_needed).toBe(false);
  });

  it('defaults changes_needed to true if absent (LLM-typical under-specification)', () => {
    // An older prompt format may omit the field. We treat that as "yes,
    // changes are needed" because the suggestions field is non-empty.
    // The UI gating (showing the Modal) checks changes_needed.
    const raw = JSON.stringify({ suggestions: 'Add tags' });
    const result = parseSchemaSuggestion(raw);
    expect(result.changes_needed).toBe(true);
    expect(result.suggestions).toBe('Add tags');
  });
});

describe('extractBodyFromFull (#97)', () => {
  it('strips frontmatter from a full schema file', () => {
    const full = '---\nversion: 1\n---\n\n# Wiki Schema\n\nbody\n';
    expect(extractBodyFromFull(full)).toBe('# Wiki Schema\n\nbody\n');
  });

  it('returns the input unchanged when there is no frontmatter', () => {
    const body = '# Wiki Schema\nbody\n';
    expect(extractBodyFromFull(body)).toBe(body);
  });

  it('returns the input unchanged when frontmatter is unterminated (defensive)', () => {
    const malformed = '---\nversion: 1\n# Wiki Schema\n'; // no closing ---
    // The function must not throw — return the input as-is so the user
    // sees the malformed content in the diff Modal and can fix it.
    expect(extractBodyFromFull(malformed)).toBe(malformed);
  });
});
