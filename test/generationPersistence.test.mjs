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
test('P5 runtime build identity and source/context fingerprints survive the real store round trip', async () => {
  const f = await fixture();
  const buildIdentity = { release: 'synthetic-release', commit: 'synthetic-build-commit' };
  let reloaded;
  try {
    f.g = new Generator(f.plugin, buildIdentity);
    await f.g.run(f.h);
    const batch = structuredClone(f.h.generation);
    const audit = structuredClone(f.h.cards[0].generation.audit);
    assert.deepEqual(batch.provenance.build, buildIdentity);
    assert.deepEqual(batch.audit.provenance, batch.provenance);
    assert.deepEqual(audit.provenance, batch.provenance);
    assert.equal(batch.provenance.inputKey, batch.inputKey);
    assert.equal(batch.provenance.sourceKey, audit.sourceKey);
    assert.match(batch.provenance.inputKey, /^[a-f0-9]{64}$/);
    assert.match(batch.provenance.sourceKey, /^[a-f0-9]{64}$/);
    assert.equal(batch.version, 1, 'schema version is not the plugin release');
    await f.store.flush();
    f.store.close();
    reloaded = new InboxStore(f.app, 'study');
    await reloaded.load();
    const h = reloaded.all()[0];
    assert.deepEqual(h.generation, batch);
    assert.deepEqual(h.cards[0].generation.audit, audit);
    f.plugin.store = reloaded;
    await new Generator(f.plugin, { release: 'later-release' }).run(h);
    assert.deepEqual(h.generation, batch, 'resuming completed work must not backfill a later release identity');
    assert.deepEqual(h.cards[0].generation.audit, audit);
    assert.deepEqual(f.calls, ['preparation', 'grounded cards', 'audit']);
  } finally { f.store.close(); reloaded?.close(); }
});

test('P5 a release identity works without a commit, and new audit identity records the actual resumed runtime', async () => {
  const f = await fixture();
  const complete = f.backend.complete;
  let fail = true;
  f.backend.complete = async req => {
    if (req.label === 'audit' && fail) throw Error('synthetic audit unavailable');
    return complete(req);
  };
  try {
    await new Generator(f.plugin, { release: 'batch-start-release' }).run(f.h);
    assert.equal(f.h.cards.length, 0);
    assert.equal(f.h.generation.provenance.build.release, 'batch-start-release');
    fail = false;
    const retry = new Generator(f.plugin, { release: 'audit-runtime-release' });
    retry.kick = () => {};
    retry.retry(f.h);
    await retry.run(f.h);
    assert.equal(f.h.cards[0].generation.audit.provenance.build.release, 'audit-runtime-release');
    assert.equal(f.h.cards[0].generation.audit.provenance.build.commit, undefined);
    assert.equal(f.h.generation.provenance.build.release, 'batch-start-release', 'the batch start is historical, the new audit names its own runtime');
  } finally { f.store.close(); }
});

test('P5 unavailable build identity is unknown and legacy records are not backfilled', async () => {
  const f = await fixture();
  try {
    await f.g.run(f.h);
    assert.ok(f.h.generation.provenance.sourceKey);
    assert.equal(f.h.generation.provenance.build, undefined);
    delete f.h.generation.provenance;
    delete f.h.generation.audit.provenance;
    delete f.h.cards[0].generation.audit.provenance;
    const legacy = structuredClone(f.h);
    await new Generator(f.plugin, { release: 'current-release' }).run(f.h);
    assert.deepEqual(f.h.generation, legacy.generation);
    assert.deepEqual(f.h.cards, legacy.cards);
    assert.equal(f.h.generation.provenance, undefined);
    assert.equal(f.h.cards[0].generation.audit.provenance, undefined);
  } finally { f.store.close(); }
});

test('P5 changed source or writing context gets a new fingerprint without rewriting prior provenance', async () => {
  for (const change of ['source', 'context']) {
    const f = await fixture();
    try {
      const g = new Generator(f.plugin, { release: 'synthetic-release' });
      await g.run(f.h);
      const original = structuredClone(f.h.generation);
      if (change === 'source') f.h.before = 'Revised surrounding context';
      else f.plugin.settings.writerInstructions = 'Revised writing context';
      await g.run(f.h);
      assert.notEqual(f.h.generation.provenance.inputKey, original.provenance.inputKey);
      assert.equal(f.h.generation.provenance.sourceKey === original.provenance.sourceKey, change !== 'source');
      assert.deepEqual(f.h.generationHistory.find(g => g.id === original.id), original);
    } finally { f.store.close(); }
  }
});

test('the real queue preserves concurrent batches without confusing another checkpoint with an unsaved no-op',{timeout:2000},async()=>{
  const f=await fixture();const second=makeHighlight({sourcePath:'second.md',sourceTitle:'Second synthetic',text:'Amber stores heat.'});f.store.add(second);f.plugin.settings.concurrency=2;
  const done=new Promise(resolve=>{f.plugin.refreshStatusBar=()=>{if(f.g.running.size===0&&f.store.all().every(h=>h.status!=='queued'))resolve();};});
  try{f.g.start();await done;assert.deepEqual(f.store.all().map(h=>h.status),['ready','ready']);assert.equal(f.calls.length,6);}finally{f.g.stop();f.store.close();}
});

test('real store reload resumes durable preparation without repeating it',async()=>{
  const f=await fixture();const complete=f.backend.complete;f.backend.complete=async req=>{if(req.label==='grounded cards')throw Error('writer unavailable');return complete(req);};
  await f.g.run(f.h);await f.store.flush();const saved=JSON.parse(f.files.get(f.store.filePath));assert.ok(saved.highlights[0].generation.preparation);f.store.close();
  const reloaded=new InboxStore(f.app,'study');await reloaded.load();f.plugin.store=reloaded;f.backend.complete=complete;
  try{const retry=new Generator(f.plugin);retry.kick=()=>{};retry.retry(reloaded.all()[0]);await retry.run(reloaded.all()[0]);assert.deepEqual(f.calls,['preparation','grounded cards','audit']);const durable=JSON.parse(f.files.get(reloaded.filePath)).highlights[0];assert.equal(durable.cards.length,1);assert.equal(durable.cards[0].generation.audit.status,'verified');}finally{reloaded.close();}
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
