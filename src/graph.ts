/**
 * The note graph and Personalized PageRank over it.
 *
 * Lexical search only finds a note that uses the question's words. A note the
 * reader would call obviously related — linked from the one that matched, in
 * the same corner of the wiki — is invisible to it. This walks the wikilinks
 * between topic notes so those neighbours can be found too.
 *
 * Adapted from gd4ai/obsidian-llm-wiki (`src/core/build-graph.ts` and
 * `src/core/monte-carlo-ppr.ts`, Apache-2.0). Monte Carlo rather than power
 * iteration for the reason given there: the cost is walks x steps, which does
 * not grow with the vault, so a wiki of 2,000 notes costs what 20 costs.
 *
 * Pure: no `obsidian` import, so `test/graph.test.mjs` can bundle it.
 */

/** Nodes are note paths; `edges` maps a note to the notes it links to. */
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

const DEFAULT_NUM_WALKS = 800;
const DEFAULT_MAX_STEPS = 12;
const DEFAULT_DAMPING = 0.15;

/**
 * A wikilink to another note: `[[path]]`, `[[path|display]]`, `[[path#section]]`.
 *
 * Embeds (`![[...]]`) are excluded by the caller rather than here, because an
 * embedded PDF page is a source, not a link to a sibling note.
 */
const WIKI_LINK_RE = /(!)?\[\[([^\]|#]+?)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Files that are sources rather than notes; a link to one is not a graph edge. */
const NON_NOTE = /\.(pdf|m4a|mp3|mp4|png|jpe?g|gif|webp|svg|canvas)$/i;

/**
 * Build the graph from note bodies.
 *
 * Links are resolved the way Obsidian resolves them: an exact path first, then
 * the basename, so `[[Pharmacokinetics]]` written in a note reaches
 * `wiki/concepts/Pharmacokinetics.md` without the writer typing the folder.
 * A link to a note that does not exist yet is dropped — it is a link to
 * nothing, and a node with no content cannot be evidence.
 */
/**
 * Every note link in a body, in order.
 *
 * `embed` marks `![[...]]`: a transclusion of a PDF page or image, which is a
 * source rather than a link to a sibling note. Links to non-note files are
 * dropped outright — neither the graph nor the lint has anything to say about
 * a link to a PDF.
 *
 * The one place wikilinks are read. `buildGraph` walks them and
 * `src/vaultLint.ts` checks them, and they must agree about what a link is or
 * the lint would report dead links the graph happily traverses.
 */
export function noteLinks(content: string): Array<{ raw: string; embed: boolean }> {
  const out: Array<{ raw: string; embed: boolean }> = [];
  WIKI_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKI_LINK_RE.exec(content)) !== null) {
    const raw = m[2].trim();
    if (!raw || NON_NOTE.test(raw)) continue;
    out.push({ raw, embed: !!m[1] });
  }
  return out;
}

/**
 * A link target reduced to the key every resolver matches on.
 *
 * Basename, no `.md`, lowercased — and slugified: runs of anything that is
 * not a letter or a digit become one hyphen, trimmed at the ends. The wiki's
 * pages are slugs on disk (`model-context-protocol.md`) while its links are
 * written in prose (`[[concepts/Model Context Protocol]]`); before this fold
 * the two never met, and 196 of the vault's 226 "dead" links were this bug.
 * Letters outside ASCII are kept, so a title with an accent still resolves
 * to the file named after it.
 */
export function linkKey(raw: string): string {
  const base = (raw.split("/").pop() ?? raw).replace(/\.md$/i, "").toLowerCase();
  return base.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

/**
 * Build the graph from note bodies.
 *
 * Links are resolved the way Obsidian resolves them: an exact path first, then
 * the basename, so `[[Pharmacokinetics]]` written in a note reaches
 * `wiki/concepts/Pharmacokinetics.md` without the writer typing the folder.
 * A link to a note that does not exist yet is dropped — it is a link to
 * nothing, and a node with no content cannot be evidence.
 */
export function buildGraph(pages: Array<{ path: string; content: string }>): Graph {
  const nodes = pages.map((p) => p.path);
  const edges = new Map<string, string[]>();
  for (const path of nodes) edges.set(path, []);

  const known = new Set(nodes);
  const byBasename = new Map<string, string>();
  for (const p of nodes) {
    // First writer wins, so a duplicate title cannot silently retarget links.
    if (!byBasename.has(linkKey(p))) byBasename.set(linkKey(p), p);
  }

  for (const page of pages) {
    const seen = new Set<string>();
    const out = edges.get(page.path);
    if (!out) continue;

    for (const { raw, embed } of noteLinks(page.content)) {
      if (embed) continue;
      const withMd = raw.toLowerCase().endsWith(".md") ? raw : `${raw}.md`;
      const target = known.has(raw) ? raw : known.has(withMd) ? withMd : byBasename.get(linkKey(raw));
      if (!target || target === page.path || seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
  }

  return { nodes, edges };
}

/**
 * Personalized PageRank from one seed, by random walk (Fogaras 2005).
 *
 * Each walk starts at the seed and follows a random link; with probability
 * `damping` — and at any dead end — it teleports back. The share of visits a
 * note collects is how reachable it is *from the seed*, which is the quantity
 * "related to the note that matched" actually means.
 */
export function personalizedPageRank(graph: Graph, seed: string, options: PPROptions = {}): Map<string, number> {
  if (!graph.edges.has(seed)) return new Map();

  const numWalks = options.numWalks ?? DEFAULT_NUM_WALKS;
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
  const damping = options.damping ?? DEFAULT_DAMPING;
  const rng = options.rng ?? Math.random;

  const visits = new Map<string, number>();
  visits.set(seed, numWalks);

  for (let w = 0; w < numWalks; w++) {
    let current = seed;
    for (let s = 0; s < maxSteps; s++) {
      const outgoing = graph.edges.get(current);
      // Teleport on the damping draw, and at a dead end (Haveliwala 2002).
      if (rng() < damping || !outgoing || outgoing.length === 0) {
        current = seed;
      } else {
        current = outgoing[Math.floor(rng() * outgoing.length)];
      }
      visits.set(current, (visits.get(current) ?? 0) + 1);
    }
  }

  let total = 0;
  for (const c of visits.values()) total += c;
  const out = new Map<string, number>();
  if (total === 0) return out;
  for (const [node, c] of visits) out.set(node, c / total);
  return out;
}

/**
 * PPR from several seeds at once, keeping each note's best score.
 *
 * Max rather than sum, as upstream: a note strongly reachable from one seed
 * should not be beaten by one weakly reachable from three.
 */
export function pprFromSeeds(graph: Graph, seeds: string[], options: PPROptions = {}): Map<string, number> {
  const merged = new Map<string, number>();
  for (const seed of seeds) {
    for (const [node, score] of personalizedPageRank(graph, seed, options)) {
      if (score > (merged.get(node) ?? 0)) merged.set(node, score);
    }
  }
  return merged;
}

/**
 * Whether the graph has enough links to be worth walking.
 *
 * A wiki that is mostly unlinked notes gives PPR nothing to do: every walk
 * dead-ends at its seed, and the result is the seed back again dressed as
 * discovery. The gate is deliberately low — this vault is being built up, and
 * the point is for expansion to switch itself on as the links accumulate,
 * without anyone editing a setting.
 */
export function isGraphUsable(graph: Graph, minEdges = 8): boolean {
  if (graph.nodes.length < 4) return false;
  let edgeCount = 0;
  for (const targets of graph.edges.values()) edgeCount += targets.length;
  return edgeCount >= minEdges;
}
