// The command registry's data half: ids, palette names, chat aliases, and a
// one-clause availability hint each. Pure on purpose — no `obsidian` import —
// so the chat matcher and its tests can read the table without a plugin.
//
// The ids and names of the visible entries are the ones Obsidian registers
// (src/main.ts loops over the palette commands from src/commands.ts). Changing
// an id orphans a user's hotkey; changing a name changes what the palette
// shows.

export interface CommandSpec {
  /** Globally unique within the plugin; what `addCommand` registers. */
  id: string;
  /** What the command palette shows. */
  name: string;
  /** Short words the chat box accepts, with or without a leading slash. */
  aliases: string[];
  /** One clause on when the command is available, shown by `/help`. */
  hint: string;
  /**
   * Kept out of the palette (and so out of the hotkey list) but still run by
   * its chat aliases. The palette carries the workflow; these are the tools a
   * reader reaches for by name when they already know what they want.
   */
  hidden?: boolean;
}

// The palette order is the workflow order the reader asked for on 2026-09-28:
// AI highlight, Digest, Lint first, the capture and housekeeping commands
// after. The chat-only commands come last. Five commands were removed in that
// change (capture-pdf-selection, capture-pdf-selection-with-instruction,
// ai-highlight-with-instruction, ai-highlight-pdf, add-transcript); their
// aliases now live on the command that absorbed each one, so a chat habit
// survives the merge even though a hotkey bound to the old id does not.
export const COMMAND_TABLE: CommandSpec[] = [
  {
    id: "ai-highlight",
    name: "AI highlight…",
    aliases: ["ai", "ai-instruct", "suggest", "transcript"],
    hint: "needs an open note or PDF",
  },
  {
    id: "digest-pdf-highlights",
    name: "Digest: PDF highlights into concept and entity notes…",
    aliases: ["digest"],
    hint: "needs an open PDF, or a note with PDF++ links",
  },
  {
    id: "digest-folder",
    name: "Digest folder: every highlighted PDF under a folder…",
    aliases: ["digest-folder"],
    hint: "always",
  },
  {
    id: "lint-wiki",
    // The name has to carry the word a reader searches for. "Check the wiki
    // for gaps and dead links" described it well and was unfindable: the
    // palette matches on the name only, so typing "lint" returned nothing.
    // Aliases are a chat affordance and never reach the palette.
    name: "Lint wiki: find gaps, dead links and ungrounded quotes",
    aliases: ["wiki", "lint"],
    hint: "always available",
  },
  {
    id: "capture-selection",
    name: "Send selection to inbox",
    aliases: ["capture", "send", "pdf"],
    hint: "needs an open note or PDF",
  },
  {
    id: "capture-selection-with-instruction",
    name: "Send selection to inbox with instructions…",
    aliases: ["capture-instruct", "pdf-instruct"],
    hint: "needs an open note or PDF",
  },
  {
    id: "open-chat",
    name: "Open chat: ask the notes",
    aliases: ["chat", "ask"],
    hint: "always",
  },
  {
    id: "open-inbox",
    name: "Open inbox",
    aliases: ["inbox"],
    hint: "always",
  },
  {
    id: "export-reviewed",
    name: "Export all reviewed cards to Anki",
    aliases: ["export"],
    hint: "always",
  },
  {
    id: "cancel-ingestion",
    name: "Cancel the running AI highlight, digest or ingest",
    aliases: ["cancel", "stop-run"],
    hint: "while a run is in progress",
  },
  {
    id: "open-schema",
    name: "Open the schema note",
    aliases: ["schema"],
    hint: "always",
  },
  {
    id: "review-schema-suggestions",
    name: "Review schema suggestions",
    aliases: ["suggestions"],
    hint: "always",
  },
  {
    id: "ingest-source",
    name: "Ingest source: read this markdown into the wiki",
    aliases: ["ingest", "read-source"],
    hint: "needs an open note",
    hidden: true,
  },
  {
    id: "ingest-folder",
    name: "Ingest folder: read every note in a folder into the wiki",
    aliases: ["ingest-folder", "read-folder"],
    hint: "always",
    hidden: true,
  },
  {
    id: "capture-markdown-highlights",
    name: "Send all ==highlights== in this note to inbox",
    aliases: ["highlights", "sweep"],
    hint: "needs an open note",
    hidden: true,
  },
  {
    // The inbox's own menu has "Retry failed highlights", which is where a
    // reader looking at a failed row already is.
    id: "retry-failed",
    name: "Retry failed highlights",
    aliases: ["retry"],
    hint: "always",
    hidden: true,
  },
];

/** The commands Obsidian registers: everything but the chat-only ones. */
export function paletteCommands<T extends Pick<CommandSpec, "hidden">>(table: T[]): T[] {
  return table.filter((c) => !c.hidden);
}
