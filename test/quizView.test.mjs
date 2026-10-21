import { before,test } from 'node:test';
import assert from 'node:assert/strict';
import {loadQuiz,harness,start,prepare,button,text,SOURCE} from './quizHarness.mjs';
const mc=()=>({question:'Which statement describes affinity?',point:1,choices:[{id:'A',text:'Affinity is a measure of drug mass.'},{id:'B',text:SOURCE},{id:'C',text:'Affinity is a measure of receptor size.'}],correctId:'B'});
function withMc(h){h.host.llm.quizMultipleChoice=async()=>mc();h.host.llm.quizChoiceAudit=async()=>({choices:[{id:'A',supported:false},{id:'B',supported:true},{id:'C',supported:false}]});return h;}
let QuizView;
test('a miss offers deliberate source-only capture, with no writes before clicking or duplicate more calls',async()=>{
 const h=withMc(harness(QuizView));await start(h,'Multiple choice');
 await button(h.root,`A. ${mc().choices[0].text}`).events.click();
 assert.equal(h.rows.length,0);const send=button(h.root,'Send to Inbox');assert.ok(send);
 await send.events.click();await send.events.click();
 assert.equal(h.rows.length,1);assert.equal(h.queued.length,1);assert.equal(h.rows[0].text,SOURCE);assert.equal(h.rows[0].origin,'quiz');
 assert.doesNotMatch(h.rows[0].instruction,/drug mass/);
});
for(const archived of [false,true])test(`existing ${archived?'archived':'active'} captures never silently request more`,async()=>{
 const h=withMc(harness(QuizView));await start(h,'Multiple choice');
 await button(h.root,`A. ${mc().choices[0].text}`).events.click();
 const send=button(h.root,'Send to Inbox');
 if(archived)h.host.store.hasDuplicate=()=>true;
 else h.rows.push({id:'old',sourcePath:h.file.path,text:SOURCE,status:'ready'});
 await send.events.click();assert.equal(h.queued.length,0);assert.match(text(h.root),/Already captured/);
});
test('source revocation after a miss prevents capture',async()=>{
 const h=withMc(harness(QuizView));await start(h,'Multiple choice');await button(h.root,`A. ${mc().choices[0].text}`).events.click();
 const send=button(h.root,'Send to Inbox');h.ignore();await send.events.click();assert.equal(h.rows.length,0);
});
test('a source-identity hint keeps supporting answers hidden; skip deliberately reveals the source',async()=>{
 const h=harness(QuizView);await start(h);await button(h.root,'Hint').events.click();
 assert.doesNotMatch(text(h.root),/Affinity is the strength/);assert.equal(h.calls.length,1);
 await button(h.root,'Skip').events.click();assert.match(text(h.root),/Affinity is the strength/);assert.equal(h.view.session.results[0].skipped,true);
});
test('mounted source events revoke retained grounding and capture offers without changing a draft',async()=>{
 const h=harness(QuizView);await h.view.onOpen();await start(h);await button(h.root,'Skip').events.click();
 h.view.draftQuestion='Unsent draft';h.file.stat.mtime++;h.events.modify(h.file);
 assert.equal(h.view.session,null);assert.equal(h.view.draftQuestion,'Unsent draft');assert.doesNotMatch(text(h.root),/Affinity is the strength/);
 await h.view.onClose();
});
test('conflicting unsaved editors and oversized sources fail before dispatch',async()=>{
 for(const kind of ['conflict','disk bound','extraction bound']){
  const h=harness(QuizView);
  if(kind==='conflict')h.editors.push(...['one','two'].map(value=>({view:{file:h.file,editor:{getValue:()=>value}}})));
  if(kind==='disk bound')h.file.stat.size=100001;
  if(kind==='extraction bound')h.setRaw('A'.repeat(100001));
  await start(h);assert.equal(h.calls.length,0);
 }
});
test('cancelled session cannot overwrite a newly started session when its old question resolves',async()=>{
 const h=harness(QuizView);let release;h.host.llm.quizQuestion=async()=>new Promise(r=>{release=r;});
 await prepare(h);const old=button(h.root,'Free response').events.click();
 while(!release)await new Promise(r=>setTimeout(r,0));
 h.view.cancel();h.host.llm.quizQuestion=async()=>({question:'Explain the binding concept?',shape:'concept',expects:[1]});await start(h);
 release({question:'Stale old question?',shape:'concept',expects:[1]});await old;
 assert.equal(h.view.session.current.cue,'Explain the binding concept?');assert.doesNotMatch(text(h.root),/Stale old question/);
});
test('source-bearing provider failures are generic and retryable, not learner misses',async()=>{
 const h=harness(QuizView);await start(h);
 h.host.llm.quizRecallGrade=async()=>{throw Error('SECRET SOURCE CANARY');};h.view.draftQuestion='Answer';await h.view.ask();
 assert.equal(h.view.session.results.length,0);assert.ok(h.view.session.current);assert.doesNotMatch(text(h.root),/SECRET SOURCE CANARY/);
});
test('cancelling MC removes old choices and restores the start action',async()=>{
 const h=withMc(harness(QuizView));await start(h,'Multiple choice');h.view.cancel();
 assert.ok(button(h.root,'Send'));assert.equal(h.view.mc,null);
});
test('a free-response question that the source cannot answer is not shown',async()=>{
 const h=harness(QuizView);h.host.llm.quizQuestion=async()=>({question:'Why do unicorns bind this receptor?',shape:'concept',expects:[1]});
 h.host.llm.quizQuestionAudit=async()=>({supported:false});await start(h);
 assert.equal(h.view.session?.current??null,null);assert.doesNotMatch(text(h.root),/unicorns/);
});
test('current questions and literal feedback link to their actual source note',async()=>{
 const h=harness(QuizView);await start(h);
 const {nodes}=await import('./quizHarness.mjs');
 let link=nodes(h.root).find(n=>n.tagName==='A'&&n.options.href===h.file.path);assert.ok(link);
 await button(h.root,'Skip').events.click();link=nodes(h.root).find(n=>n.tagName==='A'&&n.options.href===h.file.path);assert.ok(link);
});
test('an old grade failure cannot change the status of a new session',async()=>{
 const h=harness(QuizView);await start(h);let reject;
 h.host.llm.quizRecallGrade=async()=>new Promise((_,r)=>{reject=r;});h.view.draftQuestion='Answer';const old=h.view.ask();
 h.view.draftQuestion='quiz me';await h.view.ask();const status=h.view.status;
 reject(Error('OLD FAILURE'));await old;assert.equal(h.view.status,status);
});
test('a delayed Next-question failure cannot overwrite a new target choice',async()=>{
 const h=harness(QuizView);h.setRaw(`${SOURCE}\n## Mechanism\nA receptor can change its shape after ligand binding.`);await start(h);await button(h.root,'Skip').events.click();
 let reject;h.host.llm.quizQuestion=async()=>new Promise((_,r)=>{reject=r;});const old=button(h.root,'Next question').events.click();
 h.view.draftQuestion='quiz me';await h.view.ask();const status=h.view.status;reject(Error('OLD FAILURE'));await old;assert.equal(h.view.status,status);
});
test('typed next advances after feedback without broadening or counting another miss',async()=>{
 const h=harness(QuizView);h.setRaw(`${SOURCE}\n## Mechanism\nA receptor can change its shape after ligand binding.`);await start(h);await button(h.root,'Skip').events.click();
 h.view.draftQuestion='next';await h.view.ask();assert.ok(h.view.session.current);assert.equal(h.view.session.results.length,1);
});
test('actual caller resolves a singular alias and frontmatter tag strings on uppercase Markdown files',async()=>{
 for(const target of ['Binding sites','#bio']){
  const h=harness(QuizView);h.file.extension='MD';h.file.path='biology/Receptors.MD';
  h.host.app.metadataCache.getFileCache=()=>({frontmatter:{alias:'Binding sites',tags:'bio, study'}});
  await start(h,'Free response',`quiz me on ${target}`);assert.ok(h.view.session.current);
 }
});
before(async()=>{({QuizView}=await loadQuiz());});
for(const [id,count] of [['A',0],['B',1],['C',0]]) test(`multiple choice ${id} is graded locally and reveals only after the click`,async()=>{
 const h=withMc(harness(QuizView));await start(h,'Multiple choice');
 assert.match(text(h.root),/Which statement describes affinity/);assert.doesNotMatch(text(h.root),/Correct answer|Recalled|correctId|Supporting source/);
 const calls=h.calls.length;await button(h.root,`${id}. ${mc().choices.find(c=>c.id===id).text}`).events.click();
 assert.match(text(h.root),new RegExp(`Recalled ${count} of 1`));assert.equal(h.calls.length,calls);assert.equal(h.view.session.results.length,1);
});
for(const [name,change] of [
 ['invalid choice ID',d=>{d.choices[0].id='A\n';}],
 ['duplicate IDs',d=>{d.choices[2].id='B';}],['duplicate text',d=>{d.choices[2].text=d.choices[1].text;}],
 ['unsupported correct answer',d=>{d.choices[1].text='Affinity does not describe binding strength.';}],
 ['missing correct ID',d=>{d.correctId='D';}],['invalid point',d=>{d.point=2;}],
]) test(`MC validation rejects ${name} before rendering choices`,async()=>{
 const h=withMc(harness(QuizView));h.host.llm.quizMultipleChoice=async()=>{const d=mc();change(d);return d;};
 h.host.llm.quizChoiceAudit=async({draft})=>({choices:draft.choices.map(c=>({id:c.id,supported:c.id===draft.correctId}))});
 await start(h,'Multiple choice');assert.equal(h.view.session?.current??null,null);assert.doesNotMatch(text(h.root),/A\. Affinity/);
});
test('MC semantic audit rejects a second supported choice or missing verdict',async()=>{
 for(const choices of [[{id:'A',supported:true},{id:'B',supported:true},{id:'C',supported:false}],[]]){
  const h=withMc(harness(QuizView));h.host.llm.quizChoiceAudit=async()=>({choices});await start(h,'Multiple choice');assert.equal(h.view.session?.current??null,null);
 }
});
test('rendered free-response path hides evidence until an attempt and preserves legacy history without sending it',async()=>{
  const h=harness(QuizView);h.view.turns=[{role:'assistant',text:'OLD NON-EVIDENCE HISTORY'}];await h.view.onOpen();
  await start(h,'Free response','quiz me on Binding sites');
  assert.match(text(h.root),/What does affinity mean/);assert.doesNotMatch(text(h.root),/Affinity is the strength/);
  assert.match(text(h.root),/OLD NON-EVIDENCE HISTORY/);assert.equal(h.rows.length,0);
  assert.doesNotMatch(JSON.stringify(h.calls),/OLD NON-EVIDENCE HISTORY/);
  h.view.draftQuestion=SOURCE;await h.view.ask();
  assert.match(text(h.root),/Recalled 1 of 1/);assert.match(text(h.root),/Affinity is the strength/);
  assert.doesNotMatch(text(h.root),/Untrusted feedback/);assert.equal(h.view.session.results.length,1);
});
for (const [label,points] of [
  ['missing',[]],['duplicate',[{n:1,status:'missed',said:'',note:'',cue:''},{n:1,status:'missed',said:'',note:'',cue:''}]],
  ['out-of-range',[{n:2,status:'missed',said:'',note:'',cue:''}]],
  ['forged learner quote',[{n:1,status:'recalled',said:'Not in the answer',note:'',cue:''}]],
]) test(`a ${label} grade leaves the actual question retryable without counting a miss`,async()=>{
  const h=harness(QuizView);await start(h);
  h.host.llm.quizRecallGrade=async()=>({points,feedback:'INVENTED FEEDBACK'});
  h.view.draftQuestion='An answer';await h.view.ask();
  assert.equal(h.view.session.results.length,0);assert.ok(h.view.session.current);
  assert.match(text(h.root),/No attempt counted/);assert.doesNotMatch(text(h.root),/INVENTED FEEDBACK/);
});
for (const answer of ['Affinity is the number of unicorns in a receptor.','Affinity does not describe binding strength.'])
  test(`a source-unsupported learner claim is not accepted by token overlap: ${answer}`,async()=>{
    const h=harness(QuizView);await start(h);
    h.host.llm.quizGradeAudit=async()=>({points:[{n:1,agrees:false}]});
    h.view.draftQuestion=answer;await h.view.ask();
    assert.equal(h.view.session.results.length,0);assert.match(text(h.root),/No attempt counted/);
  });
