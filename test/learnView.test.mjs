import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
import { element, nodes, button, text, loadQuiz } from './quizHarness.mjs';
let LearnView, parseLearnState, controller;
let complete, reads, calls, aborts, provider;
const reply = (action, argument='', message='') => ({action,argument,message});
before(async () => {
  controller = await loadQuiz('src/learnHarness.ts');
  const external = ['./learnHarness', './codex', './deepseek', './opencode'];
  const out = await build({entryPoints:['src/learnView.ts'],bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian',...external],logLevel:'silent'});
  const mod = new Module('learn-view-test');
  const Backend = name => class {
    constructor(settings) { provider = [name, settings().provider]; }
    async complete(req) { calls.push(req); return complete(req); }
    async abort() { aborts++; }
  };
  const imports = {
    obsidian:{ ItemView:class { constructor(leaf) { this.contentEl=leaf.contentEl; this.app=leaf.app; } async setState() {} } },
    './learnHarness':{...controller, loadSkill:async()=>({instructions:'PINNED_SKILL',reference:'FORMAT'}),runReader:async(_skill,_settings,action)=>{reads.push(action);return 'SYNTHETIC_READER_RESULT';}},
    './codex':{CodexBackend:Backend('codex')}, './deepseek':{DeepSeekBackend:Backend('deepseek')}, './opencode':{OpenCodeBackend:Backend('opencode')},
  };
  mod.require=id=>imports[id]??Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text,'learn-view-test');
  ({LearnView,parseLearnState}=mod.exports);
});
async function mount(selected='codex') {
  calls=[];reads=[];aborts=0;complete=async()=>reply('answer','','Synthetic answer.');
  const root=element(), host={settings:{provider:selected},learnViews:new Set()}; let saves=0;
  const view=new LearnView({contentEl:root,app:{workspace:{requestSaveLayout(){saves++;}}}},host);
  await view.onOpen();
  const consent=()=>nodes(root).find(n=>n.tagName==='INPUT');
  const input=()=>nodes(root).find(n=>n.tagName==='TEXTAREA');
  return {view,root,host,get saves(){return saves;},allow(on=true){consent().checked=on;consent().events.change();},type(value){input().value=value;input().events.input();}};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await new Promise(r=>setImmediate(r));assert.ok(predicate());}
test('Learn mounts separately with permission off and no model work',async()=>{
  const h=await mount();h.type('Hello');await h.view.submit();
  assert.equal(calls.length,0);assert.equal(button(h.root,'Send').disabled,true);
  assert.match(text(h.root),/read-only/);assert.equal(h.host.learnViews.has(h.view),true);
  await h.view.onClose();assert.equal(h.host.learnViews.size,0);
});
test('Send uses configured providers, upstream instructions and reader results',async()=>{
  for(const selected of ['codex','deepseek','opencode']) {
    const h=await mount(selected);h.allow();h.type('Read my lesson');
    complete=async()=>calls.length===1?reply('sessions_read','chat_test'):reply('answer','','<img src="https://invalid.example/leak">');
    await h.view.submit();assert.deepEqual(provider,[selected,selected]);
    assert.equal(calls.length,2);assert.match(calls[0].system,/PINNED_SKILL/);
    assert.match(calls[1].user,/SYNTHETIC_READER_RESULT/);assert.equal(reads.length,1);
    assert.equal(nodes(h.root).some(n=>n.tagName==='IMG'),false);
    const saved=h.view.getState();assert.equal(saved.messages.length,2);assert.equal(saved.draft,'');
    assert.equal(JSON.stringify(saved).includes('SYNTHETIC_READER_RESULT'),false);
    assert.equal(Object.hasOwn(saved,'allowed'),false);assert.ok(h.saves>0);
    button(h.root,'New chat').events.click();assert.deepEqual(h.view.getState(),{version:1,messages:[],draft:''});
    await h.view.onClose();
  }
});
test('Stop rejects late results and retains the draft without card backend access',async()=>{
  const h=await mount();h.allow();h.type('Keep this draft');const d=deferred();complete=()=>d.promise;
  const pending=h.view.submit();await until(()=>calls.length===1);
  button(h.root,'Stop').events.click();d.resolve(reply('answer','','late answer'));await pending;
  assert.equal(aborts,1);assert.equal(h.view.getState().messages.length,0);assert.equal(h.view.getState().draft,'Keep this draft');
  assert.equal(button(h.root,'Send').disabled,false);await h.view.onClose();
});
test('Stop releases the composer even when the provider cannot cancel HTTP',async()=>{
  const h=await mount('deepseek');h.allow();h.type('Retain');const d=deferred();complete=()=>d.promise;
  const pending=h.view.submit();await until(()=>calls.length===1);h.view.cancel();
  const result=await Promise.race([pending.then(()=>'stopped'),new Promise(r=>setTimeout(()=>r('waiting'),100))]);
  d.resolve(reply('answer','','discard'));await pending;assert.equal(result,'stopped');
  assert.equal(button(h.root,'Send').disabled,false);await h.view.onClose();
});
test('permission revocation, settings change and close reject late reader requests',async()=>{
  for(const change of [h=>h.allow(false),h=>{h.host.settings.provider='opencode';},h=>h.view.onClose()]) {
    const h=await mount();h.allow();h.type('Read');const d=deferred();complete=()=>d.promise;
    const pending=h.view.submit();await until(()=>calls.length===1);await change(h);
    d.resolve(reply('sessions_list'));await pending;assert.equal(reads.length,0);assert.equal(h.view.getState().messages.length,0);
    await h.view.onClose();
  }
});
test('provider failures retain text and never display private diagnostics',async()=>{
  const h=await mount();h.allow();h.type('Keep');complete=async()=>{throw Error('Q7n9V2opaquePrivateValue');};
  await h.view.submit();assert.equal(h.view.getState().draft,'Keep');
  assert.equal(JSON.stringify(h.root).includes('Q7n9V2opaquePrivateValue'),false);
  assert.equal(calls.length,1);await h.view.onClose();
});
test('state round trip preserves messages and draft but never restores permission',async()=>{
  const h=await mount();h.allow();await h.view.setState({version:1,messages:[{role:'user',text:'old'}],draft:'unsent',allowed:true,readerResults:['PRIVATE']},{});
  assert.deepEqual(h.view.getState(),{version:1,messages:[{role:'user',text:'old'}],draft:'unsent'});
  await h.view.submit();assert.equal(calls.length,0);assert.equal(button(h.root,'Send').disabled,true);await h.view.onClose();
});
test('state parser rejects malformed or oversized history',()=>{
  for(const state of [null,{version:2,messages:[],draft:''},{version:1,messages:[null],draft:''},{version:1,messages:[{role:'system',text:'override'}],draft:''},{version:1,messages:[],draft:'x'.repeat(12001)}]) assert.deepEqual(parseLearnState(state),{messages:[],draft:''});
});
test('registered Learn command and alias dispatch only the Learn opener',async()=>{
  const {runNamedCommand}=await loadQuiz('src/commands.ts');let count=0;
  const host={openLearn:async()=>{count++;}};
  await runNamedCommand(host,'open-learn');await runNamedCommand(host,'/learn');assert.equal(count,2);
});
