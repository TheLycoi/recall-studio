// multi-file-row-state.ts — how one left-pane row in the file picker
// renders (#598).
//
// Extracted from MultiFileSuggestModal for the same reason
// schema-diff-modal-classes.ts was: the Modal base class cannot be
// instantiated outside Obsidian, so anything left inside it is only ever
// verified by reading. The decision this file holds is exactly the one
// that was wrong — the checkbox was assigned from queue membership on
// every queue mutation, so a batch running in the background silently
// discarded whatever the user was ticking.
//
// PURE: no DOM, no Obsidian, no IO.

import type { IngestDiskState } from '../../core/ingest-state';

export interface RowInputs {
  /** The user's mark. The ONLY thing the checkbox reflects. */
  selected: boolean;
  /** A job for this path is pending or running in this session. */
  queued: boolean;
  /** A job for this path completed in this session. */
  completed: boolean;
  /** What the vault says, from `scanDiskStates`. */
  disk: IngestDiskState;
}

export interface RowState {
  checked: boolean;
  disabled: boolean;
  /** Class name → whether it applies. */
  classes: Record<string, boolean>;
  /** i18n key for the row's trailing label, or null for no label. */
  labelKey: 'multiFileRowIngested' | 'multiFileRowDrifted' | null;
}

export function resolveRowState(input: RowInputs): RowState {
  // A row that is already ingested and unchanged is settled: the checkbox
  // shows a greyed tick, the way a completed job's row always did. The
  // skip check would decline it anyway, and "I ticked it and nothing
  // happened" is worse feedback than a locked row.
  //
  // A DRIFTED row is deliberately left live. It is the one case where
  // picking the note again is a real intent rather than a mistake — the
  // page was built from a body that no longer exists — so the decision
  // stays with the user even though this PR offers no re-ingest button of
  // its own.
  const settled = input.completed || input.disk === 'ingested';
  return {
    // Two meanings, never at once: on a settled row the tick reads
    // "done", on a live row it reads "picked". Selection and queue
    // membership stay separate — rendering the queue into the checkbox
    // is what made a selection unstable while a batch ran.
    checked: settled || input.selected,
    disabled: settled,
    classes: {
      'llm-wiki-multi-file-row-ingested': input.completed,
      // Carries the signal the checkbox used to carry.
      'llm-wiki-multi-file-row-queued': input.queued,
      'llm-wiki-multi-file-row-on-disk': input.disk === 'ingested',
      'llm-wiki-multi-file-row-drifted': input.disk === 'drifted',
    },
    labelKey:
      input.disk === 'drifted' ? 'multiFileRowDrifted' :
      input.disk === 'ingested' ? 'multiFileRowIngested' :
      null,
  };
}
