// Run with: npm test  (bundles src/reviewChatView.ts the way the plugin build
// does, then reads the source and the bundle as text)
//
// Chat is embedded inside Inbox, with vault retrieval, optional source narrowing,
// no tools handed to the model and no general-knowledge fallback.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sharedBuildOptions } from "../scripts/esbuild-shared.mjs";

const SOURCE = () => readFileSync("src/reviewChatView.ts", "utf8");
let js;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-chat-view-"));
  const out = path.join(dir, "reviewChatView.js");
  await build({ ...sharedBuildOptions(), entryPoints: ["src/reviewChatView.ts"], outfile: out, logLevel: "silent" });
  js = readFileSync(out, "utf8");
});

test("the legacy chat view type is retained for workspace migration", () => {
  assert.match(SOURCE(), /VIEW_TYPE_CHAT\s*=\s*"review-inbox-chat"/);
});

test("ChatView is an embedded component, not an ItemView", () => {
  assert.match(SOURCE(), /export class ChatView \{/);
  assert.doesNotMatch(SOURCE(), /extends ItemView/);
  assert.match(SOURCE(), /export const VIEW_TYPE_CHAT/);
});

test("Chat has a heading rather than a separate Inbox/Chat tab switch", () => {
  const s = SOURCE();
  assert.ok(/openInbox\(/.test(s), "no route back to the Inbox");
  assert.match(s, /text:\s*"Chat"/);
  assert.doesNotMatch(s, /role:\s*"tablist"/);
});

test("the view is driven by a structural host, not by importing the plugin", () => {
  const s = SOURCE();
  assert.equal(/from "\.\/main"/.test(s), false, "the view must not import main.ts");
  assert.ok(/interface ChatHost/.test(s), "the host type must be structural");
});

test("optional source narrowing lists Markdown with accessible checkboxes", () => {
  const s = SOURCE();
  assert.ok(/getMarkdownFiles\(\)/.test(s), "markdown files are not listed");
  assert.ok(/cachedRead\(/.test(s), "selected files are not read");
  assert.ok(/type:\s*"checkbox"/.test(s), "no accessible source checkbox");
  // No silent default selection: the class starts with an empty selection.
  assert.ok(/new Set<string>\(\)/.test(s), "the selection does not start empty");
});

test("answers are wired through the chat LlmClient method and the Inbox store", () => {
  const s = SOURCE();
  assert.ok(/answerSelected\(/.test(s), "answerSelected is not called");
  assert.ok(/generator\.enqueue\(/.test(s), "generated drafts are not queued");
  assert.ok(/store\.add\(/.test(s), "the highlight is not added to the store");
  assert.ok(/origin:\s*"ask"/.test(s), "answer rows are not tagged origin ask");
});

test("the model is never handed a tool, and no general-knowledge fallback survives", () => {
  assert.equal(/innerHTML|insertAdjacentHTML/.test(js), false, "model text must be rendered as text");
  assert.equal(/general knowledge/i.test(js), false, "a general-knowledge path must not exist");
  assert.equal(/tools?\s*:|function_call|tools\s*:/i.test(js), false, "no tool schema is sent");
});

test("the view pulls in no wiki-ingestion or quiz graph", () => {
  const s = SOURCE();
  for (const gone of ["digest", "ingestSource", "quiz", "topicNote", "retrieval", "graph"]) {
    assert.equal(new RegExp(`from "\\./${gone}"`).test(s), false, gone);
  }
});

test("nothing the chat view adds says WikiLM, and it carries no MIT notice it should not", () => {
  const s = SOURCE();
  assert.equal(/WikiLM|WikiLm|WIKILM/.test(s), false);
});
