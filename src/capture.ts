import { Editor, MarkdownView, Notice, TFile } from "obsidian";
import type RecallPlugin from "./main";
import { makeHighlight, type Highlight } from "./model";
import type { PdfSelection } from "./pdf";
import {
  basenameNoExt,
  canWrapAsHighlight,
  contextWindow,
  findMarkdownHighlights,
  headingAbove,
  lineOf,
  locateQuote,
  markQuotes,
  newId,
  normalizeWs,
  splitFrontmatter,
} from "./util";
import { missTitle, renderMissInstruction, type QuizMiss } from "./quiz";
import { resolveUnitSource, type UnitSource } from "./unitSource";
import type { EvidenceUnit } from "./pageIndex";
import { mayMark } from "./paths";

function stripMarks(s: string): string {
  return s.replace(/==/g, "");
}

/** Keep the source body, not frontmatter; long notes use a selection-centered window. */
function noteContext(raw: string, start: number, end: number): Highlight["noteContext"] {
  const { body, offset } = splitFrontmatter(raw);
  const limit = 24000;
  const center = Math.max(0, (start + end) / 2 - offset);
  const from = Math.max(0, Math.min(body.length - limit, Math.floor(center - limit / 2)));
  return { text: body.slice(from, from + limit), truncated: body.length > limit };
}

export interface CaptureOptions {
  /** Free-text instruction for the card writer. */
  instruction?: string;
  /** Set by highlighter mode: never fall back to the paragraph, and stay quiet on duplicates. */
  gesture?: boolean;
}

/** The paragraph containing the cursor, when nothing is selected. */
function paragraphAt(editor: Editor): { from: { line: number; ch: number }; to: { line: number; ch: number } } | null {
  const cur = editor.getCursor();
  const count = editor.lineCount();
  if (!editor.getLine(cur.line).trim()) return null;
  let a = cur.line;
  while (a > 0 && editor.getLine(a - 1).trim()) a--;
  let b = cur.line;
  while (b < count - 1 && editor.getLine(b + 1).trim()) b++;
  return { from: { line: a, ch: 0 }, to: { line: b, ch: editor.getLine(b).length } };
}

function announce(plugin: RecallPlugin, h: Highlight, opts: CaptureOptions): void {
  plugin.store.add(h);
  plugin.generator.enqueue(h);
  const what = opts.gesture ? "highlighted and sent to inbox" : "sent to inbox";
  new Notice(`Recall Studio: ${what}${opts.instruction ? " with instructions" : ""}.`);
  if (plugin.settings.openInboxOnCapture) void plugin.openInbox();
}

