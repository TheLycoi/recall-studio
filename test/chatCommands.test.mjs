// Run with: npm test  (bundles src/commandTable.ts and src/chatCommands.ts first,
// then exercises them with node:test). Both modules are pure — neither imports
// `obsidian` — which is why esbuild can bundle them for plain node here.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let table;
let cc;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const outTable = path.join(dir, "commandTable.mjs");
  const outChat = path.join(dir, "chatCommands.mjs");
  await build({ entryPoints: ["src/commandTable.ts"], bundle: true, format: "esm", platform: "node", outfile: outTable, logLevel: "silent" });
  await build({ entryPoints: ["src/chatCommands.ts"], bundle: true, format: "esm", platform: "node", outfile: outChat, logLevel: "silent" });
  table = await import(pathToFileURL(outTable).href);
  cc = await import(pathToFileURL(outChat).href);
});

// The ids and names Obsidian registers. Verbatim and in order: an id change
// orphans a user's hotkey, a name change moves the entry in the palette.
const EXPECTED = [
  ["capture-selection", "Send selection to inbox"],
  ["capture-pdf-selection", "Send PDF selection to inbox"],
  ["capture-pdf-selection-with-instruction", "Send PDF selection to inbox with instructions…"],
  ["capture-selection-with-instruction", "Send selection to inbox with instructions…"],
  ["capture-markdown-highlights", "Send all ==highlights== in this note to inbox"],
  ["ai-highlight", "AI-highlight this note and write cards"],
  ["ai-highlight-with-instruction", "AI-highlight this note with instructions…"],
  ["ingest-source", "Ingest source: read this markdown into the wiki"],
  ["add-transcript", "Add transcript for document highlighting"],
  ["extract-pdf-highlights", "Extract PDF highlights to manifest"],
  ["digest-pdf-highlights", "Digest PDF highlights into topic notes…"],
  ["digest-pdf-highlights-from-json", "Digest PDF highlights from pasted model output…"],
  ["ai-highlight-pdf", "AI-highlight this PDF into the wiki…"],
  ["open-chat", "Open chat: ask the notes"],
  ["lint-wiki", "Lint wiki: find gaps, dead links and ungrounded quotes"],
  ["open-inbox", "Open inbox"],
  ["export-reviewed", "Export all reviewed cards to Anki"],
  ["retry-failed", "Retry failed highlights"],
];

test("COMMAND_TABLE holds the eighteen (id, name) pairs verbatim and in order", () => {
  assert.equal(table.COMMAND_TABLE.length, 18);
  assert.deepEqual(
    table.COMMAND_TABLE.map((c) => [c.id, c.name]),
    EXPECTED,
  );
});

test("every command has at least one alias and a hint", () => {
  for (const c of table.COMMAND_TABLE) {
    assert.ok(c.aliases.length > 0, `${c.id} has no alias`);
    assert.ok(c.hint.length > 0, `${c.id} has no hint`);
  }
});

test("aliases are unique across the table and never collide with another id", () => {
  const seen = new Map();
  const ids = new Set(table.COMMAND_TABLE.map((c) => c.id));
  for (const c of table.COMMAND_TABLE) {
    for (const a of c.aliases) {
      assert.ok(!seen.has(a), `alias "${a}" is used by both ${seen.get(a)} and ${c.id}`);
      seen.set(a, c.id);
      // An alias equal to another command's id would make "/x" ambiguous.
      assert.ok(!ids.has(a) || a === c.id, `alias "${a}" on ${c.id} is another command's id`);
    }
  }
});

// The scorer the panel actually injects (src/chatPanel.ts:411), not a copy of
// it: a local reimplementation drifted from the shipped one, so the suite
// passed while the app scored differently. Bound after the bundle loads.
const fuzzy = (q) => cc.tokenOverlapScorer(q);

const COMMANDS = () => table.COMMAND_TABLE.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));

test("matchCommand: slash lines", () => {
  const cmds = COMMANDS();
  assert.deepEqual(cc.matchCommand("/help", cmds, fuzzy), { kind: "help" });
  assert.deepEqual(cc.matchCommand("/commands", cmds, fuzzy), { kind: "help" });
  assert.deepEqual(cc.matchCommand("/?", cmds, fuzzy), { kind: "help" });
  assert.deepEqual(cc.matchCommand("/extract", cmds, fuzzy), { kind: "run", id: "extract-pdf-highlights" });
  // Fuzzy over names, so the palette name after a slash works with any casing.
  assert.deepEqual(cc.matchCommand("/Extract PDF highlights", cmds, fuzzy), { kind: "run", id: "extract-pdf-highlights" });
  assert.deepEqual(cc.matchCommand("/nope", cmds, fuzzy), { kind: "unknown", query: "nope" });
});

test("matchCommand: plain text that is exactly a name or an alias runs", () => {
  const cmds = COMMANDS();
  assert.deepEqual(cc.matchCommand("Extract PDF highlights to manifest", cmds, fuzzy), { kind: "run", id: "extract-pdf-highlights" });
  assert.deepEqual(cc.matchCommand("extract", cmds, fuzzy), { kind: "run", id: "extract-pdf-highlights" });
  // The trailing ellipsis on the palette name is not something anyone types.
  assert.deepEqual(cc.matchCommand("Digest PDF highlights into topic notes", cmds, fuzzy), { kind: "run", id: "digest-pdf-highlights" });
});

