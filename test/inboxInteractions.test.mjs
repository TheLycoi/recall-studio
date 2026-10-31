import { auditVerdict } from './auditFixture.mjs';
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let InboxView, makeHighlight, makeCard, RECALL_COMMANDS, Generator, LlmClient;
let lastMenu;
const notices=[];
before(async () => {
  globalThis.window ??= globalThis;
  window.requestAnimationFrame ??= callback => setImmediate(callback);
  window.cancelAnimationFrame ??= handle => clearImmediate(handle);
  const out = await build({stdin:{contents:`export {InboxView} from './src/inboxView'; export {makeHighlight,makeCard} from './src/model'; export {RECALL_COMMANDS} from './src/commands'; export {Generator} from './src/generator'; export {LlmClient} from './src/llm';`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian'],logLevel:'silent'});
  const mod = new Module('inbox-view');
  class Menu { constructor(){ this.items=[];lastMenu=this; } addItem(fn){const item={setTitle(t){this.title=t;return this;},setIcon(){return this;},setDisabled(){return this;},onClick(cb){this.click=cb;return this;}};fn(item);this.items.push(item);} showAtMouseEvent(){} }
  const obsidian = new Proxy({ItemView:class {constructor(leaf){this.contentEl=leaf.contentEl;} registerDomEvent(){}},setIcon(){},Menu,Notice:class {constructor(message){notices.push(message);}}}, {get:(o,k)=>o[k] ?? class {}});
  mod.require = id => id === 'obsidian' ? obsidian : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text,'inbox-view');
  ({InboxView,makeHighlight,makeCard,RECALL_COMMANDS,Generator,LlmClient}=mod.exports);
});
function element(tag='div', options={}) {
  return {tagName:tag.toUpperCase(),options,children:[],dataset:{},events:{},scrollTop:0,
    createEl(tag,opts){const e=element(tag,opts);e.parent=this;this.children.push(e);return e;},
    createDiv(opts){return this.createEl('div',opts);},createSpan(opts){return this.createEl('span',opts);},
    classes:(options.cls??'').split(/\s+/).filter(Boolean),setText(text){this.text=text;},
    addClass(cls){if(cls!==undefined)this.classes.push(cls);},
    removeClass(cls){this.classes=this.classes.filter(c=>c!==cls);},
    toggleClass(cls,on){if(on)this.addClass(cls);else this.removeClass(cls);},
    hasClass(cls){return this.classes.includes(cls);},
    setAttribute(k,v){this[k]=v;},
    appendText(text){this.children.push(element('span',{text}));},
    closest(selector){for(let e=this;e;e=e.parent){if(selector.split(',').some(s=>s.trim().startsWith('.')?s.trim().slice(1).split('.').every(c=>e.classes.includes(c)):e.tagName===s.trim().toUpperCase()))return e;}return null;},
    addEventListener(k,fn){this.events[k]=fn;},empty(){this.children=[];},querySelector(){return null;},
  };
}
function descendants(e){return [e,...e.children.flatMap(descendants)];}
function summaryHarness() {
  const {root,view,host}=harness();
  view.renderHeader=InboxView.prototype.renderHeader;
  view.rebuildCrossInterference=InboxView.prototype.rebuildCrossInterference;
  host.store.counts=()=>({toReview:2,queued:0,generating:0,errors:0});
  host.schema={openCount:()=>0};
  const h=makeHighlight({sourcePath:'test.md',sourceTitle:'Test',text:'Amber stores heat and releases energy.',status:'ready'});
  h.cards=[makeCard(h.id,{kind:'qa',front:'What does Amber store?',back:'heat'}),makeCard(h.id,{kind:'cloze',text:'{{c1::Amber}} stores {{c2::heat}}; {{c1::Amber}} releases energy.'})];
  host.store.all=()=>[h];
  root.querySelectorAll=selector=>descendants(root).filter(e=>selector.slice(1).split('.').every(c=>e.classes.includes(c)));
  const exports=[];
  host.exportHighlights=async(list,ids)=>exports.push({list,ids:[...ids]});
  return {root,view,host,h,exports};
}

test('Export summary counts notes and distinct retrieval tasks without an approval step',async()=>{
  const {root,view,h,exports}=summaryHarness();
  await view.onOpen();
  const summaries=descendants(root).filter(e=>e.classes.includes('wikilm-export-summary'));
  assert.equal(summaries.length,3,'header, source and passage summaries');
  for(const summary of summaries) {
    const text=descendants(summary).map(e=>e.text??e.options.text??'').join('\n');
    assert.match(text,/2 notes · 3 expected retrieval tasks/);
    assert.match(text,/warning/);
  }
  assert.equal(exports.length,0,'rendering never exports');
  const buttons=descendants(root).filter(e=>e.tagName==='BUTTON');
  assert.ok(!buttons.some(e=>/approve|confirm/i.test(e.options.text??'')));
  buttons.find(e=>e.title?.includes('⌘⏎')).events.click();
  await Promise.resolve();
  assert.deepEqual(exports[0].ids,h.cards.map(c=>c.id));
});
function harness(){
  const root=element();
  const host={app:{workspace:{},metadataCache:{},vault:{getMarkdownFiles:()=>[],getFiles:()=>[],configDir:'.obsidian'}},store:{all:()=>[],onChange:()=>()=>{}},settings:{lintMode:'show'}};
  const view=new InboxView({contentEl:root},host);
  view.renderHeader=()=>{};view.rebuildCrossInterference=()=>{};
  return {root,view,host};
}

function textOf(root) { return descendants(root).map(e => e.text ?? e.options.text ?? '').join('\n'); }

function heldHarness() {
  const f = summaryHarness();
  f.h.cards = [f.h.cards[0]];
  f.h.generation = { version: 1, id: 'batch', phase: 'blocked', instruction: '', inputKey: '', drafts: [makeCard(f.h.id, { front: 'PRIVATE ORIGINAL', back: 'Private answer' })], blocked: [{ cardId: 'held', reasons: ['The front needs its subject.', 'Final audit rejected the repair.'] }], audit: { status: 'verified', reason: 'Initial pass', verdicts: [] }, finalAudit: { status: 'failed', reason: 'Final checker found a problem', verdicts: [] } };
  const retries = [], enqueues = [];
  f.host.generator = new Generator(f.host);
  f.host.generator.kick = () => {};
  const retry = f.host.generator.retry.bind(f.host.generator);
  f.host.generator.retry = h => { retries.push(h.id); retry(h); };
  f.host.generator.enqueue = h => enqueues.push(h.id);
  return { ...f, retries, enqueues };
}

test('partial generation shows held counts, reasons and final audit without exposing private drafts', async () => {
  const { root, view, h, exports } = heldHarness();
  const original = structuredClone(h);
  await view.onOpen();
  assert.match(textOf(root), /1 held/);
  const sourceHead = descendants(root).find(e => e.classes.includes('wikilm-source-head'));
  assert.match(textOf(sourceHead), /1 held/);
  const heldStat = descendants(root).filter(e => e.classes.includes('wikilm-stat')).find(e => /held/.test(textOf(e)));
  assert.ok(heldStat, 'header counts held drafts separately from published review cards');
  assert.match(textOf(root), /The front needs its subject/);
  assert.match(textOf(root), /Final checker found a problem/);
  assert.doesNotMatch(textOf(root), /PRIVATE ORIGINAL|Private answer/);
  assert.equal(descendants(root).filter(e => e.classes.includes('wikilm-card')).length, 1);
  assert.deepEqual(h, original, 'rendering must not mutate private or published records');
  descendants(root).find(e => e.title?.includes('⌘⏎')).events.click();
  await Promise.resolve();
  assert.deepEqual(exports[0].ids, h.cards.map(c => c.id));
});

for (const phase of ['preparing', 'writing', 'auditing', 'repairing', 'rechecking']) test(`generation UI shows the actual ${phase} phase`, async () => {
  const { root, view, h } = heldHarness();
  h.status = 'generating'; h.generation.phase = phase; h.generation.blocked = [];
  await view.onOpen();
  assert.match(textOf(root), new RegExp(phase));
  assert.doesNotMatch(textOf(root), /PRIVATE ORIGINAL/);
});

for (const entry of ['header', 'passage', 'source', 'menu', 'command']) test(`${entry} Retry authorizes held ready captures without restarting archived, dismissed or busy work`, async () => {
  const f = heldHarness(), { root, view, host, h, retries } = f;
  const extra = ['error', 'ready', 'generating', 'queued', 'dismissed', 'ready', 'ready'].map((status, i) => ({ ...structuredClone(h), id: `other-${i}`, status, archived: i === 1 }));
  // Even a ready capture can still have its final checkpoint running.
  host.generator.running.add(extra[5].id);
  extra[6].generation.blocked = [];
  host.store.all = () => [h, ...extra];
  await view.onOpen();
  if (entry === 'command') RECALL_COMMANDS.find(c => c.id === 'retry-failed').run(host);
  else if (entry === 'menu') {
    descendants(root).find(e => e.title === 'More actions').events.click({});
    lastMenu.items.find(i => /^Retry/.test(i.title)).click();
  } else {
    const target = entry === 'header' ? descendants(root).find(e => e.classes.includes('wikilm-retry-btn'))
      : entry === 'source' ? descendants(root).find(e => e.classes.includes('wikilm-source-actions'))?.children.find(e => e.options.text === 'Retry')
      : descendants(root).find(e => e.title === 'Retry');
    assert.ok(target, `mounted ${entry} retry`);
    target.events.click();
  }
  assert.deepEqual(retries, entry === 'passage' ? [h.id] : [h.id, extra[0].id]);
  assert.equal(h.generation.repairRound, 1, 'retry must authorize a new bounded round');
});

test('the real queue exposes held Retry after its busy final checkpoint settles', async () => {
  const { root, view, host, h } = summaryHarness();
  Object.assign(host.settings, { provider: 'codex', codexModel: 'synthetic', concurrency: 1, historyExamples: false, notifyWhenReady: false });
  host.refreshStatusBar = () => {};
  host.llm = new LlmClient(() => host.settings);
  host.llm.codex = { complete: async req => {
    if (req.label === 'preparation') return req.schema.parse({ facts: [{ id: 'F1', statement: h.text, quote: h.text }], plan: [{ id: 'P1', factIds: ['F1'], entity: 'Amber', aspect: 'storage', value: 'heat', reason: 'Stated' }], exclusions: [], omissions: [], conflicts: [] });
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [{ planId: 'P1', factIds: ['F1'], kind: 'qa', front: 'What does Amber release?', back: 'energy', text: '' }] });
    if (req.label === 'generation repair') throw Error('Synthetic repair unavailable');
    return req.schema.parse({ verdicts: JSON.parse(req.user).cards.map((card, index) => (auditVerdict(card, { index, cardId: card.id, status: 'failed', reason: 'Synthetic held candidate' }))) });
  } };
  host.generator = new Generator(host);
  let release, paused = false;
  const gate = new Promise(resolve => { release = resolve; });
  host.store.flush = async () => { if (h.generation?.phase === 'blocked') { paused = true; await gate; } };
  host.store.touch = host.store.notify = () => view.scheduleRender();
  const settle = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setImmediate(r)); assert.ok(predicate(), 'queue barrier reached'); };
  try {
    await view.onOpen(); host.generator.enqueue(h);
    await settle(() => paused); await new Promise(r => setImmediate(r));
    assert.equal(h.status, 'ready'); assert.equal(h.generation.phase, 'blocked');
    assert.equal(descendants(root).some(e => e.classes.includes('wikilm-retry-btn')), false, 'do not retry a still-running final checkpoint');
    release(); await settle(() => host.generator.running.size === 0);
    await new Promise(r => setImmediate(r));
    assert.ok(descendants(root).some(e => e.classes.includes('wikilm-retry-btn')), 'busy completion must notify the mounted view');
  } finally { release(); await host.generator.stop(); await view.onClose(); }
});