/** Capture the editor selection (or, outside highlighter mode, the current paragraph) into the inbox. */
export async function captureSelection(
  plugin: RecallPlugin,
  editor: Editor,
  file: TFile,
  instructionOrOpts: string | CaptureOptions = "",
): Promise<Highlight | null> {
  const opts: CaptureOptions = typeof instructionOrOpts === "string" ? { instruction: instructionOrOpts } : instructionOrOpts;
  const instruction = opts.instruction ?? "";
  let sel = editor.getSelection();
  let from = editor.getCursor("from");
  let to = editor.getCursor("to");
  if (!sel.trim()) {
    if (opts.gesture) return null;
    const p = paragraphAt(editor);
    if (!p) {
      new Notice("Recall Studio: select some text first.");
      return null;
    }
    from = p.from;
    to = p.to;
    sel = editor.getRange(from, to);
  }
  const text = stripMarks(sel).trim();
  if (text.length < 3) {
    if (!opts.gesture) new Notice("Recall Studio: selection is too short.");
    return null;
  }
  if (plugin.store.hasDuplicate(file.path, normalizeWs(text))) {
    if (!opts.gesture) new Notice("Recall Studio: that highlight is already in the inbox.");
    return null;
  }

  const full = editor.getValue();
  const start = editor.posToOffset(from);
  const end = editor.posToOffset(to);
  const ctx = contextWindow(full, start, end, plugin.settings.contextChars);

  const h = makeHighlight({
    sourcePath: file.path,
    sourceTitle: basenameNoExt(file.path),
    text,
    before: stripMarks(ctx.before),
    after: stripMarks(ctx.after),
    line: from.line,
    noteContext: noteContext(full, start, end),
    heading: headingAbove(full, start),
    instruction,
    origin: opts.gesture ? "highlighter" : "selection",
  });

  // Mark the span in the note so the reader can see what has been sent.
  // Already-marked spans are left alone: re-dragging one must never produce ====text====.
  const mode = plugin.settings.markMode;
  if (mode !== "none" && mayMark(file.path, plugin.settings.topicFolder) && canWrapAsHighlight(sel)) {
    let replacement = `==${sel}==`;
    if (mode === "highlight+block") {
      const lastLine = editor.getLine(to.line);
      const hasBlockId = /\^[A-Za-z0-9-]+\s*$/.test(lastLine);
      if (!hasBlockId) {
        h.blockId = `recall-${newId()}`;
        const tail = lastLine.slice(to.ch);
        replacement = replacement + tail + ` ^${h.blockId}`;
        to = { line: to.line, ch: lastLine.length };
      } else {
        h.blockId = lastLine.match(/\^([A-Za-z0-9-]+)\s*$/)?.[1] ?? null;
      }
    }
    editor.replaceRange(replacement, from, to);
  } else if (mode === "highlight+block") {
    const lastLine = editor.getLine(to.line);
    h.blockId = lastLine.match(/\^([A-Za-z0-9-]+)\s*$/)?.[1] ?? null;
  }
  // Collapse the selection. Load-bearing for highlighter mode: a selection
  // left standing would be seen again by the next mouseup anywhere.
  if (opts.gesture) editor.setCursor(editor.getCursor("to"));

  announce(plugin, h, opts);
  return h;
}

/** Sweep a note for ==highlights== and queue every new one. */
export async function captureMarkdownHighlights(plugin: RecallPlugin, file: TFile, instruction = ""): Promise<number> {
  const raw = await plugin.app.vault.read(file);
  const { body, offset } = splitFrontmatter(raw);
  const spans = findMarkdownHighlights(body);
  let added = 0;
  for (const sp of spans) {
    const text = sp.text;
    if (plugin.store.hasDuplicate(file.path, normalizeWs(text))) continue;
    const ctx = contextWindow(body, sp.start, sp.end, plugin.settings.contextChars);
    const h = makeHighlight({
      sourcePath: file.path,
      sourceTitle: basenameNoExt(file.path),
      text,
      before: stripMarks(ctx.before),
      after: stripMarks(ctx.after),
      line: lineOf(raw, offset + sp.start),
      noteContext: noteContext(raw, offset + sp.start, offset + sp.end),
      heading: headingAbove(body, sp.start),
      instruction,
      origin: "markdown-highlight",
    });
    plugin.store.add(h);
    plugin.generator.enqueue(h);
    added++;
  }
  new Notice(
    spans.length === 0
      ? "Recall Studio: no ==highlights== found in this note."
      : `Recall Studio: queued ${added} highlight${added === 1 ? "" : "s"}${spans.length - added ? ` (${spans.length - added} already in inbox)` : ""}.`,
  );
  return added;
}

interface LocatedSpan {
  start: number;
  end: number;
}

/**
 * Turn located character spans of a note's body into highlights: build the
 * records, mark the spans in the live note text (src/util.ts markQuotes), and
 * queue card writing. Used by reading-view capture.
 */
