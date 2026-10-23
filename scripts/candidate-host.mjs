// Candidate-only probe: native Obsidian APIs, synthetic sources/store/transport.
import { Plugin, editorInfoField } from 'obsidian';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { InboxView } from '../src/inboxView';
import RecallPlugin from '../src/main';
import { runNamedCommand } from '../src/commands';
import { captureSelection } from '../src/capture';
import { LlmClient } from '../src/llm';
import { InboxStore } from '../src/store';
import { Generator } from '../src/generator';
import { makeHighlight, makeCard } from '../src/model';
import { DEFAULT_SETTINGS } from '../src/settings';
import { registerSourceVisibility } from '../src/sourceVisibility';

export default class CandidateProbe extends Plugin {
  async loadCSS() {} // Never install or register this probe's CSS globally.
  async onload() { try { this.result = await this.verify(); } catch (error) { this.result = { error: error.stack }; } }
  async verify() {
    const checks = [], calls = [], reads = [], exports = [];
    const ok = (condition, message) => { if (!condition) throw Error(message); checks.push(message); };
    const pause = () => new Promise(r => setTimeout(r, 20));
    const wait = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await pause(); if (!predicate()) throw Error('Probe timed out'); };
    const source = 'Affinity is the strength with which a drug binds its receptor.';
    const file = { path: 'synthetic/Receptors.md', basename: 'Receptors', extension: 'md', stat: { mtime: 1, size: source.length } };
    let raw = source;
    const extraFile = { ...file, path: 'synthetic/Extra.md', basename: 'Extra', stat: { ...file.stat } };
    const files = new Map(), refs = new Set();
    const on = (name, fn) => { const ref = { name, fn }; refs.add(ref); return ref; };
    const offref = ref => refs.delete(ref);
    const adapter = {
      mkdir: async () => {}, exists: async path => path === 'synthetic-data' || files.has(path), read: async path => { if (!files.has(path)) throw Error('missing synthetic file'); return files.get(path); },
      write: async (path, value) => { files.set(path, value); }, remove: async path => { files.delete(path); },
      rename: async (from, to) => { if (!files.has(from) || files.has(to)) throw Error('synthetic rename conflict'); files.set(to, files.get(from)); files.delete(from); },
    };
    const app = {
      vault: { adapter, configDir: '.obsidian', getFiles: () => [file, extraFile], getAbstractFileByPath: path => [file, extraFile].find(f => f.path === path) ?? null,
        read: async f => { if (![file, extraFile].includes(f)) throw Error('Unexpected source'); reads.push(f.path); return f === file ? raw : source; }, on, offref },
      workspace: { getActiveFile: () => file, getLeavesOfType: () => [], on, offref, openLinkText: () => { throw Error('Navigation forbidden'); } },
      metadataCache: { isUserIgnored: () => false, getFileCache: f => ({ frontmatter: { aliases: f === file ? ['Binding sites'] : [] } }), on, offref },
    };
    const settings = { ...DEFAULT_SETTINGS, schemaLearning: false, srRecognitionEnabled: false, srRecognitionNotePaths: file.path };
    const store = new InboxStore(app, 'synthetic-data');
    await store.load();
    const llm = new LlmClient(() => settings);
    const keep = { index: 0, verdict: 'keep', reason: '', bloom: 'remember', kind: 'qa', front: '', back: '', text: '' };
    llm.codex = { complete: async req => {
      calls.push(req.label);
      const value = req.label === 'preparation' ? { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Affinity', aspect: 'definition', value: 'strength', reason: 'Stated in source' }], exclusions: [], omissions: [], conflicts: [] }
        : req.label === 'grounded cards' ? { cards: [{ kind: 'cloze', front: '', back: '', text: source.replace('strength', '{{c1::strength}}'), planId: 'P1', factIds: ['F1'] }] }
        : req.label === 'audit' ? { verdicts: JSON.parse(req.user).cards.map((c, index) => ({ index, cardId: c.id, status: 'verified', reason: 'Supported by source' })) }
        : req.label === 'verdicts' ? { verdicts: [{ ...keep, verdict: req.user.includes('What does it delay?') ? 'revise' : 'keep', reason: 'Name the subject.' }] }
        : req.label === 'card' ? { kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' } : null;
      if (!value) throw Error(`Unexpected provider request: ${req.label}`);
      return req.schema.parse(value);
    } };
    const queued = [];
    const host = { app, settings, store, llm, generator: null, refreshStatusBar() {},
      schema: { openCount: () => 0 }, exportHighlights: async hs => { exports.push(hs.map(h => h.id)); },
      fileAt: path => [file, extraFile].find(f => f.path === path) ?? null, activeMarkdown: () => null, openInbox() {} };
    const generator = new Generator(host);
    host.generator = { enqueue: h => { queued.push(h); generator.enqueue(h); }, more: () => { throw Error('Unexpected more'); } };
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:900px;overflow:auto;pointer-events:none;';
    mount.dataset.recallCandidateHost = 'true';
    mount.inert = true; // Run synthetic clicks without taking focus from the user's current input.
    document.body.appendChild(mount);
    let view, editor, controller, readingChild;
    try {
      view = new InboxView(this.app._probeLeaf, host);
      Object.assign(app.workspace, { getLeavesOfType: kind => kind === 'review-inbox' ? [{ view }] : [], getRightLeaf: () => null, revealLeaf: async () => {} });
      host.openInbox = RecallPlugin.prototype.openInbox.bind(host);
      if (view.containerEl === this.app._probeLeaf.view.containerEl) throw Error('Candidate shares live container');
      mount.appendChild(view.containerEl);
      await view.onOpen();
      const root = view.contentEl;
      const button = label => [...root.querySelectorAll('button')].find(b => b.textContent === label);
      ok(view.getDisplayText() === 'Recall Studio', 'Recall Studio display name');
      ok(!button('Chat') && !root.querySelector('.wikilm-tabs, .review-inbox-chat, .review-chat'), 'Only Inbox mounts; no hidden Chat or panel switch');
      ok(!root.querySelector('textarea') && getComputedStyle(view.cardsEl).display !== 'none', 'Inbox is visible without a message composer');
      ok(!calls.length && !reads.length, 'Opening Inbox does not start a study request');
      for (const alias of ['/chat', '/flashcards', '/make-flashcards']) {
        ok(await runNamedCommand(host, alias) === null, `${alias} is retired rather than opening a hidden study view`);
      }
      const capture = async f => captureSelection(host, {
        getSelection: () => source, getCursor: which => ({ line: 0, ch: which === 'to' ? source.length : 0 }),
        getValue: () => source, posToOffset: pos => pos.ch, getLine: () => source,
        replaceRange: () => { throw Error('Source marking is disabled in this fixture'); },
      }, f, 'Test the definition of affinity.');
      settings.markMode = 'none';
      const generated = await capture(file);
      await wait(() => generated.status === 'ready' || generated.status === 'error');
      ok(generated.cards[0]?.kind === 'cloze' && generated.cards[0].generation?.audit.status === 'verified', 'Source selection still runs preparation, card writing and audit');
      ok(generated.sourcePath === file.path && generated.text === source, 'Capture retains original source provenance');
      await capture(file);
      ok(queued.length === 1 && store.all().length === 1, 'Repeated source capture does not generate twice');
      const extraCapture = await capture(extraFile);
      await wait(() => extraCapture.status === 'ready' || extraCapture.status === 'error');
      ok(extraCapture.cards.length === 1 && queued.length === 2, 'A second source uses the same Inbox writer');
      ok(exports.length === 0, 'Capture and generation never export automatically');
      ok(await runNamedCommand(host, '/export') === true && exports.length === 1, 'Registered export remains explicitly available');
      const h = makeHighlight({ sourcePath: file.path, sourceTitle: 'Synthetic', text: 'Dormancy delays germination.', status: 'ready' });
      const c = makeCard(h.id, { kind: 'qa', front: 'What does it delay?', back: 'germination' }); h.cards = [c]; store.add(h); view.render();
      root.querySelector(`[data-id="${c.id}"] button[title^="Check card against"]`).click();
      await wait(() => !view.checking.size);
      ok(c.front === 'What does dormancy delay?' && store.revisions().at(-1)?.via === 'repair', 'Real card star repairs and records history');
      const verifyIn = row => [...row.querySelectorAll('button')].find(b => b.textContent === 'Verify');
      for (const [scope, selector, expected] of [['passage', '.wikilm-hl-actions', 1], ['source', '.wikilm-source-actions', 2], ['inbox', '.wikilm-header-right', 3]]) {
        view.render();
        const card = root.querySelector(`[data-id="${c.id}"]`);
        const row = scope === 'passage' ? card.closest('.wikilm-hl').querySelector(selector)
          : scope === 'source' ? card.closest('.wikilm-source').querySelector(selector) : root.querySelector(selector);
        const verify = verifyIn(row), siblings = [...row.children], beforeVerify = calls.filter(c => c === 'verdicts').length;
        ok(verify && siblings[siblings.indexOf(verify) - 1]?.textContent === 'Export' && verify.getAttribute('aria-label'), `${scope} Verify is labeled and immediately follows Export`);
        verify.click(); await wait(() => !view.verifying);
        ok(calls.filter(c => c === 'verdicts').length - beforeVerify === expected && exports.length === 1, `${scope} Verify respects visible scope without exporting`);
      }
      await store.flush();
      const restored = new InboxStore(app, 'synthetic-data'); await restored.load();
      ok(restored.findCard(c.id)?.card.front === c.front && restored.revisions().at(-1)?.via === 'repair', 'Repair survives real store serialization and reload'); restored.close();
      generated.cards[0].status = 'exported'; generated.status = 'exported'; store.clearExported(); await store.flush();
      ok(!store.all().includes(generated) && store.sourceHistory(file.path).includes(generated), 'Archived exported capture retains source history');
      // Optional learning must not redraw over a draft typed after Convert succeeds.
      settings.schemaLearning = true;
      let finishLearning, learningStarted = false, suggestions = 0;
      host.schema.openCount = () => suggestions;
      host.schema.learn = () => { learningStarted = true; return new Promise(resolve => { finishLearning = resolve; }); };
      const complete = llm.codex.complete;
      const converted = { kind: 'cloze', front: '', back: '', text: 'Dormancy delays {{c1::germination}}.' };
      llm.codex.complete = async req => {
        if (req.label !== 'card') return complete(req);
        calls.push(req.label);
        return req.schema.parse(converted);
      };
      const cardRoot = () => root.querySelector(`.wikilm-card[data-id="${c.id}"]`);
      cardRoot().querySelector('button[title="Edit (e)"]').click();
      const originalEditor = cardRoot().querySelector('.wikilm-editor');
      cardRoot().querySelector('button[title="Convert to cloze"]').click();
      await wait(() => learningStarted);
      const form = cardRoot().querySelector('.wikilm-editor'), editorIdentity = view.editorDraft;
      ok(c.kind === 'cloze' && c.text === converted.text && form !== originalEditor && store.revisions().at(-1)?.via === 'rewrite', 'Authorized Convert redraws its accepted replacement and records a rewrite before learning');
      const question = form.querySelector('textarea[aria-label="Question"]');
      const sentence = form.querySelector('textarea[aria-label="Cloze sentence"]');
      const extra = form.querySelector('textarea[aria-label="Extra"]');
      question.value = 'My newer unsaved question after Convert';
      sentence.value = 'My newer {{c1::unsaved}} sentence';
      extra.value = 'My newer unsaved annotation';
      for (const field of [question, sentence, extra]) field.dispatchEvent(new Event('input'));
      const savedCard = JSON.stringify(c), savedHistory = JSON.stringify(store.revisions());
      suggestions = 1; finishLearning(1);
      await wait(() => !view.checking.has(c.id));
      await new Promise(resolve => requestAnimationFrame(resolve));
      const currentEditor = cardRoot().querySelector('.wikilm-editor');
      ok(currentEditor === form && form.isConnected && view.editing === c.id && view.editorDraft === editorIdentity
        && currentEditor.querySelector('textarea[aria-label="Question"]').value === 'My newer unsaved question after Convert'
        && currentEditor.querySelector('textarea[aria-label="Cloze sentence"]').value === 'My newer {{c1::unsaved}} sentence'
        && currentEditor.querySelector('textarea[aria-label="Extra"]').value === 'My newer unsaved annotation', 'Late learning preserves the mounted editor and newer unsaved fields');
      ok(JSON.stringify(c) === savedCard && JSON.stringify(store.revisions()) === savedHistory && !root.querySelector('.wikilm-schema-chip'), 'Learning preserves saved rewrite/history and defers the proposal header while editing');
      const beforeRetired = { calls: calls.length, reads: reads.length, queued: queued.length };
      ok(await runNamedCommand(host, '/flashcards') === null, 'Retired study command remains unavailable with a card editor open');
      ok(cardRoot().querySelector('.wikilm-editor') === form && form.isConnected
        && question.value === 'My newer unsaved question after Convert' && sentence.value === 'My newer {{c1::unsaved}} sentence'
        && extra.value === 'My newer unsaved annotation' && JSON.stringify(c) === savedCard && JSON.stringify(store.revisions()) === savedHistory
        && calls.length === beforeRetired.calls && reads.length === beforeRetired.reads && queued.length === beforeRetired.queued,
        'Retired command preserves the mounted card editor without reads, writes or generation');
      [...currentEditor.querySelectorAll('button')].find(b => b.textContent === 'Cancel').click();
      await wait(() => root.querySelector('.wikilm-schema-chip')?.textContent === '1 card rule suggestion');
      ok(view.editing === null && JSON.stringify(c) === savedCard, 'Cancel releases the proposal header without undoing the accepted rewrite');
      await store.flush();
      const learned = new InboxStore(app, 'synthetic-data'); await learned.load();
      ok(JSON.stringify(learned.findCard(c.id)?.card) === savedCard && JSON.stringify(learned.revisions()) === savedHistory, 'Accepted rewrite and history survive serialization after late learning'); learned.close();
      settings.schemaLearning = false; llm.codex.complete = complete;
      // Mount the actual CM6 extension without registering it in the live vault.
      let extension, processor;
      host.registerEditorExtension = value => { extension = value; };
      host.registerMarkdownPostProcessor = value => { processor = value; };
      controller = registerSourceVisibility(host);
      raw = 'Question::Answer <!--SR:!2026-10-20,1,250-->\n\nUntouched nearby prose';
      editor = new EditorView({ parent: mount, state: EditorState.create({ doc: raw, extensions: [editorInfoField.init(() => ({ file })), extension] }) });
      ok(!editor.dom.textContent.includes('Flashcard'), 'SR recognition starts off');
      settings.srRecognitionEnabled = true; controller.refresh(); await pause();
      ok(editor.dom.querySelectorAll('.ri-source-mark').length === 1 && editor.dom.textContent.includes('Flashcard'), 'Real CM6 shows only the existing SR card badge');
      ok(editor.state.doc.toString() === raw, 'SR leaves scheduling and source bytes unchanged');
      editor.dom.querySelector('.ri-source-mark').click();
      await wait(() => app._probeModals?.at(-1)?.contentEl.textContent.includes('Flashcard'));
      const history = app._probeModals.at(-1); mount.appendChild(history.containerEl);
      ok(history.contentEl.textContent.includes('read-only syntax recognition') && !history.contentEl.textContent.includes('<!--SR:'), 'Source history distinguishes existing SR syntax without importing schedules');
      history.close();
      const reading = mount.createDiv(); reading.createEl('p', { text: 'Question::Answer' });
      processor(reading, { sourcePath: file.path, getSectionInfo: () => ({ text: raw, lineStart: 0, lineEnd: 0 }), addChild: child => { readingChild = child; child.load(); } });
      await pause();
      ok(reading.querySelectorAll('.ri-source-mark').length === 0, 'Reading view declines a section containing scheduling markup');
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'Plain unsaved prose' } });
      ok(!editor.dom.textContent.includes('Flashcard'), 'SR marker disappears after unsaved edit');
      // Inline cards written in an outline note: bullet items, curved cloze and a subdeck tag.
      // Reuse the mounted extension: re-registering would not re-decorate this editor.
      settings.srRecognitionTags = '#flashcards';
      raw = [
        '#flashcards/Psychiatry',
        '',
        '- What is OCD?::A disorder of repetitive unwanted thoughts',
        '',
        '- Nested card',
        '    - Nested::Deep answer',
        '',
        '- OCD is ==repetitive==.',
        '',
        '- OCD is {{unwanted}}.',
        '',
        '- Example:',
        '  ```md',
        '  hidden::answer',
        '  ```',
        '',
        '- OCD is **emphasis only**.',
      ].join('\n');
      file.stat.mtime++; file.stat.size = raw.length;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: raw } });
      controller.refresh(); await pause();
      const inlineBadges = [...editor.dom.querySelectorAll('.ri-source-mark')].map(el => el.textContent);
      ok(inlineBadges.length === 4 && inlineBadges.every(text => text.includes('Flashcard')), 'Real CM6 marks only the four real inline cards in a bulleted note');
      ok(editor.state.doc.toString().includes('hidden::answer') && editor.dom.textContent.includes('hidden::answer'), 'Fenced example inside a list keeps its bytes and gains no badge');
      ok(editor.state.doc.toString() === raw, 'Inline card recognition leaves the outline note unchanged');
      editor.dom.querySelector('.ri-source-mark').click();
      await wait(() => app._probeModals?.at(-1)?.contentEl.textContent.includes('Flashcard'));
      const inlineHistory = app._probeModals.at(-1); mount.appendChild(inlineHistory.containerEl);
      ok(inlineHistory.contentEl.textContent.includes('Suggested deck from the note tag: Psychiatry'), 'Subdeck tag appears only as a suggested deck hint');
      inlineHistory.close();
      settings.srBoldCloze = true; controller.refresh(); await pause();
      ok([...editor.dom.querySelectorAll('.ri-source-mark')].some(el => el.textContent.includes('cloze')), 'Bold becomes a cloze only after the explicit opt-in');
      settings.srBoldCloze = false; controller.destroy(); controller = null;
      await generator.stop();
      return { checks, providerRequests: calls, syntheticDiskFiles: files.size, actualNetworkRequests: 0 };
    } finally {
      readingChild?.unload(); controller?.destroy(); editor?.destroy();
      if (view) { await view.onClose(); view.unload(); }
      await generator.stop(); store.close(); mount.remove();
      if (refs.size) throw Error(`Leaked ${refs.size} synthetic subscriptions`);
    }
  }
}