test('mounted Retry rechecks current busy and dismissal state before authorizing a round', async () => {
  const { root, view, host, h, retries } = heldHarness(); await view.onOpen();
  const retry = descendants(root).find(e => e.classes.includes('wikilm-retry-btn'));
  host.generator.running.add(h.id); retry.events.click();
  host.generator.running.delete(h.id); h.status = 'dismissed'; retry.events.click();
  h.status = 'ready'; h.archived = true; retry.events.click();
  assert.deepEqual(retries, []);
  assert.equal(h.generation.repairRound, undefined);
});

test('held retry schedules rather than replacing an unsaved editor', async () => {
  const { root, view, h } = heldHarness(); await view.onOpen();
  view.editing = h.cards[0].id;
  const editor = element('textarea', { text: 'Unsaved draft' });
  root.querySelector = selector => selector.includes('wikilm-editor') ? editor : null;
  const mounted = root.children;
  descendants(root).find(e => e.classes.includes('wikilm-retry-btn')).events.click();
  assert.equal(root.children, mounted);
  assert.equal(editor.options.text, 'Unsaved draft');
});

test('review keeps an active held capture visible even when its published cards were exported', async () => {
  const { root, view, h } = heldHarness();
  h.status = 'exported'; h.cards[0].status = 'exported';
  await view.onOpen();
  assert.ok(view.visibleHighlights().includes(h));
  assert.match(textOf(root), /1 held/);
});

