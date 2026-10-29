import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz, element, text, button, nodes } from './quizHarness.mjs';

let ExportWarningModal, InboxView, RecallPlugin, makeHighlight, makeCard, cardContent, cardAuditContent, generationSourceKey;
let exportDecision;
const dialogs = [];
class Modal {
  constructor() { this.contentEl = element(); }
  open() { this.onOpen(); dialogs.push(this); exportDecision?.(this); }
  close() { this.onClose(); }
}
class Setting {
  constructor(root) { this.root = root; }
  addButton(configure) {
    const el = this.root.createEl('button');
    const control = {
      setButtonText(value) { el.setText(value); return this; },
      onClick(fn) { el.addEventListener('click', fn); return this; },
    };
    configure(control);
    return this;
  }
}
before(async () => {
  ({ ExportWarningModal } = await loadQuiz('src/modals.ts', { Modal, Setting }));
  ({ InboxView } = await loadQuiz('src/inboxView.ts'));
  ({ default: RecallPlugin } = await loadQuiz('src/main.ts', {
    Modal, Setting,
    Plugin: class { constructor(app) { this.app = app; } },
  }));
  ({ makeHighlight, makeCard } = await loadQuiz('src/model.ts'));
  ({ cardContent } = await loadQuiz('src/cardActions.ts'));
  ({ cardAuditContent, generationSourceKey } = await loadQuiz('src/generation.ts'));
});

function inboxFixture() {
  const root = element();
  const h = makeHighlight({ sourcePath: 'source.md', sourceTitle: 'Source', text: 'Amber stores heat.', status: 'ready' });
  const c = makeCard(h.id, { kind: 'qa', front: 'What does Amber store?', back: 'heat' });
  h.cards = [c];
  const view = new InboxView({ contentEl: root }, { settings: { lintMode: 'badge' }, store: { all: () => [h] }, app: {} });
  return { root, h, c, view };
}

test('Inbox and Evidence omit certification decoration for legacy, checked and changed cards', () => {
  for (const state of ['legacy', 'checked', 'verified', 'card changed', 'capture changed']) {
    const { root, h, c, view } = inboxFixture();
    if (state !== 'legacy') {
      c.generation = { batchId: 'g', planId: 'P1', factIds: ['F1'], audit: { status: 'verified', reason: 'Supported', content: cardAuditContent(c), sourceKey: generationSourceKey(h) } };
      h.generation = { version: 1, id: 'g', inputKey: '', instruction: '', phase: 'complete', audit: { status: 'verified', reason: "Independent audit completed; see each candidate's verdict.", verdicts: [] } };
    }
    if (state === 'checked') c.userCheck = { content: cardContent(c, h), at: 'fixture', issues: [] };
    if (state === 'card changed') c.front = 'Amber stores which form of energy?';
    if (state === 'capture changed') h.text = 'Changed source';
    const before = structuredClone(h);
    view.renderHighlight(root, h);
    assert.doesNotMatch(text(root), /audit|verified|unverified|checked|Supported/i, state);
    const badges = nodes(root).filter(n => n.classes.includes('wikilm-badge')).map(n => n.text);
    assert.deepEqual(badges, ['1 drafts', 'Draft'], `${state} adds no replacement certification badge`);
    let opened;
    view.openSource = source => { opened = source; };
    button(root, 'Open source').events.click({ stopPropagation() {} });
    assert.equal(opened, h);
    assert.deepEqual(h, before);
  }
});

for (const status of ['failed', 'unverified']) test(`generation header keeps ${status} concrete findings without a status label`, () => {
  const { root, h, view } = inboxFixture();
  h.generation = { version: 1, id: 'g', inputKey: '', instruction: '', phase: 'blocked',
    audit: { status: 'verified', reason: 'Initial positive result', verdicts: [] },
    finalAudit: { status, reason: 'Final check found an ambiguous retrieval cue.', verdicts: [] },
    blocked: [{ cardId: 'held', reasons: ['The front needs its subject.'] }],
  };
  const before = structuredClone(h);
  view.renderHighlight(root, h);
  assert.match(text(root), /Final check found an ambiguous retrieval cue\./);
  assert.match(text(root), /The front needs its subject\./);
  assert.doesNotMatch(text(root), /Audit failed|Audit unverified|Audit verified|Initial positive result/i);
  assert.deepEqual(h, before);
});

