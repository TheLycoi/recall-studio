import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';

let Generator, LlmClient, makeHighlight, makeCard, parseInboxJson, DeepSeekBackend;
let httpReply;
let CodexBackend, OpenCodeBackend, toStrictSchema;
before(async () => {
  const out = await build({ stdin: { contents: `export {Generator} from './src/generator'; export {LlmClient} from './src/llm'; export {makeHighlight,makeCard} from './src/model'; export {parseInboxJson} from './src/inboxData'; export {DeepSeekBackend} from './src/deepseek'; export {CodexBackend,toStrictSchema} from './src/codex';export {OpenCodeBackend} from './src/opencode';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const mod = new Module('generation-fixture');
  mod.require = id => id === 'obsidian' ? { Notice: class {}, requestUrl: async args=>httpReply(args) } : Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text, 'generation-fixture');
  ({Generator,LlmClient,makeHighlight,makeCard,parseInboxJson,DeepSeekBackend,CodexBackend,OpenCodeBackend,toStrictSchema} = mod.exports);
});
const source = 'Amber stores heat. Cobalt reflects light.';
const preparation = () => ({ facts: [{id:'F1', statement:'Amber stores heat.', quote:'Amber stores heat.'}, {id:'F2',statement:'Cobalt reflects light.',quote:'Cobalt reflects light.'}], plan: [{id:'P1',factIds:['F1'],entity:'Amber',aspect:'function',value:'stores heat',reason:'A stated property'}], exclusions: [], omissions: [{factIds:['F2'],reason:'Batch limit'}], conflicts: [] });
const draft = () => ({cards:[{planId:'P1',factIds:['F1'],kind:'qa',front:'What does Amber store?',back:'heat',text:''}]});
function fixture(overrides={}) {
  const h=makeHighlight({sourcePath:'synthetic.md',sourceTitle:'Synthetic',text:source});
  const settings={provider:'codex',codexModel:'synthetic',effort:'low',maxCardsPerHighlight:5,writerInstructions:'',language:'',historyExamples:false,critiquePass:true,lintMode:'badge',notifyWhenReady:false,concurrency:1,...overrides};
  const calls=[]; const saves=[];
  const llm=new LlmClient(()=>settings);
  const backend={complete:async req=>{
    calls.push(req);
    const result=req.label==='preparation' ? preparation() : req.label==='grounded cards' ? draft() : {verdicts:[{index:0,cardId:JSON.parse(req.user).cards[0].id,status:'verified',reason:'The captured source supports this claim.'}]};
    return req.schema.parse(result);
  }};
  llm.codex=backend; llm.deepseek=backend; llm.opencode=backend;
  const plugin={settings,llm,store:{all:()=>[h],touch(){},async flush(){saves.push(JSON.parse(JSON.stringify(h)));},hasUnsavedChanges:false},refreshStatusBar(){}};
  const g=new Generator(plugin);
  return {h,settings,calls,saves,llm,backend,plugin,g};
}

test('six deletions on the same source sentence remain one cloze note', async () => {
  const f = fixture({ lintMode: 'hide' });
  const terms = ['agility', 'balance', 'coordination', 'speed', 'power', 'reaction time'];
  f.h.text = `The skill-related components are ${terms.join(', ')}.`;
  const text = `The skill-related components are ${terms.map((term, i) => `{{c${i + 1}::${term}}}`).join(', ')}.`;
  f.backend.complete = async req => {
    f.calls.push(req);
    if (req.label === 'preparation') return req.schema.parse({
      facts: terms.map((term, i) => ({ id: `F${i + 1}`, statement: `${term} is a skill-related component.`, quote: term })),
      plan: [{ id: 'P1', factIds: terms.map((_, i) => `F${i + 1}`), entity: 'Skill-related components', aspect: 'members', value: terms.join(', '), reason: 'Independent deletions share their source sentence.' }],
      exclusions: [], omissions: [], conflicts: [],
    });
    if (req.label === 'grounded cards') return req.schema.parse({ cards: [{ planId: 'P1', factIds: terms.map((_, i) => `F${i + 1}`), kind: 'cloze', front: '', back: '', text }] });
    return req.schema.parse({ verdicts: [{ index: 0, cardId: JSON.parse(req.user).cards[0].id, status: 'verified', reason: 'Each hidden term appears in the source.' }] });
  };
  await f.g.run(f.h);
  assert.equal(f.h.cards.length, 1);
  assert.equal(f.h.cards[0].kind, 'cloze');
  assert.equal(f.h.cards[0].text, text);
  assert.equal(f.h.cards[0].status, 'pending');
  assert.deepEqual(f.h.cards[0].lintFailures ?? [], []);
  assert.equal(f.calls.length, 3);
});

test('source-backed cloze notes can exceed the old per-highlight quota without another request', async () => {
  const f = fixture({ maxCardsPerHighlight: 1 });
  const facts = Array.from({ length: 6 }, (_, i) => ({ id: `F${i + 1}`, statement: `Item${i + 1} stores token${i + 1}.`, quote: `Item${i + 1} stores token${i + 1}.` }));
  f.h.text = facts.map(fact => fact.quote).join(' ');
  f.backend.complete = async req => {
    f.calls.push(req);
    if (req.label === 'preparation') return req.schema.parse({ facts, plan: facts.map((fact, i) => ({ id: `P${i + 1}`, factIds: [fact.id], entity: `Item${i + 1}`, aspect: 'property', value: `token${i + 1}`, reason: 'A distinct supported fact.' })), exclusions: [], omissions: [], conflicts: [] });
    if (req.label === 'grounded cards') return req.schema.parse({ cards: facts.map((fact, i) => ({ planId: `P${i + 1}`, factIds: [fact.id], kind: 'cloze', front: '', back: '', text: `Item${i + 1} stores {{c1::token${i + 1}}}.` })) });
    return req.schema.parse({ verdicts: JSON.parse(req.user).cards.map((card, index) => ({ index, cardId: card.id, status: 'verified', reason: 'Supported by the source.' })) });
  };
  await f.g.run(f.h);
  assert.equal(f.h.status, 'ready');
  assert.equal(f.h.cards.length, 6);
  assert.ok(f.h.cards.every(card => card.kind === 'cloze' && card.status === 'pending'));
  assert.equal(f.calls.length, 3);
});

for(const [provider,Backend] of [['codex',()=>CodexBackend],['opencode',()=>OpenCodeBackend]])test(`${provider} actual complete adapter validates all three stages through a mocked transport`,async()=>{
  const f=fixture({provider});const backend=new (Backend())(()=>f.settings);let transports=0;
  backend.exec=async req=>{transports++;const user=JSON.parse(req.user);const result=req.label==='preparation'?preparation():req.label==='grounded cards'?draft():{verdicts:[{index:0,cardId:user.cards[0].id,status:'verified',reason:'Captured source supports the claim'}]};if(provider==='codex'){const schema=toStrictSchema(req.schema);assert.equal(schema.additionalProperties,false);}return JSON.stringify(result);};
  f.llm[provider]=backend;await f.g.run(f.h);assert.equal(f.h.status,'ready');assert.equal(transports,3);assert.equal(f.h.cards[0].generation.audit.status,'verified');
});

test('partial multi-card audit verifies only the exact addressed card',async()=>{
  const f=fixture();const original=f.backend.complete;
  f.backend.complete=async req=>{f.calls.push(req);const user=JSON.parse(req.user);if(req.label==='preparation'){const p=preparation();p.plan.push({id:'P2',factIds:['F2'],entity:'Cobalt',aspect:'',value:'reflects light',reason:'Stated property'});p.omissions=[];return req.schema.parse(p);}if(req.label==='grounded cards'){const d=draft();d.cards.push({planId:'P2',factIds:['F2'],kind:'qa',front:'What does Cobalt reflect?',back:'light',text:''});return req.schema.parse(d);}assert.equal(user.cards.length,2);assert.deepEqual(user.cards.map(c=>c.index),[0,1]);return req.schema.parse({verdicts:[{index:1,cardId:user.cards[1].id,status:'verified',reason:'The second card is supported'}]});};
  await f.g.run(f.h);assert.equal(f.h.generation.audit.status,'unverified');assert.equal(f.h.cards.length,1);assert.equal(f.h.cards[0].back,'light');assert.equal(f.h.cards[0].generation.audit.status,'verified');assert.equal(f.h.generation.blocked.length,1);assert.equal(f.h.generation.phase,'blocked');
});

test('ungrounded cloze content stays private even with a positive model audit',async()=>{
  const f=fixture({lintMode:'hide'});const original=f.backend.complete;
  f.backend.complete=async req=>req.label==='grounded cards'?(f.calls.push(req),req.schema.parse({cards:[{planId:'P1',factIds:['F1'],kind:'cloze',front:'',back:'',text:'{{c1::Amber}} stores {{c2::invented radiation}}.'}]})):original(req);
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.equal(f.h.generation.phase,'blocked');assert.match(f.h.generation.blocked[0].reasons.join(' '),/not in the highlight/);assert.match(f.h.generation.drafts[0].text,/invented radiation/);
});

test('a single cloze stays cloze with evidence links and a stable export identity on retry',async()=>{
  const f=fixture();const original=f.backend.complete;
  f.backend.complete=async req=>req.label==='grounded cards'?(f.calls.push(req),req.schema.parse({cards:[{planId:'P1',factIds:['F1'],kind:'cloze',front:'',back:'',text:'Amber stores {{c1::heat}}.'}]})):original(req);
  await f.g.run(f.h);const c=f.h.cards[0];assert.equal(c.kind,'cloze');assert.equal(c.text,'Amber stores {{c1::heat}}.');assert.deepEqual(c.generation.factIds,['F1']);const id=c.id;await f.g.run(f.h);assert.equal(f.h.cards[0].id,id);assert.equal(f.calls.length,3);
});

test('DeepSeek staged preparation performs one HTTP request even on empty JSON output',async()=>{
  const f=fixture({provider:'deepseek',deepseekModel:'synthetic',deepseekApiKey:'synthetic-not-a-secret'});
  f.llm.deepseek=new DeepSeekBackend(()=>f.settings);let requests=0;
  httpReply=async()=>{requests++;return {status:200,json:{choices:[{message:{content:''},finish_reason:'stop'}]}};};
  await f.g.run(f.h);assert.equal(f.h.status,'error');assert.equal(requests,1);
});

test('DeepSeek real adapter parses all three bounded stages with deterministic HTTP fixtures',async()=>{
  const f=fixture({provider:'deepseek',deepseekModel:'synthetic',deepseekApiKey:'synthetic-not-a-secret'});
  f.llm.deepseek=new DeepSeekBackend(()=>f.settings);const requests=[];
  httpReply=async args=>{const body=JSON.parse(args.body);requests.push(body);const user=JSON.parse(body.messages[1].content);const out=requests.length===1?preparation():requests.length===2?draft():{verdicts:[{index:0,cardId:user.cards[0].id,status:'verified',reason:'Captured source supports the claim'}]};return {status:200,json:{choices:[{message:{content:JSON.stringify(out)},finish_reason:'stop'}]}};};
  await f.g.run(f.h);assert.equal(f.h.status,'ready');assert.equal(requests.length,3);assert.equal(f.h.cards[0].generation.audit.status,'verified');assert.ok(requests.every(r=>r.model==='synthetic'));
});

test('actual queue runs a superseding more request once and never publishes its stale predecessor',{timeout:2000},async()=>{
  const f=fixture();const original=f.backend.complete;let superseded=false;
  f.backend.complete=async req=>{const out=await original(req);if(req.label==='grounded cards'&&!superseded){superseded=true;f.g.more(f.h,'New intentional request');}return out;};
  const done=new Promise(resolve=>{f.plugin.refreshStatusBar=()=>{if(f.g.running.size===0&&f.h.status!=='queued')resolve();};});
  f.g.enqueue(f.h);await done;assert.equal(f.h.status,'ready');assert.equal(f.h.cards.length,1);assert.deepEqual(f.calls.map(c=>c.label),['preparation','grounded cards','preparation','grounded cards','audit']);
});

test('checkpointed audit survives a save failure and a JSON reload without another model request',async()=>{
  const f=fixture();let fail=true;f.plugin.store.flush=async()=>{if(f.h.generation?.audit&&fail)throw Error('audit save failed');};
  await f.g.run(f.h);assert.equal(f.h.status,'error');assert.equal(f.h.cards.length,0);assert.equal(f.calls.length,3);const id=f.h.generation.drafts[0].id;
  Object.assign(f.h,JSON.parse(JSON.stringify(f.h)));fail=false;await new Generator(f.plugin).run(f.h);
  assert.equal(f.calls.length,3);assert.equal(f.h.cards[0].id,id);assert.equal(f.h.status,'ready');
});

test('failed final commit retries without duplicating cards or resetting a user edit',async()=>{
  const f=fixture();let fail=true;f.plugin.store.flush=async()=>{if(f.h.generation?.committed&&fail)throw Error('final save failed');};
  await f.g.run(f.h);assert.equal(f.h.status,'error');assert.equal(f.h.cards.length,1);const c=f.h.cards[0];c.back='User edit';c.edited=true;
  fail=false;await new Generator(f.plugin).run(f.h);assert.equal(f.calls.length,3);assert.equal(f.h.cards.length,1);assert.equal(f.h.cards[0],c);assert.equal(c.back,'User edit');assert.equal(f.h.status,'ready');
});

test('one bounded preparation, linked writing and independent audit checkpoint before publishing',async()=>{
  const f=fixture(); await f.g.run(f.h);
  assert.deepEqual(f.calls.map(c=>c.label),['preparation','grounded cards','audit']);
  assert.equal(f.h.cards.length,1);
  assert.equal(f.h.cards[0].generation.audit.status,'verified');
  assert.deepEqual(f.h.cards[0].generation.factIds,['F1']);
  assert.equal(f.h.generation.preparation.omissions[0].reason,'Batch limit');
  assert.ok(f.saves.some(h=>h.generation?.preparation && !h.generation?.drafts));
  assert.ok(f.saves.some(h=>h.generation?.drafts && !h.generation?.audit));
});

for (const [name, mutate] of [
  ['quote from context only',p=>p.facts[0].quote='Context-only secret'],
  ['normalized instead of exact quote',p=>p.facts[0].quote='amber stores heat.'],
  ['duplicate fact IDs',p=>p.facts[1].id='F1'],
  ['unknown plan fact',p=>p.plan[0].factIds=['F99']],
  ['unknown omission fact',p=>p.omissions[0].factIds=['F99']],
  ['undisposed fact',p=>p.omissions=[]],
  ['malformed fact identifier',p=>p.facts[0].id=' F1'],
  ['contradictory exclusion',p=>p.exclusions=[{factIds:['F1'],reason:'Excluded but also planned'}]],
  ['fabricated conflict quote',p=>p.conflicts=[{quote:'invented',reason:'conflict'}]],
]) test(`preparation rejects ${name} before the writer`,async()=>{
  const f=fixture(); f.h.before='Context-only secret';
  f.backend.complete=async req=>{ f.calls.push(req); const p=preparation();mutate(p);return req.schema.parse(p); };
  await f.g.run(f.h);assert.equal(f.h.status,'error');assert.equal(f.h.cards.length,0);assert.equal(f.calls.length,1);
});
for (const [name,mutate] of [
  ['unknown plan',d=>d.cards[0].planId='P99'],
  ['unknown fact',d=>d.cards[0].factIds=['F99']],
  ['missing plan card',d=>d.cards=[]],
  ['duplicate plan card',d=>d.cards.push({...d.cards[0]})],
]) test(`writer rejects ${name} without an audit or repair loop`,async()=>{
  const f=fixture();const original=f.backend.complete;
  f.backend.complete=async req=>{if(req.label!=='grounded cards')return original(req);f.calls.push(req);const d=draft();mutate(d);return req.schema.parse(d);};
  await f.g.run(f.h);assert.equal(f.h.status,'error');assert.equal(f.calls.length,2);assert.equal(f.h.cards.length,0);
});

test('failed writer resumes checkpointed preparation after JSON reload',async()=>{
  const f=fixture();const original=f.backend.complete;let fail=true;
  f.backend.complete=async req=>{if(req.label==='grounded cards'&&fail){f.calls.push(req);throw Error('transient writer failure');}return original(req);};
  await f.g.run(f.h);assert.equal(f.h.status,'error');assert.ok(f.h.generation.preparation);
  const raw=JSON.stringify({version:1,highlights:[f.h]});const parsed=parseInboxJson(raw);assert.equal(parsed.ok,true);
  Object.assign(f.h,parsed.data.highlights[0]); fail=false;
  const retry=new Generator(f.plugin);retry.kick=()=>{};retry.retry(f.h);await retry.run(f.h);
  assert.deepEqual(f.calls.map(c=>c.label),['preparation','grounded cards','grounded cards','audit']);assert.equal(f.h.status,'ready');
});

test('saved drafts resume audit with stable IDs after checkpoint save failure',async()=>{
  const f=fixture();let fail=true;
  f.plugin.store.flush=async()=>{if(f.h.generation?.drafts&&fail)throw Error('disk failure');f.saves.push(JSON.parse(JSON.stringify(f.h)));};
  await f.g.run(f.h);const id=f.h.generation.drafts[0].id;
  assert.equal(f.h.status,'error');assert.equal(f.calls.length,2);assert.equal(f.h.cards.length,0);
  fail=false;await new Generator(f.plugin).run(f.h);
  assert.equal(f.h.cards[0].id,id);assert.equal(f.calls.length,3);
});

test('retrying a completed batch never duplicates its stored cards or calls',async()=>{
  const f=fixture();await f.g.run(f.h);const id=f.h.cards[0].id;
  await new Generator(f.plugin).run(f.h);
  assert.equal(f.calls.length,3);assert.deepEqual(f.h.cards.map(c=>c.id),[id]);
});

for(const change of ['text','instruction','before','provider','writerInstructions','language','maxCardsPerHighlight','rules']) test(`retry invalidates saved stages after ${change} changes`,async()=>{
  const f=fixture();const original=f.backend.complete;let fail=true;
  f.backend.complete=async req=>{if(req.label==='grounded cards'&&fail){f.calls.push(req);throw Error('writer unavailable');}return original(req);};
  await f.g.run(f.h);const old=f.h.generation.id;fail=false;
  if(change==='rules') f.llm.getSchema=async()=>({cards:'new rules'});
  else if(change in f.settings)f.settings[change]=change==='provider'?'deepseek':change==='maxCardsPerHighlight'?4:'changed';
  else f.h[change]+=' changed';
  const retry=new Generator(f.plugin);retry.kick=()=>{};retry.retry(f.h);await retry.run(f.h);
  assert.notEqual(f.h.generation.id,old);assert.equal(f.calls.filter(c=>c.label==='preparation').length,2);
});

for(const mode of ['throws','partial','unknown-id','wrong-index','duplicate']) test(`audit ${mode} never becomes a green pass`,async()=>{
  const f=fixture({critiquePass:mode!=='disabled'});const original=f.backend.complete;
  f.backend.complete=async req=>{
    if(req.label!=='audit')return original(req);f.calls.push(req);
    if(mode==='throws')throw Error('offline');
    const id=JSON.parse(req.user).cards[0].id;
    const v={index:mode==='wrong-index'?1:0,cardId:mode==='unknown-id'?'made-up':id,status:'verified',reason:'supported'};
    return req.schema.parse({verdicts:mode==='partial'?[]:mode==='duplicate'?[v,v]:[v]});
  };
  await f.g.run(f.h);
  assert.equal(f.h.status,'error');assert.equal(f.h.cards.length,0);assert.equal(f.h.generation.phase,'blocked');assert.equal(f.h.generation.blocked.length,1);
  assert.notEqual(f.h.generation.audit.status,'verified');const count=f.calls.length;await f.g.run(f.h);assert.equal(f.calls.length,count,'no hidden retry of a terminal audit');
});

test('a failed finding attempts one repair and retains unresolved originals privately',async()=>{
  const f=fixture();const original=f.backend.complete;
  f.backend.complete=async req=>req.label==='audit'?(f.calls.push(req),req.schema.parse({verdicts:[{index:0,cardId:JSON.parse(req.user).cards[0].id,status:'failed',reason:'Unsupported qualifier'}]})):original(req);
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.equal(f.h.generation.drafts[0].back,'heat');assert.equal(f.h.generation.audit.status,'failed');assert.equal(f.calls.filter(c=>c.label==='generation repair').length,1);assert.equal(f.h.generation.phase,'blocked');
});

for(const stage of ['preparation','grounded cards','audit']) for(const action of ['stop','dismiss','archive','source','instruction','settings']) test(`${action} during ${stage} prevents stale publish`,async()=>{
  const f=fixture();const original=f.backend.complete;
  f.backend.complete=async req=>{const result=await original(req);if(req.label===stage){if(action==='stop')f.g.stop();else if(action==='dismiss')f.h.status='dismissed';else if(action==='archive')f.h.archived=true;else if(action==='source')f.h.text+=' changed';else if(action==='instruction')f.h.instruction='changed';else f.settings.writerInstructions='changed';}return result;};
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.equal(f.calls.length,['preparation','grounded cards','audit'].indexOf(stage)+1);
});

test('a read-only no-op flush is not a persisted checkpoint',async()=>{
  const f=fixture();f.plugin.store.hasUnsavedChanges=true;await f.g.run(f.h);
  assert.equal(f.calls.length,0);assert.equal(f.h.status,'error');assert.match(f.h.error,/not saved/);
});

test('source conflict remains visible and cannot acquire verified status',async()=>{
  const f=fixture();const original=f.backend.complete;
  f.backend.complete=async req=>{if(req.label!=='preparation')return original(req);f.calls.push(req);const p=preparation();p.conflicts=[{quote:'Amber stores heat.',reason:'Source conflicts require review'}];return req.schema.parse(p);};
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.match(f.h.generation.blocked[0].reasons.join(' '),/conflicts/);assert.equal(f.h.generation.preparation.conflicts.length,1);
});

test('an interrupted audit is not re-spent after restart',async()=>{
  const f=fixture();const original=f.backend.complete;
  f.backend.complete=async req=>{const out=await original(req);if(req.label==='audit')f.g.stop();return out;};
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.equal(f.h.status,'queued');
  await new Generator(f.plugin).run(f.h);assert.equal(f.calls.filter(c=>c.label==='audit').length,1);assert.equal(f.h.cards.length,0);assert.equal(f.h.generation.phase,'blocked');
});

test('changed instructions after a completed batch include the old accepted history on the first retry',async()=>{
  const f=fixture({historyExamples:true});f.llm.getHighlights=()=>[f.h];
  await f.g.run(f.h);f.h.cards[0].status='approved';f.h.instruction='Changed instruction';
  await new Generator(f.plugin).run(f.h);assert.equal(f.h.status,'ready');assert.equal(f.h.cards.length,2);
});

test('house rules changed during the writer prevent stale publication',async()=>{
  const f=fixture();const original=f.backend.complete;
  f.backend.complete=async req=>{const out=await original(req);if(req.label==='grounded cards')f.llm.getSchema=async()=>({cards:'Changed house rule'});return out;};
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.equal(f.h.status,'error');
});

test('house rules changed during the final checkpoint cannot leave a stale published batch',async()=>{
  const f=fixture();f.plugin.store.flush=async()=>{if(f.h.generation?.committed)f.llm.getSchema=async()=>({cards:'Changed while saving'});};
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.equal(f.h.status,'error');
});

test('source changed during the final store flush cannot leave a stale published batch',async()=>{
  const f=fixture();f.plugin.store.flush=async()=>{if(f.h.generation?.committed)f.h.text+=' changed';};
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.equal(f.h.status,'error');
});

test('more starts a distinct bounded batch and retains its one-off instruction on retry',async()=>{
  const f=fixture();await f.g.run(f.h);const id=f.h.cards[0].id,old=f.h.generation.id;f.h.generatedAt='2000-01-01T00:00:00.000Z';
  f.g.kick=()=>{};f.g.more(f.h,'Focus on mechanism');assert.notEqual(f.h.generation.id,old);
  assert.equal(f.h.generationHistory?.find(g=>g.id===old)?.preparation.facts[0].quote,'Amber stores heat.');
  const original=f.backend.complete;let fail=true;
  f.backend.complete=async req=>{if(req.label==='grounded cards'&&fail){f.calls.push(req);throw Error('transient');}return original(req);};
  await f.g.run(f.h);assert.equal(f.h.generation.instruction,'Focus on mechanism');fail=false;
  const retry=new Generator(f.plugin);retry.kick=()=>{};retry.retry(f.h);await retry.run(f.h);assert.equal(f.h.cards.length,2);assert.equal(f.h.cards[0].id,id);assert.equal(f.h.instruction,'');assert.notEqual(f.h.generatedAt,'2000-01-01T00:00:00.000Z');
  assert.equal(f.calls.filter(c=>c.label==='preparation').length,2);assert.equal(f.calls.filter(c=>c.label==='audit').length,2);
  assert.match(f.calls.filter(c=>c.label==='grounded cards').at(-1).user,/Focus on mechanism/);
});

test('a request superseded by more during await cannot commit the previous batch',async()=>{
  const f=fixture();const original=f.backend.complete;f.g.kick=()=>{};
  f.backend.complete=async req=>{const out=await original(req);if(req.label==='grounded cards')f.g.more(f.h,'New batch');return out;};
  await f.g.run(f.h);assert.equal(f.h.cards.length,0);assert.equal(f.h.status,'queued');assert.equal(f.h.generation.instruction,'New batch');
});

test('existing accepted edits and exported identity survive new cloze batches',async()=>{
  const f=fixture();const old=makeCard(f.h.id,{kind:'qa',front:'Edited question',back:'personal answer',status:'exported',edited:true,ankiNoteId:123});f.h.cards.push(old);
  const original=f.backend.complete;
  f.backend.complete=async req=>req.label==='grounded cards'?(f.calls.push(req),req.schema.parse({cards:[{planId:'P1',factIds:['F1'],kind:'cloze',front:'',back:'',text:'{{c1::Amber}} stores {{c2::heat}}.'}]})):original(req);
  await f.g.run(f.h);assert.equal(f.h.cards[0],old);assert.equal(old.ankiNoteId,123);assert.equal(old.back,'personal answer');assert.equal(f.h.cards[1].kind,'cloze');assert.match(f.h.cards[1].text,/c2::heat/);
  const id=f.h.cards[1].id;await f.g.run(f.h);assert.equal(f.h.cards[1].id,id);
});
