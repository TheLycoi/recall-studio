import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let chat, View, anki, Generator;
let ankiResponse;
before(async () => {
  async function load(file) {
    const out = await build({entryPoints:[file], bundle:true, write:false, format:'cjs', platform:'node', external:['obsidian'], logLevel:'silent'});
    const mod = new Module(file);
    mod.require = id => id === 'obsidian' ? { ItemView: class {}, Notice: class {}, requestUrl: async () => ({status:200,json:ankiResponse}) } : Module.createRequire(import.meta.url)(id);
    mod._compile(out.outputFiles[0].text, file);
    return mod.exports;
  }
  chat = await load('src/reviewChat.ts');
  View = (await load('src/reviewChatView.ts')).ChatView;
  anki = await load('src/anki.ts');
  Generator = (await load('src/generator.ts')).Generator;
});
const text = 'Albumin binds drugs but does not transduce a signal.';
const evidence = [{n:1, path:'a.md', title:'A', line:1, page:null, text}];
const draft = (claim, quotes=[{n:1, quote:text}]) => ({coverage:'full', quotes, sentences:[{text:claim, kind:'claim', cited:[1]}]});
test('negation reversal is not verified through matching words', () => {
  assert.equal(chat.checkChatAnswer(draft('Albumin binds drugs and does transduce a signal.'), evidence).report.refused, true);
});
test('fabricated quotes cannot support an otherwise matching claim', () => {
  assert.equal(chat.checkChatAnswer(draft(text,[{n:1,quote:'Fabricated quote'}]),evidence).report.refused,true);
});
test('gap fields cannot smuggle unverified model claims', () => {
  const d=draft(text); d.sentences.push({kind:'gap',text:'INJECTED_UNSUPPORTED_CLAIM',cited:[]});
  assert.ok(!chat.checkChatAnswer(d,evidence).answer.includes('INJECTED_UNSUPPORTED_CLAIM'));
});
test('heading without a blank line does not swallow its passage', () => {
  const result=chat.buildChatEvidence([{...evidence[0],kind:'note',text:'# Topic\n'+text}]);
  assert.equal(result.evidence[0]?.text,text);
  assert.equal(result.evidence[0]?.line,2);
});
test('source change prevents old answers entering the next prompt', () => {
  const v=new View({},{}); v.turns=[{role:'user',text:'Old question'}, {role:'assistant',text:'EXCLUDED_SECRET',selectedPaths:['excluded.md']}];
  v.selectedSourcePaths=()=>['a.md'];
  assert.ok(!JSON.stringify(v.history()).includes('EXCLUDED_SECRET'));
});
test('Chat view type cannot collide with Recall', () => {
  const v=new View({},{}); assert.equal(v.getViewType(),'review-inbox-chat');
});
test('identity preserves distinctions lost by slugification', () => {
  assert.notEqual(anki.cardIdentityTag('A B','c_x'),anki.cardIdentityTag('A-B','c_x'));
});
test('malformed Anki responses cannot supply note identities', async () => {
  const client = new anki.AnkiClient(() => 'http://127.0.0.1:8765');
  for (const response of [null, {}, {error:null,result:'123'}, {error:null,result:[-1]}, {error:null,result:['123']}]) {
    ankiResponse=response;
    await assert.rejects(client.findNotes('tag:test'), /Invalid/);
  }
  ankiResponse={error:null,result:[123]};
  assert.deepEqual(await client.findNotes('tag:test'),[123]);
});
test('media filenames are content-addressed instead of overwriting basenames', async () => {
  const fields=[]; const names=[];
  const fake={createDeck:async()=>1,findNotes:async()=>[],addNotes:async notes=>{fields.push(notes[0].fields);return [123];},storeMediaFile:async n=>{names.push(n);return n;}};
  const h={status:'ready',sourcePath:'a.md',sourceTitle:'A',text:'quote',cards:[]};
  const c={id:'c1',highlightId:'h1',status:'approved',kind:'qa',front:'Question',back:'![[photo.png]]',extra:''};h.cards=[c];
  const ctx={vaultName:'A',deck:'D',settings:{basicModel:'Basic',basicFrontField:'Front',basicBackField:'Back',basicExtraField:'',extraTags:'',includeExtra:true},resolveMedia:async()=>({path:'photo.png',data:Uint8Array.from([1,2,3]).buffer})};
  await anki.exportToAnki(fake,[{card:c,highlight:h}],ctx);
  assert.match(names[0],/^review-inbox-[a-f0-9]{64}\.png$/);
  assert.ok(fields[0].Back.includes(names[0]));
});