test('missing or conflicting audit verdicts fail closed',async()=>{
  for(const points of [[],[{n:1,agrees:true},{n:1,agrees:false}],[{n:2,agrees:true}]]){
    const h=harness(QuizView);await start(h);h.host.llm.quizGradeAudit=async()=>({points});
    h.view.draftQuestion=SOURCE;await h.view.ask();assert.equal(h.view.session.results.length,0);
  }
});

for(const mutation of ['ignored','disk edit','rename','delete','unsaved edit'])
 test(`revocation during question await invalidates the result: ${mutation}`,async()=>{
  const h=harness(QuizView);let release;
  h.host.llm.quizQuestion=async()=>new Promise(r=>{release=r;});
  await prepare(h);const pending=button(h.root,'Free response').events.click();
  while(!release)await new Promise(r=>setTimeout(r,0));
  if(mutation==='ignored')h.ignore();
  if(mutation==='disk edit')h.file.stat.mtime++;
  if(mutation==='rename')h.file.path='renamed.md';
  if(mutation==='delete')h.host.app.vault.getFiles=()=>[];
  if(mutation==='unsaved edit')h.editors.push({view:{file:h.file,editor:{getValue:()=> 'Unsaved new source'}}});
  release({question:'What does affinity mean?',shape:'concept',expects:[1]});await pending;
  assert.equal(h.view.session?.current??null,null);assert.doesNotMatch(text(h.root),/What does affinity mean/);
 });
