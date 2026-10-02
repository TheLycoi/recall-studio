import { Editor, MarkdownView, Notice, TFile } from "obsidian";
import type WikiLmPlugin from "./main";
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
  newId,
  normalizeWs,
  splitFrontmatter,
} from "./util";
import { describeError } from "./llm";
import type { Manifest, ManifestHighlight } from "./manifest";
import { renderRowInstruction } from "./topicNote";
import { renderPdfSubpath } from "./pdflink";
import { missTitle, renderMissInstruction, type QuizMiss } from "./quiz";
import { buildAskRow, resolveUnitSource, type UnitSource } from "./askCapture";
import type { EvidenceUnit } from "./retrieval";

function stripMarks(s: string): string {
  return s.replace(/==/g, "");
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

function announce(plugin: WikiLmPlugin, h: Highlight, opts: CaptureOptions): void {
  plugin.store.add(h);
  plugin.generator.enqueue(h);
  const what = opts.gesture ? "highlighted and sent to inbox" : "sent to inbox";
  new Notice(`WikiLM: ${what}${opts.instruction ? " with instructions" : ""}.`);
  if (plugin.settings.openInboxOnCapture) void plugin.openInbox();
}

/** Capture the editor selection (or, outside highlighter mode, the current paragraph) into the inbox. */
export async function captureSelection(
  plugin: WikiLmPlugin,
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
      new Notice("WikiLM: select some text first.");
      return null;
    }
    from = p.from;
    to = p.to;
    sel = editor.getRange(from, to);
  }
  const text = stripMarks(sel).trim();
  if (text.length < 3) {
    if (!opts.gesture) new Notice("WikiLM: selection is too short.");
    return null;
  }
  if (plugin.store.hasDuplicate(file.path, normalizeWs(text))) {
    if (!opts.gesture) new Notice("WikiLM: that highlight is already in the inbox.");
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
    heading: headingAbove(full, start),
    instruction,
    origin: opts.gesture ? "highlighter" : "selection",
  });

  // Mark the span in the note so the reader can see what has been sent.
  // Already-marked spans are left alone: re-dragging one must never produce ====text====.
  const mode = plugin.settings.markMode;
  if (mode !== "none" && canWrapAsHighlight(sel)) {
    let replacement = `==${sel}==`;
    if (mode === "highlight+block") {
      const lastLine = editor.getLine(to.line);
      const hasBlockId = /\^[A-Za-z0-9-]+\s*$/.test(lastLine);
      if (!hasBlockId) {
        h.blockId = `wikilm-${newId()}`;
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
export async function captureMarkdownHighlights(plugin: WikiLmPlugin, file: TFile, instruction = ""): Promise<number> {
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
      ? "WikiLM: no ==highlights== found in this note."
      : `WikiLM: queued ${added} highlight${added === 1 ? "" : "s"}${spans.length - added ? ` (${spans.length - added} already in inbox)` : ""}.`,
  );
  return added;
}

interface LocatedSpan {
  start: number;
  end: number;
  title?: string;
}

/**
 * Turn located character spans of a note's body into highlights: build the
 * records, mark the spans in the file (last to first so offsets stay valid),
 * and queue card writing. Shared by AI highlighting and reading-view capture.
 */
async function captureSpans(
  plugin: WikiLmPlugin,
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
        heading: headingAbove(body, l.start),
        title: l.title ?? "",
        instruction,
        origin,
      }),
    });
  }

  const mode = plugin.settings.markMode;
  if (mode !== "none" && created.length) {
    let edited = body;
    for (const { h, span: l } of [...created].reverse()) {
      const span = body.slice(l.start, l.end);
      if (!canWrapAsHighlight(span)) continue;
      let rep = `==${span}==`;
      let end = l.end;
      if (mode === "highlight+block") {
        const lineEnd = body.indexOf("\n", l.end);
        const eol = lineEnd === -1 ? body.length : lineEnd;
        const tail = body.slice(l.end, eol);
        if (!/\^[A-Za-z0-9-]+\s*$/.test(tail)) {
          h.blockId = `wikilm-${newId()}`;
          rep = rep + tail + ` ^${h.blockId}`;
          end = eol;
        }
      }
      edited = edited.slice(0, l.start) + rep + edited.slice(end);
    }
    if (edited !== body) await plugin.app.vault.modify(file, raw.slice(0, offset) + edited);
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
  plugin: WikiLmPlugin,
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
    new Notice("WikiLM: could not find that selection in the note's markdown.");
    return null;
  }
  if (plugin.store.hasDuplicate(file.path, normalizeWs(stripMarks(body.slice(loc.start, loc.end))))) {
    if (!opts.gesture) new Notice("WikiLM: that highlight is already in the inbox.");
    return null;
  }
  const { created } = await captureSpans(plugin, file, raw, [loc], opts.gesture ? "highlighter" : "selection", opts.instruction ?? "");
  sel?.removeAllRanges();
  if (!created.length) return null;
  new Notice(`WikiLM: ${opts.gesture ? "highlighted and " : ""}sent to inbox.`);
  if (plugin.settings.openInboxOnCapture) void plugin.openInbox();
  return created[0];
}

