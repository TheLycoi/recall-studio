import { loadPdfJs } from "obsidian";

export const PDF_GUIDE_MAX_BYTES = 20 * 1024 * 1024;
export const PDF_GUIDE_MAX_PAGES = 200;

export class StudyGuidePdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudyGuidePdfError";
  }
}

const UNREADABLE = "The PDF could not be read. Try another PDF with selectable text.";
const ENCRYPTED = "Encrypted PDFs are not supported. Choose an unencrypted PDF.";

export interface StudyGuidePdf {
  name: string;
  text: string;
  pages: number;
  emptyPages: number[];
}

export async function readStudyGuidePdf(
  file: Pick<File, "name" | "size" | "type" | "arrayBuffer">,
  maxChars: number,
  signal?: AbortSignal,
): Promise<StudyGuidePdf> {
  const abortError = new DOMException("PDF reading was cancelled.", "AbortError");
  const checkAbort = () => { if (signal?.aborted) throw abortError; };
  checkAbort();
  let rejectCancelled!: (reason: unknown) => void;
  const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
  // A cancelled read may finish before reaching its next await.
  void cancelled.catch(() => {});
  const onAbort = () => rejectCancelled(abortError);
  signal?.addEventListener("abort", onAbort, { once: true });
  const waitFor = <T>(pending: PromiseLike<T> | T): Promise<T> => Promise.race([pending, cancelled]);
  try {
    if (!Number.isSafeInteger(maxChars) || maxChars <= 0) {
      throw new StudyGuidePdfError("The PDF text limit must be a positive whole number.");
    }
    if (!file.name.toLowerCase().endsWith(".pdf") || (file.type !== "" && file.type.toLowerCase() !== "application/pdf")) {
      throw new StudyGuidePdfError("Choose a PDF file (.pdf).");
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new StudyGuidePdfError(UNREADABLE);
    if (file.size > PDF_GUIDE_MAX_BYTES) throw new StudyGuidePdfError("The PDF exceeds the 20 MiB file limit.");
    if (file.size === 0) throw new StudyGuidePdfError("The PDF file is empty.");
    checkAbort();
    const data = await waitFor(file.arrayBuffer());
    checkAbort();
    if (data.byteLength > PDF_GUIDE_MAX_BYTES) throw new StudyGuidePdfError("The PDF exceeds the 20 MiB file limit.");
    if (data.byteLength === 0) throw new StudyGuidePdfError("The PDF file is empty.");
    if (!new TextDecoder("ascii").decode(data.slice(0, 1024)).includes("%PDF-")) {
      throw new StudyGuidePdfError(UNREADABLE);
    }
    checkAbort();
    const pdfjs = await waitFor(loadPdfJs());
    checkAbort();
    // Data-only extraction supplies no resource URLs and never invokes PDF scripting or rendering.
    const task = pdfjs.getDocument({
      data,
      isEvalSupported: false,
      useWorkerFetch: false,
      useWasm: false,
      disableFontFace: true,
      enableXfa: false,
      stopAtErrors: true,
    });
    try {
      checkAbort();
      const doc = await waitFor<any>(task.promise);
      checkAbort();
      if (!Number.isInteger(doc.numPages) || doc.numPages < 1) throw new StudyGuidePdfError(UNREADABLE);
      if (doc.numPages > PDF_GUIDE_MAX_PAGES) throw new StudyGuidePdfError("The PDF exceeds the limit of 200 pages.");
      const metadata = await waitFor<any>(doc.getMetadata());
      checkAbort();
      if (metadata.info.EncryptFilterName != null) throw new StudyGuidePdfError(ENCRYPTED);
      const pages: string[] = [];
      const emptyPages: number[] = [];
      let total = 0;
      for (let n = 1; n <= doc.numPages; n++) {
        checkAbort();
        if (total > maxChars) {
          throw new StudyGuidePdfError(`The PDF text exceeds the coverage limit of ${maxChars} characters.`);
        }
        const page = await waitFor<any>(doc.getPage(n));
        checkAbort();
        const content = await waitFor<any>(page.getTextContent());
        checkAbort();
        let text = "";
        for (const item of content.items) {
          checkAbort();
          if (typeof item.str !== "string") continue;
          if (item.str) {
            if (text && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
            text += item.str;
          }
          if (item.hasEOL) text += "\n";
          if (total + text.trim().length > maxChars) {
            throw new StudyGuidePdfError(`The PDF text exceeds the coverage limit of ${maxChars} characters.`);
          }
        }
        text = text.trim();
        pages.push(text);
        if (!text) emptyPages.push(n);
        total += text.length + 2;
      }
      if (emptyPages.length === doc.numPages) {
        throw new StudyGuidePdfError("The PDF has no selectable text. It may be blank or image-only; OCR is not supported.");
      }
      return { name: file.name, text: pages.join("\n\n"), pages: doc.numPages, emptyPages };
    } finally {
      // Document.destroy delegates to this task; destroying both would release it twice.
      await waitFor(task.destroy());
      checkAbort();
    }
  } catch (error) {
    checkAbort();
    if (error instanceof StudyGuidePdfError) throw error;
    if (error && typeof error === "object" && "name" in error && error.name === "PasswordException") {
      throw new StudyGuidePdfError(ENCRYPTED);
    }
    throw new StudyGuidePdfError(UNREADABLE);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
