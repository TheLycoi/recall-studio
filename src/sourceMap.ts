// Offset-preserving view of a markdown source, so a quote a model proposes can
// be checked against the real text and placed in the document. The markdown
// analogue of src/pageMap.ts: where that module segments a PDF page's text
// items and can invert an offset back to a `selection=` subpath, this one
// segments a note by heading and paragraph and inverts an offset back to the
// segment, heading and line it fell in.
//
// The asymmetry is deliberate and is the "best-effort" half of the anchoring
// decision. A PDF span round-trips through `selectionText`, so a PDF++ link
// reopens the exact selection; markdown has no such oracle, so a markdown
// quote is cited by note and heading and re-located on open by `locateQuote`.
// A passage-level markdown anchor would be a promise this code cannot keep.
//
// No `obsidian` import (see src/pageMap.ts:1-8): bundled standalone and
// exercised with node --test (test/sourceMap.test.mjs).
import { locateQuote, normalizeWs, splitFrontmatter } from "./util";

/**
 * One addressable chunk of a markdown note: a paragraph, list block, or fenced
 * code block, together with the heading trail it sits under.
 *
 * `start`/`end` are offsets into the ORIGINAL file text, frontmatter included,
 * so a segment offset is directly usable against the bytes on disk. `line` is
 * 1-based and counted the same way, which is what an editor jump expects.
 */
export interface Segment {
  /** Offset of the segment's first character in the original file text. */
  start: number;
  /** Offset one past the segment's last character. */
  end: number;
  /** 1-based line number of the segment's first line in the original file. */
  line: number;
  /** The segment's own text, exactly as it appears between start and end. */
  text: string;
  /** Nearest heading above the segment, "" when it sits before any heading. */
  heading: string;
  /**
   * The full heading trail, outermost first — ["Methods", "Sampling"] for a
   * paragraph under `## Methods` then `### Sampling`. Empty before any heading.
   * A trail beats a bare heading for citation because "Sampling" alone repeats
   * across notes.
   */
  trail: string[];
  /** True for a fenced code block: quotable text, but never prose. */
  code: boolean;
}

/**
 * A note's segments plus the body text they were cut from.
 *
 * `body` is the note without frontmatter and `bodyOffset` is where it starts,
 * so `body.slice(s.start - bodyOffset, s.end - bodyOffset)` is `s.text`.
 */
export interface SourceMap {
  body: string;
  bodyOffset: number;
  segments: Segment[];
}

/** `## Heading` — captures the level and the text, ignoring trailing hashes. */
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
/** ``` or ~~~ with an optional info string. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Cut a markdown note into segments.
 *
 * Blank lines separate segments, headings never join one, and a fenced block is
 * one segment however many blank lines it contains — a blank line inside a
 * fence is content, not a separator. Frontmatter is skipped but its length is
 * carried in every offset, so offsets address the original file.
 */