test('Inbox keeps current check issues, lint and interference without a checked badge', () => {
  const { root, h, c, view } = inboxFixture();
  c.userCheck = { content: cardContent(c, h), at: 'fixture', issues: ['The question needs a visible subject.'] };
  c.lintFailures = ['qa-answer-long'];
  c.lintWarnings = ['shared-answer'];
  c.critiqueReason = 'The answer omits the stated condition.';
  view.crossInterference.set(c.id, ['other']);
  const before = structuredClone(h);
  view.renderCard(root, h, c);
  assert.match(text(root), /The question needs a visible subject\./);
  assert.match(text(root), /The answer omits the stated condition\./);
  const badges = nodes(root).filter(n => n.classes.includes('wikilm-badge')).map(n => n.text);
  assert.ok(badges.includes('shared answer'));
  assert.ok(badges.includes('answer used elsewhere'));
  assert.doesNotMatch(text(root), /checked|verified|unverified/i);
  assert.deepEqual(h, before);
});

test('export warning renders concrete reasons without verification-status prose', () => {
  const summary = { notes: 14, tasks: 23, warnings: [{ cardId: 'long', source: 'Source', reasons: ['answer too long (product style policy)'] }] };
  const items = [{ card: { id: 'long', kind: 'qa', front: 'Which answer?', back: 'Stored answer' } }];
  const before = structuredClone({ summary, items }), decisions = [];
  const modal = new ExportWarningModal({}, summary, items, accepted => decisions.push(accepted));
  modal.open();
  assert.match(text(modal.contentEl), /Review export warnings/);
  assert.match(text(modal.contentEl), /14 notes \/ 23 reviews selected\. 1 notes need your review\./);
  assert.match(text(modal.contentEl), /answer too long \(product style policy\)/);
  assert.match(text(modal.contentEl), /Which answer\? Answer: Stored answer/);
  assert.doesNotMatch(text(modal.contentEl), /verified|unverified|Audit/);
  assert.deepEqual(decisions, []);
  button(modal.contentEl, 'Export despite warnings').events.click();
  assert.deepEqual(decisions, [true]);
  assert.deepEqual({ summary, items }, before);
});

for (const action of ['Cancel', 'close']) test(`export warning ${action} does not accept`, () => {
  const decisions = [];
  const modal = new ExportWarningModal({}, { notes: 1, tasks: 1, warnings: [] }, [], accepted => decisions.push(accepted));
  modal.open();
  if (action === 'close') modal.close();
  else button(modal.contentEl, action).events.click();
  assert.deepEqual(decisions, [false]);
});

function exportFixture() {
  const { h, c } = inboxFixture();
  const sent = [];
  let writes = 0, flushes = 0;
  const plugin = new RecallPlugin({ vault: { getName: () => 'Fixture vault' } });
  plugin.store = { all: () => [h], touch() { writes++; }, async flush() { flushes++; } };
  // Intercept only the final transport; use the production summary and modal gate.
  plugin.sendToAnki = plugin.writeTextFile = async items => {
    assert.equal(c.status, 'approved');
    sent.push(items.map(({ card }) => card.id));
  };
  return { h, c, plugin, sent, writes: () => writes, flushes: () => flushes };
}

async function decide(fn, run) {
  exportDecision = fn;
  try { await run(); } finally { exportDecision = undefined; }
}

