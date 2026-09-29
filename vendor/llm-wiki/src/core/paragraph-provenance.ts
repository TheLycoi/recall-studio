import { preserveExistingSections, reassertH1, sectionIdentityKey } from './section-header-canonicalizer';
import { turkishCaseFold } from './slug';

// Paragraph-level provenance guard — a paragraph another source footnoted may
// not vanish from a rewrite this source runs. Pure, no LLM, O(paragraphs²).
//
// Multi-source pages accumulate paragraphs that end in an inline footnote
// naming the source they came from — `^[Quelle: [[Berberin]]]`, `^[Source:
// [[Berberin]]]`, any label, the wikilink is what carries the attribution.
// The merge and related-page paths hand the whole body to the model with
// "keep existing content" and adopt its rewrite. The section guard
// (`preserveExistingSections`) catches a section that collapsed by an order
// of magnitude; one paragraph of five going missing passes under it, and
// measured on a rebuilt vault that is the shape the loss takes — most often
// in a rewrite that a DIFFERENT source triggered, and more often still the
// paragraph survives but its footnote is stripped.
//
// Ownership, not size, is the variable: a paragraph footnoted to X may only
// disappear when X itself is the source being merged (its facts are being
// rewritten by the note that stated them). Every other footnoted paragraph is
// matched into the same section of the rewrite by word overlap; one that is
// not found is put back where it stood — after the nearest preceding
// paragraph that did survive — and one that is found without its footnote
// gets the footnote re-attached. Unfootnoted prose stays the model's call;
// the section-shrink floor remains the only guard for it.

/**
 * An inline footnote that carries a wikilink: `^[<label>: [[X]]]`, alias and
 * folder tolerated. Label-agnostic on purpose — the vault's config decides how
 * the marker is worded, the guard only needs the link.
 */
const SOURCE_FOOTNOTE = /\^\[[^[\]\n]*\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\][^[\]\n]*\]/g;
/** A footnoted paragraph is "still there" when this fraction of its words appears in one paragraph of its section in the rewrite. Below it, the paragraph is restored. */
export const PARAGRAPH_KEEP_OVERLAP = 0.5;
/** Paragraphs with fewer distinct words than this are never guarded — too short for overlap to mean anything. */
const MIN_GUARDED_WORDS = 4;
// ES6 target: `\p{…}` needs the constructor form, the literal is rejected.
const WORD = new RegExp('[\\p{L}\\p{N}]+', 'gu');
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const HEADER = /^##\s+(.+?)\s*$/;

interface Unit {
  /** Canonical section identity (label + suffix) the unit sits in. */
  section: string;
  /** Index of the unit's last line in the body's line array. */
  end: number;
  text: string;
  /** Footnote source keys (folded basenames) → the verbatim footnote that carried each. */
  sources: Map<string, string>;
  words: Set<string>;
}

interface Layout {
  units: Unit[];
  /** Section identity → index of its header line (first occurrence). */
  headers: Map<string, number>;
}

/** `entities/Berberin` / `Berberin.md` / `berberin` all name the same source — the same fold the alias layer uses. */
function sourceKey(name: string): string {
  const base = name.trim().split('/').pop() ?? '';
  return turkishCaseFold(base.replace(/\.md$/i, '').trim().normalize('NFC'));
}

function footnotesOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(SOURCE_FOOTNOTE)) {
    const key = sourceKey(m[1]);
    if (key && !out.has(key)) out.set(key, m[0]);
  }
  return out;
}

function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  for (const m of text.replace(SOURCE_FOOTNOTE, '').normalize('NFC').matchAll(WORD)) {
    words.add(m[0].toLowerCase());
  }
  return words;
}

function pushTo<K>(map: Map<K, string[]>, key: K, value: string): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Split a body into guardable units: a paragraph is a run of non-blank lines,
 * except that every list item is a unit of its own (footnotes sit on single
 * bullets as often as on prose). Only lines inside a canonical `##` section
 * count — the lead, foreign sections and the Mentions section (quotes carry
 * their own provenance) are outside this guard's contract.
 */
function layoutOf(lines: string[], canonicalLabels: string[], mentionsLabel: string): Layout {
  const units: Unit[] = [];
  const headers = new Map<string, number>();
  let section: string | null = null;
  let start = -1;
  const flush = (end: number) => {
    const from = start;
    start = -1;
    if (section === null || from < 0) return;
    const text = lines.slice(from, end + 1).join('\n').trim();
    if (text) units.push({ section, end, text, sources: footnotesOf(text), words: wordsOf(text) });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = HEADER.exec(line);
    if (header) {
      flush(i - 1);
      const key = sectionIdentityKey(header[1], canonicalLabels);
      section = key !== null && key !== mentionsLabel ? key : null;
      if (section !== null && !headers.has(section)) headers.set(section, i);
      continue;
    }
    if (!line.trim() || line.startsWith('#')) {
      flush(i - 1);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush(i - 1);
      start = i;
      continue;
    }
    if (start < 0) start = i;
  }
  flush(lines.length - 1);
  return { units, headers };
}