function summaryText(root) {
  const summary=descendants(root).find(e=>e.classes.includes('wikilm-export-summary'));
  return descendants(summary).map(e=>e.text??e.options.text??'').join('\n');
}

test('summary follows collapsed sources and hidden flagged groups through real redraws',async()=>{
  const {root,view,host,h}=summaryHarness();
  host.settings.lintMode='hide';h.cards[1].status='flagged';
  await view.onOpen();
  assert.match(summaryText(root),/1 note · 1 expected retrieval task/);
  descendants(root).find(e=>e.classes.includes('wikilm-flagged-toggle')).events.click();
  assert.match(summaryText(root),/2 notes · 3 expected retrieval tasks/);
  descendants(root).find(e=>e.classes.includes('wikilm-collapse')).events.click();
  assert.match(summaryText(root),/0 notes · 0 expected retrieval tasks/);
  descendants(root).find(e=>e.classes.includes('wikilm-collapse')).events.click();
  assert.match(summaryText(root),/2 notes · 3 expected retrieval tasks/);
});

test('export recomputes current visible IDs instead of trusting the displayed summary',async()=>{
  const {root,view,h,exports}=summaryHarness();await view.onOpen();
  assert.match(summaryText(root),/2 notes/);
  root.querySelectorAll=()=>[{dataset:{id:h.cards[0].id},closest:()=>null}];
  descendants(root).find(e=>e.title?.includes('⌘⏎')).events.click();
  await Promise.resolve();
  assert.deepEqual(exports[0].ids,[h.cards[0].id]);
  assert.match(summaryText(root),/1 note · 1 expected retrieval task/);
});

