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
  ["ingest-folder", "Ingest folder: read every note in a folder into the wiki"],
  ["cancel-ingestion", "Cancel the running AI highlight or ingest"],
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

test("COMMAND_TABLE holds the twenty (id, name) pairs verbatim and in order", () => {
  assert.equal(table.COMMAND_TABLE.length, 20);
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

// `table` is bound in `before()`, so the context reads it through a getter
// rather than capturing an undefined at import time.
const CTX = {
  pages: [
    { path: "classes/HBIO250/Receptors.md", title: "Receptors", aliases: ["Drug Receptors"], classCodes: ["HBIO250"], hasPdfLinks: true },
    { path: "classes/PHED163/Stages of Change.md", title: "Stages of Change", aliases: [], classCodes: ["PHED163"], hasPdfLinks: false },
  ],
  pdfs: [
    { path: "sources/class notes/HBIO250/HBIO 250 History of Doping and Oversight Fall 2026.pdf", basename: "HBIO 250 History of Doping and Oversight Fall 2026" },
    { path: "sources/class notes/PSYC360/Ch3.pdf", basename: "Ch3" },
    { path: "sources/class notes/PSYC360/Ch3 notes.pdf", basename: "Ch3 notes" },
  ],
  manifests: ["wikilm-manifests/Ch3.md"],
  get commands() {
    return table.COMMAND_TABLE;
  },
};

test("quiz phrases resolve their target: active, page by title or alias, class, or query", () => {
  assert.deepEqual(cc.matchIntent("quiz me", CTX), { kind: "quiz", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("Quiz me on this note", CTX), { kind: "quiz", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("quiz me on receptors", CTX), { kind: "quiz", target: { kind: "page", path: "classes/HBIO250/Receptors.md", title: "Receptors" } });
  assert.deepEqual(cc.matchIntent("test me on drug receptors", CTX).target, { kind: "page", path: "classes/HBIO250/Receptors.md", title: "Receptors" });
  assert.deepEqual(cc.matchIntent("quiz me on hbio250", CTX).target, { kind: "class", code: "HBIO250" });
  assert.deepEqual(cc.matchIntent("quiz me about affinity and binding", CTX).target, { kind: "query", words: "affinity and binding" });
});

test("digest and highlight phrases resolve a PDF, a manifest, a note with PDF links, or the active file", () => {
  assert.deepEqual(cc.matchIntent("digest", CTX), { kind: "digest", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("AI digest this", CTX), { kind: "digest", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("digest the doping pdf", CTX).target, {
    kind: "pdf",
    path: "sources/class notes/HBIO250/HBIO 250 History of Doping and Oversight Fall 2026.pdf",
    basename: "HBIO 250 History of Doping and Oversight Fall 2026",
  });
  assert.deepEqual(cc.matchIntent("digest receptors", CTX).target, { kind: "page", path: "classes/HBIO250/Receptors.md", title: "Receptors" });
  assert.equal(cc.matchIntent("digest stages of change", CTX).kind, "ambiguous", "a page with no PDF links cannot be digested");
  assert.deepEqual(cc.matchIntent("highlight ch3 notes", CTX), { kind: "highlight", target: { kind: "pdf", path: "sources/class notes/PSYC360/Ch3 notes.pdf", basename: "Ch3 notes" } });
});

test("two files that fit equally are offered as candidates, never guessed", () => {
  const m = cc.matchIntent("digest ch3", CTX);
  assert.equal(m.kind, "ambiguous");
  assert.equal(m.verb, "digest");
  assert.deepEqual(
    m.candidates.map((c) => c.path),
    ["sources/class notes/PSYC360/Ch3.pdf", "sources/class notes/PSYC360/Ch3 notes.pdf", "wikilm-manifests/Ch3.md"],
  );
});

test("a target nothing matches is ambiguous with no candidates", () => {
  const m = cc.matchIntent("digest the kinematics deck", CTX);
  assert.equal(m.kind, "ambiguous");
  assert.deepEqual(m.candidates, []);
  assert.equal(m.words, "the kinematics deck");
});

test("lint, export, inbox and help are phrases", () => {
  assert.deepEqual(cc.matchIntent("lint the wiki", CTX), { kind: "lint" });
  assert.deepEqual(cc.matchIntent("check the wiki", CTX), { kind: "lint" });
  assert.deepEqual(cc.matchIntent("export reviewed cards to anki", CTX), { kind: "export" });
  assert.deepEqual(cc.matchIntent("open the inbox", CTX), { kind: "inbox" });
  assert.deepEqual(cc.matchIntent("help", CTX), { kind: "help" });
  assert.deepEqual(cc.matchIntent("what can you do?", CTX), { kind: "help" });
});

test("a palette name or alias typed exactly still runs that command", () => {
  assert.deepEqual(cc.matchIntent("Extract PDF highlights to manifest", CTX), { kind: "command", id: "extract-pdf-highlights" });
  assert.deepEqual(cc.matchIntent("retry", CTX), { kind: "command", id: "retry-failed" });
});

test("a leading slash is tolerated and means the same thing", () => {
  assert.deepEqual(cc.matchIntent("/quiz receptors", CTX).target.kind, "page");
  assert.deepEqual(cc.matchIntent("/digest", CTX), { kind: "digest", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("/help", CTX), { kind: "help" });
});

test("everything else is a question, including sentences that mention a verb", () => {
  assert.deepEqual(cc.matchIntent("what does the wiki say about digestion of drugs?", CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("how do I highlight in PDF++", CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("receptors bind ligands with high affinity", CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("", CTX), { kind: "question" });
});

test("renderHelp lists phrases, not slash commands", () => {
  const help = cc.renderHelp();
  assert.ok(help.includes("**quiz me**"));
  assert.ok(help.includes("**digest**"));
  assert.ok(help.includes("**highlight**"));
  assert.ok(!help.includes("/quiz"), "no slash grammar is documented");
});