test('an unapproved card changed during identity lookup is not sent', async () => {
  const c={id:'c2',status:'approved',kind:'qa',front:'Q',back:'A',extra:''};
  const h={status:'ready',cards:[c],sourcePath:'a.md',sourceTitle:'A',text:'A'};
  let adds=0;
  const fake={createDeck:async()=>1,findNotes:async()=>{c.status='pending';return [];},addNotes:async()=>{adds++;return [1];}};
  await anki.exportToAnki(fake,[{card:c,highlight:h}],{vaultName:'A',deck:'D',settings:{basicModel:'Basic',basicFrontField:'Front',basicBackField:'Back',extraTags:''}});
  assert.equal(adds,0);
  assert.equal(c.status,'pending');
});

test('dismissal during background generation is not undone by its response', async () => {
  let finish;
  const response=new Promise(resolve=>{finish=resolve;});
  const plugin={settings:{critiquePass:false,lintMode:'badge',notifyWhenReady:false},store:{touch(){}},llm:{writeCards:()=>response}};
  const g=new Generator(plugin);
  const h={id:'h',text:'A is B.',instruction:'',cards:[],status:'queued'};
  const run=g.run(h);
  h.status='dismissed';
  finish([{kind:'qa',front:'What is A?',back:'B',text:''}]);
  await run;
  assert.equal(h.status,'dismissed');
  assert.equal(h.cards.length,0);
});

test('a captured PDF answer reuses the existing highlight and still queues drafts', async () => {
  const passage = 'Albumin binds drugs but does not transduce a signal.';
  const existing = {
    id: 'h-pdf', sourcePath: 'p.pdf', sourceTitle: 'Paper', text: passage,
    page: 3, line: 1, status: 'exported', instruction: 'from the original capture', origin: 'pdf',
    cards: [{ id: 'c-old', highlightId: 'h-pdf', kind: 'qa', front: 'old q', back: 'old a', status: 'exported' }],
  };
  const added = [];
  const moreCalls = [];
  const enqueued = [];
  // hasDuplicate true models the store knowing the passage is already captured;
  // the view must still be able to produce drafts from it.
  const store = { all: () => [existing], add: (h) => { added.push(h); return h; }, hasDuplicate: () => true };
  const generator = { enqueue: (h) => enqueued.push(h), more: (h, inst) => moreCalls.push([h, inst]) };
  const v = new View({}, { store, generator, app: {}, openInbox() {} });
  v.render = () => {};
  v.selectedSourcePaths = () => ['p.pdf'];
  const turn = {
    role: 'assistant',
    text: `${passage} [1]`,
    evidence: [{ n: 1, path: 'p.pdf', title: 'Paper', page: 3, line: 1, text: passage }],
    report: { coverage: 'full', kept: 1, removed: 0, quotesVerified: 1, quotesRejected: 0, cited: [1], refused: false },
    selectedPaths: ['p.pdf'],
  };
  v.turns = [{ role: 'user', text: 'What binds drugs?' }, turn];
  await v.sendToInbox(turn);

  assert.equal(added.length, 0, 'the existing capture must not be duplicated');
  assert.equal(enqueued.length, 0, 'no new highlight is queued when one already exists');
  assert.equal(moreCalls.length, 1, 'the captured evidence must still produce drafts');
  assert.equal(moreCalls[0][0], existing, 'drafts are written on the existing highlight');
  assert.match(moreCalls[0][1], /What binds drugs\?/, 'the answer steers the run');
  assert.equal(existing.cards.length, 1, 'the existing card list is untouched');
  assert.equal(existing.cards[0].status, 'exported', 'an exported card is neither re-approved nor re-queued');
  assert.equal(existing.instruction, 'from the original capture', 'the stored capture instruction is not overwritten');
  assert.equal(turn.sentToInbox, true);
});

test('an uncaptured answer still adds a new highlight tagged origin ask', async () => {
  const passage = 'The hippocampus consolidates memory.';
  const added = [];
  const enqueued = [];
  const store = { all: () => [], add: (h) => { added.push(h); return h; } };
  const generator = { enqueue: (h) => enqueued.push(h), more: () => { throw new Error('more must not be called for a new capture'); } };
  const v = new View({}, { store, generator, app: {}, openInbox() {} });
  v.render = () => {};
  v.selectedSourcePaths = () => ['n.md'];
  const turn = {
    role: 'assistant',
    text: `${passage} [1]`,
    evidence: [{ n: 1, path: 'n.md', title: 'N', page: null, line: 1, text: passage }],
    report: { coverage: 'full', kept: 1, removed: 0, quotesVerified: 1, quotesRejected: 0, cited: [1], refused: false },
    selectedPaths: ['n.md'],
  };
  v.turns = [{ role: 'user', text: 'What consolidates memory?' }, turn];
  await v.sendToInbox(turn);

  assert.equal(added.length, 1, 'a new passage becomes a new highlight');
  assert.equal(added[0].origin, 'ask', 'the row is tagged origin ask');
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0], added[0]);
});
