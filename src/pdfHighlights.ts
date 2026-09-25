/**
 * Collect every highlight of one lecture PDF into a manifest, and read/write
 * the manifest note.
 *
 * Two sources feed one list. Backlinking notes carry PDF++ links
 * (`[[x.pdf#page=4&selection=…]]`, `&annotation=846R`, `![[…&rect=…]]`) whose
 * quote in the callout is authoritative. The PDF itself carries embedded
 * text-markup annotations, which only pdf.js can see. Both are turned into
 * ManifestHighlight rows, merged by location (src/manifest.ts mergeHighlights),
 * and given stable ids in reading order.
 *
 * This is Obsidian-side code: it imports `obsidian` and owns the pdf.js
 * document, so it is never imported by a pure module or a test. Every pdf.js
 * shape is funnelled through `readPage` below, which hands plain data to the
 * typed, pdf.js-free functions in src/pdftext.ts.
 */
import { TFile, normalizePath } from "obsidian";
import type WikiLmPlugin from "./main";
import { loadPdfDocument } from "./pdf";
import { findPdfReferences, highlightKey, splitLinktext, type PdfReference, type PdfTarget } from "./pdflink";
import {
  MANIFEST_CONTEXT_CHARS,
  mergeHighlights,
  sortAndAssignIds,
  type Manifest,
  type ManifestHighlight,
} from "./manifest";
import {
  annotationHighlights,
  contextFor,
  hasCharGeometry,
  joinPages,
  pageText,
  selectionText,
  singleLine,
  textInRect,
  type Annot,
  type TextItem,
} from "./pdftext";
import { basenameNoExt, normalizeWs, truncateTranscript } from "./util";

/** One page's plain data, as src/pdftext.ts wants it. */
export interface PageData {
  items: TextItem[];
  annots: Annot[];
}

/**
 * The only place pdf.js shapes are touched. PDF++ reads a page the same way
 * (`Promise.all([page.getTextContent({includeChars: true}), page.getAnnotations()])`);
 * `includeChars` is what puts per-character geometry on `items[].chars`, which
 * every rect-based extraction needs. `doc`/`page` are `any` because Obsidian's
 * `loadPdfJs()` is typed `Promise<any>` (obsidian.d.ts:3870) and ships no
 * pdf.js types; nothing untyped escapes this function.
 */
async function readPage(doc: any, pageNumber: number): Promise<PageData> {
  const page = await doc.getPage(pageNumber);
  const [content, annots] = await Promise.all([
    page.getTextContent({ includeChars: true }),
    page.getAnnotations(),
  ]);
  const items: TextItem[] = Array.isArray(content?.items) ? (content.items as TextItem[]) : [];
  const list: Annot[] = Array.isArray(annots) ? (annots as Annot[]) : [];
  return { items, annots: list };
}

/** Local ISO timestamp without milliseconds or zone, e.g. "2026-09-10T15:04:00". */
function localIsoNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function kindOfTarget(t: PdfTarget): "selection" | "annotation" | "rect" {
  if (t.selection) return "selection";
  if (t.annotation !== undefined) return "annotation";
  return "rect";
}

/** A row before sortAndAssignIds gives it its id; the id field is a placeholder. */
function row(
  target: PdfTarget,
  kind: "selection" | "annotation" | "rect",
  color: string | null,
  text: string,
  page: string,
  origins: string[],
  reader?: { notes: string | null; heading: string | null },
): ManifestHighlight {
  const ctx = text ? contextFor(page, text, MANIFEST_CONTEXT_CHARS) : { before: "", after: "" };
  const row: ManifestHighlight = {
    id: "",
    key: highlightKey(target),
    page: target.page,
    kind,
    color,
    target,
    text,
    before: ctx.before,
    after: ctx.after,
    origins,
  };
  if (reader?.notes) row.notes = reader.notes;
  if (reader?.heading) row.heading = reader.heading;
  return row;
}

/** One backlinking note's references to this PDF. */
interface NoteRefs {
  path: string;
  refs: PdfReference[];
}

/**
 * Every note that links to `pdf`, with the references that actually resolve to
 * it. `resolvedLinks` (obsidian.d.ts:4438) maps source path → target path →
 * count, so the sources are the keys whose inner map holds `pdf.path`. Notes
 * inside the manifest folder are skipped: a manifest links every highlight of
 * the PDF back at it, and re-reading it would double every entry.
 */
