export interface SrRecognitionSettings {
  srRecognitionEnabled: boolean;
  srRecognitionTags: string;
  srRecognitionNotePaths: string;
  srSingleLineSeparator: string;
  srSingleLineReversedSeparator: string;
  srMultilineSeparator: string;
  srMultilineReversedSeparator: string;
  srMultilineEndMarker: string;
  srHighlightCloze: boolean;
}

/** Reference syntax defaults, not detected or effective settings of another plugin. */
export const SR_RECOGNITION_DEFAULTS: SrRecognitionSettings = {
  srRecognitionEnabled: false, srRecognitionTags: "", srRecognitionNotePaths: "",
  srSingleLineSeparator: "::", srSingleLineReversedSeparator: ":::",
  srMultilineSeparator: "?", srMultilineReversedSeparator: "??", srMultilineEndMarker: "",
  srHighlightCloze: true,
};
export type SrCard = { kind: "basic" | "reversed" | "multiline-basic" | "multiline-reversed" | "cloze"; start: number; end: number; text: string; line: number };

type Line = { text: string; start: number; line: number; blocked: boolean };

/** Exclusions keep original offsets and never join across hidden source text. */
function sourceLines(raw: string): Line[] {
  let start = 0, frontmatter = /^(?:\uFEFF)?---\r?\n/.test(raw), fence = "", comment = "", metadata = false;
  return raw.split("\n").map((value, i) => {
    let text = value.replace(/\r$/, ""), blocked = false;
    if (frontmatter) {
      blocked = true;
      if (i > 0 && /^(---|\.\.\.)\s*$/.test(text)) frontmatter = false;
    } else if (fence) {
      blocked = true;
      const close = text.match(/^ {0,3}(`{3,}|~{3,})\s*$/)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = "";
    } else {
      metadata = /^ {0,3}> ?\[!sr\|card-metadata\]/.test(text) || (metadata && /^ {0,3}>/.test(text));
      const open = !comment ? text.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] : null;
      if (metadata && !comment) blocked = true;
      else if (open) { fence = open; blocked = true; }
      else if (!comment && /^\t|^ {4}/.test(text)) blocked = true;
      else {
        const original = text;
        let cursor = 0;
        blocked = !!comment;
        while (cursor < original.length) {
          if (comment) {
            const end = original.indexOf(comment, cursor);
            if (end < 0) break;
            cursor = end + comment.length;
            comment = "";
          } else {
            const html = original.indexOf("<!--", cursor), obsidian = original.indexOf("%%", cursor);
            if (html < 0 && obsidian < 0) break;
            const isHtml = html >= 0 && (obsidian < 0 || html < obsidian);
            const at = isHtml ? html : obsidian;
            // Scheduling bytes are not card content or imported state.
            if (isHtml && original.startsWith("<!--SR:", at)) text = text.slice(0, at).trimEnd();
            else blocked = true;
            comment = isHtml ? "-->" : "%%";
            cursor = at + (isHtml ? 4 : 2);
          }
        }
      }
    }
    const result = { text, start, line: i + 1, blocked };
    start += value.length + 1;
    return result;
  });
}

// Adapted from src/parser.ts, obsidian-spaced-repetition, commit
// 3d5079f3bcd54531b084040d1c0178f15f681510. MIT, (c) 2021 - 2024 Stephen Mwangi.
// Keep upstream first-marker/backtick behavior and longest-separator-first precedence.
function hasMarker(text: string, marker: string): boolean {
  if (!marker) return false;
  const at = text.indexOf(marker);
  if (at < 0) return false;
  // Deliberately stricter than upstream for multi-backtick code spans.
  for (const code of text.matchAll(/(`+)[\s\S]*?\1/g)) {
    if (at >= code.index! && at < code.index! + code[0].length) return false;
  }
  const before = text.slice(0, at).split("`").length - 1;
  const after = text.slice(at + marker.length).split("`").length - 1;
  return !(before % 2 === 1 && after % 2 === 1);
}

export function recognizeSrCards(raw: string, path: string, settings: Partial<SrRecognitionSettings>): SrCard[] {
  const s = { ...SR_RECOGNITION_DEFAULTS, ...settings };
  // shortcut: notes over 1,048,576 characters are not scanned; add incremental parsing if needed.
  if (raw.length > 1_048_576 || s.srRecognitionEnabled !== true || !/\.md$/i.test(path) || path.split("/").some(p => !p || p.startsWith("."))) return [];
  if (Object.keys(SR_RECOGNITION_DEFAULTS).some(key => typeof s[key as keyof SrRecognitionSettings] !== typeof SR_RECOGNITION_DEFAULTS[key as keyof SrRecognitionSettings])) return [];
  const lines = sourceLines(raw);
  const tags = s.srRecognitionTags.split(/\s+/).filter(tag => /^#[\p{L}\p{N}_/-]+$/u.test(tag));
  const paths = s.srRecognitionNotePaths.split(/\r?\n/).map(p => p.trim()).filter(Boolean);
  const tagged = lines.some(l => !l.blocked && l.text.trim().split(/\s+/).some(t => tags.some(tag => t === tag || t.startsWith(`${tag}/`))) && !l.text.includes("`"));
  if (!paths.includes(path) && !tagged) return [];
  const separators: { separator: string; kind: SrCard["kind"] }[] = [
    { separator: s.srSingleLineSeparator, kind: "basic" },
    { separator: s.srSingleLineReversedSeparator, kind: "reversed" },
  ];
  separators.sort((a, b) => b.separator.length - a.separator.length);
  const cards: SrCard[] = [];
  let block: Line[] = [], kind: SrCard["kind"] | null = null, divider = -1;
  const add = (type: SrCard["kind"], first: Line, last: Line) => {
    const end = last.start + last.text.trimEnd().length;
    if (raw.slice(first.start, end).includes("<!--SR:")) return; // Never expose embedded scheduling bytes as card content.
    cards.push({ kind: type, start: first.start, end, text: raw.slice(first.start, end), line: first.line });
  };
  const flush = () => {
    const content = block.filter(l => l.text.trim());
    if (kind && content.length && (kind === "cloze" || (divider > 0 && block.slice(divider + 1).some(l => l.text.trim())))) add(kind, content[0], content[content.length - 1]);
    block = []; kind = null; divider = -1;
  };
  // Upstream paragraphs accumulate until a blank line/end marker. Inline cards
  // take precedence over multiline and cloze, then reset the paragraph buffer.
  for (const line of lines) {
    if (line.blocked) { block = []; kind = null; divider = -1; continue; }
    const trimmed = line.text.trim();
    if ((s.srMultilineEndMarker && trimmed === s.srMultilineEndMarker) || (!trimmed && (!s.srMultilineEndMarker || !kind))) { flush(); continue; }
    const inline = separators.find(({ separator }) => hasMarker(line.text, separator));
    if (inline) {
      const at = line.text.indexOf(inline.separator);
      if (line.text.slice(0, at).trim() && line.text.slice(at + inline.separator.length).trim()) add(inline.kind, line, line);
      block = []; kind = null; divider = -1;
      continue;
    }
    block.push(line);
    if (trimmed && (trimmed === s.srMultilineSeparator || trimmed === s.srMultilineReversedSeparator)) {
      if (block.slice(0, -1).some(l => l.text.trim())) {
        kind = trimmed === s.srMultilineSeparator ? "multiline-basic" : "multiline-reversed";
        divider = block.length - 1;
      }
    } else if (!kind && s.srHighlightCloze && !line.text.includes(";;") && /==[^=\n]+==/.test(line.text) && hasMarker(line.text, "==")) kind = "cloze";
  }
  flush();
  return cards;
}