async function captureSpans(
  plugin: RecallPlugin,
  file: TFile,
  raw: string,
  spans: LocatedSpan[],
  origin: Highlight["origin"],
  instruction: string,
): Promise<{ created: Highlight[]; skipped: number }> {
  const { body, offset } = splitFrontmatter(raw);
  const located = [...spans].sort((a, b) => a.start - b.start);
  const created: Array<{ h: Highlight; span: LocatedSpan }> = [];
  let skipped = 0;
  for (const l of located) {
    const text = stripMarks(body.slice(l.start, l.end)).trim();
    if (text.length < 3) continue;
    if (plugin.store.hasDuplicate(file.path, normalizeWs(text))) {
      skipped++;
      continue;
    }
    const ctx = contextWindow(body, l.start, l.end, plugin.settings.contextChars);
    created.push({
      span: l,
      h: makeHighlight({
        sourcePath: file.path,
        sourceTitle: basenameNoExt(file.path),
        text,
        before: stripMarks(ctx.before),
        after: stripMarks(ctx.after),
        line: lineOf(raw, offset + l.start),
        noteContext: noteContext(raw, offset + l.start, offset + l.end),
        heading: headingAbove(body, l.start),
        instruction,
        origin,
      }),
    });
  }

  // Marked in the live text, so anything the reader typed since the note was
  // read survives. Each quote is found again in that text; one no longer there
  // stays unmarked.
  const mode = plugin.settings.markMode;
  if (mode !== "none" && mayMark(file.path, plugin.settings.topicFolder) && created.length) {
    const quotes = created.map(({ span: l }) => ({ text: body.slice(l.start, l.end), start: l.start, end: l.end }));
    let blockIds = new Map<number, string>();
    await plugin.app.vault.process(file, (data) => {
      const marked = markQuotes(data, quotes, mode);
      blockIds = marked.blockIds;
      return marked.text;
    });
    created.forEach(({ h }, i) => {
      const id = blockIds.get(i);
      if (id) h.blockId = id;
    });
  }

  for (const { h } of created) {
    plugin.store.add(h);
    plugin.generator.enqueue(h);
  }
  return { created: created.map((c) => c.h), skipped };
}

/**
 * Highlighter mode in reading view: the selection lives in the rendered DOM,
 * not in an editor, so the text is located in the note body and marked there.
 */
export async function captureReadingSelection(
  plugin: RecallPlugin,
  view: MarkdownView,
  win: Window,
  opts: CaptureOptions & {
    /**
     * The selection, read before a modal opened. Asking for an instruction
     * focuses a text box, which takes the page's selection with it, so the
     * "with instructions" command reads it first and passes it here.
     */
    text?: string;
  } = {},
): Promise<Highlight | null> {
  const file = view.file;
  if (!file) return null;
  const sel = win.getSelection();
  const text = opts.text ?? (sel && !sel.isCollapsed ? sel.toString().trim() : "");
  if (!text) return null;
  const raw = await plugin.app.vault.read(file);
  const { body } = splitFrontmatter(raw);
  const loc = locateQuote(body, text);
  if (!loc) {
    new Notice("Recall Studio: could not find that selection in the note's markdown.");
    return null;
  }
  if (plugin.store.hasDuplicate(file.path, normalizeWs(stripMarks(body.slice(loc.start, loc.end))))) {
    if (!opts.gesture) new Notice("Recall Studio: that highlight is already in the inbox.");
    return null;
  }
  const { created } = await captureSpans(plugin, file, raw, [loc], opts.gesture ? "highlighter" : "selection", opts.instruction ?? "");
  sel?.removeAllRanges();
  if (!created.length) return null;
  new Notice(`Recall Studio: ${opts.gesture ? "highlighted and " : ""}sent to inbox.`);
  if (plugin.settings.openInboxOnCapture) void plugin.openInbox();
  return created[0];
}

