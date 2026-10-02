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

// The ids and names in the table, in order. An id change orphans a user's
// hotkey, a name change moves the entry in the palette. Updated for the
// command simplification (2026-09-28): the palette commands first, then
// the four the chat still reaches by alias. Five commands were removed outright
// and their aliases moved onto the command that absorbed them. On 2026-10-01
// the two digest commands became one "Digest…" with a picker (digest-folder
// removed, its alias absorbed) and upstream's lint (lint-wiki-upstream, in
// the palette since 2026-09-29) went chat-only, leaving one Lint wiki whose
// name leads with links.
const EXPECTED = [
  ["ai-highlight", "AI highlight…"],
  ["digest-pdf-highlights", "Digest…"],
  ["lint-wiki", "Lint wiki: create missing links, fix dead links, check quotes"],
  ["capture-selection", "Send selection to inbox"],
  ["capture-selection-with-instruction", "Send selection to inbox with instructions…"],
  ["open-chat", "Open chat: ask the notes"],
  ["open-inbox", "Open inbox"],
  ["export-reviewed", "Export all reviewed cards to Anki"],
  ["cancel-ingestion", "Cancel the running AI highlight, digest or ingest"],
  ["open-schema", "Open the schema note"],
  ["review-schema-suggestions", "Review schema suggestions"],
  ["lint-wiki-upstream", "Lint wiki (llm-wiki): scan and Smart Fix All"],
  ["ingest-source", "Ingest source: read this markdown into the wiki"],
  ["ingest-folder", "Ingest folder: read every note in a folder into the wiki"],
  ["capture-markdown-highlights", "Send all ==highlights== in this note to inbox"],
  ["retry-failed", "Retry failed highlights"],
];

const HIDDEN = ["lint-wiki-upstream", "ingest-source", "ingest-folder", "capture-markdown-highlights", "retry-failed"];
const REMOVED = ["capture-pdf-selection", "capture-pdf-selection-with-instruction", "ai-highlight-with-instruction", "ai-highlight-pdf", "add-transcript", "digest-folder"];

test("COMMAND_TABLE holds the sixteen (id, name) pairs verbatim and in order", () => {
  assert.equal(table.COMMAND_TABLE.length, 16);
  assert.deepEqual(
    table.COMMAND_TABLE.map((c) => [c.id, c.name]),
    EXPECTED,
  );
});

test("exactly the five chat-only commands are hidden, and the removed ones are gone", () => {
  assert.deepEqual(
    table.COMMAND_TABLE.filter((c) => c.hidden).map((c) => c.id),
    HIDDEN,
  );
  for (const id of REMOVED) assert.ok(!table.COMMAND_TABLE.some((c) => c.id === id), `${id} should be removed`);
});

test("the palette gets the eleven visible commands and none of the hidden ones", () => {
  const palette = table.paletteCommands(table.COMMAND_TABLE);
  assert.equal(palette.length, 11);
  assert.deepEqual(
    palette.map((c) => c.id),
    EXPECTED.slice(0, 11).map(([id]) => id),
  );
  for (const id of HIDDEN) assert.ok(!palette.some((c) => c.id === id), `${id} must not reach the palette`);
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
    { path: "classes/BIO101/Receptors.md", title: "Receptors", aliases: ["Drug Receptors"], classCodes: ["BIO101"], hasPdfLinks: true },
    { path: "classes/PHED163/Stages of Change.md", title: "Stages of Change", aliases: [], classCodes: ["PHED163"], hasPdfLinks: false },
  ],
  pdfs: [
    { path: "sources/class notes/BIO101/BIO101 History of Doping and Oversight.pdf", basename: "BIO101 History of Doping and Oversight" },
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
  assert.deepEqual(cc.matchIntent("quiz me on receptors", CTX), { kind: "quiz", target: { kind: "page", path: "classes/BIO101/Receptors.md", title: "Receptors" } });
  assert.deepEqual(cc.matchIntent("test me on drug receptors", CTX).target, { kind: "page", path: "classes/BIO101/Receptors.md", title: "Receptors" });
  assert.deepEqual(cc.matchIntent("quiz me on bio101", CTX).target, { kind: "class", code: "BIO101" });
  assert.deepEqual(cc.matchIntent("quiz me about affinity and binding", CTX).target, { kind: "query", words: "affinity and binding" });
});