export function buildSourceMap(md: string): SourceMap {
  const text = md ?? "";
  const { body, offset: bodyOffset } = splitFrontmatter(text);

  const segments: Segment[] = [];
  const trail: string[] = [];
  /** Heading level of each entry in `trail`, so a deeper heading knows what to pop. */
  const levels: number[] = [];
  const lines = body.split("\n");

  // Line starts as offsets into `body`, so a segment's offset is one lookup.
  const lineStart: number[] = new Array(lines.length);
  {
    let at = 0;
    for (let i = 0; i < lines.length; i++) {
      lineStart[i] = at;
      at += lines[i].length + 1; // +1 for the "\n" split consumed
    }
  }

  // Line index of the frontmatter's end, so `line` counts from the file's top
  // rather than the body's.
  const frontLines = bodyOffset === 0 ? 0 : text.slice(0, bodyOffset).split("\n").length - 1;

  let i = 0;
  let fence: string | null = null;
  let startLine = -1;

  const flush = (endLine: number, code: boolean) => {
    if (startLine < 0) return;
    const from = lineStart[startLine];
    // `endLine` is inclusive; trim the trailing newline the split removed.
    const to = lineStart[endLine] + lines[endLine].length;
    const raw = body.slice(from, to);
    if (raw.trim().length > 0) {
      segments.push({
        start: from + bodyOffset,
        end: to + bodyOffset,
        line: frontLines + startLine + 1,
        text: raw,
        heading: trail.length > 0 ? trail[trail.length - 1] : "",
        trail: trail.slice(),
        code,
      });
    }
    startLine = -1;
  };

  while (i < lines.length) {
    const line = lines[i];

    if (fence !== null) {
      // Inside a fence: only the closing marker ends the segment.
      const m = FENCE.exec(line);
      if (m && m[1].startsWith(fence[0]) && m[1].length >= fence.length) {
        flush(i, true);
        fence = null;
      }
      i++;
      continue;
    }

    const fenceOpen = FENCE.exec(line);
    if (fenceOpen) {
      flush(i - 1, false);
      fence = fenceOpen[1];
      startLine = i;
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush(i - 1, false);
      const level = heading[1].length;
      // Pop every heading at or below this level, then push it: `### B` under
      // `## A` gives ["A", "B"], and a following `## C` replaces both with
      // ["C"]. Levels are tracked alongside the text rather than used as array
      // indices, so an h3 with no h2 above it yields ["B"] and not ["", "B"] —
      // a hole would render as a stray separator in a citation.
      while (levels.length > 0 && levels[levels.length - 1] >= level) {
        levels.pop();
        trail.pop();
      }
      levels.push(level);
      trail.push(heading[2]);
      i++;
      continue;
    }

    if (line.trim().length === 0) {
      flush(i - 1, false);
      i++;
      continue;
    }

    if (startLine < 0) startLine = i;
    i++;
  }

  // An unterminated fence still yields its segment: the text is real even
  // though the author forgot to close it.
  flush(lines.length - 1, fence !== null);

  return { body, bodyOffset, segments };
}

/**
 * Where a quote sits in the note, or null when it is not there.
 *
 * Exact `indexOf` first, then `locateQuote`'s whitespace- and
 * markdown-insensitive match. A fuzzy hit is accepted only when the matched
 * text really is the quote modulo whitespace and case — the same guard
 * `locateInPage` (src/pageMap.ts:71-91) applies, and for the same reason: a
 * wrong anchor is worse than none.
 */
export function locateInSource(map: SourceMap, quote: string): { start: number; end: number } | null {
  const q = (quote ?? "").trim();
  if (!q) return null;

  const exact = map.body.indexOf(q);
  if (exact >= 0) return { start: exact + map.bodyOffset, end: exact + q.length + map.bodyOffset };

  const hit = locateQuote(map.body, q);
  if (!hit) return null;
  if (hit.end <= hit.start || hit.end > map.body.length) return null;
  if (!hit.exact) {
    // The fuzzy match can stop just short of the quote's closing punctuation,
    // so compare with trailing punctuation trimmed from both sides. Anything
    // looser would let a match span text that is not the quote, which is the
    // one failure worth refusing (see src/pageMap.ts:71-91).
    const got = trimEnd(normalizeWs(map.body.slice(hit.start, hit.end)).toLowerCase());
    if (got !== trimEnd(normalizeWs(q).toLowerCase())) return null;
  }
  return { start: hit.start + map.bodyOffset, end: hit.end + map.bodyOffset };
}