/** A selection in Obsidian's PDF viewer becomes a highlight with a page number. */
export function capturePdfSelection(
  plugin: RecallPlugin,
  file: TFile,
  sel: PdfSelection,
  opts: CaptureOptions = {},
): Highlight | null {
  const text = sel.text.trim();
  if (text.length < 3) return null;
  if (plugin.store.hasDuplicate(file.path, normalizeWs(text))) {
    if (!opts.gesture) new Notice("Recall Studio: that highlight is already in the inbox.");
    return null;
  }
  let before = "";
  let after = "";
  if (sel.pageText) {
    const loc = locateQuote(sel.pageText, text);
    if (loc) {
      const ctx = contextWindow(sel.pageText, loc.start, loc.end, plugin.settings.contextChars);
      before = ctx.before;
      after = ctx.after;
    }
  }
  const h = makeHighlight({
    sourcePath: file.path,
    sourceTitle: basenameNoExt(file.path),
    text,
    before,
    after,
    line: 0,
    page: sel.page,
    noteContext: sel.pageText ? noteContext(sel.pageText, locateQuote(sel.pageText, text)?.start ?? 0, locateQuote(sel.pageText, text)?.end ?? 0) : undefined,
    heading: `page ${sel.page}`,
    instruction: opts.instruction ?? "",
    origin: "pdf",
  });
  announce(plugin, h, opts);
  return h;
}

/**
 * Where a row built from one evidence unit points: the PDF++ selection when
 * the unit's PDF resolves from its page, the page otherwise
 * (src/unitSource.ts resolveUnitSource).
 */
function pdfSourceFor(plugin: RecallPlugin, unit: EvidenceUnit): UnitSource {
  return resolveUnitSource(unit, (pdfBasename, notePath) => pdfDest(plugin, pdfBasename, notePath));
}

function pdfDest(plugin: RecallPlugin, pdfBasename: string, notePath: string): { path: string } | null {
  return plugin.app.metadataCache.getFirstLinkpathDest(`${pdfBasename}.pdf`, notePath);
}

/**
 * Queue the passages a quiz found the reader did not know as inbox highlights,
 * so the writer / critique / linter chain turns each into a card. The missed
 * question rides along as the highlight's title and as the writer's
 * per-highlight instruction (src/quiz.ts renderMissInstruction), so the card
 * tests the fact the reader missed rather than whichever fact in the passage
 * the writer would have chosen on its own. A PDF-backed unit resolves back to
 * the PDF file, so the inbox opens the exact PDF++ highlight. Otherwise the
 * wiki page itself is the source.
 *
 * Shows no Notice: the caller reports the result once. When nothing was
 * added, `reason` says why. `skipped` counts every miss not queued;
 * `duplicates` is the part of it already in the inbox (the rest were too
 * short), so a caller can treat "all already there" as sent.
 */
export function captureQuizMisses(
  plugin: RecallPlugin,
  misses: QuizMiss[],
): { added: number; skipped: number; duplicates: number; reason?: string } {
  let added = 0;
  let skipped = 0;
  let duplicates = 0;
  for (const miss of misses) {
    const unit = miss.unit;
    const text = unit.text.trim();
    if (text.length < 3) {
      skipped++;
      continue;
    }
    const { sourcePath, page, heading, subpath } = pdfSourceFor(plugin, unit);
    if (plugin.store.hasDuplicate(sourcePath, normalizeWs(text))) {
      skipped++;
      duplicates++;
      continue;
    }
    const h = makeHighlight({
      sourcePath,
      sourceTitle: basenameNoExt(sourcePath),
      text,
      before: "",
      after: "",
      line: 0,
      page,
      heading,
      title: missTitle(miss),
      instruction: renderMissInstruction(miss),
      subpath,
      origin: "quiz",
    });
    plugin.store.add(h);
    plugin.generator.enqueue(h);
    added++;
  }
  if (added > 0) return { added, skipped, duplicates };
  const reason =
    skipped === 0
      ? "nothing to send."
      : duplicates === skipped
        ? "already in the inbox."
        : duplicates === 0
          ? "too short to card."
          : `${duplicates} already in the inbox, ${skipped - duplicates} too short to card.`;
  return { added, skipped, duplicates, reason };
}
