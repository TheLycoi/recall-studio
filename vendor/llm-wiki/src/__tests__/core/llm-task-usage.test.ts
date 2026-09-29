import { describe, it, expect } from 'vitest';
import {
  recordTaskUsage,
  snapshotTaskUsage,
  taskUsageSince,
  formatTaskUsage,
} from '../../core/llm-task-usage';

// The totals are cumulative and live for the process, because two ingests can
// overlap and a reset would be wrong the moment they do. Callers diff against a
// snapshot instead. These tests are written the same way on purpose: none of
// them assumes the map starts empty, since in a real run it never does — and a
// test that did assume it would pass alone and fail beside its neighbours.

describe('recordTaskUsage', () => {
  it('accumulates calls and time under the label it was given', () => {
    const before = snapshotTaskUsage();
    recordTaskUsage('extract', 100);
    recordTaskUsage('extract', 250);
    expect(new Map(taskUsageSince(before)).get('extract')).toEqual({ calls: 2, millis: 350 });
  });

  it('files an unlabelled call under "untagged" rather than dropping it', () => {
    // A call site that forgets a label still costs time, and a table that
    // silently omitted it would under-report the run it is meant to explain.
    const before = snapshotTaskUsage();
    recordTaskUsage(undefined, 40);
    expect(new Map(taskUsageSince(before)).get('untagged')).toEqual({ calls: 1, millis: 40 });
  });
});

describe('taskUsageSince', () => {
  it('reports one entry per label, slowest first', () => {
    const before = snapshotTaskUsage();
    recordTaskUsage('dedup', 300);
    recordTaskUsage('merge-body', 900);
    recordTaskUsage('page-generate', 600);
    expect(taskUsageSince(before).map(([label]) => label))
      .toEqual(['merge-body', 'page-generate', 'dedup']);
  });

  it('leaves out labels that did not move, so a run sees only its own calls', () => {
    recordTaskUsage('extract', 500);
    const before = snapshotTaskUsage();
    recordTaskUsage('dedup', 20);
    const labels = taskUsageSince(before).map(([label]) => label);
    expect(labels).toContain('dedup');
    expect(labels).not.toContain('extract');
  });

  it('subtracts rather than resets — the same baseline read twice is empty the second time', () => {
    const before = snapshotTaskUsage();
    recordTaskUsage('dedup', 10);
    const after = snapshotTaskUsage();
    expect(taskUsageSince(before).length).toBeGreaterThan(0);
    expect(taskUsageSince(after)).toEqual([]);
  });

  it('copies what it snapshots, so a later call cannot move the baseline', () => {
    // This is what makes the diff safe under overlap: run A's snapshot has to
    // survive run B recording into the same map while A is still going.
    recordTaskUsage('dedup', 100);
    const before = snapshotTaskUsage();
    const baseline = before.get('dedup')?.millis;
    recordTaskUsage('dedup', 100);
    expect(before.get('dedup')?.millis).toBe(baseline);
    expect(new Map(taskUsageSince(before)).get('dedup')).toEqual({ calls: 1, millis: 100 });
  });
});

describe('formatTaskUsage', () => {
  it('writes one line per step, seconds to one decimal', () => {
    expect(formatTaskUsage([['dedup', { calls: 41, millis: 12300 }]]))
      .toEqual(['  - dedup: 41 calls, 12.3s']);
  });

  it('counts one call in the singular', () => {
    expect(formatTaskUsage([['extract', { calls: 1, millis: 1000 }]]))
      .toEqual(['  - extract: 1 call, 1.0s']);
  });

  it('says nothing when nothing was spent', () => {
    expect(formatTaskUsage([])).toEqual([]);
  });
});
