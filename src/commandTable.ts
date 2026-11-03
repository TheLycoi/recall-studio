// The command registry's data half: ids, palette names, aliases, and a
// one-clause availability hint each. Pure on purpose — no `obsidian` import —
// so the table and its tests can read it without a plugin.
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
  /** Short words the aliases box accepts, with or without a leading slash. */
  aliases: string[];
  /** One clause on when the command is available. */
  hint: string;
  /**
   * Kept out of the palette (and so out of the hotkey list) but still runnable
   * by alias. The palette carries the workflow; these are the tools a reader
   * reaches for by name when they already know what they want.
   */
  hidden?: boolean;
}

// The palette follows capture, Inbox, source history and export.
// The two hidden commands are run by name.
export const COMMAND_TABLE: CommandSpec[] = [
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
    id: "open-inbox",
    name: "Open inbox",
    aliases: ["inbox"],
    hint: "always",
  },
  {
    id: "open-source-history",
    name: "Open source history",
    aliases: ["source-history"],
    hint: "current note or PDF; choose a source otherwise",
  },
  {
    id: "open-learn",
    name: "Open Learn",
    aliases: ["learn"],
    hint: "requires the pinned LearnHarness skill and Python 3.10+",
  },
  {
    id: "export-reviewed",
    name: "Export to Anki",
    aliases: ["export"],
    hint: "always",
  },
  {
    id: "capture-markdown-highlights",
    name: "Send all ==highlights== in this note to inbox",
    aliases: ["highlights", "sweep"],
    hint: "needs an open note",
    hidden: true,
  },
  {
    id: "retry-failed",
    name: "Retry failed highlights",
    aliases: ["retry"],
    hint: "always",
    hidden: true,
  },
];

/** The commands Obsidian registers: everything but the hidden ones. */
export function paletteCommands<T extends Pick<CommandSpec, "hidden">>(table: T[]): T[] {
  return table.filter((c) => !c.hidden);
}
