import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let InboxView;
before(async () => {
  const out = await build({entryPoints:['src/inboxView.ts'],bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian'],logLevel:'silent'});
  const mod = new Module('inbox-view');
  const obsidian = new Proxy({ItemView:class {constructor(leaf){this.contentEl=leaf.contentEl;} registerDomEvent(){}},setIcon(){}}, {get:(o,k)=>o[k] ?? class {}});
  mod.require = id => id === 'obsidian' ? obsidian : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text,'inbox-view');
  InboxView=mod.exports.InboxView;
});
function element(tag='div', options={}) {
  return {tagName:tag.toUpperCase(),options,children:[],dataset:{},events:{},scrollTop:0,
    createEl(tag,opts){const e=element(tag,opts);this.children.push(e);return e;},
    createDiv(opts){return this.createEl('div',opts);},createSpan(opts){return this.createEl('span',opts);},
    classes:(options.cls??'').split(/\s+/).filter(Boolean),setText(text){this.text=text;},
    addClass(cls){if(cls!==undefined)this.classes.push(cls);},
    removeClass(cls){this.classes=this.classes.filter(c=>c!==cls);},
    toggleClass(cls,on){if(on)this.addClass(cls);else this.removeClass(cls);},
    hasClass(cls){return this.classes.includes(cls);},
    setAttribute(k,v){this[k]=v;},
    addEventListener(k,fn){this.events[k]=fn;},empty(){this.children=[];},querySelector(){return null;},
  };
}
function descendants(e){return [e,...e.children.flatMap(descendants)];}
function harness(){
  const root=element();
  const host={app:{vault:{getMarkdownFiles:()=>[],getFiles:()=>[],configDir:'.obsidian'}},store:{all:()=>[],onChange:()=>()=>{}},settings:{lintMode:'show'}};
  const view=new InboxView({contentEl:root},host);
  view.renderHeader=()=>{};view.rebuildCrossInterference=()=>{};
  return {root,view,host};
}
test('the passage star checks its live cards without asking to generate more',async()=>{
  const {root,view}=harness();
  const calls=[];view.checkAgainstPractices=async(h,c)=>calls.push(c.id);view.renderCard=()=>{};
  const h={id:'h',status:'ready',text:'Source.',createdAt:new Date().toISOString(),cards:[{id:'a',status:'pending'},{id:'b',status:'flagged'},{id:'c',status:'deleted'},{id:'d',status:'approved'},{id:'e',status:'duplicate'},{id:'f',status:'exported'}]};
  view.renderHighlight(root,h);
  const button=descendants(root).find(e=>e.title==='Check cards against best practices');
  assert.ok(button,'passage star must offer a best-practices check');
  await button.events.click();
  assert.deepEqual(calls,['a','b','d']);
});
test('Inbox redraw preserves the embedded chat and its unfinished question',async()=>{
  const {root,view}=harness();await view.onOpen();
  const chat=view.chat,chatRoot=root.children[1];
  chat.draftQuestion='Unfinished question';
  view.render();
  assert.equal(view.chat,chat);assert.equal(root.children[1],chatRoot);
  assert.equal(chat.draftQuestion,'Unfinished question');
  await view.onClose();assert.equal(chat.cancelled,true);
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
test('Inbox shortcuts leave the Chat textarea alone',()=>{
  const {view}=harness();let prevented=false;
  view.onKey({target:{tagName:'TEXTAREA'},key:'Enter',metaKey:true,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);
});
test('Inbox and Chat are one-at-a-time panels that default to Inbox',async()=>{
  const {root,view}=harness();await view.onOpen();
  const chat=view.chat,chatRoot=root.children[1],cardsEl=view.cardsEl;
  assert.equal(view.panel,'inbox');
  assert.ok(chatRoot.hasClass('review-inbox-hidden'),'Chat must start hidden');
  assert.ok(!cardsEl.hasClass('review-inbox-hidden'),'the Inbox cards must start visible');
  view.tabChat.events.click();
  assert.equal(view.panel,'chat');
  assert.ok(!chatRoot.hasClass('review-inbox-hidden'),'Chat shown when selected');
  assert.ok(cardsEl.hasClass('review-inbox-hidden'),'the Inbox cards hidden while Chat is selected');
  assert.ok(view.inboxHeaderEl.hasClass('review-inbox-hidden'),'Inbox filters/export must hide with its cards');
  assert.equal(view.chat,chat,'the same mounted chat instance must be reused');
  assert.equal(root.children[1],chatRoot,'the chat wrapper must not be rebuilt');
  view.tabInbox.events.click();
  assert.equal(view.panel,'inbox');
  assert.ok(!cardsEl.hasClass('review-inbox-hidden'),'the Inbox cards return when selected');
  await view.onClose();
});
test('switching to Chat keeps the open card editor in the Inbox DOM',async()=>{
  const {view}=harness();await view.onOpen();
  const cardsEl=view.cardsEl,editor=element();editor.value='Unsaved edit';cardsEl.children.push(editor);
  view.editing='c';view.contentEl.querySelector=sel=>sel.includes('.wikilm-editor')?editor:null;
  view.chat.draftQuestion='Unsent';view.chat.turns=[{question:'Earlier question'}];
  const turns=view.chat.turns;
  view.tabChat.events.click();view.render();
  assert.ok(cardsEl.children.includes(editor),'the open editor must survive the switch');
  assert.ok(cardsEl.hasClass('review-inbox-hidden'));
  view.tabInbox.events.click();
  assert.ok(cardsEl.children.includes(editor));assert.equal(editor.value,'Unsaved edit');
  assert.equal(view.chat.draftQuestion,'Unsent');assert.equal(view.chat.turns,turns);
});
test('switching panels restores their independent scroll positions',async()=>{
  const {view}=harness();await view.onOpen();
  view.contentEl.scrollTop=120;view.tabChat.events.click();
  assert.equal(view.contentEl.scrollTop,0);
  view.contentEl.scrollTop=30;view.tabInbox.events.click();
  assert.equal(view.contentEl.scrollTop,120);
  view.tabChat.events.click();assert.equal(view.contentEl.scrollTop,30);
});
test('toggle buttons survive switches and background redraws',async()=>{
  const {view}=harness();await view.onOpen();
  const inbox=view.tabInbox,chat=view.tabChat;
  chat.events.click();view.render();
  assert.equal(view.tabChat,chat);assert.equal(view.tabInbox,inbox);
  assert.equal(chat['aria-pressed'],'true');assert.ok(chat.hasClass('is-active'));
  inbox.events.click();
  assert.equal(view.tabInbox,inbox);assert.equal(inbox['aria-pressed'],'true');
  assert.equal(chat['aria-pressed'],'false');
});
test('reopening the same view defaults to Inbox',async()=>{
  const {view}=harness();await view.onOpen();view.tabChat.events.click();
  await view.onClose();await view.onOpen();
  assert.equal(view.panel,'inbox');
});
test('background changes while chatting redraw cards only on return',async()=>{
  const {view}=harness();await view.onOpen();
  const original=view.cardsEl.children[0],chat=view.chat;
  chat.draftQuestion='Unsent question';
  view.tabChat.events.click();view.render();
  assert.equal(view.cardsEl.children[0],original);
  assert.equal(view.chat,chat);assert.equal(chat.draftQuestion,'Unsent question');
  view.tabInbox.events.click();
  assert.notEqual(view.cardsEl.children[0],original);
  assert.equal(view.chat,chat);assert.equal(chat.draftQuestion,'Unsent question');
});
test('focusChat selects Chat before focusing the question box',async()=>{
  const {view}=harness();await view.onOpen();
  let focused=false;const box={focus(){focused=true;}};
  view.contentEl.querySelector=sel=>sel==='.review-chat textarea'?box:null;
  view.focusChat();
  assert.equal(view.panel,'chat','focusChat must select the Chat panel');
  assert.ok(focused,'the question box must receive focus');
});
test('Inbox shortcuts do not act on hidden cards while Chat is selected',async()=>{
  const {view}=harness();await view.onOpen();
  view.tabChat.events.click();
  let prevented=false;
  view.onKey({target:{tagName:'DIV'},key:'j',preventDefault(){prevented=true;}});
  assert.equal(prevented,false,'j must not move the cursor onto a hidden card');
  let exported=false;view.exportHighlights=async()=>{exported=true;};
  view.onKey({target:{tagName:'DIV'},key:'Enter',metaKey:true,preventDefault(){prevented=true;}});
  assert.equal(exported,false,'the export shortcut must not fire while Chat is selected');
});