test("digest and highlight phrases resolve a PDF, a manifest, a note with PDF links, or the active file", () => {
  assert.deepEqual(cc.matchIntent("digest", CTX), { kind: "digest", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("AI digest this", CTX), { kind: "digest", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("digest the doping pdf", CTX).target, {
    kind: "pdf",
    path: "sources/class notes/BIO101/BIO101 History of Doping and Oversight.pdf",
    basename: "BIO101 History of Doping and Oversight",
  });
  assert.deepEqual(cc.matchIntent("digest receptors", CTX).target, { kind: "page", path: "classes/BIO101/Receptors.md", title: "Receptors" });
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
  assert.deepEqual(cc.matchIntent("retry", CTX), { kind: "command", id: "retry-failed" });
  // The schema aliases reach the exact-alias match at the bottom of the
  // matcher rather than being eaten by an earlier verb rule: "suggest" opens
  // AI highlight, and "suggestions" must not.
  assert.deepEqual(cc.matchIntent("schema", CTX), { kind: "command", id: "open-schema" });
  assert.deepEqual(cc.matchIntent("/suggestions", CTX), { kind: "command", id: "review-schema-suggestions" });
});

test("hidden commands are still matched by their aliases", () => {
  assert.deepEqual(cc.matchIntent("/ingest", CTX), { kind: "command", id: "ingest-source" });
  assert.deepEqual(cc.matchIntent("ingest-folder", CTX), { kind: "command", id: "ingest-folder" });
  assert.deepEqual(cc.matchIntent("/highlights", CTX), { kind: "command", id: "capture-markdown-highlights" });
  assert.deepEqual(cc.matchIntent("/retry", CTX), { kind: "command", id: "retry-failed" });
});

test("the aliases of removed commands reach the command that absorbed them", () => {
  assert.deepEqual(cc.matchIntent("pdf", CTX), { kind: "command", id: "capture-selection" });
  assert.deepEqual(cc.matchIntent("/pdf-instruct", CTX), { kind: "command", id: "capture-selection-with-instruction" });
  for (const alias of ["ai", "ai-instruct", "suggest", "transcript"]) {
    assert.deepEqual(cc.matchIntent(alias, CTX), { kind: "command", id: "ai-highlight" }, alias);
  }
  assert.deepEqual(cc.matchIntent("digest-folder", CTX), { kind: "command", id: "digest-pdf-highlights" });
  for (const alias of ["llm-wiki-lint", "smart-fix"]) {
    assert.deepEqual(cc.matchIntent(alias, CTX), { kind: "command", id: "lint-wiki-upstream" }, alias);
  }
});

test("help lists the hidden commands on a chat-only line", () => {
  const help = cc.renderHelp();
  const line = help.split("\n").find((l) => /chat only/i.test(l));
  assert.ok(line, "help has a chat-only line");
  for (const c of table.COMMAND_TABLE.filter((c) => c.hidden)) assert.ok(line.includes(`**${c.aliases[0]}**`), `chat-only line names ${c.aliases[0]}`);
  assert.ok(!/\*\*schema\*\*/.test(line), "a palette command is not listed as chat only");
});

test("a leading slash is tolerated and means the same thing", () => {
  assert.deepEqual(cc.matchIntent("/quiz receptors", CTX).target.kind, "page");
  assert.deepEqual(cc.matchIntent("/digest", CTX), { kind: "digest", target: { kind: "active" } });
  assert.deepEqual(cc.matchIntent("/help", CTX), { kind: "help" });
});

test("the all-vault scope is reachable as a phrase, while quiz-shaped prose stays a question", () => {
  const all = { kind: "quiz", target: { kind: "query", words: "" } };
  assert.deepEqual(cc.matchIntent("/quiz all", CTX), all);
  assert.deepEqual(cc.matchIntent("quiz all", CTX), all);
  assert.deepEqual(cc.matchIntent("quiz everything", CTX), all);
  assert.deepEqual(cc.matchIntent("quiz results are in", CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("test the hypothesis", CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("drill down into receptors", CTX), { kind: "question" });
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

// ---- 2.0: a question scoped to a class

const SCOPE_CTX = {
  pages: [
    { path: "wiki/concepts/Kinetics.md", title: "Kinetics", aliases: [], classCodes: ["HBIO408"], hasPdfLinks: true },
    { path: "wiki/concepts/Stages of Change.md", title: "Stages of Change", aliases: [], classCodes: ["PHED163"], hasPdfLinks: true },
  ],
  pdfs: [],
  manifests: [],
  commands: [],
};

test("'ask HBIO408 what is impulse' and 'what is impulse in HBIO408' are questions scoped to that class", () => {
  assert.deepEqual(cc.matchIntent("ask HBIO408 what is impulse", SCOPE_CTX), { kind: "question", classCode: "HBIO408", text: "what is impulse" });
  assert.deepEqual(cc.matchIntent("What is impulse in hbio408?", SCOPE_CTX), { kind: "question", classCode: "HBIO408", text: "What is impulse" });
  assert.deepEqual(cc.matchIntent("in PHED163, what is decisional balance", SCOPE_CTX), { kind: "question", classCode: "PHED163", text: "what is decisional balance" });
});

test("a code no page carries, or a bare 'ask', is an ordinary question", () => {
  assert.deepEqual(cc.matchIntent("ask BIOL101 what is impulse", SCOPE_CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("what happens in the cell", SCOPE_CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("ask", SCOPE_CTX), { kind: "question" });
});

// ---- send the last answer to the inbox ------------------------------------------

test("send to inbox and its plain-language forms card the last answer; a question that mentions the inbox stays a question", () => {
  for (const phrase of ["send to inbox", "send it to the inbox", "Send the answer to inbox", "card it", "make flashcards", "flashcard this"]) {
    assert.deepEqual(cc.matchIntent(phrase, CTX), { kind: "send-answer" }, phrase);
  }
  assert.equal(cc.matchIntent("inbox", CTX).kind, "inbox", "the bare word still opens the inbox");
  assert.equal(cc.matchIntent("what does the inbox send to the writer?", CTX).kind, "question");
  assert.match(cc.renderHelp(), /\*\*send to inbox\*\*/);
});

// ---- 2.0 ask cleanup: send phrases (B3), file verbs that open questions (A15),
// ---- "ask about X in CODE" (C15), help text (B6)

test("every plain way of asking to send the last answer is the send-answer intent", () => {
  const phrases = [
    "send to inbox",
    "send answer to inbox",
    "send the answer to inbox",
    "send it",
    "send that",
    "send this",
    "add to inbox",
    "add that to inbox",
    "card it",
    "card that",
    "card the answer",
    "card this answer",
  ];
  for (const phrase of phrases) {
    assert.deepEqual(cc.matchIntent(phrase, CTX), { kind: "send-answer" }, phrase);
    assert.deepEqual(cc.matchIntent(phrase.toUpperCase(), CTX), { kind: "send-answer" }, `${phrase} in capitals`);
    assert.deepEqual(cc.matchIntent(`${phrase}.`, CTX), { kind: "send-answer" }, `${phrase} with a full stop`);
  }
});

test("bare 'send' stays the capture alias, and questions that start with send or card stay questions", () => {
  assert.deepEqual(cc.matchIntent("send", CTX), { kind: "command", id: "capture-selection" });
  assert.deepEqual(cc.matchIntent("send a signal down the axon?", CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("what does card sorting measure", CTX), { kind: "question" });
});

test("a file verb leading a real question is a question when no file fits", () => {
  assert.deepEqual(cc.matchIntent("highlight the differences between kinetics and kinematics", CTX), { kind: "question" });
  assert.deepEqual(cc.matchIntent("digest the main arguments of the doping debate", CTX), { kind: "question" });
  // A short name that fits nothing is still a file command that missed, so
  // the panel says "Nothing called…" rather than answering "lab4".
  const miss = cc.matchIntent("digest lab4", CTX);
  assert.equal(miss.kind, "ambiguous");
  assert.deepEqual(miss.candidates, []);
  assert.equal(miss.words, "lab4");
});

test("a file verb leading a question keeps a class scope the line names", () => {
  assert.deepEqual(cc.matchIntent("highlight the differences between kinetics and kinematics in HBIO408", SCOPE_CTX), {
    kind: "question",
    classCode: "HBIO408",
    text: "highlight the differences between kinetics and kinematics",
  });
});

test("'ask about X in CODE' keeps its class", () => {
  assert.deepEqual(cc.matchIntent("ask about impulse in HBIO408", SCOPE_CTX), { kind: "question", classCode: "HBIO408", text: "impulse" });
  assert.deepEqual(cc.matchIntent("ask what is impulse in hbio408?", SCOPE_CTX), { kind: "question", classCode: "HBIO408", text: "what is impulse" });
});

test("help describes one inbox row per answer, lists the send phrases, and the class scope", () => {
  const help = cc.renderHelp();
  assert.ok(!/one inbox item per source/.test(help), "the retired one-item-per-source wording is gone");
  assert.match(help, /one inbox row per answer, with the sources it rested on beneath it/);
  for (const p of ["send it", "add to inbox", "card it"]) assert.ok(help.includes(p), `help lists ${p}`);
  assert.ok(help.includes("**ask BIO101 …**") && help.includes("**… in BIO101**"));
});
