// multi-file-row-state.test.ts — the file picker's left-pane row (#598)
//
// The bug this pins down: `updateLeftPaneSelections` assigned
// `checkbox.checked = isQueued` on every queue mutation, so the checkbox
// was a rendering of queue membership rather than of the user's
// selection. A batch running in the background therefore reset every
// tick the user made while it ran. Issue #598 derived that from reading
// the assignment; these are the cases that make it observable.
//
// The second half is the disk state: the picker described every row from
// session state alone, so after a plugin reload a note ingested weeks ago
// read as never ingested.

import { describe, it, expect } from 'vitest';
import { resolveRowState } from '../../ui/modals/multi-file-row-state';

const base = { selected: false, queued: false, completed: false, disk: 'none' as const };

describe('the checkbox is the user selection, not the queue', () => {
  it('stays ticked while a job for the same path runs', () => {
    // The old assignment produced `checked` here too — but from the
    // queue, which is why the next case was broken.
    expect(resolveRowState({ ...base, selected: true, queued: true }).checked).toBe(true);
  });

  it('does NOT tick a queued row the user never selected', () => {
    // Pending/running is not settled — only a finished job is.
    expect(resolveRowState({ ...base, queued: true }).checked).toBe(false);
  });

  it('keeps a selection made while an unrelated batch is running', () => {
    // This is the discarded-selection case: a queue mutation repaints
    // every row, and the row the user just ticked is not in the queue.
    expect(resolveRowState({ ...base, selected: true }).checked).toBe(true);
  });

  it('marks a queued row with a class instead of the checkbox', () => {
    const state = resolveRowState({ ...base, queued: true });
    expect(state.classes['llm-wiki-multi-file-row-queued']).toBe(true);
    expect(state.checked).toBe(false);
  });
});

describe('settled rows carry a greyed tick', () => {
  it('locks and ticks a row whose job completed in this session', () => {
    const state = resolveRowState({ ...base, completed: true });
    expect(state.disabled).toBe(true);
    expect(state.checked).toBe(true);
  });

  it('locks and ticks a row already ingested on disk', () => {
    // Same statement, older evidence: the summary page exists and the
    // note has not changed since. The skip check would decline it.
    const state = resolveRowState({ ...base, disk: 'ingested' });
    expect(state.disabled).toBe(true);
    expect(state.checked).toBe(true);
    expect(state.classes['llm-wiki-multi-file-row-on-disk']).toBe(true);
  });

  it('leaves a DRIFTED row live and unticked', () => {
    // The one case where picking the note again is a real intent: the
    // page was built from a body that no longer exists.
    const state = resolveRowState({ ...base, disk: 'drifted' });
    expect(state.disabled).toBe(false);
    expect(state.checked).toBe(false);
  });

  it('lets the user tick a drifted row', () => {
    expect(resolveRowState({ ...base, selected: true, disk: 'drifted' }).checked).toBe(true);
  });
});

describe('the disk label', () => {
  it('has none for a note with no page', () => {
    expect(resolveRowState(base).labelKey).toBeNull();
  });

  it('names the ingested state', () => {
    expect(resolveRowState({ ...base, disk: 'ingested' }).labelKey).toBe('multiFileRowIngested');
  });

  it('names the drifted state, and only that class applies', () => {
    const state = resolveRowState({ ...base, disk: 'drifted' });
    expect(state.labelKey).toBe('multiFileRowDrifted');
    expect(state.classes['llm-wiki-multi-file-row-drifted']).toBe(true);
    expect(state.classes['llm-wiki-multi-file-row-on-disk']).toBe(false);
  });

  it('survives a session job on top of the disk state', () => {
    // A note ingested weeks ago and re-ingested just now: both the
    // session lock and the disk label apply.
    const state = resolveRowState({ ...base, completed: true, disk: 'ingested' });
    expect(state.disabled).toBe(true);
    expect(state.classes['llm-wiki-multi-file-row-ingested']).toBe(true);
    expect(state.classes['llm-wiki-multi-file-row-on-disk']).toBe(true);
  });

  it('a completed job overrides a drifted page — the run just rewrote it', () => {
    const state = resolveRowState({ ...base, completed: true, disk: 'drifted' });
    expect(state.disabled).toBe(true);
    expect(state.checked).toBe(true);
  });
});