test('privacy is rechecked after an async source read before any provider call',async()=>{
 const h=harness(QuizView);h.host.app.vault.read=async()=>{h.ignore();return SOURCE;};
 await start(h);assert.equal(h.calls.length,0);
});
test('hidden and managed source names cannot authorize a read',async()=>{
 for(const path of ['.secret/Receptors.md','cards/Receptors.md','exports/Receptors.md']){
  const h=harness(QuizView);h.file.path=path;h.host.settings={schemaFolder:'cards',exportFolder:'exports'};
  await prepare(h,`quiz me on ${path}`);
  assert.equal(button(h.root,'Free response'),undefined);assert.equal(h.calls.length,0);
 }
});
test('source changes between grade and audit prevent the second source-bearing call',async()=>{
 const h=harness(QuizView);await start(h);
 h.host.llm.quizRecallGrade=async args=>{h.file.stat.mtime++;return{points:[{n:1,status:'recalled',said:args.answer,note:'',cue:''}],feedback:''};};
 h.view.draftQuestion=SOURCE;await h.view.ask();
 assert.equal(h.calls.filter(c=>c[0]==='audit').length,0);assert.equal(h.view.session?.results.length??0,0);
});
test('an unsaved editor supplies the actual source and later unsaved edits revoke it',async()=>{
 const h=harness(QuizView);let value='Binding affinity measures how strongly a drug attaches to its receptor.';
 h.editors.push({view:{file:h.file,editor:{getValue:()=>value}}});await start(h);
 assert.equal(h.calls[0][1].points[0],value);
 value='New unsaved source';h.view.draftQuestion='Answer';await h.view.ask();
 assert.equal(h.calls.filter(c=>c[0]==='grade').length,0);
});
test('cancel and unload discard delayed work without aborting shared generation',async()=>{
 for(const stop of ['cancel','onClose']){
  const h=harness(QuizView);let release;h.host.llm.abort=()=>{throw Error('shared abort forbidden');};
  h.host.llm.quizQuestion=async()=>new Promise(r=>{release=r;});
  await prepare(h);const pending=button(h.root,'Free response').events.click();
  while(!release)await new Promise(r=>setTimeout(r,0));await h.view[stop]();
  release({question:'What does affinity mean?',shape:'concept',expects:[1]});await pending;
  assert.equal(h.view.session?.current??null,null);
 }
});