test('summary refresh does not replace an unsaved editor',async()=>{
  const {root,view,h}=summaryHarness();await view.onOpen();
  const editor=element('textarea',{text:'Unsaved wording'});
  view.editing=h.cards[0].id;
  root.querySelector=selector=>selector.includes('wikilm-editor')?editor:null;
  const children=root.children;
  h.cards[1].status='exported';
  view.scheduleRender();
  assert.equal(root.children,children);assert.equal(editor.options.text,'Unsaved wording');
  assert.match(summaryText(root),/1 note · 1 expected retrieval task/);
});

test('Evidence is collapsed, reads safely, and opens only the existing source action',async()=>{
  const {root,view,h,exports}=summaryHarness();await view.onOpen();
  const details=descendants(root).find(e=>e.classes.includes('wikilm-evidence'));
  assert.equal(details.tagName,'DETAILS');assert.ok(!details.open);
  let opened;
  view.openSource=async(source)=>{opened=source;};
  descendants(details).find(e=>e.options.text==='Open source').events.click({stopPropagation(){}});
  assert.equal(opened,h);assert.equal(exports.length,0);
  let prevented=false;
  view.focusedCard=h.cards[0].id;
  view.onKey({target:{tagName:'SUMMARY'},key:'Enter',preventDefault(){prevented=true;}});
  assert.equal(prevented,false);assert.equal(exports.length,0);
});
test('collision warnings cover draft and flagged cards that Export accepts',()=>{
  const {view,host}=harness();
  host.store.all=()=>['pending','flagged'].map((status,i)=>({id:`h${i}`,status:'ready',cards:[{id:`c${i}`,kind:'qa',front:`Question ${i}?`,back:'The same answer',status}]}));
  InboxView.prototype.rebuildCrossInterference.call(view);
  assert.deepEqual(view.crossInterference.get('c0'),['c1']);
  assert.deepEqual(view.crossInterference.get('c1'),['c0']);
});
test('collapsed sources do not offer an Export button for hidden cards',()=>{
  const {root,view}=harness();
  view.renderHighlight=()=>{};
  const list=[{sourceTitle:'Source',cards:[{status:'pending'}]}];
  view.collapsed.add('source.md');view.renderSource(root,'source.md',list);
  assert.equal(descendants(root).filter(e=>e.options.text==='Export').length,0);
  root.empty();view.collapsed.clear();view.renderSource(root,'source.md',list);
  assert.equal(descendants(root).filter(e=>e.options.text==='Export').length,1);
});
test('native button activation never reaches card export shortcuts',async()=>{
  const {view}=harness();await view.onOpen();
  view.cardIds=()=>['c'];view.focusedCard='c';
  view.plugin.store.findCard=()=>({highlight:{id:'h'},card:{id:'c'}});
  let exported=false,prevented=false;
  view.exportHighlights=async()=>{exported=true;};
  for(const key of ['Enter',' ']) view.onKey({target:{tagName:'BUTTON'},key,preventDefault(){prevented=true;}});
  assert.equal(exported,false);assert.equal(prevented,false);
});
test('Inbox shortcuts leave textareas alone',()=>{
  const {view}=harness();let prevented=false;
  view.onKey({target:{tagName:'TEXTAREA'},key:'Enter',metaKey:true,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);
});

test('archive menu reports success only after persistence, and reports a failed write honestly',async()=>{
  const {root,view,host}=harness();
  host.store.counts=()=>({queued:0,generating:0,toReview:0,flagged:0,errors:0});
  let attempts=0;
  host.store.clearExported=()=>attempts++===0?2:0;
  host.store.flush=async()=>{throw Error('disk full');};
  host.schema={openCount:()=>0};host.settings.defaultDeck='Default';
  InboxView.prototype.renderHeader.call(view,root);
  const more=descendants(root).find(e=>e.title==='More actions');
  more.events.click({});
  const item=lastMenu.items.find(i=>/archiv/i.test(i.title));
  assert.ok(item,'the menu must say archive, not clear');
  const before=notices.length;
  const error=console.error;console.error=()=>{};
  try { await item.click(); } finally { console.error=error; }
  assert.ok(notices.slice(before).some(m=>/not saved/i.test(m)));
  assert.ok(!notices.slice(before).some(m=>/archived 2/i.test(m)));
  host.store.flush=async()=>{};
  more.events.click({});
  const retry=lastMenu.items.find(i=>/archiv/i.test(i.title));
  const next=notices.length;
  await retry.click();
  assert.ok(notices.slice(next).some(m=>/saved/i.test(m)));
  assert.ok(!notices.slice(next).some(m=>/archived 2/i.test(m)));
});