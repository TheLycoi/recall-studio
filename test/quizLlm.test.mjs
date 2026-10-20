import { before,test } from 'node:test';
import assert from 'node:assert/strict';
import {loadQuiz,SOURCE} from './quizHarness.mjs';
let LlmClient;
test('real DeepSeek Quiz transport never blindly retries empty source-bearing output',async()=>{
 let calls=0;
 const {LlmClient:Client}=await loadQuiz('src/llm.ts',{requestUrl:async req=>{calls++;assert.match(JSON.parse(req.body).messages[1].content,/Affinity is the strength/);return{status:200,json:{choices:[{message:{content:''},finish_reason:'stop'}]}};}});
 const client=new Client(()=>({provider:'deepseek',deepseekApiKey:'synthetic-test-placeholder',deepseekModel:'deepseek-v4-flash',effort:'low'}));
 await assert.rejects(client.quizQuestion(args()));assert.equal(calls,1);
});
test('rendered free-response caller uses the real LlmClient and fails closed on a semantic audit rejection',async()=>{
 const {QuizView}=await loadQuiz();const {harness,start,text}=await import('./quizHarness.mjs');
 const h=harness(QuizView);const client=new LlmClient(()=>({provider:'codex'}));const labels=[];
 client.codex={complete:async req=>{labels.push(req.label);return req.schema.parse(req.label==='quiz cue'?{question:'What does affinity mean?',shape:'concept',expects:[1]}:req.label==='quiz question audit'?{supported:true}:req.label==='grade'?{...grade(),points:[{...grade().points[0],said:'Affinity does not describe binding strength.'}]}:{points:[{n:1,agrees:false}]});}};
 h.host.llm=client;await start(h);h.view.draftQuestion='Affinity does not describe binding strength.';await h.view.ask();
 assert.deepEqual(labels,['quiz cue','quiz question audit','grade','quiz grade audit']);assert.equal(h.view.session.results.length,0);assert.match(text(h.root),/No attempt counted/);
});
before(async()=>{({LlmClient}=await loadQuiz('src/llm.ts'));});
const args=()=>({noteTitle:'Receptors',section:'',part:1,parts:1,points:[SOURCE],level:1,asked:[],standingInstructions:'',failure:'',question:'What does affinity mean?',answer:SOURCE,cued:false,authorized:()=>true});
const grade=()=>({points:[{n:1,status:'recalled',said:SOURCE,note:'',cue:''}],feedback:'Untrusted feedback'});
const draft=()=>({question:'Which statement describes affinity?',point:1,choices:[{id:'A',text:SOURCE},{id:'B',text:'Mass'}],correctId:'A'});
test('real Quiz wrappers use bounded schemas, independent semantic audits and no blind transport retries',async()=>{
 const client=new LlmClient(()=>({provider:'codex'}));const calls=[];
 client.codex={complete:async req=>{calls.push(req);const value=req.label==='quiz question audit'?{supported:true}:req.label==='quiz choices'?draft():req.label==='quiz choice audit'?{choices:[{id:'A',supported:true},{id:'B',supported:false}]}:req.label==='quiz grade audit'?{points:[{n:1,agrees:true}]}:req.label==='grade'?grade():{question:'What does affinity mean?',shape:'concept',expects:[1]};return req.schema.parse(value);}};
 await client.quizQuestion(args());await client.quizRecallGrade(args());await client.quizMultipleChoice(args());await client.quizChoiceAudit({...args(),draft:draft()});await client.quizGradeAudit({...args(),grade:grade()});await client.quizQuestionAudit({...args(),draft:{question:"What does affinity mean?",shape:"concept",expects:[1]}});
 assert.equal(calls.length,6);for(const c of calls){assert.equal(c.retryInvalidResponse,false);assert.match(c.user,/Affinity is the strength/);}
 assert.match(calls[4].system,/negat|contradict/i);assert.match(calls[4].system,/overlap/i);assert.doesNotMatch(calls[4].user,/Untrusted feedback/);
});
for(const method of ['quizQuestion','quizQuestionAudit','quizRecallGrade','quizMultipleChoice','quizChoiceAudit','quizGradeAudit'])test(`${method} rechecks authorization at the real wrapper`,async()=>{
 const client=new LlmClient(()=>({provider:'codex'}));let calls=0;
 client.codex={complete:async()=>{calls++;return{};}};
 await assert.rejects(client[method]({...args(),authorized:()=>false,draft:draft(),grade:grade()}));assert.equal(calls,0);
});
test('revocation after provider await invalidates a real wrapper result',async()=>{
 const client=new LlmClient(()=>({provider:'codex'}));let allowed=true;
 client.codex={complete:async()=>{allowed=false;return{question:'What does affinity mean?',shape:'concept',expects:[1]};}};
 await assert.rejects(client.quizQuestion({...args(),authorized:()=>allowed}));
});
