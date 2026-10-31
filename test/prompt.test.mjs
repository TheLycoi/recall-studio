// Run with: npm test (checks the remaining flashcard request schemas).
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { loadQuiz } from './quizHarness.mjs';

/**
 * The card schema goes to Codex through `z.toJSONSchema`,
 * which runs strict: every property listed in `required` and no extra
 * properties, at every level. A `.optional()` or a `.default()` slipped into
 * a card schema would show up here as a property missing from `required`.
 */
function assertStrict(node, path, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (node.type === "object") {
    const props = Object.keys(node.properties ?? {});
    assert.deepEqual(
      [...(node.required ?? [])].sort(),
      [...props].sort(),
      `${path}: every property must be required (got ${JSON.stringify(node.required)} for ${JSON.stringify(props)})`,
    );
    assert.equal(node.additionalProperties, false, `${path}: additionalProperties must be false`);
    for (const [k, v] of Object.entries(node.properties ?? {})) assertStrict(v, `${path}.${k}`, seen);
  }
  if (node.type === "array") assertStrict(node.items, `${path}[]`, seen);
  // Nullable review ordinals are supported; card variants keep flat sentinels.
  if (node.anyOf) {
    assert.match(path, /\.reviews\[\]\.ordinal$/);
    assert.deepEqual(node.anyOf.map(branch => branch.type), ["integer", "null"]);
    node.anyOf.forEach(branch => assertStrict(branch, path, seen));
  }
  for (const key of ["oneOf", "allOf"]) assert.equal(node[key], undefined, `${path}: unsupported composition`);
}

test("assembled card schemas retain strict variants and empty-field sentinels", async () => {
  const { LlmClient } = await loadQuiz('src/llm.ts');
  const { makeHighlight, makeCard } = await loadQuiz('src/model.ts');
  const h = makeHighlight({ sourcePath: 'synthetic.md', sourceTitle: 'Zeta', text: 'Zeta stores heat.' });
  const c = makeCard(h.id, { kind: 'qa', front: 'What does Zeta store?', back: 'heat' });
  const requests = [], client = new LlmClient(() => ({ provider: 'codex', language: '' }));
  client.codex = { complete: async req => {
    requests.push(req);
    return req.schema.parse(req.label === 'cards' ? { cards: [] } : req.label === 'verdicts' ? { verdicts: [] } : { kind: 'qa', front: c.front, back: c.back, text: '' });
  } };
  await client.writeCards(h);
  await client.critiqueCards(h, [c]);
  await client.rewriteCard(h, c, 'Keep the supported fact.');
  for (const req of requests) {
    const schema = z.toJSONSchema(req.schema);
    assertStrict(schema, req.label);
    const fields = schema.properties.cards?.items?.properties ?? schema.properties.verdicts?.items?.properties ?? schema.properties;
    for (const field of ['front', 'back', 'text']) assert.match(fields[field].description, /Empty string/);
    assert.deepEqual(fields.kind.enum, ['qa', 'cloze']);
    if (req.label !== 'verdicts') assert.match(fields.back.description, /explanation.*procedure/);
  }
});
