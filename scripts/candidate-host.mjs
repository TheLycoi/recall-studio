// Candidate-only probe: native Obsidian APIs, synthetic sources/store/transport.
import { Plugin, editorInfoField } from 'obsidian';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { InboxView } from '../src/inboxView';
import { LlmClient } from '../src/llm';
import { InboxStore } from '../src/store';
import { Generator } from '../src/generator';
import { makeHighlight, makeCard } from '../src/model';
import { DEFAULT_SETTINGS } from '../src/settings';
import { registerSourceVisibility } from '../src/sourceVisibility';

export default class CandidateProbe extends Plugin {
  async loadCSS() {} // Never install or register this probe's CSS globally.
  async onload() { this.result = await this.verify(); }
  async verify() {
    const checks = [], calls = [];
    const ok = (condition, message) => { if (!condition) throw Error(message); checks.push(message); };
    const pause = () => new Promise(r => setTimeout(r, 20));
    const wait = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await pause(); if (!predicate()) throw Error('Probe timed out'); };
    const source = 'Affinity is the strength with which a drug binds its receptor.';
    const file = { path: 'synthetic/Receptors.md', basename: 'Receptors', extension: 'md', stat: { mtime: 1, size: source.length } };
    let raw = source;
    const files = new Map(), refs = new Set();
    const on = (name, fn) => { const ref = { name, fn }; refs.add(ref); return ref; };
    const offref = ref => refs.delete(ref);
    const adapter = {
      mkdir: async () => {}, exists: async path => path === 'synthetic-data' || files.has(path), read: async path => { if (!files.has(path)) throw Error('missing synthetic file'); return files.get(path); },
      write: async (path, value) => { files.set(path, value); }, remove: async path => { files.delete(path); },
      rename: async (from, to) => { if (!files.has(from) || files.has(to)) throw Error('synthetic rename conflict'); files.set(to, files.get(from)); files.delete(from); },
    };
    const app = {
      vault: { adapter, configDir: '.obsidian', getFiles: () => [file], getAbstractFileByPath: path => path === file.path ? file : null,
        read: async f => { if (f !== file) throw Error('Unexpected source'); return raw; }, on, offref },
      workspace: { getActiveFile: () => file, getLeavesOfType: () => [], on, offref, openLinkText: () => { throw Error('Navigation forbidden'); } },
      metadataCache: { isUserIgnored: () => false, getFileCache: () => ({ frontmatter: { aliases: ['Binding sites'] } }), on, offref },
    };
    const settings = { ...DEFAULT_SETTINGS, schemaLearning: false, srRecognitionEnabled: false, srRecognitionNotePaths: file.path };
    const store = new InboxStore(app, 'synthetic-data');
    const llm = new LlmClient(() => settings);
    const keep = { index: 0, verdict: 'keep', reason: '', bloom: 'remember', kind: 'qa', front: '', back: '', text: '' };
    llm.codex = { complete: async req => {
      calls.push(req.label);
      const value = req.label === 'preparation' ? { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Affinity', aspect: 'definition', value: 'strength', reason: 'Stated in source' }], exclusions: [], omissions: [], conflicts: [] }
        : req.label === 'grounded cards' ? { cards: [{ kind: 'cloze', front: '', back: '', text: source.replace('strength', '{{c1::strength}}'), planId: 'P1', factIds: ['F1'] }] }
        : req.label === 'audit' ? { verdicts: JSON.parse(req.user).cards.map((c, index) => ({ index, cardId: c.id, status: 'verified', reason: 'Supported by source' })) }
        : req.label === 'quiz cue' ? { question: 'What does affinity mean?', shape: 'concept', expects: [1] }
        : req.label === 'quiz question audit' ? { supported: true }
        : req.label === 'grade' ? { points: [{ n: 1, status: 'wrong', said: 'Affinity means mass.', note: '', cue: '' }], feedback: 'UNTRUSTED_FEEDBACK' }
        : req.label === 'quiz grade audit' ? { points: [{ n: 1, agrees: true }] }
        : req.label === 'quiz choices' ? { question: 'Which statement describes affinity?', point: 1, choices: [{ id: 'A', text: source }, { id: 'B', text: 'Affinity is mass.' }], correctId: 'A' }
        : req.label === 'quiz choice audit' ? { choices: [{ id: 'A', supported: true }, { id: 'B', supported: false }] }
        : req.label === 'verdicts' ? { verdicts: [{ ...keep, verdict: req.user.includes('What does it delay?') ? 'revise' : 'keep', reason: 'Name the subject.' }] }
        : req.label === 'card' ? { kind: 'qa', front: 'What does dormancy delay?', back: 'germination', text: '' } : null;
      if (!value) throw Error(`Unexpected provider request: ${req.label}`);
      return req.schema.parse(value);
    } };
    const queued = [];
    const host = { app, settings, store, llm, generator: null, refreshStatusBar() {},
      schema: { openCount: () => 0 }, exportHighlights: () => { throw Error('Export forbidden'); },
      fileAt: path => path === file.path ? file : null, activeMarkdown: () => null, openInbox() {} };
    const generator = new Generator(host);
    host.generator = { enqueue: h => { queued.push(h); generator.enqueue(h); }, more: () => { throw Error('Unexpected more'); } };
    const mount = document.createElement('div');
    mount.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:900px;overflow:auto;pointer-events:none;';
    document.body.appendChild(mount);
    let view, editor, controller, readingChild;
    try {
      view = new InboxView(this.app._probeLeaf, host);
      if (view.containerEl === this.app._probeLeaf.view.containerEl) throw Error('Candidate shares live container');
      mount.appendChild(view.containerEl);
      await view.onOpen();
      const root = view.contentEl;
      const button = label => [...root.querySelectorAll('button')].find(b => b.textContent === label);
      ok(view.getDisplayText() === 'Recall Studio', 'Recall Studio display name');
      ok(getComputedStyle(view.chatEl).display === 'none', 'Quiz starts hidden in the real theme');
      button('Quiz').click();
      ok(getComputedStyle(view.cardsEl).display === 'none' && getComputedStyle(view.chatEl).display !== 'none', 'Quiz/Inbox panels are mutually exclusive');
      const quiz = view.chat;
      const type = text => { const box = root.querySelector('.review-chat textarea'); box.value = text; box.dispatchEvent(new Event('input')); };
      type('quiz me on Binding sites'); button('Start quiz').click(); await pause();
      button('Free response').click(); await wait(() => !quiz.busy);
      ok(!!quiz.session?.current && !view.chatEl.textContent.includes(source), 'Free response hides source answer until attempted');
      type('Affinity means mass.'); button('Submit answer').click(); await wait(() => !quiz.busy);
      ok(view.chatEl.textContent.includes(source) && !view.chatEl.textContent.includes('UNTRUSTED_FEEDBACK'), 'Feedback uses literal source, not generated teaching prose');
      ok(store.all().length === 0 && queued.length === 0, 'A miss creates no cards without consent');
      button('Send to Inbox').click(); await pause();
      ok(store.all().length === 1 && queued.length === 1 && store.all()[0].text === source, 'Explicit capture uses source rather than incorrect answer');
      button('Sent to Inbox').click(); await pause();
      ok(queued.length === 1, 'Repeated capture does not generate again');
      await wait(() => store.all()[0].status === 'ready' || store.all()[0].status === 'error');
      const generated = store.all()[0];
      ok(generated.cards[0]?.kind === 'cloze' && generated.cards[0].generation?.audit.status === 'verified', 'Quiz capture completes preparation, single-cloze writing and audit');
      button('Cancel quiz').click(); type('quiz me'); button('Start quiz').click(); await pause();
      button('Multiple choice').click(); await wait(() => !quiz.busy);
      ok(quiz.mc?.correctId === 'A' && !view.chatEl.textContent.includes('correctId'), 'Multiple choice keeps answer key internal');
      const beforeGrade = calls.length; button(`A. ${source}`).click();
      ok(calls.length === beforeGrade && quiz.session.results.length === 1, 'Multiple choice grading is local');
      type('unfinished request'); button('Inbox').click(); button('Quiz').click();
      ok(quiz.draftQuestion === 'unfinished request', 'Panel round trip retains unfinished request');
      button('Inbox').click();
      const h = makeHighlight({ sourcePath: file.path, sourceTitle: 'Synthetic', text: 'Dormancy delays germination.', status: 'ready' });
      const c = makeCard(h.id, { kind: 'qa', front: 'What does it delay?', back: 'germination' }); h.cards = [c]; store.add(h); view.render();
      root.querySelector(`[data-id="${c.id}"] button[title^="Check card against"]`).click();
      await wait(() => !view.checking.size);
      ok(c.front === 'What does dormancy delay?' && store.revisions().at(-1)?.via === 'repair', 'Real card star repairs and records history');
      await store.flush();
      const restored = new InboxStore(app, 'synthetic-data'); await restored.load();
      ok(restored.findCard(c.id)?.card.front === c.front && restored.revisions().at(-1)?.via === 'repair', 'Repair survives real store serialization and reload'); restored.close();
      generated.cards[0].status = 'exported'; generated.status = 'exported'; store.clearExported(); await store.flush();
      ok(!store.all().includes(generated) && store.sourceHistory(file.path).includes(generated), 'Archived exported capture retains source history');
      // Mount the actual CM6 extension without registering it in the live vault.
      let extension, processor;
      host.registerEditorExtension = value => { extension = value; };
      host.registerMarkdownPostProcessor = value => { processor = value; };
      controller = registerSourceVisibility(host);
      raw = 'Question::Answer <!--SR:!2026-10-20,1,250-->\n\nUntouched nearby prose';
      editor = new EditorView({ parent: mount, state: EditorState.create({ doc: raw, extensions: [editorInfoField.init(() => ({ file })), extension] }) });
      ok(!editor.dom.textContent.includes('Existing SR card'), 'SR recognition starts off');
      settings.srRecognitionEnabled = true; controller.refresh(); await pause();
      ok(editor.dom.querySelectorAll('.ri-source-mark').length === 1 && editor.dom.textContent.includes('Existing SR card'), 'Real CM6 shows only the existing SR card badge');
      ok(editor.state.doc.toString() === raw, 'SR leaves scheduling and source bytes unchanged');
      editor.dom.querySelector('.ri-source-mark').click();
      await wait(() => app._probeModals?.at(-1)?.contentEl.textContent.includes('Existing SR card'));
      const history = app._probeModals.at(-1); mount.appendChild(history.containerEl);
      ok(history.contentEl.textContent.includes('read-only syntax recognition') && !history.contentEl.textContent.includes('<!--SR:'), 'Source history distinguishes existing SR syntax without importing schedules');
      history.close();
      const reading = mount.createDiv(); reading.createEl('p', { text: 'Question::Answer' });
      processor(reading, { sourcePath: file.path, getSectionInfo: () => ({ text: raw, lineStart: 0, lineEnd: 0 }), addChild: child => { readingChild = child; child.load(); } });
      await pause();
      ok(reading.querySelectorAll('.ri-source-mark').length === 0, 'Reading view declines a section containing scheduling markup');
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'Plain unsaved prose' } });
      ok(!editor.dom.textContent.includes('Existing SR card'), 'SR marker disappears after unsaved edit');
      controller.destroy(); controller = null;
      ok(!editor.dom.textContent.includes('Existing SR card'), 'Visibility unload removes markers');
      return { checks, providerRequests: calls, syntheticDiskFiles: files.size, actualNetworkRequests: 0 };
    } finally {
      readingChild?.unload(); controller?.destroy(); editor?.destroy();
      if (view) { await view.onClose(); view.unload(); }
      store.close(); mount.remove();
      if (refs.size) throw Error(`Leaked ${refs.size} synthetic subscriptions`);
    }
  }
}
