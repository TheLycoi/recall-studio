// The command registry's behaviour half. Each entry in COMMAND_TABLE gets an
// `available` predicate and a `run` action here; `src/main.ts` registers the
// merged list with a single `addCommand` loop, and the chat panel runs the same
// objects directly. There is no `app.commands` in the public Obsidian typings,
// so WikiLM owning the registry is the only way the chat can run a command.
//
// Most bodies began as the addCommand blocks of 0.5.0: `available` is the
// checkCallback's availability test, `run` its `!checking` branch. The
// command simplification of 2026-09-28 merged five commands into "AI
// highlight…" and the two selection commands, whose bodies now dispatch on
// what is open. Hidden commands keep an implementation here because the chat
// still runs them by alias; main.ts only leaves them out of the palette.

import { Notice, type TFile } from "obsidian";
import type WikiLmPlugin from "./main";
import { COMMAND_TABLE, type CommandSpec } from "./commandTable";
import { ingestSourceNote } from "./ingestSource";
import { ingestFolderWithUpstream, ingestWithUpstream } from "./upstream/ingest";
import { lintWithUpstream } from "./upstream/lint";
import { aiHighlightNote, captureMarkdownHighlights, capturePdfSelection, captureReadingSelection, captureSelection } from "./capture";
import { isPdfFile, pdfsLinkedFrom, readPdfSelection } from "./pdf";
import { digestFolder, digestPdf } from "./digest";
import { suggestPdfHighlights } from "./suggest";
import { askHighlightOptions, askInstruction, pickFolder, pickPdf, SchemaSuggestionsModal } from "./modals";

export interface WikiLmCommand extends CommandSpec {
  /** True when the command can run right now; the palette hides it otherwise. */
  available(plugin: WikiLmPlugin): boolean;
  /** Performs the command. Callers use `void` or `await`; errors surface as Notices. */
  run(plugin: WikiLmPlugin): Promise<void> | void;
}

type Implementation = Pick<WikiLmCommand, "available" | "run">;

/** The file "AI highlight…" and the selection commands work on: an open markdown note or PDF. */
function noteOrPdf(p: WikiLmPlugin): TFile | null {
  const file = p.app.workspace.getActiveFile();
  return file && (file.extension === "md" || isPdfFile(file)) ? file : null;
}

const INSTRUCTION_TITLE = "Instructions for this highlight";
const INSTRUCTION_PLACEHOLDER = "e.g. one cloze on the number; cards in Dutch; focus on the mechanism";

