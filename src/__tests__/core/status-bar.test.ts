import { describe, it, expect } from 'vitest';
import { buildIngestStatusBarText } from '../../core/status-bar';

const LABEL = '提取中... 点击取消';

describe('buildIngestStatusBarText', () => {
  it('returns the bare label when no filename and no batch info', () => {
    expect(buildIngestStatusBarText(LABEL)).toBe(LABEL);
  });

  it('prefixes the filename before the label for a single file', () => {
    expect(buildIngestStatusBarText(LABEL, 'My Note')).toBe('My Note · 提取中... 点击取消');
  });

  it('prefixes the batch counter and filename when batch info is given', () => {
    expect(buildIngestStatusBarText(LABEL, 'My Note', { current: 4, total: 10 })).toBe(
      '[4/10] My Note · 提取中... 点击取消'
    );
  });

  it('shows the batch counter alone when batch info is given but filename is missing', () => {
    expect(buildIngestStatusBarText(LABEL, undefined, { current: 2, total: 5 })).toBe(
      '[2/5] 提取中... 点击取消'
    );
  });

  it('falls back to the bare label when filename is empty/whitespace and no batch', () => {
    expect(buildIngestStatusBarText(LABEL, '   ')).toBe(LABEL);
  });

  it('trims the filename', () => {
    expect(buildIngestStatusBarText(LABEL, '  Note  ')).toBe('Note · 提取中... 点击取消');
  });

  it('ignores null batch info', () => {
    expect(buildIngestStatusBarText(LABEL, 'Doc', null)).toBe('Doc · 提取中... 点击取消');
  });

  // v1.25.11 PATCH #169 — fine-grained stage hints.
  //
  // Why this test exists (vs. ad-hoc string concat at the call site):
  // the v3 plan carries stage labels through `updateStatusBar` on a
  // dedicated stage field, NOT by smuggling them into the existing
  // localized `label` argument. The status bar should still report
  // `[4/10] My Note · <stage label> · <base label>` (stage sandwiched
  // between filename and the existing cancel hint) so the user sees:
  //   - which page is being processed (filename)
  //   - which pipeline stage we're in (stage — new in #169)
  //   - the always-visible cancel hint (base label — preserved)
  it('appends a fine-grained stage between filename and base label when stage is set', () => {
    expect(
      buildIngestStatusBarText(LABEL, 'My Note', { current: 4, total: 10 }, 'Generating summary')
    ).toBe('[4/10] My Note · Generating summary · 提取中... 点击取消');
  });

  it('omits the stage prefix when stage is undefined or empty (backward-compatible)', () => {
    expect(buildIngestStatusBarText(LABEL, 'My Note', undefined, undefined)).toBe(
      'My Note · 提取中... 点击取消'
    );
    expect(buildIngestStatusBarText(LABEL, 'My Note', undefined, '')).toBe(
      'My Note · 提取中... 点击取消'
    );
    expect(buildIngestStatusBarText(LABEL, 'My Note', undefined, '   ')).toBe(
      'My Note · 提取中... 点击取消'
    );
  });

  it('composes stage-only (no filename) when stage and batch are set but filename is empty', () => {
    expect(
      buildIngestStatusBarText(LABEL, '', { current: 1, total: 3 }, 'Analyzing')
    ).toBe('[1/3] Analyzing · 提取中... 点击取消');
  });
});

// B2 fix (v1.26.3 PATCH follow-up): the status-bar update path
// (command-registry.ts setStatusBarUpdateCallback) must preserve the
// always-visible "click to cancel" hint. Previously the callback called
// setText(text) directly with the raw progress text, so the user only
// saw "Analyzing batch 2/3..." without any indication that they could
// click the status bar to abort. The fix routes the update text through
// `composeStatusBarUpdate` (a thin wrapper that picks the active label
// and appends it as a stage segment), restoring the
// buildIngestStatusBarText contract documented above.
import { composeStatusBarUpdate } from '../../core/status-bar';

describe('composeStatusBarUpdate (B2 fix)', () => {
  const INGEST_LABEL = 'Ingesting... click to cancel';
  const LINT_LABEL = 'Linting... click to cancel';

  it('returns null when nothing is running (status bar should hide)', () => {
    expect(composeStatusBarUpdate({
      isIngesting: false,
      isLintRunning: false,
      ingestLabel: INGEST_LABEL,
      lintLabel: LINT_LABEL,
      updateText: 'Analyzing batch 2/3...',
    })).toBeNull();
  });

  it('composes ingest label + update text when ingesting', () => {
    expect(composeStatusBarUpdate({
      isIngesting: true,
      isLintRunning: false,
      ingestLabel: INGEST_LABEL,
      lintLabel: LINT_LABEL,
      updateText: 'Analyzing batch 2/3 (0 entities, 5 concepts so far)...',
    })).toBe('Analyzing batch 2/3 (0 entities, 5 concepts so far)... · Ingesting... click to cancel');
  });

  it('composes lint label + update text when linting', () => {
    expect(composeStatusBarUpdate({
      isIngesting: false,
      isLintRunning: true,
      ingestLabel: INGEST_LABEL,
      lintLabel: LINT_LABEL,
      updateText: 'Checking duplicates...',
    })).toBe('Checking duplicates... · Linting... click to cancel');
  });

  it('prefers ingest label when both are running (ingest takes precedence)', () => {
    // In practice this should not happen — ingest and lint are
    // mutex. Defensive default in case a future bug lets them overlap.
    expect(composeStatusBarUpdate({
      isIngesting: true,
      isLintRunning: true,
      ingestLabel: INGEST_LABEL,
      lintLabel: LINT_LABEL,
      updateText: 'progress',
    })).toBe('progress · Ingesting... click to cancel');
  });

  it('returns bare active label when update text is empty', () => {
    expect(composeStatusBarUpdate({
      isIngesting: true,
      isLintRunning: false,
      ingestLabel: INGEST_LABEL,
      lintLabel: LINT_LABEL,
      updateText: '',
    })).toBe('Ingesting... click to cancel');
    expect(composeStatusBarUpdate({
      isIngesting: false,
      isLintRunning: true,
      ingestLabel: INGEST_LABEL,
      lintLabel: LINT_LABEL,
      updateText: '',
    })).toBe('Linting... click to cancel');
  });
});
