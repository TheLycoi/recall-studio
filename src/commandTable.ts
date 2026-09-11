// The command registry's data half: ids, palette names, chat aliases, and a
// one-clause availability hint each. Pure on purpose — no `obsidian` import —
// so the chat matcher and its tests can read the table without a plugin.
//
// The ids and names here are the ones Obsidian registers (src/main.ts loops
// over RECALL_COMMANDS in src/commands.ts). Changing an id orphans a user's
// hotkey; changing a name changes what the palette shows. Both are verbatim
// from the 0.5.0 addCommand blocks.

export interface CommandSpec {
  /** Globally unique within the plugin; what `addCommand` registers. */
  id: string;
  /** What the command palette shows. */
  name: string;
  /** Short words the chat box accepts, with or without a leading slash. */
  aliases: string[];
  /** One clause on when the command is available, shown by `/help`. */
  hint: string;
}

export const COMMAND_TABLE: CommandSpec[] = [
  {
    id: "capture-selection",
    name: "Send selection to inbox",
    aliases: ["capture", "send"],
    hint: "needs an open note",
  },
  {
    id: "capture-pdf-selection",
    name: "Send PDF selection to inbox",
    aliases: ["pdf"],
    hint: "needs an open PDF",
  },
  {
    id: "capture-pdf-selection-with-instruction",
    name: "Send PDF selection to inbox with instructions…",
    aliases: ["pdf-instruct"],
    hint: "needs an open PDF",
  },
  {
    id: "capture-selection-with-instruction",
    name: "Send selection to inbox with instructions…",
    aliases: ["capture-instruct"],
    hint: "needs an open note",
  },
  {
    id: "capture-markdown-highlights",
    name: "Send all ==highlights== in this note to inbox",
    aliases: ["highlights", "sweep"],
    hint: "needs an open note",
  },
  {
    id: "ai-highlight",
    name: "AI-highlight this note and write cards",
    aliases: ["ai"],
    hint: "needs an open note",
  },
  {
    id: "ai-highlight-with-instruction",
    name: "AI-highlight this note with instructions…",
    aliases: ["ai-instruct"],
    hint: "needs an open note",
  },
  {
    id: "add-transcript",
    name: "Add transcript for document highlighting",
    aliases: ["transcript"],
    hint: "needs an open note",
  },
  {
    id: "extract-pdf-highlights",
    name: "Extract PDF highlights to manifest",
    aliases: ["extract"],
    hint: "needs an open PDF",
  },
  {
    id: "digest-pdf-highlights",
    name: "Digest PDF highlights into topic notes…",
    aliases: ["digest"],
    hint: "needs an open PDF or manifest note",
  },
  {
    id: "digest-pdf-highlights-from-json",
    name: "Digest PDF highlights from pasted model output…",
    aliases: ["digest-json", "paste"],
    hint: "needs an open PDF or manifest note",
  },
  {
    id: "open-chat",
    name: "Ask the notes",
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
    id: "retry-failed",
    name: "Retry failed highlights",
    aliases: ["retry"],
    hint: "always",
  },
];
