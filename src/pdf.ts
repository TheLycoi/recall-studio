import { loadPdfJs } from "obsidian";
import type { App, TFile } from "obsidian";

/**
 * What the reader has selected in Obsidian's own PDF viewer. pdf.js renders
 * every page as div.page[data-page-number] with a .textLayer of spans, so a
 * DOM selection inside it already carries the text, the page, and the whole
 * page's text for context. No PDF parsing library is needed, which is why
 * Recall can read PDFs without the load-time hazards an earlier version of
 * this plugin had to dodge.
 */
export interface PdfSelection {
  text: string;
  page: number;
  /** Plain text of the page the selection starts on, for context. */
  pageText: string;
}

export function readPdfSelection(win: Window): PdfSelection | null {
  const sel = win.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().replace(/\s*\n\s*/g, " ").trim();
  if (!text) return null;
  const anchor = sel.anchorNode;
  const anchorEl = !anchor ? null : anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
  const pageEl = anchorEl?.closest(".page[data-page-number]") ?? null;
  if (!pageEl) return null;
  const page = Number(pageEl.getAttribute("data-page-number"));
  if (!Number.isInteger(page) || page < 1) return null;
  const layer = pageEl.querySelector(".textLayer");
  const pageText = layer ? (layer.textContent ?? "").replace(/\s+/g, " ").trim() : "";
  return { text, page, pageText };
}

export function isPdfFile(file: TFile | null | undefined): file is TFile {
  return !!file && file.extension.toLowerCase() === "pdf";
}

/** The PDFs a note's PDF++ links and embeds resolve to, distinct, in link order. */
export function pdfsLinkedFrom(app: App, note: TFile): TFile[] {
  const cache = app.metadataCache.getFileCache(note);
  const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
  const out: TFile[] = [];
  for (const r of refs) {
    const dest = app.metadataCache.getFirstLinkpathDest(r.link.split("#")[0], note.path);
    if (dest && isPdfFile(dest) && !out.includes(dest)) out.push(dest);
  }
  return out;
}

/**
 * Open a vault PDF with Obsidian's bundled pdf.js and return the
 * PDFDocumentProxy. `loadPdfJs()` is Obsidian's own accessor for the pdf.js
 * build the PDF viewer uses (obsidian.d.ts:3870, typed `Promise<any>`), and
 * `Vault.readBinary` gives the bytes (obsidian.d.ts:7426).
 *
 * The returned document holds a worker and page caches, so **callers must
 * call `doc.destroy()` in a `finally`**. Typed `any` because pdf.js ships no
 * types here; keep the untyped surface as small as possible around the call
 * site.
 */
export async function loadPdfDocument(app: App, file: TFile): Promise<any> {
  const pdfjs = await loadPdfJs();
  const data = await app.vault.readBinary(file);
  return await pdfjs.getDocument({ data }).promise;
}
