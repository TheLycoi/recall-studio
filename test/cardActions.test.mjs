import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let actions;
before(async () => {
  const out = await build({entryPoints:['src/cardActions.ts'],bundle:true,write:false,format:'cjs',platform:'node'});
  const mod = new Module('actions'); mod._compile(out.outputFiles[0].text,'actions'); actions=mod.exports;
});
function fixture() {
  const card={id:'c1',kind:'qa',front:'What binds drugs?',back:'Albumin',text:'',extra:'',status:'pending',critiqueRan:true};
  const highlight={id:'h1',status:'ready',text:'Albumin binds drugs.',before:'',after:'',sourcePath:'a.md',cards:[card]};
  return {card,highlight};
}
const keep=async()=>[{verdict:'keep',bloom:'remember',reason:''}];
test('legacy automatic critiques do not count as an explicit check',()=>{
  const {card,highlight}=fixture(); assert.equal(actions.currentCardCheck(card,highlight),undefined);
});
test('explicit check preserves wording and records current content only',async()=>{
  const {card,highlight}=fixture(); const before=card.front;
  await actions.checkCard(card,highlight,async()=>[{verdict:'revise',bloom:'remember',reason:'Narrow the question',kind:'qa',front:'Replacement',back:'Replacement'}]);
  assert.equal(card.front,before); assert.equal(card.status,'pending');
  assert.ok(actions.currentCardCheck(card,highlight).issues.includes('Narrow the question'));
  card.back='Edited'; assert.equal(actions.currentCardCheck(card,highlight),undefined);
});
test('check failure removes the previous result without marking checked',async()=>{
  const {card,highlight}=fixture(); await actions.checkCard(card,highlight,keep);
  await assert.rejects(actions.checkCard(card,highlight,async()=>{throw Error('offline');}));
  assert.equal(actions.currentCardCheck(card,highlight),undefined);
});
test('edit or cancellation during check discards the result',async()=>{
  for (const cancel of [false,true]) {
    const {card,highlight}=fixture(); let finish; let cancelled=false;
    const run=actions.checkCard(card,highlight,()=>new Promise(r=>finish=r),()=>!cancelled);
    if(cancel) cancelled=true; else card.front='Changed';
    finish([{verdict:'keep',bloom:'remember'}]); await run;
    assert.equal(actions.currentCardCheck(card,highlight),undefined);
  }
});
test('missing or invalid model verdict cannot mark checked',async()=>{
  for(const result of [[],[{}],[{verdict:'made-up'}]]) {
    const {card,highlight}=fixture(); await assert.rejects(actions.checkCard(card,highlight,async()=>result));
    assert.equal(actions.currentCardCheck(card,highlight),undefined);
  }
});
test('export selection is an explicit allowlist with optional individual scope',()=>{
  const {card,highlight}=fixture();
  const flagged={...card,id:'flag',status:'flagged'}; const legacy={...card,id:'old',status:'approved'};
  highlight.cards.push(flagged,legacy,...['deleted','duplicate','exported'].map(status=>({...card,id:status,status})));
  assert.deepEqual(actions.exportCandidates([highlight]).map(x=>x.card.id),['c1','flag','old']);
  assert.deepEqual(actions.exportCandidates([highlight],new Set(['flag'])).map(x=>x.card.id),['flag']);
  highlight.status='dismissed';assert.deepEqual(actions.exportCandidates([highlight]),[]);
});
test('export refuses empty Q&A and malformed cloze without changing state',()=>{
  const {card,highlight}=fixture(); card.back='';assert.throws(()=>actions.exportCandidates([highlight]),/empty/i);assert.equal(card.status,'pending');
  card.kind='cloze';card.text='No deletion';assert.throws(()=>actions.exportCandidates([highlight]),/cloze/i);
});
test('export acceptance is temporary on failure and retains successes',async()=>{
  const {card,highlight}=fixture();
  const items=actions.exportCandidates([highlight]);
  await assert.rejects(actions.withExportAcceptance(items,async()=>{assert.equal(card.status,'approved');throw Error('offline');}));
  assert.equal(card.status,'pending');
  await actions.withExportAcceptance(items,async()=>{card.status='exported';});assert.equal(card.status,'exported');
});
test('export cleanup never revives a card deleted while sending',async()=>{
  const {card,highlight}=fixture();
  await actions.withExportAcceptance(actions.exportCandidates([highlight]),async()=>{card.status='deleted';});
  assert.equal(card.status,'deleted');
});
test('a stale caller cannot export an archived ready highlight',()=>{
  const {highlight}=fixture();highlight.archived=true;
  assert.deepEqual(actions.exportCandidates([highlight]),[]);
});
