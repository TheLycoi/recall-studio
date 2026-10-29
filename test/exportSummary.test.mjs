import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let summarizeExport, makeCard, makeHighlight, exportCandidates, cardAuditContent, generationSourceKey, cardContent;
before(async()=>{
  const out=await build({stdin:{contents:`export {summarizeExport} from './src/exportSummary'; export {makeCard,makeHighlight} from './src/model'; export {exportCandidates,cardContent} from './src/cardActions'; export {cardAuditContent,generationSourceKey} from './src/generation';`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node'});
  const m=new Module('summary');m._compile(out.outputFiles[0].text,'summary');
  ({summarizeExport,makeCard,makeHighlight,exportCandidates,cardAuditContent,generationSourceKey,cardContent}=m.exports);
});
function fixture(){
  const h=makeHighlight({sourcePath:'source.md',sourceTitle:'Source',text:'Amber stores heat and releases energy.',status:'ready'});
  h.cards=[makeCard(h.id,{kind:'qa',front:'What does Amber store?',back:'heat'}),makeCard(h.id,{kind:'cloze',text:'{{c1::Amber}} stores {{c2::heat}}; {{c1::Amber}} releases energy.'})];
  return {h,ids:new Set(h.cards.map(c=>c.id))};
}
test('counts repeated cloze numbers once and preserves data',()=>{
  const {h,ids}=fixture();const before=structuredClone(h);
  const result=summarizeExport([h],ids);
  assert.equal(result.notes,2);assert.equal(result.tasks,3);assert.equal(result.error,undefined);
  assert.deepEqual(h,before);
});
for(const status of ['pending','flagged','approved','deleted','exported','duplicate'])test(`summary shares export eligibility for ${status}`,()=>{
  const {h,ids}=fixture();h.cards[0].status=status;
  assert.equal(summarizeExport([h],ids).notes,exportCandidates([h],ids).length);
});
for(const state of ['archived','dismissed','queued','generating','error','exported'])test(`${state} captures contribute no notes`,()=>{
  const {h,ids}=fixture();if(state==='archived')h.archived=true;else h.status=state;
  const result=summarizeExport([h],ids);assert.equal(result.notes,0);assert.equal(result.tasks,0);
});
test('only selected IDs count, including empty selections',()=>{
  const {h}=fixture();assert.equal(summarizeExport([h],new Set([h.cards[0].id])).tasks,1);
  assert.deepEqual(summarizeExport([h],new Set()),{notes:0,tasks:0,warnings:[]});
});
for(const kind of ['qa','cloze'])test(`invalid ${kind} reports the existing refusal, not a partial count`,()=>{
  const {h,ids}=fixture();h.cards[0].kind=kind;h.cards[0].front='';h.cards[0].text='{{c0::broken}}';
  const result=summarizeExport([h],ids);
  assert.match(result.error,/Cannot export/);assert.equal(result.notes,0);
  assert.throws(()=>exportCandidates([h],ids),{message:result.error});
});
test('legacy and edited cards without concrete findings have no status-only warning',()=>{
  const {h}=fixture();const c=h.cards[0];h.cards=[c];const ids=new Set([c.id]);
  assert.deepEqual(summarizeExport([h],ids).warnings,[]);
  c.generation={batchId:'g',planId:'P',factIds:['F'],audit:{status:'verified',reason:'Supported',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};
  assert.deepEqual(summarizeExport([h],ids).warnings,[]);
  c.front='Amber stores which form of energy?';
  assert.deepEqual(summarizeExport([h],ids).warnings,[]);
  h.text='Different capture';
  assert.deepEqual(summarizeExport([h],ids).warnings,[]);
});
for(const status of ['failed','unverified'])test(`${status} concrete findings survive wording and source changes without status labels`,()=>{
  const {h}=fixture();const c=h.cards[0];h.cards=[c];const ids=new Set([c.id]);
  const reason='The capture does not establish that Amber stores heat.';
  c.generation={batchId:'g',planId:'P',factIds:['F'],audit:{status,reason,content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};
  for(const change of ['none','card','capture']) {
    if(change==='card')c.front='Amber stores which form of energy?';
    if(change==='capture')h.text='Different capture';
    const before=structuredClone(h);
    assert.deepEqual(summarizeExport([h],ids).warnings,[{cardId:c.id,source:h.sourceTitle,reasons:[reason]}]);
    assert.deepEqual(h,before);
  }
});
for(const reason of ['', 'Unverified', 'Audit unverified', 'Independent audit has not run.', 'Explicit rewrite; original staged audit retained on the source card.'])test(`status-only audit reason does not warn: ${reason}`,()=>{
  const {h}=fixture();const c=h.cards[0];h.cards=[c];
  c.generation={batchId:'g',planId:'P',factIds:['F'],audit:{status:'unverified',reason,content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};
  assert.deepEqual(summarizeExport([h],new Set([c.id])).warnings,[]);
});
test('source-conflict details remain export warnings from the card’s own saved batch',()=>{
  const {h}=fixture();const c=h.cards[0];h.cards=[c];const ids=new Set([c.id]);
  c.generation={batchId:'old',planId:'P1',factIds:['F1'],audit:{status:'verified',reason:'Supported',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};
  h.generation={version:1,id:'new',inputKey:'',instruction:'',phase:'complete',preparation:{facts:[],plan:[],conflicts:[{factIds:['F1'],quote:'Unrelated batch quote',reason:'Other batch concern'}],exclusions:[],omissions:[]}};
  h.generationHistory=[{version:1,id:'old',inputKey:'',instruction:'',phase:'complete',preparation:{facts:[],plan:[],conflicts:[{factIds:['F1'],quote:'Exact <b>quote</b>',reason:'The source contradicts this claim.'},{factIds:['F2'],quote:'Other fact',reason:'Other fact concern'}],exclusions:[],omissions:[]}}];
  const before=structuredClone(h);
  assert.deepEqual(summarizeExport([h],ids).warnings,[{cardId:c.id,source:h.sourceTitle,reasons:['Source conflict: The source contradicts this claim. Quote: “Exact <b>quote</b>”']}]);
  assert.deepEqual(h,before);
});

test('legacy cards retain whole-capture conflicts as warnings without inventing fact-ID matches',()=>{
  const {h}=fixture();const c=h.cards[0];h.cards=[c];
  h.generationHistory=[{version:1,id:'old',inputKey:'',instruction:'',phase:'complete',preparation:{facts:[],plan:[],conflicts:[{quote:'Amber stores heat.',reason:'Earlier unresolved capture conflict.'},{factIds:['F1'],quote:'Other fact',reason:'No matching card provenance'}],exclusions:[],omissions:[]}}];
  const before=structuredClone(h);
  assert.deepEqual(summarizeExport([h],new Set([c.id])).warnings,[{cardId:c.id,source:h.sourceTitle,reasons:['Source conflict: Earlier unresolved capture conflict. Quote: “Amber stores heat.”']}]);
  assert.deepEqual(h,before);
});

test('current check issues and cross-source interference are advisory warnings',()=>{
  const {h,ids}=fixture();const c=h.cards[0];
  c.userCheck={content:cardContent(c,h),at:'fixture',issues:['Needs a more precise cue']};
  const warnings=summarizeExport([h],ids,new Map([[c.id,['outside-selection']]])).warnings;
  const reasons=warnings.find(w=>w.cardId===c.id).reasons.join(' ');
  assert.match(reasons,/Needs a more precise cue/);assert.match(reasons,/elsewhere|across|cross|source/i);
  c.front='Changed question?';
  assert.doesNotMatch(summarizeExport([h],ids).warnings.flatMap(w=>w.reasons).join(' '),/Needs a more precise cue/);
  assert.equal(exportCandidates([h],ids).length,2);
});
