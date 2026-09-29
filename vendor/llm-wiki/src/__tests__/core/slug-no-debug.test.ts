// v1.22.2: slug.ts:2 console.debug noise — must not emit debug logs on every normal call
import { describe, it, expect, vi } from 'vitest';
import { computeSlug } from '../../core/slug';

describe('computeSlug (v1.22.2 — no console.debug noise)', () => {
  it('does NOT call console.debug on normal slug computation', () => {
    const spy = vi.spyOn(console, 'debug');
    computeSlug('hello world');
    computeSlug('test-slug');
    computeSlug('another.example');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('still works correctly (no behaviour change)', () => {
    expect(computeSlug('hello world')).toBe('hello-world');
    expect(computeSlug('test:file')).toBe('testfile');
  });
});
