import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let InboxView, makeHighlight, makeCard;
let lastMenu;
const notices=[];
before(async () => {
  const out = await build({stdin:{contents:`export {InboxView} from './src/inboxView'; export {makeHighlight,makeCard} from './src/model';`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian'],logLevel:'silent'});
  const mod = new Module('inbox-view');
  class Menu { constructor(){ this.items=[];lastMenu=this; } addItem(fn){const item={setTitle(t){this.title=t;return this;},setIcon(){return this;},setDisabled(){return this;},onClick(cb){this.click=cb;return this;}};fn(item);this.items.push(item);} showAtMouseEvent(){} }
  const obsidian = new Proxy({ItemView:class {constructor(leaf){this.contentEl=leaf.contentEl;} registerDomEvent(){}},setIcon(){},Menu,Notice:class {constructor(message){notices.push(message);}}}, {get:(o,k)=>o[k] ?? class {}});
  mod.require = id => id === 'obsidian' ? obsidian : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text,'inbox-view');
  ({InboxView,makeHighlight,makeCard}=mod.exports);
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
test('passage Verify checks its visible eligible cards without asking to generate more',async()=>{
  const {root,view,host}=harness();
  const calls=[];view.checkAgainstPractices=async(h,c)=>{calls.push(c.id);return true;};view.renderCard=()=>{};
  const h={id:'h',status:'ready',text:'Source.',createdAt:new Date().toISOString(),cards:[{id:'a',status:'pending'},{id:'b',status:'flagged'},{id:'c',status:'deleted'},{id:'d',status:'approved'},{id:'e',status:'duplicate'},{id:'f',status:'exported'}]};
  host.store.all=()=>[h];host.llm={requestAuthorization:active=>active};
  view.cardIds=()=>h.cards.filter(c=>c.status!=='deleted').map(c=>c.id);
  root.querySelectorAll=()=>[];
  view.renderHighlight(root,h);
  const button=descendants(root).find(e=>e.options.text==='Verify');
  assert.ok(button,'passage must offer a labeled Verify control');
  await button.events.click();
  assert.deepEqual(calls,['a','b','d']);
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