test("matchCommand: a short command-like sentence is offered, not run", () => {
  const cmds = COMMANDS();
  // "extract pdf highlights" is neither a name nor an alias. Against the name
  // "Extract PDF highlights to manifest" all three query tokens are present,
  // so the injected scorer computes 3 — at or above OFFER_THRESHOLD, an offer.
  const scored = fuzzy("extract pdf highlights")("Extract PDF highlights to manifest");
  assert.equal(scored, 3);
  assert.equal(cc.OFFER_THRESHOLD, 2);
  assert.deepEqual(cc.matchCommand("extract pdf highlights", cmds, fuzzy), {
    kind: "offer",
    id: "extract-pdf-highlights",
    score: 3,
  });
});

test("matchCommand: a question mark makes it a question regardless of score", () => {
  const cmds = COMMANDS();
  const q = "how do I export?";
  // Not because it scores badly: it matches the export command's alias.
  assert.equal(fuzzy(q)("export"), 1);
  assert.deepEqual(cc.matchCommand(q, cmds, fuzzy), { kind: "question" });
});

test("matchCommand: a long sentence is a question because of its length", () => {
  const cmds = COMMANDS();
  const long =
    "I would really like to understand how the export of reviewed cards to Anki actually works behind the scenes here";
  assert.equal(long.trim().split(/\s+/).length, 20);
  // It scores well above the threshold; length alone sends it to the model.
  const hit = fuzzy(long)("Export all reviewed cards to Anki");
  assert.ok(hit >= cc.OFFER_THRESHOLD, `expected a high score, got ${hit}`);
  assert.deepEqual(cc.matchCommand(long, cmds, fuzzy), { kind: "question" });
});

test("matchCommand: ordinary short questions stay questions", () => {
  const cmds = COMMANDS();
  assert.deepEqual(cc.matchCommand("what is a receptor", cmds, fuzzy), { kind: "question" });
  assert.deepEqual(cc.matchCommand("", cmds, fuzzy), { kind: "question" });
});

test("a run-together command word still names its command", () => {
  // "wikilint" is "wiki" and "lint" typed without the space. Splitting on
  // non-alphanumerics alone scored it zero against every command, so the Run
  // chip could never appear for it.
  assert.equal(fuzzy("wikilint")("wiki"), 1);
  assert.equal(fuzzy("wiki lint")("lint"), 1);
  // Not any substring: a command word under three characters cannot match
  // inside an unrelated query word.
  assert.equal(fuzzy("something")("me"), null);
});

test("a mistyped slash command is offered, not dead-ended", () => {
  const cmds = COMMANDS();
  // The reported case: "/wikilint" answered "No command matches" with the
  // command one word away.
  assert.deepEqual(cc.matchCommand("/wikilint", cmds, fuzzy), { kind: "offer", id: "lint-wiki", score: 1 });
  // A slash line that plainly names its command still runs without asking.
  assert.deepEqual(cc.matchCommand("/wiki", cmds, fuzzy), { kind: "run", id: "lint-wiki" });
  // Nothing recognisable is still unknown.
  assert.deepEqual(cc.matchCommand("/nope", cmds, fuzzy), { kind: "unknown", query: "nope" });
});

test("filler words alone never offer a command", () => {
  // Filler is what let ordinary questions reach the offer threshold: this
  // query shares "the", "for" and "and" with the lint command's name and must
  // score nothing at all.
  assert.equal(fuzzy("what does the for and")("Check the wiki for gaps and dead links"), null);
});

test("a prose question that mentions a command word is still answered", () => {
  const cmds = COMMANDS();
  // An offer replaces the answer (src/chatPanel.ts:427-443), so a question
  // that merely says "wiki" must not be turned into a chip. This is why the
  // prose threshold stays at two while a slash line offers at one.
  assert.deepEqual(cc.matchCommand("what does the wiki say", cmds, fuzzy), { kind: "question" });
});

test("a question opening with an interrogative outranks its word overlap", () => {
  const cmds = COMMANDS();
  // Renaming lint-wiki to "Lint wiki: find gaps…" put both "lint" and "wiki"
  // in the name, so this question started scoring 2 — the offer threshold —
  // and could no longer be asked. Word count cannot separate it from the real
  // command below; the opening word can.
  const lint = cmds.find((c) => c.id === "lint-wiki");
  assert.equal(fuzzy("how do I lint a wiki note")(lint.name), 2);
  assert.deepEqual(cc.matchCommand("how do I lint a wiki note", cmds, fuzzy), { kind: "question" });
  // Without the interrogative it is an instruction, and still offered.
  assert.deepEqual(cc.matchCommand("lint the wiki", cmds, fuzzy), { kind: "offer", id: "lint-wiki", score: 2 });
  // A question mark is not required for the guard to apply.
  assert.deepEqual(cc.matchCommand("where is the wiki lint", cmds, fuzzy), { kind: "question" });
});

test("renderHelp lists one line per command", () => {
  const lines = cc
    .renderHelp(table.COMMAND_TABLE.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, hint: c.hint, available: c.hint === "always" })))
    .split("\n");
  assert.equal(lines.length, table.COMMAND_TABLE.length);
  for (const line of lines) assert.ok(line.startsWith("- **/"), `bad help line: ${line}`);
  assert.ok(lines.some((l) => l.includes("(available)")));
  assert.ok(lines.some((l) => l.includes("(not now)")));
});
