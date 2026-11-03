import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
let m;
before(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'recall-learn-test-'));
  const out = path.join(dir, 'module.mjs');
  await build({entryPoints:['src/learnHarness.ts'],bundle:true,format:'esm',platform:'node',outfile:out,logLevel:'silent'});
  m = await import(pathToFileURL(out));
});
const reply = (action, argument='', message='') => ({action,argument,message});

test('only exact read actions and safe identifiers become script arguments',()=>{
  assert.deepEqual(m.readerArguments(reply('sessions_read','chat_test')),['sessions.py','read','chat_test']);
  assert.deepEqual(m.readerArguments(reply('graph_find','$(touch NEVER)')),['graph.py','find','--','$(touch NEVER)']);
  for (const action of [reply('bash','rm -rf /'),reply('sessions_read','../auth'),reply('sessions_list','--include-operations'),reply('graph_chains','--help')]) assert.throws(()=>m.readerArguments(action));
});

test('missing skill installation fails clearly',async()=>{
  await assert.rejects(m.loadSkill('/nonexistent/recall-skill'),/skill installation/i);
});
test('modified upstream instructions are refused before execution',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'recall-skill-tamper-'));
  writeFileSync(path.join(dir,'SKILL.md'),'not the pinned skill');
  await assert.rejects(m.loadSkill(dir),/skill installation|integrity/i);
});

test('skill loop loads upstream instructions and passes real tool results as data',async()=>{
  const calls=[]; const skill={instructions:'EXACT_UPSTREAM_SKILL',reference:'FORMAT_REFERENCE'};
  const output=await m.runLearnTurn({skill,messages:[{role:'user',text:'Read my lesson'}],authorized:()=>true,
    complete:async req=>{calls.push(req);return calls.length===1?reply('sessions_read','chat_test'):reply('answer','','Here is the lesson.');},
    read:async action=>{assert.equal(action.argument,'chat_test');return 'REAL_READER_RESULT';}});
  assert.equal(output,'Here is the lesson.');
  assert.match(calls[0].system,/EXACT_UPSTREAM_SKILL/);
  assert.match(calls[0].system,/FORMAT_REFERENCE/);
  assert.match(calls[1].user,/REAL_READER_RESULT/);
  assert.equal(calls[0].retryInvalidResponse,false);
});
test('revocation after reader work prevents another provider dispatch',async()=>{
  let allowed=true, calls=0;
  await assert.rejects(m.runLearnTurn({skill:{instructions:'skill',reference:''},messages:[{role:'user',text:'Read'}],authorized:()=>allowed,
    complete:async()=>{calls++;return reply('sessions_list');},read:async()=>{allowed=false;return 'PRIVATE';}}));
  assert.equal(calls,1);
});
test('tool loops and oversized records fail without silently truncating evidence',async()=>{
  let calls=0;
  await assert.rejects(m.runLearnTurn({skill:{instructions:'skill',reference:''},messages:[{role:'user',text:'Read'}],authorized:()=>true,
    complete:async()=>{calls++;return reply('sessions_list');},read:async()=> 'ok'}),/limit/i);
  assert.equal(calls,m.MAX_LEARN_CALLS);
  calls=0;
  await assert.rejects(m.runLearnTurn({skill:{instructions:'skill',reference:''},messages:[{role:'user',text:'Read'}],authorized:()=>true,
    complete:async()=>{calls++;return reply('sessions_list');},read:async()=> 'x'.repeat(m.MAX_LEARN_CONTEXT+1)}),/large|limit/i);
  assert.equal(calls,1);
});
test('malformed or injected tool actions never reach the reader',async()=>{
  let reads=0;
  await assert.rejects(m.runLearnTurn({skill:{instructions:'skill',reference:''},messages:[{role:'user',text:'Hi'}],authorized:()=>true,
    complete:async()=>reply('shell','touch NEVER'),read:async()=>{reads++;return '';}}));
  assert.equal(reads,0);
});
