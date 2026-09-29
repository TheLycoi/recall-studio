import { describe, it, expect } from 'vitest';
import { checkContentRequirements, type ContentCheckInput } from '../../core/source-requirements';

// v1.25.10 PATCH invariant: DocTpoint §2 — admission rules must be expressed
// in exactly one place. The `CONTENT_CHECKS` registry is the canonical
// source. This test pins that registry's shape and verifies the two checks
// it currently ships with. New admission rules get added to the registry
// alone — no prompt-level duplication.
describe('admission criterion invariant — single-source-of-truth', () => {
  it('CONTENT_CHECKS registry is non-empty and ordered', async () => {
    const { CONTENT_CHECKS } = await import('../../core/source-requirements');
    expect(CONTENT_CHECKS.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null for a well-formed source', () => {
    const input: ContentCheckInput = {
      extension: 'md',
      content: '---\ntags: [note]\n---\n\nSome body text.',
      allowedExtensions: ['md', 'pdf'],
    };
    expect(checkContentRequirements(input)).toBeNull();
  });

  it('rejects an empty source with the "empty" reason', () => {
    const input: ContentCheckInput = {
      extension: 'md',
      content: '',
      allowedExtensions: ['md', 'pdf'],
    };
    const result = checkContentRequirements(input);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('empty');
  });

  it('rejects an incompatible type with detail == extension', () => {
    const input: ContentCheckInput = {
      extension: 'zip',
      content: 'whatever',
      allowedExtensions: ['md', 'pdf'],
    };
    const result = checkContentRequirements(input);
    expect(result).not.toBeNull();
    expect(result!.reason).toBe('incompatible-type');
    expect(result!.detail).toBe('zip');
  });

  it('frontmatter-only file (no body) is rejected — Yinmin Zhong class of bug', () => {
    // The original Issue #164 complaint: tags-only stubs hallucinate content
    // on small/local models. This is the canonical admission rule and must
    // remain here — NOT duplicated as a "if blank, refuse" instruction in the
    // LLM prompt.
    const input: ContentCheckInput = {
      extension: 'md',
      content: '---\ntags: [reading-list]\n---',
      allowedExtensions: ['md', 'pdf'],
    };
    expect(checkContentRequirements(input)).toEqual({ reason: 'empty' });
  });
});
