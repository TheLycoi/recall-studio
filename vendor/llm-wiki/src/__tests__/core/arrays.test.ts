import { describe, it, expect } from 'vitest';
import { coerceToArray, extractSourceTags } from '../../core/arrays';
describe('coerceToArray', () => {
  it('returns the same array when value is an array', () => {
    const arr = [1, 2, 3];
    const result = coerceToArray<number>(arr);
    expect(result).toBe(arr);
    expect(result).toEqual([1, 2, 3]);
  });

  it('returns empty array for null', () => {
    expect(coerceToArray(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(coerceToArray(undefined)).toEqual([]);
  });

  it('returns empty array for non-array truthy value', () => {
    expect(coerceToArray(true)).toEqual([]);
  });

  it('returns empty array for string', () => {
    expect(coerceToArray('hello')).toEqual([]);
  });

  it('returns empty array for number', () => {
    expect(coerceToArray(42)).toEqual([]);
  });

  it('returns empty array for object', () => {
    expect(coerceToArray({ foo: 'bar' })).toEqual([]);
  });

  it('preserves array contents', () => {
    expect(coerceToArray<string>(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('extractSourceTags', () => {
  it('returns empty array when content has no frontmatter', () => {
    expect(extractSourceTags('# Just a heading\nNo frontmatter')).toEqual([]);
  });

  it('returns empty array when frontmatter has no tags field', () => {
    const content = '---\ntype: source\ncreated: 2026-06-08\n---\n\nBody';
    expect(extractSourceTags(content)).toEqual([]);
  });

  it('extracts tags from inline array format', () => {
    const content = '---\ntags: [历史, 古代, 文学]\n---\n\nBody';
    expect(extractSourceTags(content)).toEqual(['历史', '古代', '文学']);
  });

  it('extracts tags from multi-line array format', () => {
    const content = '---\ntags:\n  - 历史\n  - 古代\n  - 文学\n---\n\nBody';
    expect(extractSourceTags(content)).toEqual(['历史', '古代', '文学']);
  });

  it('returns single-element array when tags is a scalar (Obsidian allows this)', () => {
    const content = '---\ntags: history\n---\n\nBody';
    expect(extractSourceTags(content)).toEqual(['history']);
  });

  it('trims whitespace and filters empty strings', () => {
    const content = '---\ntags: [ 历史 , , 古代 ]\n---\n\nBody';
    expect(extractSourceTags(content)).toEqual(['历史', '古代']);
  });
});

