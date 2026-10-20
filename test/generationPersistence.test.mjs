import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let InboxStore, Generator, LlmClient, makeHighlight;
before(async()=>{
  globalThis.window??=globalThis;
  const out=await build({stdin:{contents:`export {Generator} from './src/generator';export {InboxStore} from './src/store';export {LlmClient} from './src/llm';export {makeHighlight} from './src/model';`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian'],logLevel:'silent'});
  const m=new Module('generation-persistence');m.require=id=>id==='obsidian'?{Notice:class{},normalizePath:p=>p}:Module.createRequire(import.meta.url)(id);m._compile(out.outputFiles[0].text,'generation-persistence');({InboxStore,Generator,LlmClient,makeHighlight}=m.exports);
});
const prep={facts:[{id:'F1',statement:'Amber stores heat.',quote:'Amber stores heat.'}],plan:[{id:'P1',factIds:['F1'],entity:'Amber',aspect:'',value:'stores heat',reason:'Stated property'}],omissions:[],exclusions:[],conflicts:[]};
function vault(){
  const files=new Map(),dirs=new Set(['study']);
  const adapter={async exists(p){return files.has(p)||dirs.has(p);},async mkdir(p){dirs.add(p);},async read(p){if(!files.has(p))throw Error('missing');return files.get(p);},async write(p,s){files.set(p,s);},async rename(p,to){assert.ok(files.has(p));assert.equal(files.has(to),false,'Obsidian refuses overwrite rename');files.set(to,files.get(p));files.delete(p);},async remove(p){assert.ok(files.delete(p));}};
  return {files,adapter,app:{vault:{adapter}}};
}
async function fixture(){
  const v=vault(),store=new InboxStore(v.app,'study');await store.load();
  const h=makeHighlight({sourcePath:'synthetic.md',sourceTitle:'Synthetic',text:'Amber stores heat.'});store.add(h);
  const settings={provider:'codex',codexModel:'synthetic',maxCardsPerHighlight:5,language:'',writerInstructions:'',critiquePass:true,historyExamples:false,lintMode:'badge',notifyWhenReady:false,concurrency:1};
  const calls=[],llm=new LlmClient(()=>settings);const backend={async complete(req){calls.push(req.label);const user=JSON.parse(req.user);return req.schema.parse(req.label==='preparation'?prep:req.label==='grounded cards'?{cards:[{planId:'P1',factIds:['F1'],kind:'qa',front:'What does Amber store?',back:'heat',text:''}]}:{verdicts:[{index:0,cardId:user.cards[0].id,status:'verified',reason:'Supported by source'}]});}};llm.codex=backend;
  const plugin={settings,store,llm,refreshStatusBar(){}};
  return {...v,store,h,calls,backend,plugin,g:new Generator(plugin)};
}
test('the real queue preserves concurrent batches without confusing another checkpoint with an unsaved no-op',{timeout:2000},async()=>{
  const f=await fixture();const second=makeHighlight({sourcePath:'second.md',sourceTitle:'Second synthetic',text:'Amber stores heat.'});f.store.add(second);f.plugin.settings.concurrency=2;
  const done=new Promise(resolve=>{f.plugin.refreshStatusBar=()=>{if(f.g.running.size===0&&f.store.all().every(h=>h.status!=='queued'))resolve();};});
  try{f.g.start();await done;assert.deepEqual(f.store.all().map(h=>h.status),['ready','ready']);assert.equal(f.calls.length,6);}finally{f.g.stop();f.store.close();}
});

test('real store reload resumes durable preparation without repeating it',async()=>{
  const f=await fixture();const complete=f.backend.complete;f.backend.complete=async req=>{if(req.label==='grounded cards')throw Error('writer unavailable');return complete(req);};
  await f.g.run(f.h);await f.store.flush();const saved=JSON.parse(f.files.get(f.store.filePath));assert.ok(saved.highlights[0].generation.preparation);f.store.close();
  const reloaded=new InboxStore(f.app,'study');await reloaded.load();f.plugin.store=reloaded;f.backend.complete=complete;
  try{await new Generator(f.plugin).run(reloaded.all()[0]);assert.deepEqual(f.calls,['preparation','grounded cards','audit']);const durable=JSON.parse(f.files.get(reloaded.filePath)).highlights[0];assert.equal(durable.cards.length,1);assert.equal(durable.cards[0].generation.audit.status,'verified');}finally{reloaded.close();}
});
test('real store preparation checkpoint failure stops calls and retains retryable memory',async()=>{
  const f=await fixture(),write=f.adapter.write;f.adapter.write=async(p,s)=>{if(JSON.parse(s).highlights[0].generation?.preparation)throw Error('synthetic disk full');return write(p,s);};
  const error=console.error;console.error=()=>{};
  try{await f.g.run(f.h);assert.deepEqual(f.calls,['preparation']);assert.equal(f.h.status,'error');assert.match(f.h.error,/disk full/);assert.ok(f.h.generation.preparation);f.adapter.write=write;await new Generator(f.plugin).run(f.h);assert.deepEqual(f.calls,['preparation','grounded cards','audit']);assert.equal(f.store.hasUnsavedChanges,false);}finally{console.error=error;f.store.close();}
});
test('source mutation during final real-store write is rolled back durably',async()=>{
  const f=await fixture(),write=f.adapter.write;
  f.adapter.write=async(p,s)=>{await write(p,s);if(JSON.parse(s).highlights[0].generation?.committed)f.h.text='Changed captured text';};
  try{await f.g.run(f.h);assert.equal(f.h.cards.length,0);const durable=JSON.parse(f.files.get(f.store.filePath)).highlights[0];assert.equal(durable.cards.length,0);assert.equal(durable.text,'Changed captured text');}finally{f.store.close();}
});
test('real read-only store does not authorize a single provider request',async()=>{
  const f=await fixture();f.store.close();const s=new InboxStore({vault:{adapter:{exists:async()=>{throw Error('unreadable');}}}},'study');const error=console.error;console.error=()=>{};
  try{await s.load();s.add(f.h);f.plugin.store=s;await new Generator(f.plugin).run(f.h);assert.deepEqual(f.calls,[]);assert.equal(f.h.status,'error');assert.equal(s.hasUnsavedChanges,true);}finally{console.error=error;s.close();}
});

test('generated evidence and card identity survive archive, source rename and real-store reload', async () => {
  const f = await fixture();
  let reloaded;
  try {
    await f.g.run(f.h);
    const id = f.h.cards[0].id;
    f.h.cards[0].status = 'exported';
    f.h.cards[0].ankiNoteId = 123;
    f.h.status = 'exported';
    const generation = structuredClone(f.h.generation);
    assert.equal(f.store.clearExported(), 1);
    assert.equal(f.store.moveSource('synthetic.md', 'renamed.md'), 1);
    await f.store.flush();
    f.store.close();
    reloaded = new InboxStore(f.app, 'study');
    await reloaded.load();
    assert.equal(reloaded.all().length, 0);
    const [history] = reloaded.sourceHistory('renamed.md');
    assert.equal(history.cards[0].id, id);
    assert.equal(history.cards[0].ankiNoteId, 123);
    assert.deepEqual(history.generation, generation);
    assert.equal(history.cards[0].generation.audit.status, 'verified');
    assert.equal(reloaded.hasDuplicate('renamed.md', f.h.text), true);
    assert.deepEqual(f.calls, ['preparation', 'grounded cards', 'audit']);
  } finally {
    f.store.close();
    reloaded?.close();
  }
});

test('source-history rename during generation stops the stale batch before publication', async () => {
  const f = await fixture();
  const complete = f.backend.complete;
  f.backend.complete = async req => {
    const result = await complete(req);
    if (req.label === 'grounded cards') f.store.moveSource('synthetic.md', 'renamed.md');
    return result;
  };
  try {
    await f.g.run(f.h);
    await f.store.flush();
    assert.equal(f.h.status, 'error');
    assert.equal(f.store.sourceHistory('renamed.md')[0].cards.length, 0);
    assert.equal(JSON.parse(f.files.get(f.store.filePath)).highlights[0].cards.length, 0);
    assert.deepEqual(f.calls, ['preparation', 'grounded cards']);
  } finally {
    f.store.close();
  }
});
