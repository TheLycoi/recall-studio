/** Template placeholder renderer: replaces `{{name}}` tokens with values from a vars map. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderTemplate } from '../../core/template-renderer';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderTemplate', () => {
  it('replaces a single occurrence', () => {
    expect(renderTemplate('Hello {{name}}', { name: 'world' })).toBe('Hello world');
  });

  it('replaces ALL occurrences of the same placeholder', () => {
    expect(
      renderTemplate('{{x}} + {{x}} + {{x}} = 3{{x}}', { x: 'a' })
    ).toBe('a + a + a = 3a');
  });

  it('replaces multiple distinct placeholders', () => {
    expect(
      renderTemplate('{{greeting}} {{name}}, today is {{date}}.', {
        greeting: 'Hello',
        name: 'Bob',
        date: '2026-07-27',
      })
    ).toBe('Hello Bob, today is 2026-07-27.');
  });

  it('returns the original string when no placeholders are present', () => {
    expect(renderTemplate('plain text', { foo: 'bar' })).toBe('plain text');
  });

  it('logs unknown placeholders at debug (not warn) and leaves them untouched', () => {
    // Design rationale (v1.26.x PATCH follow-up): renderTemplate is the
    // FIRST of a two-stage render (the second is `applySectionLabels`).
    // Templates deliberately use `{{section_*}}` markers that the first
    // stage does NOT substitute — the second stage does, reading from
    // settings. Previously this triggered `console.warn` on every entity/
    // concept page creation (3+ warnings per page), which is a false
    // positive: the marker is by design unknown to stage 1. Downgrading
    // to `console.debug` keeps the diagnostic visible to devs (build:dev)
    // while silencing the production-build log noise that obscured real
    // warnings during E2E ingest.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const result = renderTemplate('Hello {{name}}, your {{unknown}} is ready.', { name: 'Alice' });
    expect(result).toBe('Hello Alice, your {{unknown}} is ready.');
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('{{unknown}}'));
  });

  it('does not warn or debug-log when all placeholders are known', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    renderTemplate('Hello {{name}}', { name: 'Alice' });
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('debug-logs once per unknown placeholder across many occurrences', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    renderTemplate('{{a}} {{a}} {{b}} {{b}}', {});
    expect(debug).toHaveBeenCalledTimes(4);
  });

  it('leaves placeholders with non-word chars (dot/dash) untouched', () => {
    expect(renderTemplate('{{a.b}} {{a-b}}', {})).toBe('{{a.b}} {{a-b}}');
  });

  it('does not recursively substitute values that look like placeholders', () => {
    expect(
      renderTemplate('{{a}}', { a: '{{b}}', b: 'should-not-appear' })
    ).toBe('{{b}}');
  });
});