async function backlinkingNotes(plugin: WikiLmPlugin, pdf: TFile): Promise<NoteRefs[]> {
  const resolved = plugin.app.metadataCache.resolvedLinks;
  const sourcePaths = Object.keys(resolved)
    .filter((sourcePath) => Object.prototype.hasOwnProperty.call(resolved[sourcePath] ?? {}, pdf.path))
    .filter((sourcePath) => sourcePath !== pdf.path)
    .sort();

  const out: NoteRefs[] = [];
  for (const sourcePath of sourcePaths) {
    const file = plugin.app.vault.getAbstractFileByPath(sourcePath); // obsidian.d.ts:7369
    if (!(file instanceof TFile)) continue;
    if (file.extension.toLowerCase() !== "md") continue;
    const md = await plugin.app.vault.cachedRead(file); // obsidian.d.ts:7420
    // findPdfReferences wants the name *with* .pdf (naming contract (a)).
    const all = findPdfReferences(md, pdf.name);
    // A link matching by basename may still resolve to a different file of the
    // same name elsewhere in the vault; ask Obsidian which one it means.
    const refs = all.filter((ref) => {
      const linktext = linktextOf(md, ref, pdf.name);
      if (linktext === null) return true;
      const dest = plugin.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath); // obsidian.d.ts:4411
      return dest !== null && dest.path === pdf.path;
    });
    if (refs.length) out.push({ path: sourcePath, refs });
  }
  return out;
}

/**
 * The path part of the wikilink this reference came from, for
 * getFirstLinkpathDest. PdfReference records the line it sits on but not the
 * path as written (folders may be spelled out), so re-find the link on that
 * line and return its path part. Null when it cannot be pinned down, in which
 * case the caller keeps the reference: findPdfReferences already matched the
 * basename.
 */
function linktextOf(md: string, ref: PdfReference, pdfFilename: string): string | null {
  const line = md.split("\n")[ref.line];
  if (line === undefined) return null;
  const re = /!?\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const { path, subpath } = splitLinktext(m[1]);
    if (!subpath) continue;
    const base = path.split("/").pop() ?? path;
    if (base.toLowerCase() !== pdfFilename.toLowerCase()) continue;
    return path;
  }
  return null;
}

/**
 * Class code from either vault convention: `sources/class notes/<CODE>/…` or
 * `wiki/sources/classes/<CODE>/…`.
 */
function classCodeFromPath(pdfPath: string): string {
  const m = /sources\/(?:class notes|classes)\/([^/]+)\//.exec(pdfPath);
  return m ? m[1] : "";
}

export interface CollectResult {
  manifest: Manifest;
  paperText: string;
  truncated: boolean;
  warnings: string[];
  /**
   * Per-page text items and annotations, kept only when `opts.pages` was set;
   * empty otherwise.
   */
  pages: PageData[];
}

/**
 * Read every highlight of `pdf`: the PDF++ references in notes that link to
 * it, plus the text-markup annotations embedded in the file. Opens the pdf.js
 * document exactly once and always destroys it.
 *
 * `opts.paperText` also returns the whole document's text (page-marked and
 * capped at `settings.paperTextMaxChars`), which the digest prompt needs and
 * the plain extract command does not.
 */
