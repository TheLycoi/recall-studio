// Candidate-only probe: native Obsidian APIs, synthetic sources/store/transport.
import { Plugin, editorInfoField } from 'obsidian';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { InboxView } from '../src/inboxView';
import RecallPlugin from '../src/main';
import { runNamedCommand } from '../src/commands';
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
      const value = req.label === 'study evidence' ? { selections: JSON.parse(req.user).passages.map(p => ({ id: p.id, quote: p.text })), gaps: [] }
        : req.label === 'preparation' ? { facts: [{ id: 'F1', statement: source, quote: source }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Affinity', aspect: 'definition', value: 'strength', reason: 'Stated in source' }], exclusions: [], omissions: [], conflicts: [] }
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
      host.openChat = RecallPlugin.prototype.openChat.bind(host);
      if (view.containerEl === this.app._probeLeaf.view.containerEl) throw Error('Candidate shares live container');
      mount.appendChild(view.containerEl);
      await view.onOpen();
      const root = view.contentEl;
      const button = label => [...root.querySelectorAll('button')].find(b => b.textContent === label);
      ok(view.getDisplayText() === 'Recall Studio', 'Recall Studio display name');
      ok(getComputedStyle(view.chatEl).display === 'none', 'Quiz starts hidden in the real theme');
      button('Chat').click();
      ok(button('Chat').getAttribute('aria-label') === 'Chat panel', 'Chat tab has its matching accessible name');
      ok(view.chatEl.querySelector('h3')?.textContent === 'Chat' && view.chatEl.textContent.includes('Quiz & Make Flashcards · Experimental'), 'Chat heading keeps experimental activities explicit');
      ok(view.chatEl.querySelector('textarea')?.getAttribute('aria-label') === 'Chat message', 'Shared composer has the Chat accessible name');
      ok(getComputedStyle(view.cardsEl).display === 'none' && getComputedStyle(view.chatEl).display !== 'none', 'Quiz/Inbox panels are mutually exclusive');
      const quiz = view.chat;
      const type = text => { const box = root.querySelector('.review-chat textarea'); box.value = text; box.dispatchEvent(new Event('input')); };
      type('quiz me on Binding sites'); button('Send').click(); await pause();
      ok(quiz.awaitingGuide && !button('Free response') && !calls.length && !reads.length, 'Alias Quiz asks for a fresh guide before reads or provider calls');
      type('Test the definition of affinity.'); button('Send').click(); await wait(() => !!button('Free response'));
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
      button('Cancel').click(); const beforeNewQuiz = calls.length;
      type('quiz me on Binding sites'); button('Send').click(); await pause();
      ok(quiz.awaitingGuide && !button('Multiple choice') && calls.length === beforeNewQuiz, 'A second Quiz cannot reuse the previous guide');
      type('Test the definition of affinity.'); button('Send').click(); await wait(() => !!button('Multiple choice'));
      button('Multiple choice').click(); await wait(() => !quiz.busy);
      ok(quiz.mc?.correctId === 'A' && !view.chatEl.textContent.includes('correctId'), 'Multiple choice keeps answer key internal');
      const beforeGrade = calls.length; button(`A. ${source}`).click();
      ok(calls.length === beforeGrade && quiz.session.results.length === 1, 'Multiple choice grading is local');
      type('unfinished request'); button('Inbox').click(); button('Chat').click();
      ok(quiz.draftQuestion === 'unfinished request', 'Panel round trip retains unfinished request');
      button('Inbox').click();
      ok(!root.querySelector('textarea[aria-label="Inbox command"]') && !button('Send command'), 'Inbox has no message composer');
      const enterStudy = async text => { button('Chat').click(); type(text); button('Send').click(); await pause(); };
      const chatIdentity = view.chat, cardsIdentity = view.cardsEl;
      const studyTextarea = root.querySelector('.review-chat textarea');
      const beforeRejected = { session: quiz.session, plan: quiz.plan, guide: quiz.guide, turns: JSON.stringify(quiz.turns), sources: JSON.stringify([...quiz.unitSources]), calls: calls.length, reads: reads.length, queued: queued.length, captures: store.all().length };
      ok(await host.openChat('Make flashcards on Extra') === false, 'External study command refuses an unfinished Chat draft');
      ok(quiz.draftQuestion === 'unfinished request'
        && root.querySelector('.review-chat textarea') === studyTextarea && studyTextarea.value === 'unfinished request'
        && view.chat === chatIdentity && view.cardsEl === cardsIdentity,
      'External commands preserve the mounted Chat draft');
      ok(quiz.session === beforeRejected.session && quiz.plan === beforeRejected.plan && quiz.guide === beforeRejected.guide
        && JSON.stringify(quiz.turns) === beforeRejected.turns && JSON.stringify([...quiz.unitSources]) === beforeRejected.sources
        && calls.length === beforeRejected.calls && reads.length === beforeRejected.reads
        && queued.length === beforeRejected.queued && store.all().length === beforeRejected.captures,
      'Rejected command leaves study state, reads, requests and captures unchanged');
      type(''); // Explicitly clear the synthetic draft through its normal input event.
      await enterStudy('Make flashcards');
      ok(quiz.awaitingTopic && quiz.studyMode === 'flashcards' && quiz.guide === ''
        && calls.length === beforeRejected.calls && reads.length === beforeRejected.reads, 'Chat Make Flashcards requires a fresh topic');
      type('Extra'); button('Send').click(); await pause();
      ok(quiz.awaitingGuide && view.chat === chatIdentity && view.cardsEl === cardsIdentity, 'Chat requires a fresh guide without replacing the Inbox');
      type('Test the definition of affinity.'); button('Send').click(); await wait(() => !quiz.busy);
      const extraCapture = store.all().find(h => h.sourcePath === extraFile.path);
      ok(extraCapture?.text === source && queued.length === 2 && extraCapture.instruction.includes('Test the definition'), 'Make Flashcards sends exact notes and coverage instructions to the existing queue');
      await wait(() => extraCapture.status === 'ready' || extraCapture.status === 'error');
      ok(extraCapture.cards.length === 1 && extraCapture.cards[0].generation?.audit.status === 'verified', 'Make Flashcards runs the existing writer and audit');
      ok(view.chatEl.querySelector('a[href="synthetic/Extra.md"]') && /Experimental/.test(view.chatEl.textContent), 'Experimental Flashcards retain clickable source provenance');
      button('Inbox').click();
      await enterStudy('Make flashcards on Extra');
      type('Test the definition of affinity.'); button('Send').click(); await wait(() => !quiz.busy);
      ok(queued.length === 2 && store.all().length === 2, 'A fresh repeat cannot generate duplicate captures');
      button('Inbox').click();
      ok(await runNamedCommand(host, '/export') === true, 'Registered export command remains available');
      ok(exports.length === 1 && view.panel === 'inbox', 'Export remains separate from Chat study text');
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
      type('Another unfinished study draft');
      const editorStudyBox = root.querySelector('.review-chat textarea');
      const beforeEditorCommand = { calls: calls.length, reads: reads.length, queued: queued.length, turns: JSON.stringify(quiz.turns) };
      ok(await runNamedCommand(host, '/flashcards') === false, 'Registered study command refuses unfinished Chat text');
      ok(quiz.draftQuestion === 'Another unfinished study draft'
        && root.querySelector('.review-chat textarea') === editorStudyBox && editorStudyBox.value === 'Another unfinished study draft'
        && cardRoot().querySelector('.wikilm-editor') === form && form.isConnected
        && question.value === 'My newer unsaved question after Convert' && sentence.value === 'My newer {{c1::unsaved}} sentence'
        && extra.value === 'My newer unsaved annotation' && JSON.stringify(c) === savedCard && JSON.stringify(store.revisions()) === savedHistory
        && calls.length === beforeEditorCommand.calls && reads.length === beforeEditorCommand.reads
        && queued.length === beforeEditorCommand.queued && JSON.stringify(quiz.turns) === beforeEditorCommand.turns,
      'Rejected registered command preserves the real mounted card editor and Chat draft');
      type(''); button('Inbox').click();
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
      // The writer already ran above; these regressions isolate the explicit capture boundary.
      await generator.stop();
      host.generator.enqueue = h => queued.push(h);
      raw = 'Affinity is the strength with which a drug binds its receptor, and this binding strength describes the interaction between that drug and its receptor. Receptor occupancy is the proportion of receptors occupied by a drug at a given concentration, and occupancy increases as that concentration rises. Efficacy is the capacity of a bound drug to activate its receptor and produce a biological response after binding has occurred.';
      file.stat.mtime++; file.stat.size = raw.length;
      button('Chat').click(); type(`quiz me on ${file.path}`); button('Send').click(); await pause();
      type('Test the stated definitions.'); button('Send').click(); await pause();
      button('Free response').click(); await wait(() => !quiz.busy);
      const splitPoints = quiz.session.items.flatMap(item => item.points);
      ok(splitPoints.length > 1 && splitPoints.every(point => /#s\d+$/.test(point.id) && quiz.unitSources.get(point.id)?.path === file.path), 'Split quiz points retain their original passage provenance');
      const beforeSplit = { captures: store.all().length, queued: queued.length };
      button('Skip').click(); await pause();
      ok(store.all().length === beforeSplit.captures && queued.length === beforeSplit.queued, 'Split-point miss alone does not capture or queue');
      button('Send to Inbox').click(); await pause();
      const splitCapture = store.all().find(h => h.sourcePath === file.path && h.text === raw);
      ok(splitCapture && store.all().length === beforeSplit.captures + 1 && queued.length === beforeSplit.queued + 1 && queued.at(-1) === splitCapture, 'Explicit split-point capture keeps the full original passage and queues once');
      // Two-page synthetic PDF: blank first page, source definition on page 2.
      const pdfBytes = Uint8Array.from(atob('JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA0IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNiAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNyAwIFIgPj4KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago2IDAgb2JqCjw8IC9MZW5ndGggMCA+PgpzdHJlYW0KZW5kc3RyZWFtCmVuZG9iago3IDAgb2JqCjw8IC9MZW5ndGggOTQgPj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiA3MiA3MjAgVGQgKEFmZmluaXR5IGlzIHRoZSBzdHJlbmd0aCB3aXRoIHdoaWNoIGEgZHJ1ZyBiaW5kcyBpdHMgcmVjZXB0b3IuKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA4CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDI0NyAwMDAwMCBuIAowMDAwMDAwMzczIDAwMDAwIG4gCjAwMDAwMDA0NDMgMDAwMDAgbiAKMDAwMDAwMDQ5MSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDggL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjYzNAolJUVPRgo='), c => c.charCodeAt(0));
      const pdfFile = { path: 'synthetic/NativeEvidence.pdf', basename: 'NativeEvidence', extension: 'pdf', stat: { mtime: 1, size: pdfBytes.length } };
      app.vault.getFiles = () => [file, extraFile, pdfFile];
      app.vault.getAbstractFileByPath = path => app.vault.getFiles().find(f => f.path === path) ?? null;
      host.fileAt = app.vault.getAbstractFileByPath;
      app.vault.readBinary = async f => { if (f !== pdfFile) throw Error('Unexpected PDF read'); reads.push(f.path); return pdfBytes.buffer.slice(0); };
      button('Inbox').click();
      const beforePdf = { reads: reads.length, calls: calls.length, captures: store.all().length, queued: queued.length };
      await enterStudy(`Make flashcards on ${pdfFile.path}`);
      ok(quiz.awaitingGuide && reads.length === beforePdf.reads && calls.length === beforePdf.calls, 'Explicit PDF command requires a fresh guide before native extraction');
      type('Test the definition of affinity.'); button('Send').click(); await wait(() => !quiz.busy);
      const pdfCapture = store.all().find(h => h.sourcePath === pdfFile.path);
      ok(pdfCapture?.page === 2 && pdfCapture.text === source && pdfCapture.origin === 'pdf' && reads.slice(beforePdf.reads).every(path => path === pdfFile.path), 'Native PDF.js extraction preserves exact file, page and source text');
      ok(store.all().length === beforePdf.captures + 1 && queued.length === beforePdf.queued + 1 && queued.at(-1) === pdfCapture, 'PDF Make Flashcards queues the exact passage through the existing capture boundary');
      type(`quiz me on ${pdfFile.path}`); button('Send').click(); await pause();
      ok(quiz.awaitingGuide && !button('Free response'), 'PDF Quiz asks for new coverage instead of reusing Flashcards instructions');
      type('Test the definition of affinity.'); button('Send').click(); await pause();
      button('Free response').click(); await wait(() => !quiz.busy);
      ok(!!quiz.session?.current && quiz.turns.at(-1).source?.page === 2 && quiz.turns.at(-1).source?.path === pdfFile.path && view.chatEl.querySelector(`a[href="${pdfFile.path}#page=2"]`), 'Native PDF Quiz starts with page-linked source provenance');
      const beforePdfMiss = queued.length;
      button('Skip').click(); await pause();
      ok(queued.length === beforePdfMiss, 'PDF Quiz miss still requires deliberate capture');
      button('Send to Inbox').click(); await pause();
      ok(queued.length === beforePdfMiss && store.all().filter(h => h.sourcePath === pdfFile.path).length === 1, 'Explicit PDF Quiz capture reuses the existing passage without duplicate queueing');
      const beforeScopeFunctions = { getFiles: app.vault.getFiles, getAbstractFileByPath: app.vault.getAbstractFileByPath, read: app.vault.read, getFileCache: app.metadataCache.getFileCache, isUserIgnored: app.metadataCache.isUserIgnored };
      const ignoredFile = { ...file, path: 'ignored/Private.md', basename: 'Private' };
      app.vault.getFiles = () => [...beforeScopeFunctions.getFiles(), ignoredFile];
      app.vault.getAbstractFileByPath = path => app.vault.getFiles().find(f => f.path === path) ?? null;
      app.vault.read = async f => { if (f === ignoredFile) { reads.push(f.path); throw Error('Excluded synthetic note must not be read'); } return beforeScopeFunctions.read(f); };
      app.metadataCache.isUserIgnored = path => path === ignoredFile.path;
      app.metadataCache.getFileCache = f => f === file ? { frontmatter: { aliases: ['Binding sites', 'missing/Private', 'ignored/Private', 'Missing'] } } : beforeScopeFunctions.getFileCache(f);
      try {
        for (const mode of ['quiz me', 'make flashcards']) for (const requested of ['missing/Private.md', 'ignored/Private.md', '[[Missing.md ]]']) {
          const beforeScope = { reads: reads.length, calls: calls.length, captures: store.all().length, queued: queued.length };
          await enterStudy(`${mode} on ${requested}`);
          ok(quiz.awaitingGuide && reads.length === beforeScope.reads && calls.length === beforeScope.calls, `${mode} ${requested} requests fresh coverage before resolution`);
          type('Test the definition of affinity.'); button('Send').click(); await pause();
          if (button('Free response')) { button('Free response').click(); await wait(() => !quiz.busy); }
          ok(quiz.target === null && !quiz.choices.length && /No eligible note or tag matched/.test(view.chatEl.textContent)
            && reads.length === beforeScope.reads && calls.length === beforeScope.calls
            && store.all().length === beforeScope.captures && queued.length === beforeScope.queued,
          `${mode} ${requested} fails closed before an unrelated alias can read, disclose or capture`);
        }
      } finally {
        Object.assign(app.vault, { getFiles: beforeScopeFunctions.getFiles, getAbstractFileByPath: beforeScopeFunctions.getAbstractFileByPath, read: beforeScopeFunctions.read });
        Object.assign(app.metadataCache, { getFileCache: beforeScopeFunctions.getFileCache, isUserIgnored: beforeScopeFunctions.isUserIgnored });
      }
      return { checks, providerRequests: calls, syntheticDiskFiles: files.size, actualNetworkRequests: 0 };
    } finally {
      readingChild?.unload(); controller?.destroy(); editor?.destroy();
      if (view) { await view.onClose(); view.unload(); }
      store.close(); mount.remove();
      if (refs.size) throw Error(`Leaked ${refs.size} synthetic subscriptions`);
    }
  }
}
