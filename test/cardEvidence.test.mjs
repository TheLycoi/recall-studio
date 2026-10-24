import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let resolveCardEvidence, makeCard, makeHighlight;
before(async()=>{
  const out=await build({stdin:{contents:`export {resolveCardEvidence} from './src/cardEvidence'; export {makeCard,makeHighlight} from './src/model';`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node'});
  const m=new Module('evidence');m._compile(out.outputFiles[0].text,'evidence');
  ({resolveCardEvidence,makeCard,makeHighlight}=m.exports);
});
function fixture(){
  const h=makeHighlight({sourcePath:'source.md',sourceTitle:'Source',text:'Exact quote.'});
  const c=makeCard(h.id,{kind:'qa',front:'Question?',back:'Answer',generation:{batchId:'batch',planId:'P1',factIds:['F1'],audit:{status:'unverified',reason:'Not checked',content:''}}});
  h.generation={version:1,id:'batch',phase:'complete',preparation:{facts:[{id:'F1',statement:'Fact',quote:'Exact quote.'}],plan:[{id:'P1',factIds:['F1'],reason:'Important relation'}],exclusions:[],omissions:[],conflicts:[]}};
  h.cards=[c];return {h,c};
}
test('resolves current batch evidence without changing stored data',()=>{
  const {h,c}=fixture();const before=structuredClone(h);
  const result=resolveCardEvidence(h,c);
  assert.equal(result.state,'resolved');assert.equal(result.facts[0].quote,'Exact quote.');
  assert.equal(result.plan.reason,'Important relation');assert.deepEqual(h,before);
});
test('legacy cards do not borrow the latest evidence',()=>{
  const {h,c}=fixture();delete c.generation;
  assert.deepEqual(resolveCardEvidence(h,c),{state:'legacy',facts:[]});
});
for(const [label,change] of [
  ['missing batch',({c})=>c.generation.batchId='gone'],
  ['missing preparation',({h})=>delete h.generation.preparation],
  ['missing plan',({c})=>c.generation.planId='P2'],
  ['missing fact',({c})=>c.generation.factIds=['F2']],
  ['no fact references',({c})=>c.generation.factIds=[]],
  ['fact outside plan',({h})=>h.generation.preparation.plan[0].factIds=[]],
  ['conflicting batch IDs',({h})=>h.generationHistory=[structuredClone(h.generation)]],
  ['conflicting plan IDs',({h})=>h.generation.preparation.plan.push({...h.generation.preparation.plan[0],reason:'Other'})],
  ['conflicting fact IDs',({h})=>h.generation.preparation.facts.push({id:'F1',statement:'Other',quote:'Other'})],
])test(`${label} fails visibly without substituting evidence`,()=>{
  const f=fixture();change(f);
  assert.deepEqual(resolveCardEvidence(f.h,f.c),{state:'missing',facts:[]});
});
test('retained evidence survives a source rename and repeated references stay unique',()=>{
  const {h,c}=fixture();h.sourcePath='renamed.md';c.generation.factIds=['F1','F1'];
  h.generationHistory=[h.generation];delete h.generation;
  assert.equal(resolveCardEvidence(h,c).facts.length,1);
});