/** A selection in Obsidian's PDF viewer becomes a highlight with a page number. */
export function capturePdfSelection(
  plugin: WikiLmPlugin,
  file: TFile,
  sel: PdfSelection,
  opts: CaptureOptions = {},
): Highlight | null {
  const text = sel.text.trim();
  if (text.length < 3) return null;
  if (plugin.store.hasDuplicate(file.path, normalizeWs(text))) {
    if (!opts.gesture) new Notice("WikiLM: that highlight is already in the inbox.");
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
    heading: `page ${sel.page}`,
    instruction: opts.instruction ?? "",
    origin: "pdf",
  });
  announce(plugin, h, opts);
  return h;
}

/**
 * "highlight" operation: let the model choose spans, verify each one is really
 * in the note, mark it, and queue card writing. Fire-and-forget.
 */
export function aiHighlightNote(plugin: WikiLmPlugin, file: TFile, instruction = ""): void {
  const transcript = plugin.store.getTranscript(file.path)?.text ?? null;
  new Notice(transcript !== null ? "WikiLM: choosing highlights from the transcript in the background…" : "WikiLM: choosing highlights in the background…");
  void (async () => {
    try {
      const raw = await plugin.app.vault.read(file);
      const { body } = splitFrontmatter(raw);
      if (body.trim().length < 40) {
        new Notice("WikiLM: note is too short to highlight.");
        return;
      }
      const picks = await plugin.llm.highlight(basenameNoExt(file.path), body, instruction, transcript);
      const located: LocatedSpan[] = [];
      let missed = 0;
      for (const p of picks) {
        const loc = locateQuote(body, p.quote);
        if (!loc) {
          missed++;
          continue;
        }
        if (located.some((l) => loc.start < l.end && loc.end > l.start)) continue;
        located.push({ ...loc, title: p.title });
      }
      const { created, skipped } = await captureSpans(plugin, file, raw, located, "ai", instruction);
      const bits = [`${created.length} highlight${created.length === 1 ? "" : "s"} queued`];
      if (skipped) bits.push(`${skipped} already in inbox`);
      if (missed) bits.push(`${missed} could not be located`);
      new Notice(`WikiLM: ${bits.join(", ")}.`);
    } catch (e) {
      console.error("WikiLM: AI highlight failed", e);
      new Notice(`WikiLM: highlighting failed. ${describeError(e)}`);
    }
  })();
}

/**
 * Queue every manifest highlight as an inbox highlight, so the 0.4.0 writer /
 * critique / linter chain turns it into cards. This is the "flashcards" and
 * "both" product of a digest run: the same shape `capturePdfSelection` (:276)
 * builds for a live PDF selection, with the manifest's own context and the
 * PDF++ subpath so the inbox's source link opens the exact highlight
 * (`src/inboxView.ts` `openSource`).
 */
