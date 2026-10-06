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
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const outTable = path.join(dir, "commandTable.mjs");
  const outChat = path.join(dir, "chatCommands.mjs");
  await build({ entryPoints: ["src/commandTable.ts"], bundle: true, format: "esm", platform: "node", outfile: outTable, logLevel: "silent" });
  await build({ entryPoints: ["src/chatCommands.ts"], bundle: true, format: "esm", platform: "node", outfile: outChat, logLevel: "silent" });
  table = await import(pathToFileURL(outTable).href);
  cc = await import(pathToFileURL(outChat).href);
});

// The ids and names in the table, in order. An id change orphans a user's
// hotkey, a name change moves the entry in the palette. The Recall carve-out
// (2026-10-05) removed the wiki commands and turned open-chat into open-quiz.
const EXPECTED = [
  ["capture-selection", "Send selection to inbox"],
  ["capture-selection-with-instruction", "Send selection to inbox with instructions…"],
  ["open-quiz", "Open quiz"],
  ["open-inbox", "Open inbox"],
  ["export-reviewed", "Export all reviewed cards to Anki"],
  ["open-schema", "Open the card rules note"],
  ["review-schema-suggestions", "Review card rule suggestions"],
  ["capture-markdown-highlights", "Send all ==highlights== in this note to inbox"],
  ["retry-failed", "Retry failed highlights"],
];

const HIDDEN = ["capture-markdown-highlights", "retry-failed"];
const REMOVED = [
  "capture-pdf-selection",
  "capture-pdf-selection-with-instruction",
  "ai-highlight-with-instruction",
  "ai-highlight-pdf",
  "add-transcript",
  "digest-folder",
  "lint-wiki",
  "open-chat",
  "ai-highlight",
  "digest-pdf-highlights",
  "cancel-ingestion",
  "lint-wiki-upstream",
  "ingest-source",
  "ingest-folder",
];

test("COMMAND_TABLE holds the nine (id, name) pairs verbatim and in order", () => {
  assert.equal(table.COMMAND_TABLE.length, 9);
  assert.deepEqual(
    table.COMMAND_TABLE.map((c) => [c.id, c.name]),
    EXPECTED,
  );
});

test("exactly the two quiz-panel-only commands are hidden, and the removed ones are gone", () => {
  assert.deepEqual(
    table.COMMAND_TABLE.filter((c) => c.hidden).map((c) => c.id),
    HIDDEN,
  );
  for (const id of REMOVED) assert.ok(!table.COMMAND_TABLE.some((c) => c.id === id), `${id} should be removed`);
});

test("the palette gets the seven visible commands and none of the hidden ones", () => {
  const palette = table.paletteCommands(table.COMMAND_TABLE);
  assert.equal(palette.length, 7);
  assert.deepEqual(
    palette.map((c) => c.id),
    EXPECTED.slice(0, 7).map(([id]) => id),
  );
  for (const id of HIDDEN) assert.ok(!palette.some((c) => c.id === id), `${id} must not reach the palette`);
});

test("open-quiz answers to quiz-panel", () => {
  const quiz = table.COMMAND_TABLE.find((c) => c.id === "open-quiz");
  assert.deepEqual(quiz.aliases, ["quiz-panel"]);
  assert.equal(quiz.hint, "always");
});

test("every id is unique", () => {
  const ids = table.COMMAND_TABLE.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
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
    { path: "wiki/concepts/Receptors.md", title: "Receptors", aliases: ["Drug Receptors"] },
    { path: "wiki/concepts/Stages of Change.md", title: "Stages of Change", aliases: [] },
  ],
  get commands() {
    return table.COMMAND_TABLE;
  },
};

