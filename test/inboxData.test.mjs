// Run with: npm test  (bundles src/inboxData.ts first, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let d;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wikilm-test-"));
  const out = path.join(dir, "inboxData.mjs");
  await build({ entryPoints: ["src/inboxData.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  d = await import(pathToFileURL(out).href);
});

const savedCard = (extra = {}) => ({ id: "c1", kind: "qa", status: "pending", front: "Q?", back: "A", text: "", extra: "", ...extra });
const savedHighlight = (extra = {}) => ({
  id: "h1", sourcePath: "a.pdf", sourceTitle: "A", text: "kept", before: "", after: "", instruction: "",
  status: "ready", cards: [], ...extra,
});

const savedPreparation = () => ({
  facts: [{ id: "F1", statement: "kept", quote: "kept" }],
  plan: [{ id: "P1", factIds: ["F1"], entity: "A", aspect: "", value: "kept", reason: "stated" }],
  exclusions: [{ factIds: ["F2"], reason: "not tested" }], omissions: [], conflicts: [{ quote: "conflict", reason: "check" }],
});
const savedBatch = () => ({
  version: 1, id: "batch", instruction: "", inputKey: "key", phase: "complete", preparation: savedPreparation(),
  drafts: [savedCard()], audit: { status: "unverified", reason: "check", verdicts: [{ index: 0, cardId: "c1", status: "unverified", reason: "check" }] },
  auditRequested: true, committed: true,
});
const nestedHighlight = () => savedHighlight({
  cards: [savedCard({
    generation: { batchId: "batch", planId: "P1", factIds: ["F1"], audit: { status: "verified", reason: "checked", content: "wording" } },
    userCheck: { content: "wording", at: "now", issues: [] }, lintFailures: [], lintWarnings: [],
  })], generation: savedBatch(), generationHistory: [savedBatch()],
});

function rev(overrides = {}) {
  return {
    cardId: "c-1",
    at: "2026-09-19T00:00:00.000Z",
    via: "edit",
    instruction: "",
    before: { kind: "qa", front: "old front", back: "old back", text: "", extra: "" },
    after: { kind: "qa", front: "new front", back: "new back", text: "", extra: "" },
    ...overrides,
  };
}

// --- emptyInbox --------------------------------------------------------------

test("emptyInbox returns version 1 with an empty highlights array", () => {
  assert.deepEqual(d.emptyInbox(), { version: 1, highlights: [] });
});

// --- parseInboxJson ----------------------------------------------------------

test("parseInboxJson round-trips a valid file", () => {
  const data = { version: 1, highlights: [savedHighlight()] };
  const result = d.parseInboxJson(JSON.stringify(data));
  assert.deepEqual(result, { ok: true, data, fresh: false });
});

for (const phase of ['repairing', 'rechecking', 'blocked']) test(`parseInboxJson retains ${phase} private recovery checkpoints and history`, () => {
  const batch = { ...savedBatch(), phase, blocked: [{ cardId: 'c1', reasons: ['Needs its subject'] }], repairs: [{ cardId: 'c1', round: 1, findings: ['Needs its subject'], requested: true, content: 'old', candidate: savedCard() }] };
  const data = { version: 1, highlights: [savedHighlight({ generation: batch, generationHistory: [batch] })] };
  assert.deepEqual(d.parseInboxJson(JSON.stringify(data)), { ok: true, data, fresh: false });
});

for (const [field, value] of [
  ['blocked', [{ cardId: 'c1', reasons: null }]], ['blocked', [null]],
  ['retryFindings', [{ cardId: 'c1', reasons: 7 }]], ['repairs', [{ cardId: 'c1', round: 1, content: 'old', findings: [], requested: true, candidate: null }]],
  ['finalAudit', { status: 'verified', reason: 'checked', verdicts: null }], ['auditHistory', [null]],
  ['preparationRequested', 'yes'], ['writingRequested', 'yes'], ['finalAuditRequested', 'yes'], ['repairRound', 'one'],
]) test(`parseInboxJson rejects malformed generation recovery field ${field}: ${JSON.stringify(value)}`, () => {
  const data = { version: 1, highlights: [savedHighlight({ generation: { ...savedBatch(), [field]: value } })] };
  assert.equal(d.parseInboxJson(JSON.stringify(data)).ok, false);
});

test("parseInboxJson treats an empty string as fresh, not corrupt", () => {
  const result = d.parseInboxJson("");
  assert.equal(result.ok, true);
  assert.equal(result.fresh, true);
  assert.deepEqual(result.data, d.emptyInbox());
});

test("parseInboxJson treats whitespace-only content as fresh", () => {
  const result = d.parseInboxJson("  \n");
  assert.equal(result.ok, true);
  assert.equal(result.fresh, true);
  assert.deepEqual(result.data, d.emptyInbox());
});

test("parseInboxJson reports invalid-json for unparseable content", () => {
  const result = d.parseInboxJson("{");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-json");
  assert.equal(typeof result.detail, "string");
  assert.ok(result.detail.length > 0, "detail carries the parse error message");
});

test("parseInboxJson reports bad-shape for an array", () => {
  const result = d.parseInboxJson("[]");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad-shape");
  assert.ok(result.detail.length > 0);
});

test("parseInboxJson reports bad-shape for null", () => {
  const result = d.parseInboxJson("null");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad-shape");
});

test("parseInboxJson reports bad-shape when highlights is missing", () => {
  const result = d.parseInboxJson('{"version":1}');
  assert.equal(result.ok, false);
  assert.equal(result.reason, "bad-shape");
});

test("parseInboxJson accepts a file with extra unknown keys (old files)", () => {
  const data = { version: 1, highlights: [], someFutureField: "kept for forward compat" };
  const result = d.parseInboxJson(JSON.stringify(data));
  assert.deepEqual(result, { ok: true, data, fresh: false });
});

test("legacy highlights without an archive flag are not given invented receipts", () => {
  const legacy = savedHighlight({ status: "exported", cards: [savedCard({ status: "exported" })], subpath: "page=4" });
  const parsed = d.parseInboxJson(JSON.stringify({ version: 1, highlights: [legacy] }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.data.highlights[0], legacy);
});

test("a malformed archive flag is rejected without silently dropping a record", () => {
  const parsed = d.parseInboxJson(JSON.stringify({ version: 1, highlights: [savedHighlight({ archived: "false" })] }));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "bad-shape");
});

test("record validation rejects unsafe highlight fields without filtering the snapshot", async (t) => {
  for (const key of ["id", "sourcePath", "sourceTitle", "text", "before", "after", "instruction", "status"]) {
    for (const value of [null, 42, {}, [], undefined]) {
      await t.test(`${key} = ${JSON.stringify(value)}`, () => {
        const parsed = d.parseInboxJson(JSON.stringify({ highlights: [savedHighlight(), savedHighlight({ [key]: value })] }));
        assert.equal(parsed.ok, false);
        assert.equal(parsed.reason, "bad-shape");
        assert.equal("data" in parsed, false, "no partial writable snapshot escapes validation");
      });
    }
  }
});

test("record validation rejects unsafe card fields", async (t) => {
  for (const key of ["id", "kind", "status", "front", "back", "text", "extra"]) {
    for (const value of [null, 42, {}, [], undefined]) {
      await t.test(`${key} = ${JSON.stringify(value)}`, () => {
        const parsed = d.parseInboxJson(JSON.stringify({ highlights: [savedHighlight({ cards: [savedCard({ [key]: value })] })] }));
        assert.equal(parsed.ok, false);
        assert.equal(parsed.reason, "bad-shape");
      });
    }
  }
});

test("record validation refuses unrecognized lifecycle and card formats", async (t) => {
  for (const [label, h] of [
    ["highlight status", savedHighlight({ status: "unknown" })],
    ["card status", savedHighlight({ cards: [savedCard({ status: "unknown" })] })],
    ["card kind", savedHighlight({ cards: [savedCard({ kind: "unknown" })] })],
  ]) await t.test(label, () => assert.equal(d.parseInboxJson(JSON.stringify({ highlights: [h] })).ok, false));
});

test("nested generation and review metadata must be safe for immediate readers", async (t) => {
  const paths = [
    "cards.0.generation", "cards.0.generation.audit", "cards.0.generation.audit.reason", "cards.0.generation.factIds",
    "cards.0.userCheck", "cards.0.userCheck.issues", "cards.0.lintFailures", "cards.0.lintWarnings",
    "generation", "generation.preparation", "generation.preparation.facts", "generation.preparation.facts.0",
    "generation.preparation.plan", "generation.preparation.plan.0.factIds",
    "generation.preparation.exclusions", "generation.preparation.exclusions.0", "generation.preparation.exclusions.0.factIds",
    "generation.preparation.omissions", "generation.preparation.conflicts", "generation.preparation.conflicts.0",
    "generation.drafts", "generation.drafts.0", "generation.audit", "generation.audit.verdicts", "generation.audit.verdicts.0",
    "generationHistory", "generationHistory.0", "generationHistory.0.preparation.conflicts.0",
  ];
  for (const path of paths) await t.test(path, () => {
    const h = nestedHighlight();
    const keys = path.split(".");
    const key = keys.pop();
    let target = h;
    for (const k of keys) target = target[k];
    target[key] = null;
    const parsed = d.parseInboxJson(JSON.stringify({ highlights: [h] }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "bad-shape");
  });
  const data = { highlights: [nestedHighlight()] };
  assert.deepEqual(d.parseInboxJson(JSON.stringify(data)), { ok: true, data, fresh: false });
});

test("optional inbox collections reject malformed members rather than hiding history", async (t) => {
  const bad = [
    { version: 2 }, { version: null },
    { highlightInstructions: [] }, { highlightInstructions: null }, { highlightInstructions: { "a.md": 5 } },
    { ingested: [] }, { ingested: { "a.md": null } },
    { transcripts: [] }, { transcripts: { "a.md": null } }, { transcripts: { "a.md": { text: 5 } } },
    { revisions: {} }, { revisions: [null] }, { revisions: [rev({ before: null })] },
    { revisions: [rev({ after: { ...rev().after, back: [] } })] }, { revisions: [rev({ instruction: 2 })] },
  ];
  for (const extra of bad) await t.test(JSON.stringify(extra), () => {
    const parsed = d.parseInboxJson(JSON.stringify({ highlights: [savedHighlight()], ...extra }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, "bad-shape");
  });
});

test("present optional metadata must retain its consumer-safe primitive types", async (t) => {
  const cases = [
    ...["line", "page", "heading", "blockId", "title", "origin", "subpath", "error", "createdAt", "generatedAt", "exportedAt"].map(key => ({ highlights: [savedHighlight({ [key]: {} })] })),
    ...["highlightId", "edited", "ankiNoteId", "srNote", "createdAt", "critiqueReason", "bloom", "critiqueRan"].map(key => ({ highlights: [savedHighlight({ cards: [savedCard({ [key]: {} })] })] })),
    ...["origin", "sourceFile", "addedAt", "truncated"].map(key => ({ highlights: [], transcripts: { "a.md": { text: "kept", [key]: {} } } })),
    ...["cardId", "at", "via"].map(key => ({ highlights: [], revisions: [rev({ [key]: {} })] })),
  ];
  for (const data of cases) await t.test(JSON.stringify(data), () => assert.equal(d.parseInboxJson(JSON.stringify(data)).ok, false));
  const legacy = { highlights: [savedHighlight({ page: null, heading: null, blockId: null, error: null, generatedAt: null, exportedAt: null })] };
  assert.deepEqual(d.parseInboxJson(JSON.stringify(legacy)), { ok: true, data: legacy, fresh: false });
});

// --- pushRevision --------------------------------------------------------------

test("pushRevision creates the revisions array when absent", () => {
  const data = d.emptyInbox();
  d.pushRevision(data, rev());
  assert.equal(data.revisions.length, 1);
  assert.deepEqual(data.revisions[0], rev());
});

test("pushRevision appends oldest-first", () => {
  const data = d.emptyInbox();
  d.pushRevision(data, rev({ cardId: "c-1" }));
  d.pushRevision(data, rev({ cardId: "c-2" }));
  d.pushRevision(data, rev({ cardId: "c-3" }));
  assert.deepEqual(
    data.revisions.map((r) => r.cardId),
    ["c-1", "c-2", "c-3"],
  );
});

test("pushRevision drops the oldest once the cap is exceeded", () => {
  const data = d.emptyInbox();
  d.pushRevision(data, rev({ cardId: "c-1" }), 3);
  d.pushRevision(data, rev({ cardId: "c-2" }), 3);
  d.pushRevision(data, rev({ cardId: "c-3" }), 3);
  d.pushRevision(data, rev({ cardId: "c-4" }), 3);
  assert.deepEqual(
    data.revisions.map((r) => r.cardId),
    ["c-2", "c-3", "c-4"],
  );
});

test("pushRevision defaults to a cap of 200", () => {
  assert.equal(d.REVISION_CAP, 200);
  const data = d.emptyInbox();
  for (let i = 0; i < 201; i++) d.pushRevision(data, rev({ cardId: `c-${i}` }));
  assert.equal(data.revisions.length, 200);
  assert.equal(data.revisions[0].cardId, "c-1", "the first pushed (c-0) was dropped; c-1 is now oldest");
});

// --- rememberInstruction -------------------------------------------------------

test("rememberInstruction keeps the last instruction per file and creates the map", () => {
  const data = d.emptyInbox();
  d.rememberInstruction(data, "a.md", "only the numbers");
  d.rememberInstruction(data, "a.md", "only the definitions");
  assert.deepEqual(data.highlightInstructions, { "a.md": "only the definitions" });
});

test("rememberInstruction forgets a file when the instruction is emptied", () => {
  const data = d.emptyInbox();
  d.rememberInstruction(data, "a.md", "x");
  d.rememberInstruction(data, "a.md", "   ");
  assert.deepEqual(data.highlightInstructions, {});
});

test("rememberInstruction keeps the most recently used files once past the cap", () => {
  const data = d.emptyInbox();
  d.rememberInstruction(data, "a.md", "1", 2);
  d.rememberInstruction(data, "b.md", "2", 2);
  d.rememberInstruction(data, "a.md", "1 again", 2); // a is now the most recent
  d.rememberInstruction(data, "c.md", "3", 2);
  assert.deepEqual(Object.keys(data.highlightInstructions), ["a.md", "c.md"]);
  assert.equal(data.highlightInstructions["a.md"], "1 again");
});

// "Write more cards" used to set h.instruction = extra, so the Ask or quiz-miss
// instruction the highlight was captured with was lost for good. The extra
// instruction now lasts one run: nextInstruction picks what that run reads.
test("nextInstruction: an extra instruction is used for the run", () => {
  assert.equal(d.nextInstruction("From the Ask: explain why", "cover the dates"), "cover the dates");
});

test("nextInstruction: a blank extra falls back to the stored instruction", () => {
  assert.equal(d.nextInstruction("From the Ask: explain why", ""), "From the Ask: explain why");
  assert.equal(d.nextInstruction("From the Ask: explain why", "   "), "From the Ask: explain why");
});

test("nextInstruction: no stored and no extra instruction is empty", () => {
  assert.equal(d.nextInstruction(undefined, ""), "");
});

test("nextInstruction: the stored instruction is left alone", () => {
  const h = { instruction: "From the quiz: missed the mechanism" };
  d.nextInstruction(h.instruction, "cover the dates");
  assert.equal(h.instruction, "From the quiz: missed the mechanism");
});
