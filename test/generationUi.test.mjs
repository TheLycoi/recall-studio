import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let InboxView, makeHighlight, makeCard, cardAuditContent, generationSourceKey;
before(async()=>{
  const out=await build({stdin:{contents:`export {InboxView} from './src/inboxView';export {makeHighlight,makeCard} from './src/model';export {cardAuditContent,generationSourceKey} from './src/generation';`,resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian'],logLevel:'silent'});
  const m=new Module('audit-ui');m.require=id=>id==='obsidian'?new Proxy({ItemView:class{constructor(leaf){this.contentEl=leaf.contentEl;}},setIcon(){}},{get:(o,k)=>o[k]??class{}}):Module.createRequire(import.meta.url)(id);
  m._compile(out.outputFiles[0].text,'audit-ui');({InboxView,makeHighlight,makeCard,cardAuditContent,generationSourceKey}=m.exports);
});
function element(options={}){return {options,children:[],dataset:{},createDiv(o){return this.createEl('div',o);},createSpan(o){return this.createEl('span',o);},createEl(t,o){const e=element(o);this.children.push(e);return e;},setText(t){this.options.text=t;},setAttribute(){},addEventListener(){},addClass(){},appendText(){}};}
function labels(e){return [e.options.text??'',...e.children.flatMap(labels)].join('\n');}
function reasons(e) {
  return [
    ...(e.options.cls === 'wikilm-card-reason' ? [e.options.text] : []),
    ...e.children.flatMap(reasons),
  ];
}

test('a failed cloze audit and its mirrored critique appear only once', () => {
  const {root,h,c,v}=fixture();
  c.kind='cloze';
  c.text='Amber stores {{c1::heat}}.';
  c.status='flagged';
  const reason='The target is vague and can be supplied from the preceding wording.';
  c.generation={batchId:'g1',planId:'P1',factIds:['F1'],audit:{status:'failed',reason,content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};
  c.critiqueReason=reason;
  const before=structuredClone(h);
  v.renderCard(root,h,c);
  assert.deepEqual(reasons(root),[reason]);
  assert.doesNotMatch(labels(root),/Audit failed|Audit unverified|Audit verified/);
  assert.match(labels(root),/critique/);
  assert.deepEqual(h,before);
});
function batch(id, quote) {
  return {version:1,id,inputKey:'',instruction:'',phase:'complete',preparation:{
    facts:[{id:'F1',statement:'Stored fact',quote}],
    plan:[{id:'P1',factIds:['F1'],entity:'Amber',aspect:'storage',value:'heat',reason:`Reason for ${id}`}],
    exclusions:[],omissions:[],conflicts:[],
  }};
}

test('Evidence displays exact quotes and plan reasons from the card’s own historical batch', () => {
  const {root,h,c,v}=fixture();
  h.generation=batch('new','Wrong batch quote');
  h.generationHistory=[batch('old','Exact <b>quote</b>\nfrom the source.')];
  c.generation={batchId:'old',planId:'P1',factIds:['F1'],audit:{status:'failed',reason:'Stored concern',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};
  const before=structuredClone(h);
  v.renderCard(root,h,c);
  const text=labels(root);
  assert.match(text,/Evidence/);
  assert.match(text,/Exact <b>quote<\/b>\nfrom the source\./);
  assert.match(text,/F1/);
  assert.match(text,/P1/);
  assert.match(text,/Reason for old/);
  assert.match(text,/Stored concern/);
  assert.doesNotMatch(text,/Stored audit|Audit failed|Audit unverified|Audit verified/);
  assert.doesNotMatch(text,/Wrong batch quote|Reason for new/);
  assert.deepEqual(h,before);
});

function fixture(){const root=element();const h=makeHighlight({sourcePath:'synthetic.md',sourceTitle:'Synthetic',text:'Amber stores heat.',status:'ready'});const c=makeCard(h.id,{kind:'qa',front:'What does Amber store?',back:'heat'});h.cards=[c];const v=new InboxView({contentEl:root},{settings:{lintMode:'badge'},store:{all:()=>[h]},app:{}});return {root,h,c,v};}
for(const status of ['unverified','failed'])test(`Inbox retains ${status} findings after wording and capture changes without status labels`,()=>{
  const {root,h,c,v}=fixture();c.generation={batchId:'g1',planId:'P1',factIds:['F1'],audit:{status,reason:'Concrete finding',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};
  c.back='New user wording';h.text='Changed capture';
  const before=structuredClone(h);
  v.renderCard(root,h,c);
  assert.deepEqual(reasons(root),['Concrete finding']);
  assert.doesNotMatch(labels(root),/Audit verified|Audit unverified|Audit failed/);
  assert.deepEqual(h,before);
});
test('legacy cards retain the missing-evidence explanation without a certification label',()=>{const {root,h,c,v}=fixture();v.renderCard(root,h,c);assert.match(labels(root),/No staged evidence was saved/);assert.doesNotMatch(labels(root),/verified|unverified/);});
test('editing card content does not display a positive audit result',()=>{const {root,h,c,v}=fixture();c.generation={batchId:'g',planId:'P1',factIds:['F1'],audit:{status:'verified',reason:'supported',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};c.back='new user wording';v.renderCard(root,h,c);assert.doesNotMatch(labels(root),/Audit|verified|unverified|supported/);});
test('changing captured source does not display a positive audit result',()=>{const {root,h,c,v}=fixture();c.generation={batchId:'g',planId:'P1',factIds:['F1'],audit:{status:'verified',reason:'supported',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};h.text='Changed source';v.renderCard(root,h,c);assert.doesNotMatch(labels(root),/Audit|verified|unverified|supported/);});
test('prior source conflicts remain visible after an intentional new batch',()=>{const {root,h,v}=fixture();h.cards=[];h.generation={version:1,id:'new',inputKey:'',instruction:'',phase:'preparing'};h.generationHistory=[{version:1,id:'old',inputKey:'old',instruction:'',phase:'complete',preparation:{facts:[],plan:[],exclusions:[],omissions:[],conflicts:[{quote:'Amber stores heat.',reason:'Earlier unresolved conflict'}]}}];v.renderHighlight(root,h);assert.match(labels(root),/Earlier unresolved conflict/);});

test('passage displays saved preparation, omissions and source conflicts',()=>{const {root,h,v}=fixture();h.cards=[];h.generation={version:1,id:'g',inputKey:'x',instruction:'',phase:'auditing',preparation:{facts:[],plan:[],exclusions:[{factIds:['F1'],reason:'Excluded by reader'}],omissions:[{factIds:['F2'],reason:'Batch limit'}],conflicts:[{quote:'Amber stores heat.',reason:'Conflict requires review'}]}};v.renderHighlight(root,h);assert.match(labels(root),/Preparation saved/);assert.doesNotMatch(labels(root),/Audit unverified/);assert.match(labels(root),/Batch limit/);assert.match(labels(root),/Excluded by reader/);assert.match(labels(root),/Conflict requires review/);});