for (const method of ['exportHighlights', 'exportAsTextFile']) {
  test(`${method}: clean legacy and edited cards skip the warning modal without changing saved checks`, async () => {
    for (const state of ['legacy', 'changed']) {
      const f = exportFixture();
      if (state === 'changed') {
        f.c.generation = { batchId: 'g', planId: 'P1', factIds: ['F1'], audit: { status: 'verified', reason: 'Supported', content: cardAuditContent(f.c), sourceKey: generationSourceKey(f.h) } };
        f.c.userCheck = { content: cardContent(f.c, f.h), at: 'fixture', issues: [] };
        f.c.front = 'Amber stores which form of energy?';
      }
      const before = structuredClone(f.h), count = dialogs.length;
      await decide(() => assert.fail('A status-only dialog must not open'), () => f.plugin[method]([f.h]));
      assert.equal(dialogs.length, count);
      assert.deepEqual(f.sent, [[f.c.id]]);
      assert.deepEqual(f.h, before);
      assert.equal(f.flushes(), 1);
    }
  });

  for (const action of ['Cancel', 'close', 'Export despite warnings']) {
    test(`${method}: ${action} acts on actual failed and uncertain findings`, async () => {
      for (const status of ['failed', 'unverified']) {
        const f = exportFixture();
        const reason = 'The source does not support the stated storage condition.';
        f.c.generation = { batchId: 'g', planId: 'P1', factIds: ['F1'], audit: { status, reason, content: cardAuditContent(f.c), sourceKey: generationSourceKey(f.h) } };
        f.c.front = 'Amber stores which form of energy?';
        const before = structuredClone(f.h), count = dialogs.length;
        await decide(modal => {
          assert.deepEqual(modal.summary.warnings, [{ cardId: f.c.id, source: 'Source', reasons: [reason] }]);
          assert.ok(text(modal.contentEl).includes(reason));
          assert.doesNotMatch(text(modal.contentEl), /verified|unverified|Audit/);
          if (action === 'close') modal.close();
          else button(modal.contentEl, action).events.click();
        }, () => f.plugin[method]([f.h], new Set([f.c.id])));
        assert.equal(dialogs.length, count + 1);
        assert.deepEqual(f.c.generation, before.cards[0].generation);
        if (action === 'Export despite warnings') {
          assert.deepEqual(f.sent, [[f.c.id]]);
          assert.deepEqual(f.c.exportAcceptance.issues, [reason]);
          assert.equal(f.c.exportAcceptance.content, cardContent(f.c, f.h));
          assert.equal(f.flushes(), 1);
          delete f.c.exportAcceptance;
        } else {
          assert.deepEqual(f.sent, []);
          assert.equal(f.writes(), 0);
          assert.equal(f.flushes(), 0);
        }
        assert.deepEqual(f.h, before);
      }
    });
  }

  for (const change of ['wording', 'conflict', 'unload']) {
    test(`${method}: ${change} during acceptance persistence prevents transport`, async () => {
      const f = exportFixture();
      f.c.critiqueReason = 'The cue omits its subject.';
      f.c.generation = { batchId: 'g', planId: 'P1', factIds: ['F1'], audit: { status: 'failed', reason: 'The claim needs source context.', content: cardAuditContent(f.c), sourceKey: generationSourceKey(f.h) } };
      f.h.generation = { version: 1, id: 'g', phase: 'complete', inputKey: '', instruction: '', preparation: { facts: [], plan: [], conflicts: [], exclusions: [], omissions: [] } };
      const audit = structuredClone(f.c.generation.audit);
      f.plugin.store.flush = async () => {
        assert.ok(f.c.exportAcceptance);
        if (change === 'wording') f.c.front = 'Changed during persistence?';
        if (change === 'conflict') f.h.generation.preparation.conflicts.push({ factIds: ['F1'], quote: 'Amber stores heat.', reason: 'New conflict during persistence.' });
        if (change === 'unload') f.plugin.unloading = Promise.resolve();
      };
      await decide(modal => button(modal.contentEl, 'Export despite warnings').events.click(), () => f.plugin[method]([f.h]));
      assert.deepEqual(f.sent, []);
      assert.equal(f.c.status, 'pending');
      assert.deepEqual(f.c.generation.audit, audit);
    });
  }

  for (const change of ['card', 'audit', 'check', 'conflict', 'destination', 'unload']) {
    test(`${method}: ${change} while warnings are open revokes acceptance`, async () => {
      const f = exportFixture();
      f.c.critiqueReason = 'The cue needs its original condition.';
      f.c.generation = { batchId: 'g', planId: 'P1', factIds: ['F1'], audit: { status: 'failed', reason: 'The claim needs source context.', content: cardAuditContent(f.c), sourceKey: generationSourceKey(f.h) } };
      f.h.generation = { version: 1, id: 'g', phase: 'complete', inputKey: '', instruction: '', preparation: { facts: [], plan: [], conflicts: [], exclusions: [], omissions: [] } };
      await decide(modal => {
        if (change === 'card') f.c.back = 'changed';
        if (change === 'audit') f.c.generation.audit.reason = 'A different recorded concern.';
        if (change === 'check') f.c.userCheck = { content: cardContent(f.c, f.h), at: 'fixture', issues: ['New check concern'] };
        if (change === 'conflict') f.h.generation.preparation.conflicts.push({ factIds: ['F1'], quote: 'Amber stores heat.', reason: 'The source contradicts the claim.' });
        if (change === 'destination') f.plugin.settings.defaultDeck = 'Changed destination';
        if (change === 'unload') f.plugin.unloading = Promise.resolve();
        button(modal.contentEl, 'Export despite warnings').events.click();
      }, () => f.plugin[method]([f.h]));
      assert.deepEqual(f.sent, []);
      assert.equal(f.c.exportAcceptance, undefined);
      assert.equal(f.writes(), 0);
      assert.equal(f.flushes(), 0);
    });
  }
}
