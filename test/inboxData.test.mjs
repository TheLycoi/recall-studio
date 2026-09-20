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
  const dir = mkdtempSync(path.join(tmpdir(), "recall-test-"));
  const out = path.join(dir, "inboxData.mjs");
  await build({ entryPoints: ["src/inboxData.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  d = await import(pathToFileURL(out).href);
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
  const data = { version: 1, highlights: [{ id: "h1" }] };
  const result = d.parseInboxJson(JSON.stringify(data));
  assert.deepEqual(result, { ok: true, data, fresh: false });
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