/** Drop trailing sentence punctuation, for comparing a match against its quote. */
function trimEnd(s: string): string {
  return s.replace(/[\s.,;:!?"'\u2019\u201d)\]]+$/u, "");
}

/** The segment containing `offset`, or null when it falls between segments. */
export function segmentAt(map: SourceMap, offset: number): Segment | null {
  let lo = 0;
  let hi = map.segments.length - 1;
  let found: Segment | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = map.segments[mid];
    if (s.start <= offset) {
      found = s;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found && offset < found.end ? found : null;
}

/**
 * A located markdown quote: enough to cite it and to find it again later.
 *
 * `before`/`after` are the neighbouring text `locateQuote` uses to re-find the
 * quote when the note has been edited under it, the same way the inbox
 * re-locates a highlight. There is no selection range here by design.
 */
export interface SourceAnchor {
  quote: string;
  start: number;
  end: number;
  line: number;
  heading: string;
  trail: string[];
  before: string;
  after: string;
}

/** How much neighbouring text an anchor carries on each side. */
export const ANCHOR_CONTEXT_CHARS = 60;

/**
 * Anchor a quote to the note, or null when it is not verbatim-locatable.
 *
 * This is markdown's answer to `selectionFor` (src/pageMap.ts:139-159) and
 * carries the same invariant: a quote the model made up returns null and never
 * becomes a highlight. What differs is the address it returns — a segment and
 * a line rather than a selection, because that is what markdown can honour.
 */
export function anchorQuote(map: SourceMap, quote: string): SourceAnchor | null {
  const span = locateInSource(map, quote);
  if (!span) return null;
  const seg = segmentAt(map, span.start);
  const bodyStart = span.start - map.bodyOffset;
  const bodyEnd = span.end - map.bodyOffset;
  return {
    quote: map.body.slice(bodyStart, bodyEnd),
    start: span.start,
    end: span.end,
    line: seg?.line ?? lineOf(map, bodyStart),
    heading: seg?.heading ?? "",
    trail: seg?.trail ?? [],
    before: map.body.slice(Math.max(0, bodyStart - ANCHOR_CONTEXT_CHARS), bodyStart),
    after: map.body.slice(bodyEnd, Math.min(map.body.length, bodyEnd + ANCHOR_CONTEXT_CHARS)),
  };
}

/**
 * 1-based line of a body offset, counted from the top of the file.
 *
 * Only reached for a quote that landed between segments (in the blank space a
 * segment boundary sits on), where there is no segment line to borrow.
 */
function lineOf(map: SourceMap, bodyOffset: number): number {
  const frontLines = map.bodyOffset === 0 ? 0 : countLines(map, bodyOffset);
  const upto = map.body.slice(0, Math.max(0, bodyOffset));
  return frontLines + upto.split("\n").length;
}

/** Lines of frontmatter above the body, derived from the first segment. */
function countLines(map: SourceMap, _bodyOffset: number): number {
  const first = map.segments[0];
  if (!first) return 0;
  const bodyLinesBefore = map.body.slice(0, first.start - map.bodyOffset).split("\n").length - 1;
  return Math.max(0, first.line - 1 - bodyLinesBefore);
}

/**
 * Batch segments into groups of at most `perBatch` characters, so a long note
 * is sent to the model in pieces the way `batchPages` (src/suggestPlan.ts:17)
 * splits a PDF. A segment longer than the budget is its own batch rather than
 * being cut: cutting mid-paragraph would hand the model a truncated sentence
 * and invite a quote that spans the cut and can never be located.
 */
export function batchSegments(segments: Segment[], perBatch: number): Segment[][] {
  const budget = Number.isFinite(perBatch) && perBatch >= 1 ? Math.floor(perBatch) : 1;
  const out: Segment[][] = [];
  let cur: Segment[] = [];
  let size = 0;
  for (const s of segments) {
    const len = s.text.length;
    if (cur.length > 0 && size + len > budget) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(s);
    size += len;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * The batch as the model sees it: each segment under its heading trail, with a
 * `[s N]` marker so a proposed span can name where it came from. The markdown
 * analogue of the `[page N]` markers the PDF path uses.
 */
export function renderBatch(segments: Segment[], indexOf: (s: Segment) => number): string {
  const parts: string[] = [];
  let lastTrail = "";
  for (const s of segments) {
    const trail = s.trail.filter((t) => t.length > 0).join(" › ");
    if (trail && trail !== lastTrail) parts.push(`\n## ${trail}`);
    lastTrail = trail;
    parts.push(`[s ${indexOf(s)}]\n${s.text}`);
  }
  return parts.join("\n\n").trim();
}

/**
 * A span the model proposed and this module verified against the real note.
 *
 * The markdown counterpart of `VerifiedSpan` (src/suggestPlan.ts:28). It
 * carries an anchor rather than a `PdfTarget`: there is no selection to
 * reproduce, so what it records is where the quote sits and enough
 * surrounding text to find it again after an edit.
 */
export interface VerifiedMarkdownSpan {
  /** 1-based index of the segment the model cited, as the `[s N]` marker. */
  segment: number;
  quote: string;
  label: string;
  noteTitle: string;
  noteKind: "concept" | "entity";
  anchor: SourceAnchor;
  /** Stable identity: the note path plus the quote's offsets. */
  key: string;
}

export interface VerifyMarkdownOptions {
  /** Most spans to accept from any one segment. */
  perSegment: number;
  /** Cap across the whole run, counted down by the caller. */
  remaining: number;
  /** Keys already held, so a re-run does not duplicate what it wrote before. */
  existingKeys: Set<string>;
  /** The batch's segment indices, so a span citing outside it is refused. */
  batch: number[];
}

export interface VerifyMarkdownResult {
  spans: VerifiedMarkdownSpan[];
  dropped: { outOfBatch: number; unlocated: number; duplicate: number; overCap: number };
}

/** A span's identity: which note, and exactly where in it. */
export function markdownSpanKey(notePath: string, start: number, end: number): string {
  return `${notePath}#${start}-${end}`;
}

/** Do two spans cover any of the same characters? */
function overlapsSpan(a: SourceAnchor, b: SourceAnchor): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Keep only the spans that survive every check, in the order the model gave
 * them: inside the batch, verbatim-locatable in the note, not a quote already
 * held, not overlapping one already accepted, and within both caps.
 *
 * This is markdown's `verifySpans` (src/suggestPlan.ts:72) and enforces the
 * same invariant for the same reason: the model's output is never trusted for
 * anchoring. A quote it invented, or subtly reworded, fails `anchorQuote` and
 * is dropped rather than written to a note with a citation that would not
 * survive being clicked.
 *
 * Order matters — an earlier span wins the note against a later one that
 * overlaps it, so the model's own ranking decides ties.
 */
export function verifyMarkdownSpans(
  spans: Array<{ page?: number; segment?: number; quote?: string; label?: string; note_title?: string; note_kind?: "concept" | "entity" }>,
  map: SourceMap,
  notePath: string,
  opts: VerifyMarkdownOptions,
): VerifyMarkdownResult {
  const out: VerifiedMarkdownSpan[] = [];
  const dropped = { outOfBatch: 0, unlocated: 0, duplicate: 0, overCap: 0 };
  const acceptedKeys = new Set<string>();
  const bySegment = new Map<number, VerifiedMarkdownSpan[]>();
  const inBatch = new Set(opts.batch);

  for (const s of spans ?? []) {
    // The model is prompted with `[s N]` markers, but the shared span schema
    // names the field `page`; accept either so one schema serves both paths.
    const seg = s.segment ?? s.page;
    if (!Number.isInteger(seg) || !inBatch.has(seg as number)) {
      dropped.outOfBatch++;
      continue;
    }

    const anchor = anchorQuote(map, s.quote ?? "");
    if (!anchor) {
      dropped.unlocated++;
      continue;
    }

    const key = markdownSpanKey(notePath, anchor.start, anchor.end);
    if (opts.existingKeys.has(key) || acceptedKeys.has(key)) {
      dropped.duplicate++;
      continue;
    }

    const onSeg = bySegment.get(seg as number) ?? [];
    if (onSeg.some((prev) => overlapsSpan(prev.anchor, anchor))) {
      dropped.duplicate++;
      continue;
    }

    if (onSeg.length >= opts.perSegment || out.length >= opts.remaining) {
      dropped.overCap++;
      continue;
    }

    const span: VerifiedMarkdownSpan = {
      segment: seg as number,
      quote: anchor.quote,
      label: s.label ?? "",
      noteTitle: s.note_title ?? "",
      noteKind: s.note_kind ?? "concept",
      anchor,
      key,
    };
    out.push(span);
    acceptedKeys.add(key);
    onSeg.push(span);
    bySegment.set(seg as number, onSeg);
  }

  return { spans: out, dropped };
}

/**
 * How a verified markdown span is cited in a wiki page.
 *
 * `- "quote" — [[note#heading|Note › Heading]]`, or `[[note|Note]]` when the
 * quote sits above any heading. A heading is the finest address markdown can
 * honour: Obsidian resolves `#heading` on open, whereas a character offset
 * would silently point at the wrong text the first time the note is edited.
 */
export function renderMarkdownMention(span: VerifiedMarkdownSpan, notePath: string, noteTitle: string): string {
  const heading = span.anchor.trail.filter((t) => t.length > 0).join(" › ");
  const link = heading ? `[[${notePath}#${span.anchor.trail[span.anchor.trail.length - 1]}|${noteTitle} › ${heading}]]` : `[[${notePath}|${noteTitle}]]`;
  return `- "${span.quote.replace(/\s+/g, " ").trim()}" — ${link}`;
}
