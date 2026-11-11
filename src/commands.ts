// The command registry's behaviour half. Each entry in COMMAND_TABLE gets an
// `available` predicate and a `run` action here. `src/main.ts` registers the
// merged list with a single `addCommand` loop, so the plugin owning the
// registry is the only way a command runs.

import { Notice } from "obsidian";
import type RecallPlugin from "./main";
import { COMMAND_TABLE, type CommandSpec } from "./commandTable";
import { captureMarkdownHighlights, capturePdfSelection, captureReadingSelection, captureSelection } from "./capture";
import { isPdfFile, readPdfSelection } from "./pdf";
import { askInstruction } from "./modals";
import { openCurrentSourceHistory } from "./sourceVisibility";

export interface RecallCommand extends CommandSpec {
  /** True when the command can run right now; the palette hides it otherwise. */
  available(plugin: RecallPlugin): boolean;
  /** False refuses execution; legacy void results count as accepted. */
  run(plugin: RecallPlugin): Promise<boolean | void> | boolean | void;
}

type Implementation = Pick<RecallCommand, "available" | "run">;

const INSTRUCTION_TITLE = "Instructions for this highlight";
const INSTRUCTION_PLACEHOLDER = "e.g. one cloze on the number; cards in Dutch; focus on the mechanism";

const IMPLEMENTATIONS: Record<string, Implementation> = {
  // One command for every place a selection can live: a PDF page, a note in
  // reading view, a note in the editor.
  "capture-selection": {
    available: (p) => isPdfFile(p.app.workspace.getActiveFile()) || !!p.activeMarkdown()?.file,
    run: (p) => {
      const file = p.app.workspace.getActiveFile();
      if (isPdfFile(file)) {
        const sel = readPdfSelection(activeWindow);
        if (!sel) new Notice("Recall Studio: select text inside a PDF page first.");
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
          new Notice("Recall Studio: select text inside a PDF page first.");
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
          new Notice("Recall Studio: select text in the note first.");
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
  "open-inbox": {
    available: () => true,
    run: (p) => void p.openInbox(),
  },
  "open-source-history": {
    available: () => true,
    run: (p) => openCurrentSourceHistory(p),
  },
  "export-reviewed": {
    available: () => true,
    run: (p) => void p.exportHighlights(p.store.all().filter((h) => h.status === "ready")),
  },
  "retry-failed": {
    available: () => true,
    run: (p) => {
      let n = 0;
      for (const h of p.store.all()) if (p.generator.canRetry(h)) (p.generator.retry(h), n++);
      new Notice(`Recall Studio: retrying ${n}.`);
    },
  },
};

// Load-time consistency: a spec with no implementation would register a
// command that throws when run; an implementation with no spec would never be
// registered at all. Both are programming errors, so fail loudly at import.
for (const spec of COMMAND_TABLE) {
  if (!IMPLEMENTATIONS[spec.id]) throw new Error(`Recall Studio: command "${spec.id}" has no implementation.`);
}
for (const id of Object.keys(IMPLEMENTATIONS)) {
  if (!COMMAND_TABLE.some((spec) => spec.id === id)) throw new Error(`Recall Studio: implementation "${id}" has no command spec.`);
}

export const RECALL_COMMANDS: RecallCommand[] = COMMAND_TABLE.map((spec) => ({ ...spec, ...IMPLEMENTATIONS[spec.id] }));

/** Exact names and aliases only. Null means unknown; false means refused. */
export async function runNamedCommand(plugin: RecallPlugin, text: string): Promise<boolean | null> {
  const name = text.trim().replace(/^\//, "").replace(/^Recall Studio:\s*/i, "").toLowerCase();
  const command = RECALL_COMMANDS.find(c => [c.id, c.name, c.name.replace(/ \(Experimental\)$/, ""), ...c.aliases].some(alias => alias.toLowerCase() === name));
  if (!command) return null;
  if (!command.available(plugin)) {
    new Notice(`Recall Studio: ${command.name} ${command.hint}.`);
    return false;
  }
  return (await command.run(plugin)) !== false;
}