test("quiz phrases resolve their target: active, page by title or alias, or query", () => {
  assert.deepEqual(cc.matchIntent("quiz me", CTX), { kind: "quiz", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("Quiz me on this note", CTX), { kind: "quiz", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("quiz me on receptors", CTX), { kind: "quiz", target: { kind: "page", path: "wiki/concepts/Receptors.md", title: "Receptors" } });
  assert.deepEqual(cc.matchIntent("test me on drug receptors", CTX).target, { kind: "page", path: "wiki/concepts/Receptors.md", title: "Receptors" });
  assert.deepEqual(cc.matchIntent("quiz me about affinity and binding", CTX).target, { kind: "query", words: "affinity and binding" });
});

test("export, inbox and help are phrases", () => {
  assert.deepEqual(cc.matchIntent("export reviewed cards to anki", CTX), { kind: "export" });
  assert.deepEqual(cc.matchIntent("open the inbox", CTX), { kind: "inbox" });
  assert.deepEqual(cc.matchIntent("help", CTX), { kind: "help" });
  assert.deepEqual(cc.matchIntent("what can you do?", CTX), { kind: "help" });
});

test("a palette name or alias typed exactly still runs that command", () => {
  assert.deepEqual(cc.matchIntent("retry", CTX), { kind: "command", id: "retry-failed" });
  assert.deepEqual(cc.matchIntent("schema", CTX), { kind: "command", id: "open-schema" });
  assert.deepEqual(cc.matchIntent("/suggestions", CTX), { kind: "command", id: "review-schema-suggestions" });
  assert.deepEqual(cc.matchIntent("quiz-panel", CTX), { kind: "command", id: "open-quiz" });
});

test("hidden commands are still matched by their aliases", () => {
  assert.deepEqual(cc.matchIntent("/highlights", CTX), { kind: "command", id: "capture-markdown-highlights" });
  assert.deepEqual(cc.matchIntent("/retry", CTX), { kind: "command", id: "retry-failed" });
});

test("the aliases of removed commands reach the command that absorbed them", () => {
  assert.deepEqual(cc.matchIntent("pdf", CTX), { kind: "command", id: "capture-selection" });
  assert.deepEqual(cc.matchIntent("/pdf-instruct", CTX), { kind: "command", id: "capture-selection-with-instruction" });
});

test("help lists the hidden commands on a quiz-panel-only line", () => {
  const help = cc.renderHelp();
  const line = help.split("\n").find((l) => /quiz panel only/i.test(l));
  assert.ok(line, "help has a quiz-panel-only line");
  for (const c of table.COMMAND_TABLE.filter((c) => c.hidden)) assert.ok(line.includes(`**${c.aliases[0]}**`), `quiz-panel-only line names ${c.aliases[0]}`);
  assert.ok(!/\*\*schema\*\*/.test(line), "a palette command is not listed as quiz panel only");
});

test("a leading slash is tolerated and means the same thing", () => {
  assert.deepEqual(cc.matchIntent("/quiz receptors", CTX).target.kind, "page");
  assert.deepEqual(cc.matchIntent("/help", CTX), { kind: "help" });
});

test("the all-wiki scope is reachable as a phrase, while quiz-shaped prose is not a quiz", () => {
  const all = { kind: "quiz", target: { kind: "query", words: "" } };
  assert.deepEqual(cc.matchIntent("/quiz all", CTX), all);
  assert.deepEqual(cc.matchIntent("quiz all", CTX), all);
  assert.deepEqual(cc.matchIntent("quiz everything", CTX), all);
  assert.deepEqual(cc.matchIntent("quiz results are in", CTX), { kind: "unknown" });
  assert.deepEqual(cc.matchIntent("test the hypothesis", CTX), { kind: "unknown" });
  assert.deepEqual(cc.matchIntent("drill down into receptors", CTX), { kind: "unknown" });
});

test("renderHelp lists phrases, not slash commands", () => {
  const help = cc.renderHelp();
  assert.ok(help.includes("**quiz me**"));
  assert.ok(!help.includes("/quiz"), "no slash grammar is documented");
});

// ---- send the quiz misses to the inbox ------------------------------------------

test("send to inbox and its plain-language forms card the quiz misses; a question that mentions the inbox is not", () => {
  for (const phrase of ["send to inbox", "send it to the inbox", "send the misses to inbox", "card it", "make flashcards", "flashcard this"]) {
    assert.deepEqual(cc.matchIntent(phrase, CTX), { kind: "send-misses" }, phrase);
  }
  assert.equal(cc.matchIntent("inbox", CTX).kind, "inbox", "the bare word still opens the inbox");
  assert.equal(cc.matchIntent("what does the inbox send to the writer?", CTX).kind, "unknown");
  assert.match(cc.renderHelp(), /\*\*send to inbox\*\*/);
});

test("every plain way of asking to send the misses is the send-misses intent", () => {
  const phrases = [
    "send to inbox",
    "send them to inbox",
    "send my misses to the inbox",
    "send it",
    "send that",
    "send them",
    "add to inbox",
    "add that to inbox",
    "card it",
    "card that",
    "card them",
    "card the misses",
  ];
  for (const phrase of phrases) {
    assert.deepEqual(cc.matchIntent(phrase, CTX), { kind: "send-misses" }, phrase);
    assert.deepEqual(cc.matchIntent(phrase.toUpperCase(), CTX), { kind: "send-misses" }, `${phrase} in capitals`);
    assert.deepEqual(cc.matchIntent(`${phrase}.`, CTX), { kind: "send-misses" }, `${phrase} with a full stop`);
  }
});

test("bare 'send' stays the capture alias, and lines that start with send or card are not sends", () => {
  assert.deepEqual(cc.matchIntent("send", CTX), { kind: "command", id: "capture-selection" });
  assert.deepEqual(cc.matchIntent("send a signal down the axon?", CTX), { kind: "unknown" });
  assert.deepEqual(cc.matchIntent("what does card sorting measure", CTX), { kind: "unknown" });
});

// ---- Recall: the quiz panel reads the wiki and does nothing else ----------------

const ctx = {
  pages: [
    { path: "wiki/concepts/free-recall.md", title: "Free recall", aliases: ["Free-recall test"] },
    { path: "wiki/entities/piotr-wozniak.md", title: "Piotr Wozniak", aliases: [] },
  ],
  commands: [{ id: "open-inbox", name: "Open inbox", aliases: ["inbox"] }],
};

test("quiz me is the open note", () => {
  assert.deepEqual(cc.matchIntent("quiz me", ctx), { kind: "quiz", target: { kind: "active" } });
});

test("quiz me on a page title or alias names that page", () => {
  assert.deepEqual(cc.matchIntent("Quiz me on Free recall", ctx), { kind: "quiz", target: { kind: "page", path: "wiki/concepts/free-recall.md", title: "Free recall" } });
  assert.deepEqual(cc.matchIntent("quiz me on the free-recall test", ctx), { kind: "quiz", target: { kind: "page", path: "wiki/concepts/free-recall.md", title: "Free recall" } });
});

test("quiz me on words that name no page is a subject", () => {
  assert.deepEqual(cc.matchIntent("quiz me on spacing", ctx), { kind: "quiz", target: { kind: "query", words: "spacing" } });
});

test("quiz me on everything is the whole wiki folder", () => {
  assert.deepEqual(cc.matchIntent("quiz me on everything", ctx), { kind: "quiz", target: { kind: "query", words: "" } });
});

test("wiki verbs are not Recall's", () => {
  for (const line of ["digest", "digest Doping", "highlight Ch3", "lint", "check the wiki"]) {
    assert.deepEqual(cc.matchIntent(line, ctx), { kind: "unknown" }, line);
  }
});

test("a question is not answered here", () => {
  assert.deepEqual(cc.matchIntent("what is free recall?", ctx), { kind: "unknown" });
  assert.deepEqual(cc.matchIntent("", ctx), { kind: "unknown" });
});

test("card it sends the quiz misses", () => {
  assert.deepEqual(cc.matchIntent("card it", ctx), { kind: "send-misses" });
  assert.deepEqual(cc.matchIntent("send to inbox", ctx), { kind: "send-misses" });
});

test("help lists the quiz and no wiki verb", () => {
  const help = cc.renderHelp();
  assert.match(help, /quiz me/);
  assert.match(help, /quiz panel only/);
  assert.doesNotMatch(help, /digest|lint|ingest/);
});

test("wiki verbs name no command in the real table", () => {
  const real = { pages: [], commands: table.COMMAND_TABLE };
  for (const line of ["digest", "digest Doping", "highlight Ch3", "lint", "check the wiki", "ingest", "smart-fix", "ai"]) {
    assert.deepEqual(cc.matchIntent(line, real), { kind: "unknown" }, line);
  }
});