export function captureManifestHighlights(
  plugin: WikiLmPlugin,
  manifest: Manifest,
  items: ManifestHighlight[],
  noteTitle: string,
  topicPath: string | null,
): { added: number; skipped: number } {
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    const text = item.text.trim();
    // A row a page of the class already states is knowledge the reader has
    // on a page already, and a card for it would be a near-twin of one they
    // may hold; the planner flagged it, and it is not carded here.
    if (text.length < 3 || item.covered) {
      skipped++;
      continue;
    }
    if (plugin.store.hasDuplicate(manifest.pdfPath, normalizeWs(text))) {
      skipped++;
      continue;
    }
    const h = makeHighlight({
      sourcePath: manifest.pdfPath,
      sourceTitle: basenameNoExt(manifest.pdfPath),
      text,
      before: item.before,
      after: item.after,
      line: 0,
      page: item.page,
      heading: `page ${item.page}`,
      title: noteTitle,
      subpath: renderPdfSubpath(item.target),
      topicPath: topicPath ?? undefined,
      origin: "pdf",
      // A row the digest wrote carries its passage and label: the card is a
      // view of the note, so the writer is told what the page says about this
      // highlight (src/topicNote.ts renderRowInstruction). A raw manifest row
      // — the flashcards-only product — carries nothing extra.
      instruction: item.verbatim !== undefined || item.passage ? renderRowInstruction(item, noteTitle) : "",
    });
    plugin.store.add(h);
    plugin.generator.enqueue(h);
    added++;
  }
  new Notice(`WikiLM: ${added} highlight${added === 1 ? "" : "s"} queued as flashcards${skipped ? `, ${skipped} skipped` : ""}.`);
  return { added, skipped };
}

/**
 * Where a row built from one evidence unit points: the PDF++ selection when
 * the unit's PDF resolves from its note, the note otherwise
 * (src/askCapture.ts resolveUnitSource). Shared by quiz misses and Ask answers.
 */
function pdfSourceFor(plugin: WikiLmPlugin, unit: EvidenceUnit): UnitSource {
  return resolveUnitSource(unit, (pdfBasename, notePath) => pdfDest(plugin, pdfBasename, notePath));
}

function pdfDest(plugin: WikiLmPlugin, pdfBasename: string, notePath: string): { path: string } | null {
  return plugin.app.metadataCache.getFirstLinkpathDest(`${pdfBasename}.pdf`, notePath);
}

/**
 * Queue the passages a quiz found the reader did not know as inbox highlights,
 * so the writer / critique / linter chain turns each into a card. The missed
 * question rides along as the highlight's title and as the writer's
 * per-highlight instruction (src/quiz.ts renderMissInstruction), so the card
 * tests the fact the reader missed rather than whichever fact in the passage
 * the writer would have chosen on its own. A PDF-backed unit resolves back to
 * the PDF file (so the inbox opens the exact PDF++ highlight, as
 * `captureManifestHighlights` does above); otherwise the note itself is the
 * source.
 *
 * Shows no Notice: the caller reports the result once. When nothing was
 * added, `reason` says why. `skipped` counts every miss not queued;
 * `duplicates` is the part of it already in the inbox (the rest were too
 * short), so a caller can treat "all already there" as sent.
 */
export function captureQuizMisses(
  plugin: WikiLmPlugin,
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
    // The quiz row does not set `topicPath` (it never has), so that field of the lookup is dropped.
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

/**
 * Queue a chat answer as one inbox highlight: the answer itself, with the
 * passages it rested on under it, so the card writer works from the whole
 * answer and not from one passage at a time (by design).
 * The question is the item's title and, with what each source contributed,
 * the writer's instruction. The row is built by `buildAskRow`
 * (src/askCapture.ts): the source is the first passage's PDF page when it has
 * one, else its note; a general-knowledge answer links `fallbackSourcePath`
 * and says in its instruction that it is unverified.
 *
 * Shows no Notice: the caller reports the result once.
 */
export function captureAskAnswer(
  plugin: WikiLmPlugin,
  args: {
    question: string;
    answer: string;
    cited: Array<{ unit: EvidenceUnit; why: string }>;
    generalKnowledge: boolean;
    fallbackSourcePath?: string;
  },
): { status: "added" | "duplicate" | "skipped"; reason?: string } {
  const row = buildAskRow({ ...args, resolvePdf: (pdfBasename, notePath) => pdfDest(plugin, pdfBasename, notePath) });
  if ("reason" in row) return { status: "skipped", reason: row.reason };
  if (plugin.store.hasDuplicate(row.sourcePath, normalizeWs(row.text))) {
    return { status: "duplicate", reason: "this answer is already in the inbox." };
  }
  const h = makeHighlight({
    sourcePath: row.sourcePath,
    sourceTitle: basenameNoExt(row.sourcePath),
    text: row.text,
    before: "",
    after: "",
    line: row.line,
    page: row.page,
    heading: row.heading,
    title: row.title,
    instruction: row.instruction,
    subpath: row.subpath,
    topicPath: row.topicPath,
    origin: "ask",
  });
  plugin.store.add(h);
  plugin.generator.enqueue(h);
  return { status: "added" };
}
