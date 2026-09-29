// llm-task-usage.ts — how much time each pipeline step spent inside the LLM.
//
// The engine already times its phases, but the largest of them — page
// generation — is one interval covering path resolution, the dedup call, page
// writes and the whole merge routing. A phase that big says an ingest was slow
// without saying which of the four to look at.
//
// The `task` label on `createMessage` names the step; this is where the time
// under each label accumulates. The wrapper writes here because it is the one
// seam every call passes through, so no call site has to remember to.
//
// Totals are cumulative for the process, and callers take a snapshot before the
// work and diff against it afterwards. That is deliberate: a reset would be
// wrong the moment two ingests overlap, and an ingest is exactly the thing that
// runs in the background while another starts.

export interface TaskUsage {
  calls: number;
  /** Wall time inside `createMessage`. Overlaps when calls run concurrently. */
  millis: number;
}

const usage = new Map<string, TaskUsage>();

export function recordTaskUsage(task: string | undefined, millis: number): void {
  const label = task ?? 'untagged';
  const entry = usage.get(label) ?? { calls: 0, millis: 0 };
  entry.calls += 1;
  entry.millis += millis;
  usage.set(label, entry);
}

export function snapshotTaskUsage(): Map<string, TaskUsage> {
  return new Map([...usage].map(([label, u]) => [label, { ...u }]));
}

/**
 * What was spent since `before`, sorted slowest first, with steps that did
 * nothing in the interval left out.
 */
export function taskUsageSince(before: Map<string, TaskUsage>): Array<[string, TaskUsage]> {
  const delta: Array<[string, TaskUsage]> = [];
  for (const [label, now] of usage) {
    const then = before.get(label) ?? { calls: 0, millis: 0 };
    const calls = now.calls - then.calls;
    if (calls > 0) delta.push([label, { calls, millis: now.millis - then.millis }]);
  }
  return delta.sort((a, b) => b[1].millis - a[1].millis);
}

/** One line per step: `dedup 41 calls 12.3s`. Empty when nothing was spent. */
export function formatTaskUsage(delta: Array<[string, TaskUsage]>): string[] {
  return delta.map(([label, u]) =>
    `  - ${label}: ${u.calls} call${u.calls === 1 ? '' : 's'}, ${(u.millis / 1000).toFixed(1)}s`);
}