const IMPLEMENTATIONS: Record<string, Implementation> = {
  // One command for every place a selection can live: a PDF page, a note in
  // reading view, a note in the editor. It absorbed "Send PDF selection to
  // inbox", which was the same gesture under a second name.
  "capture-selection": {
    available: (p) => isPdfFile(p.app.workspace.getActiveFile()) || !!p.activeMarkdown()?.file,
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (isPdfFile(file)) {
        const sel = readPdfSelection(activeWindow);
        if (!sel) new Notice("WikiLM: select text inside a PDF page first.");
        else capturePdfSelection(p, file, sel);
        return;
      }
      const view = p.activeMarkdown();
      if (!view?.file) return;
      if (view.getMode() === "preview") void captureReadingSelection(p, view, activeWindow);
      else void captureSelection(p, view.editor, view.file);
    },
  },
  // The same three places, with the instruction asked first. The selection in
  // a PDF page or in reading view is DOM selection, which the instruction box
  // takes away when it is focused, so it is read before the box opens. The
  // editor's selection lives in the editor and survives the modal.
  "capture-selection-with-instruction": {
    available: (p) => isPdfFile(p.app.workspace.getActiveFile()) || !!p.activeMarkdown()?.file,
    run: async (p) => {
      const file = p.app.workspace.getActiveFile();
      if (isPdfFile(file)) {
        const sel = readPdfSelection(activeWindow);
        if (!sel) {
          new Notice("WikiLM: select text inside a PDF page first.");
          return;
        }
        const inst = await askInstruction(p.app, INSTRUCTION_TITLE, INSTRUCTION_PLACEHOLDER);
        if (inst !== null) capturePdfSelection(p, file, sel, { instruction: inst });
        return;
      }
      const view = p.activeMarkdown();
      if (!view?.file) return;
      if (view.getMode() === "preview") {
        const text = activeWindow.getSelection()?.toString().trim() ?? "";
        if (!text) {
          new Notice("WikiLM: select text in the note first.");
          return;
        }
        const inst = await askInstruction(p.app, INSTRUCTION_TITLE, INSTRUCTION_PLACEHOLDER);
        if (inst !== null) await captureReadingSelection(p, view, activeWindow, { instruction: inst, text });
        return;
      }
      const inst = await askInstruction(p.app, INSTRUCTION_TITLE, INSTRUCTION_PLACEHOLDER);
      if (inst === null) return;
      await captureSelection(p, view.editor, view.file, inst);
    },
  },
  "capture-markdown-highlights": {
    available: (p) => {
      const file = p.app.workspace.getActiveFile();
      return !!file && file.extension === "md";
    },
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return;
      void captureMarkdownHighlights(p, file);
    },
  },
  "ingest-source": {
    available: (p) => {
      const file = p.app.workspace.getActiveFile();
      return !!file && file.extension === "md";
    },
    // Both ingest commands run on upstream's engine (src/upstream/ingest.ts).
    // src/ingestSource.ts is the pipeline they ran before; "AI highlight…"
    // still uses it for a note whose product is wiki notes.
    run: async (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return;
      await ingestWithUpstream(p, file);
    },
  },
  "ingest-folder": {
    available: () => true,
    run: async (p) => {
      const folder = await pickFolder(p.app);
      if (folder) await ingestFolderWithUpstream(p, folder);
    },
  },
  // An ingest on upstream's engine listens on the same token and passes the
  // cancel on to the engine's cancelIngestion(), which aborts the model call
  // in flight (src/upstream/ingest.ts, withEngineRun). A click on the status
  // bar takes the same path.
  "cancel-ingestion": {
    available: (p) => p.cancel.active,
    run: (p) => {
      p.cancel.cancel();
      new Notice("WikiLM: stopping after this batch.");
    },
  },
  // One form for everything the highlighter can be told (what to look for,
  // the guide, what to make), then the pipeline that already makes it. It
  // absorbed the instruction form, the PDF highlighter and "Add transcript".
  // What the reader typed and picked is saved before the run starts, so a run
  // that fails does not lose it.
  "ai-highlight": {
    available: (p) => !!noteOrPdf(p),
    run: async (p) => {
      const file = noteOrPdf(p);
      if (!file) return;
      // A plain boolean, not the `isPdfFile` guard: the guard would narrow
      // `file` to `never` on the note branch (see chatPanel.ts digestTarget).
      const pdf = file.extension.toLowerCase() === "pdf";
      const choice = await askHighlightOptions(p.app, {
        fileName: file.basename,
        kind: pdf ? "pdf" : "note",
        instruction: p.store.getHighlightInstruction(file.path),
        guide: p.store.getTranscript(file.path),
        transcriptFolder: p.settings.transcriptFolder,
        transcriptMaxChars: p.settings.transcriptMaxChars,
      });
      if (choice === null) return;
      p.store.setHighlightInstruction(file.path, choice.instruction);
      if (choice.guide.action === "set") {
        const rec = choice.guide.record;
        p.store.setTranscript(file.path, rec);
        new Notice(`WikiLM: guide saved (${rec.text.length.toLocaleString()} characters)${rec.truncated ? ", cut to the size limit" : ""}.`);
      } else if (choice.guide.action === "clear" && p.store.clearTranscript(file.path)) {
        new Notice("WikiLM: guide removed.");
      }
      // Each path reads the stored guide itself (capture.ts aiHighlightNote,
      // ingestSource.ts ingestSourceNote, suggest.ts suggestPdfHighlights), so
      // the one just saved is the one used.
      if (pdf) {
        // No gate: the form already settled the guide.
        await suggestPdfHighlights(p, file, { instruction: choice.instruction });
      } else if (choice.product === "wiki") {
        await ingestSourceNote(p, file, { instruction: choice.instruction });
      } else {
        aiHighlightNote(p, file, choice.instruction);
      }
    },
  },
  "digest-pdf-highlights": {
    available: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file) return false;
      const isMd = file.extension === "md";
      return isPdfFile(file) || (isMd && pdfsLinkedFrom(p.app, file).length > 0);
    },
    run: async (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file) return;
      if (isPdfFile(file)) {
        await digestPdf(p, file);
        return;
      }
      const pdfs = pdfsLinkedFrom(p.app, file);
      const pdf = pdfs.length === 1 ? pdfs[0] : await pickPdf(p.app, pdfs);
      if (pdf) await digestPdf(p, pdf);
    },
  },
  "digest-folder": {
    available: () => true,
    run: async (p) => {
      const folder = await pickFolder(p.app);
      if (folder) await digestFolder(p, folder);
    },
  },
  "open-chat": {
    available: () => true,
    run: (p) => void p.openChat(),
  },
  "lint-wiki": {
    available: () => true,
    run: (p) => void p.lintWiki(),
  },
  // Upstream's lint on upstream's engine; the scan ends with its report
  // modal open, and each fix runs from a button there.
  "lint-wiki-upstream": {
    available: () => true,
    run: (p) => void lintWithUpstream(p),
  },
  "open-inbox": {
    available: () => true,
    run: (p) => void p.openInbox(),
  },
  "export-reviewed": {
    available: () => true,
    run: (p) => void p.exportHighlights(p.store.all().filter((h) => h.status === "ready")),
  },
  "retry-failed": {
    available: () => true,
    run: (p) => {
      let n = 0;
      for (const h of p.store.all()) if (h.status === "error") (p.generator.enqueue(h), n++);
      new Notice(`WikiLM: retrying ${n}.`);
    },
  },
  "open-schema": {
    available: () => true,
    // `ensure` writes the note from the template when it is not there yet, so
    // this is also how a reader first meets the file: they ask to see their
    // house rules and are shown the ones the plugin is already following.
    run: async (p) => {
      const file = await p.schema.ensure();
      await p.app.workspace.getLeaf(false).openFile(file);
    },
  },
  "review-schema-suggestions": {
    available: () => true,
    run: (p) => {
      new SchemaSuggestionsModal(p.app, p.schema).open();
    },
  },
};

// Load-time consistency: a spec with no implementation would register a
// command that throws when run; an implementation with no spec would never be
// registered at all. Both are programming errors, so fail loudly at import.
for (const spec of COMMAND_TABLE) {
  if (!IMPLEMENTATIONS[spec.id]) throw new Error(`WikiLM: command "${spec.id}" has no implementation.`);
}
for (const id of Object.keys(IMPLEMENTATIONS)) {
  if (!COMMAND_TABLE.some((spec) => spec.id === id)) throw new Error(`WikiLM: implementation "${id}" has no command spec.`);
}

export const WIKILM_COMMANDS: WikiLmCommand[] = COMMAND_TABLE.map((spec) => ({ ...spec, ...IMPLEMENTATIONS[spec.id] }));
