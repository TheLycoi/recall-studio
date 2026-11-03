// Explicit integration suite: requires the pinned installer and Python 3.10+.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let m, skill, pin;
const scratch=mkdtempSync(path.join(tmpdir(),'recall-learn-integration-'));
before(async()=>{
  const out=path.join(scratch,'reader.mjs');
  await build({stdin:{contents:"export * from './src/learnHarness';export * from './src/learnHarnessPin';",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'node',outfile:out,logLevel:'silent'});
  m=await import(pathToFileURL(out));skill=await m.loadSkill();pin=m.DEFAULT_SKILL_DIR;
});
after(()=>rmSync(scratch,{recursive:true,force:true}));
const reply=(action,argument='')=>({action,argument,message:''});
function fixture(){
  const dir=mkdtempSync(path.join(scratch,'data-'));
  mkdirSync(path.join(dir,'chats'));mkdirSync(path.join(dir,'graph'));
  writeFileSync(path.join(dir,'chats/chat_test.json'),JSON.stringify({version:1,id:'chat_test',title:'Synthetic lesson',createdAt:'2026-01-01',updatedAt:'2026-01-01',messages:[{id:'m1',role:'user',content:'SYNTHETIC_LEARNER_RESPONSE'}]}));
  writeFileSync(path.join(dir,'graph/format.json'),JSON.stringify({version:1}));
  writeFileSync(path.join(dir,'graph/nodes.jsonl'),JSON.stringify({id:'n1',createdAt:'2026-01-01',name:'Synthetic',statement:'Synthetic proposition',aliases:[],provenance:[{chatId:'chat_test',messageId:'m1'}]})+'\n');
  return dir;
}
const snapshot=dir=>Object.fromEntries(readdirSync(dir,{recursive:true,withFileTypes:true}).filter(f=>f.isFile()).map(f=>[path.relative(dir,path.join(f.parentPath,f.name)),readFileSync(path.join(f.parentPath,f.name),'hex')]));
test('all upstream readers execute on synthetic records without writes',async()=>{
  const dir=fixture(),before=snapshot(dir);
  for(const [action,arg,match] of [['sessions_list','','chat_test'],['sessions_read','chat_test','SYNTHETIC_LEARNER_RESPONSE'],['graph_sessions','','chat_test'],['graph_propositions','','Synthetic proposition'],['graph_find','Synthetic','n1'],['graph_chains','','']]) {
    const result=await m.runReader(skill,{dataDir:dir},reply(action,arg));assert.doesNotThrow(()=>JSON.parse(result));assert.ok(result.includes(match));
  }
  assert.deepEqual(snapshot(dir),before);
});
test('pinned skill verification rejects changed instructions',async()=>{
  const dir=path.join(scratch,'tampered');cpSync(pin,dir,{recursive:true});
  writeFileSync(path.join(dir,'SKILL.md'),'tampered');await assert.rejects(m.loadSkill(dir),/integrity/);
});
test('newer records and graph warnings fail rather than return incomplete evidence',async()=>{
  const dir=fixture(),file=path.join(dir,'chats/chat_test.json');
  const record=JSON.parse(readFileSync(file));record.version=2;writeFileSync(file,JSON.stringify(record));
  await assert.rejects(m.runReader(skill,{dataDir:dir},reply('sessions_read','chat_test')),/reader failed/);
  writeFileSync(path.join(dir,'graph/nodes.jsonl'),'private-invalid-record');
  await assert.rejects(m.runReader(skill,{dataDir:dir},reply('graph_propositions')),/incomplete or invalid/);
  assert.equal(JSON.parse(readFileSync(file)).version,2);
});
test('oversized records and missing data fail safely',async()=>{
  const dir=fixture(),file=path.join(dir,'chats/chat_test.json');
  const record=JSON.parse(readFileSync(file));record.messages[0].content='x'.repeat(m.MAX_READER_BYTES+1);writeFileSync(file,JSON.stringify(record));
  await assert.rejects(m.runReader(skill,{dataDir:dir},reply('sessions_read','chat_test')),/reader failed/);
  await assert.rejects(m.runReader(skill,{dataDir:path.join(scratch,'missing')},reply('sessions_list')),/reader failed/);
});
test('already cancelled requests refuse reader execution',async()=>{
  const abort=new AbortController();abort.abort();
  await assert.rejects(m.runReader(skill,{dataDir:fixture()},reply('sessions_list'),abort.signal),/cancelled/);
});
