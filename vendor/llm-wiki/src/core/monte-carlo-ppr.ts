// monte-carlo-ppr.ts — Monte Carlo Personalized PageRank (Fogaras 2005)
//
// Pure function for the v1.23.0 Graph Engine (#198 consensus 2026-06-24).
// Replaces power-iteration for query-time PageRank because Monte Carlo's
// K×L cost is independent of |V|: a 2000-page vault costs the same per
// query as a 200-page vault (per @DocTpoint on #198 Q4/Q5).
//
// Algorithm:
// For each of `numWalks` walks:
//   1. Start at `seed`.
//   2. At each step, with probability `damping` teleport back to seed;
//      otherwise pick a random outgoing edge uniformly and follow it.
//   3. Continue for `maxSteps` steps.
// Aggregate visit counts, normalize to probabilities.
//
// Edge case: a seed node with no outgoing edges always teleports back
// to itself, so all probability stays on the seed (verified in tests).
//
// Why not seedable RNG in the public API: tests inject a PRNG via
// `options.rng` for determinism. Production calls omit it; the default
// uses Math.random (acceptable for non-deterministic ranking — top-k
// is robust to sampling noise per #198 consensus).

export interface Graph {
  nodes: string[];
  edges: Map<string, string[]>;
}

export interface PPROptions {
  numWalks?: number;
  maxSteps?: number;
  damping?: number;
  rng?: () => number;
}

const DEFAULT_NUM_WALKS = 3000;
const DEFAULT_MAX_STEPS = 50;
const DEFAULT_DAMPING = 0.05;

export function personalizedPageRank(
  graph: Graph,
  seed: string,
  options: PPROptions = {},
): Map<string, number> {
  // Validate graph contains the seed. PPR is undefined for a missing seed.
  if (!graph.nodes.includes(seed)) {
    return new Map();
  }

  const numWalks = options.numWalks ?? DEFAULT_NUM_WALKS;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const damping = options.damping ?? DEFAULT_DAMPING;
  const rng = options.rng ?? Math.random;

  // Pre-cache outgoing edges. Map.get on undefined returns undefined;
  // we treat that as "no outgoing edges" (the seed teleports back to
  // itself every step, retaining all probability on the seed).
  const visitCounts = new Map<string, number>();
  visitCounts.set(seed, numWalks); // every walk starts at seed

  for (let walk = 0; walk < numWalks; walk++) {
    let current = seed;
    for (let step = 0; step < maxSteps; step++) {
      // With probability `damping`, teleport back to seed.
      if (rng() < damping) {
        current = seed;
        visitCounts.set(current, (visitCounts.get(current) ?? 0) + 1);
        continue;
      }
      // Otherwise follow a random outgoing edge.
      const outgoing = graph.edges.get(current);
      if (!outgoing || outgoing.length === 0) {
        // Dead end. Per the standard PPR formulation, treat as teleport
        // back to seed (this is the Haveliwala 2002 "dead-end" rule —
        // prevents walks from getting stuck on nodes without out-edges).
        current = seed;
        visitCounts.set(current, (visitCounts.get(current) ?? 0) + 1);
        continue;
      }
      const next = outgoing[Math.floor(rng() * outgoing.length)];
      current = next;
      visitCounts.set(current, (visitCounts.get(current) ?? 0) + 1);
    }
  }

  // Normalize: total visits across all walks (numWalks * (maxSteps + 1)
  // start counts + per-step visits, but we only track what we record).
  // Sum of visitCounts is the total recorded visits. Probabilities are
  // each node's count / total.
  let total = 0;
  for (const count of visitCounts.values()) total += count;

  const result = new Map<string, number>();
  if (total === 0) return result;
  for (const [node, count] of visitCounts) {
    result.set(node, count / total);
  }
  return result;
}