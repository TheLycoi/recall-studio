// Run with: npm test  (bundles src/model.ts, then exercises it with node:test)
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

let m;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "review-inbox-model-"));
  const out = path.join(dir, "model.mjs");
  await build({ entryPoints: ["src/model.ts"], bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent" });
  m = await import(pathToFileURL(out).href);
});

const card = (over) => ({ id: "c", highlightId: "h", kind: "qa", front: "q", back: "a", text: "", extra: "", status: "pending", edited: false, createdAt: "2026-01-01T00:00:00.000Z", ...over });
const hl = (cards) => ({ id: "h", cards });

test("a generated card is a draft (pending), never approved on its own", () => {
  const c = m.makeCard("h", { kind: "qa", front: "q", back: "a" });
  assert.equal(c.status, "pending");
});

test("approvedCards returns only approved cards — the exportable set", () => {
  const h = hl([card({ id: "1", status: "pending" }), card({ id: "2", status: "approved" }), card({ id: "3", status: "approved" }), card({ id: "4", status: "flagged" }), card({ id: "5", status: "exported" })]);
  assert.deepEqual(m.approvedCards(h).map((c) => c.id), ["2", "3"]);
});

test("pendingCards is the draft set and does not include approved cards", () => {
  const h = hl([card({ id: "1", status: "pending" }), card({ id: "2", status: "approved" })]);
  assert.deepEqual(m.pendingCards(h).map((c) => c.id), ["1"]);
});

test("undecidedCards is drafts plus flagged, and never approved", () => {
  const h = hl([card({ id: "1", status: "pending" }), card({ id: "2", status: "approved" }), card({ id: "3", status: "flagged" })]);
  assert.deepEqual(m.undecidedCards(h).map((c) => c.id), ["1", "3"]);
});

test("liveCards drops only deleted cards", () => {
  const h = hl([card({ id: "1", status: "deleted" }), card({ id: "2", status: "approved" })]);
  assert.deepEqual(m.liveCards(h).map((c) => c.id), ["2"]);
});