export async function collectPdfHighlights(
  plugin: WikiLmPlugin,
  pdf: TFile,
  opts: { paperText: boolean; pages?: boolean },
): Promise<CollectResult> {
  const warnings: string[] = [];

  // (1) Backlinking notes and their references.
  const notes = await backlinkingNotes(plugin, pdf);

  const rows: ManifestHighlight[] = [];
  let paperText = "";
  let truncated = false;
  // Hoisted so the return outside `finally` can see it. `TextItem`/`Annot` are
  // plain data already copied out of pdf.js by readPage, so keeping them
  // around after the document is destroyed in `finally` below is safe.
  let kept: PageData[] = [];

  // (2) One document, one pass over the pages.
  const doc = await loadPdfDocument(plugin.app, pdf);
  try {
    const numPages: number = Number(doc.numPages) || 0;
    const pages: PageData[] = [];
    for (let n = 1; n <= numPages; n++) {
      pages.push(await readPage(doc, n));
    }
    if (opts.pages) kept = pages;

    const pageTexts = pages.map((p) => pageText(p.items));
    const pageDataFor = (n: number): PageData | null => pages[n - 1] ?? null;
    const pageTextFor = (n: number): string => pageTexts[n - 1] ?? "";

    // Warn once when this pdf.js build gave no per-character geometry: every
    // rect-based extraction then yields empty text rather than silently
    // writing blank highlights.
    const firstWithItems = pages.find((p) => p.items.length > 0);
    if (firstWithItems && !hasCharGeometry(firstWithItems.items)) {
      warnings.push(
        "pdf.js text content has no per-character geometry; embedded annotations and rect embeds carry no text",
      );
      console.debug("WikiLM: pdf.js textContent sample", firstWithItems.items[0], firstWithItems.annots[0]);
    }

    // (3a) References from notes.
    for (const note of notes) {
      for (const ref of note.refs) {
        const target = ref.target;
        const page = pageDataFor(target.page);
        const items = page?.items ?? [];
        const kind = kindOfTarget(target);
        const color = target.color ?? ref.calloutColor ?? null;

        if (kind === "selection" && target.selection) {
          const resolved = selectionText(items, target.selection);
          const text = ref.quote ?? resolved ?? "";
          if (ref.quote && resolved && normalizeWs(ref.quote).toLowerCase() !== normalizeWs(resolved).toLowerCase()) {
            warnings.push(
              `page ${target.page}: the quote in ${note.path} differs from the text the selection resolves to; the quote was kept`,
            );
          }
          rows.push(row(target, "selection", color, text, pageTextFor(target.page), [note.path], ref));
          continue;
        }

        if (kind === "annotation") {
          let text = ref.quote ?? "";
          if (!text && page) {
            const embedded = annotationHighlights(page.items, page.annots).find((a) => a.id === target.annotation);
            text = embedded?.text ?? "";
          }
          rows.push(row(target, "annotation", color, text, pageTextFor(target.page), [note.path], ref));
          continue;
        }

        // rect: the embed carries no quote, so read the rectangle.
        const text = target.rect ? singleLine(textInRect(items, target.rect).text) : "";
        rows.push(row(target, "rect", color, text, pageTextFor(target.page), [note.path], ref));
      }
    }

    // (3b) Annotations embedded in the PDF, in the order annotationHighlights
    // returns them (PDF++ order) — sortAndAssignIds has no `top` input and
    // relies on that order for annotations (plan decision (c)).
    for (let n = 1; n <= numPages; n++) {
      const page = pages[n - 1];
      if (!page) continue;
      for (const a of annotationHighlights(page.items, page.annots)) {
        // Annotation targets never carry `color` (plan decision (b)): the
        // colour lives in the callout header and the manifest `color::` field.
        const target: PdfTarget = { page: n, annotation: a.id };
        rows.push(row(target, "annotation", a.color, a.text, pageTextFor(n), ["pdf annotation"]));
      }
    }

    // (5) The paper's text, page-marked and capped.
    if (opts.paperText) {
      const joined = joinPages(pageTexts);
      const cut = truncateTranscript(joined, plugin.settings.paperTextMaxChars);
      paperText = cut.text;
      truncated = cut.truncated;
    }
  } finally {
    if (typeof doc?.destroy === "function") {
      try {
        await doc.destroy();
      } catch {
        // A failed teardown must not lose the highlights we just read.
      }
    }
  }

  // (4) Merge by location, then assign reading-order ids.
  const highlights = sortAndAssignIds(mergeHighlights(rows));

  const classCode =
    classCodeFromPath(pdf.path) ||
    (notes.length ? (frontmatterClasses(plugin, notes[0].path)[0] ?? "") : "") ||
    "";

  const manifest: Manifest = {
    pdfPath: pdf.path,
    // Naming contract (a): pdfBasename is without ".pdf".
    pdfBasename: basenameNoExt(pdf.name),
    classCode,
    extracted: localIsoNow(),
    sources: notes.map((n) => n.path).sort(),
    highlights,
  };

  return { manifest, paperText, truncated, warnings, pages: opts.pages ? kept : [] };
}

/**
 * Every code in a note's `class:` frontmatter, in order; empty when it has
 * none.
 *
 * A list, not a string: the digest writes `class: [HBIO408, PHED163]` on a
 * page it merges across classes (src/topicNote.ts `addClassCode`), and a
 * reader of that key that only understood a scalar saw such a page as having
 * no class at all — which quietly dropped it out of the suggester's writable
 * set and out of the manifest's class code.
 */
export function frontmatterClasses(plugin: WikiLmPlugin, path: string): string[] {
  const file = plugin.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return [];
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter; // obsidian.d.ts:4417, :1446
  const value = fm?.class;
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim())
    : typeof value === "string"
      ? [value.trim()]
      : [];
}