/** Fraction of `a` found in `b` — containment, not Jaccard: a paragraph the rewrite grew is still the same paragraph. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / a.size;
}

/**
 * Re-assert the footnoted paragraphs a body rewrite lost.
 *
 * `existingBody` is the page before the rewrite, `rewrite` the model's reply
 * after `preserveExistingSections` — every section that carried content is
 * present, which is what lets a lost paragraph always find its section —
 * and `currentSource` the basename of the note whose merge produced it.
 * Returns `rewrite` itself when there is nothing to do.
 */
export function preserveSourcedParagraphs(
  existingBody: string,
  rewrite: string,
  currentSource: string,
  canonicalLabels: string[],
  mentionsLabel: string,
): string {
  if (existingBody.search(SOURCE_FOOTNOTE) === -1) return rewrite;
  const old = layoutOf(existingBody.split('\n'), canonicalLabels, mentionsLabel).units;
  const guarded = (u: Unit) => u.sources.size > 0 && u.words.size >= MIN_GUARDED_WORDS;
  if (!old.some(guarded)) return rewrite;

  const lines = rewrite.split('\n');
  const { units, headers } = layoutOf(lines, canonicalLabels, mentionsLabel);
  const own = sourceKey(currentSource);
  // old unit index → the unit of the rewrite it survived as (every old unit is
  // matched, footnoted or not: the unfootnoted ones anchor where a lost
  // paragraph is put back)
  const survived = new Map<number, Unit>();
  // line index → footnotes to append there
  const reattach = new Map<number, string[]>();
  // line index → paragraphs to put back after that line, in old order
  const insertAfter = new Map<number, string[]>();
  let reattached = 0;
  let restored = 0;

  old.forEach((o, i) => {
    let best: Unit | null = null;
    let bestScore = 0;
    for (const u of units) {
      if (u.section !== o.section) continue;
      const s = overlap(o.words, u.words);
      if (s > bestScore) { bestScore = s; best = u; }
    }
    const isSurvived = best !== null && bestScore >= PARAGRAPH_KEEP_OVERLAP;
    if (isSurvived) survived.set(i, best as Unit);
    if (!guarded(o)) return;
    if (isSurvived) {
      // The paragraph survived, possibly reworded — make sure its attribution did too.
      for (const [key, footnote] of o.sources) {
        if ((best as Unit).sources.has(key)) continue;
        (best as Unit).sources.set(key, footnote); // a second old paragraph fused into the same one must not re-add it
        pushTo(reattach, (best as Unit).end, footnote);
        reattached++;
      }
      return;
    }
    // Gone. The note that stated it may rewrite it; anyone else may not.
    if (Array.from(o.sources.keys()).every(key => key === own)) return;
    for (let j = i - 1; j >= 0 && old[j].section === o.section; j--) {
      const anchor = survived.get(j);
      if (anchor) {
        pushTo(insertAfter, anchor.end, o.text);
        restored++;
        return;
      }
    }
    const header = headers.get(o.section);
    if (header === undefined) {
      console.warn(`[preserveSourcedParagraphs] section "${o.section}" is absent from the rewrite — run after preserveExistingSections; paragraph not restored`);
      return;
    }
    pushTo(insertAfter, header, o.text);
    restored++;
  });

  if (reattached === 0 && restored === 0) return rewrite;

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const footnotes = reattach.get(i);
    out.push(footnotes ? `${lines[i].replace(/\s+$/, '')} ${footnotes.join(' ')}` : lines[i]);
    for (const text of insertAfter.get(i) ?? []) {
      // A bullet rejoins its list; prose gets its own block, opening the
      // section directly under the header the way the template writes it.
      if (LIST_ITEM.test(text)) out.push(text);
      else if (HEADER.test(lines[i])) out.push(text, '');
      else out.push('', text, '');
    }
  }
  console.warn(
    `[preserveSourcedParagraphs] rewrite from "${currentSource}": restored ${restored} paragraph(s) footnoted to other sources, re-attached ${reattached} footnote(s)`,
  );
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * The deterministic layers a body rewrite passes through before it is
 * adopted, in the one order they compose: sections the model dropped or
 * collapsed come back (#618), then the footnoted paragraphs a kept section
 * lost, then the page's own H1 (#419). Both rewrite paths call this.
 */
export function guardBodyRewrite(
  existingBody: string,
  rewrite: string,
  currentSource: string,
  canonicalLabels: string[],
  mentionsLabel: string,
): string {
  const sectioned = preserveExistingSections(existingBody, rewrite, canonicalLabels, mentionsLabel);
  const sourced = preserveSourcedParagraphs(existingBody, sectioned, currentSource, canonicalLabels, mentionsLabel);
  return reassertH1(existingBody, sourced);
}
