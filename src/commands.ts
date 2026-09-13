// The command registry's behaviour half. Each entry in COMMAND_TABLE gets an
// `available` predicate and a `run` action here; `src/main.ts` registers the
// merged list with a single `addCommand` loop, and the chat panel runs the same
// objects directly. There is no `app.commands` in the public Obsidian typings,
// so Recall owning the registry is the only way the chat can run a command.
//
// The bodies below are moved verbatim from the fifteen addCommand blocks that
// lived at src/main.ts:52-215 in 0.5.0: `available` is the checkCallback's
// availability test (what it decided with `checking === true`), `run` is its
// `!checking` branch, and the four `callback` commands are `available: () => true`.

import { Notice } from "obsidian";
import type RecallPlugin from "./main";
import { COMMAND_TABLE, type CommandSpec } from "./commandTable";
import { aiHighlightNote, captureMarkdownHighlights, capturePdfSelection, captureReadingSelection, captureSelection } from "./capture";
import { isPdfFile, readPdfSelection } from "./pdf";
import { isManifestNote } from "./pdfHighlights";
import { digestPdf, extractPdfHighlights } from "./digest";
import { askInstruction, askTranscript } from "./modals";
import { normalizeTranscript, truncateTranscript } from "./util";

export interface RecallCommand extends CommandSpec {
  /** True when the command can run right now; the palette hides it otherwise. */
  available(plugin: RecallPlugin): boolean;
  /** Performs the command. Callers use `void` or `await`; errors surface as Notices. */
  run(plugin: RecallPlugin): Promise<void> | void;
}

type Implementation = Pick<RecallCommand, "available" | "run">;

const IMPLEMENTATIONS: Record<string, Implementation> = {
  "capture-selection": {
    available: (p) => !!p.activeMarkdown()?.file,
    run: (p) => {
      const view = p.activeMarkdown();
      if (!view?.file) return;
      if (view.getMode() === "preview") void captureReadingSelection(p, view, activeWindow);
      else void captureSelection(p, view.editor, view.file);
    },
  },
  "capture-pdf-selection": {
    available: (p) => isPdfFile(p.app.workspace.getActiveFile()),
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!isPdfFile(file)) return;
      const sel = readPdfSelection(activeWindow);
      if (!sel) new Notice("Recall: select text inside a PDF page first.");
      else capturePdfSelection(p, file, sel);
    },
  },
  "capture-pdf-selection-with-instruction": {
    available: (p) => isPdfFile(p.app.workspace.getActiveFile()),
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!isPdfFile(file)) return;
      const sel = readPdfSelection(activeWindow);
      if (!sel) {
        new Notice("Recall: select text inside a PDF page first.");
        return;
      }
      void askInstruction(p.app, "Instructions for this highlight", "e.g. one cloze on the number").then((inst) => {
        if (inst !== null) capturePdfSelection(p, file, sel, { instruction: inst });
      });
    },
  },
  // In 0.5.0 this was a bare `editorCallback` with no availability test of its
  // own (Obsidian only offers editorCallback commands when an editor is
  // focused). The registry needs an explicit predicate, so it reuses the same
  // active-markdown test and the same `view.editor` / `view.file` pair that
  // `capture-selection` uses.
  "capture-selection-with-instruction": {
    available: (p) => {
      // The old editorCallback never fired in reading view; keep that boundary.
      const view = p.activeMarkdown();
      return !!view?.file && view.getMode() !== "preview";
    },
    run: async (p) => {
      const view = p.activeMarkdown();
      if (!view?.file) return;
      const inst = await askInstruction(p.app, "Instructions for this highlight", "e.g. one cloze on the number; cards in Dutch; focus on the mechanism");
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
  "ai-highlight": {
    available: (p) => {
      const file = p.app.workspace.getActiveFile();
      return !!file && file.extension === "md";
    },
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return;
      aiHighlightNote(p, file);
    },
  },
  "ai-highlight-with-instruction": {
    available: (p) => {
      const file = p.app.workspace.getActiveFile();
      return !!file && file.extension === "md";
    },
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file || file.extension !== "md") return;
      void askInstruction(p.app, "What should the highlighter look for?", "e.g. only the definitions and the numbers in the Results section").then((inst) => {
        if (inst !== null) aiHighlightNote(p, file, inst);
      });
    },
  },
  "add-transcript": {
    available: (p) => {
      const file = p.app.workspace.getActiveFile();
      return !!file && (file.extension === "md" || isPdfFile(file));
    },
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file || (file.extension !== "md" && !isPdfFile(file))) return;
      void askTranscript(p.app, p.store.getTranscript(file.path)).then((choice) => {
        if (choice === null) return;
        if (choice.action === "clear") {
          p.store.clearTranscript(file.path);
          new Notice("Recall: transcript removed.");
          return;
        }
        const cleaned = normalizeTranscript(choice.text);
        const { text: kept, truncated } = truncateTranscript(cleaned, p.settings.transcriptMaxChars);
        p.store.setTranscript(file.path, {
          text: kept,
          origin: choice.origin,
          sourceFile: choice.sourceFile,
          addedAt: new Date().toISOString(),
          truncated,
        });
        new Notice(`Recall: transcript saved (${kept.length.toLocaleString()} characters)${truncated ? ", cut to the size limit" : ""}.`);
      });
    },
  },
  "extract-pdf-highlights": {
    available: (p) => isPdfFile(p.app.workspace.getActiveFile()),
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!isPdfFile(file)) return;
      void extractPdfHighlights(p, file);
    },
  },
  "digest-pdf-highlights": {
    available: (p) => {
      const file = p.app.workspace.getActiveFile();
      return !!file && (isPdfFile(file) || isManifestNote(p, file));
    },
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file || !(isPdfFile(file) || isManifestNote(p, file))) return;
      void digestPdf(p, file, "model");
    },
  },
  "digest-pdf-highlights-from-json": {
    available: (p) => {
      const file = p.app.workspace.getActiveFile();
      return !!file && (isPdfFile(file) || isManifestNote(p, file));
    },
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (!file || !(isPdfFile(file) || isManifestNote(p, file))) return;
      void digestPdf(p, file, "paste");
    },
  },
  "open-chat": {
    available: () => true,
    run: (p) => void p.openChat(),
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
      new Notice(`Recall: retrying ${n}.`);
    },
  },
};

// Load-time consistency: a spec with no implementation would register a
// command that throws when run; an implementation with no spec would never be
// registered at all. Both are programming errors, so fail loudly at import.
for (const spec of COMMAND_TABLE) {
  if (!IMPLEMENTATIONS[spec.id]) throw new Error(`Recall: command "${spec.id}" has no implementation.`);
}
for (const id of Object.keys(IMPLEMENTATIONS)) {
  if (!COMMAND_TABLE.some((spec) => spec.id === id)) throw new Error(`Recall: implementation "${id}" has no command spec.`);
}

export const RECALL_COMMANDS: RecallCommand[] = COMMAND_TABLE.map((spec) => ({ ...spec, ...IMPLEMENTATIONS[spec.id] }));
