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
function fixture(){const root=element();const h=makeHighlight({sourcePath:'synthetic.md',sourceTitle:'Synthetic',text:'Amber stores heat.',status:'ready'});const c=makeCard(h.id,{kind:'qa',front:'What does Amber store?',back:'heat'});h.cards=[c];const v=new InboxView({contentEl:root},{settings:{lintMode:'badge'},store:{all:()=>[h]},app:{}});return {root,h,c,v};}
for(const status of ['verified','unverified','failed'])test(`Inbox renders explicit ${status} audit text`,()=>{
  const {root,h,c,v}=fixture();c.generation={batchId:'g1',planId:'P1',factIds:['F1'],audit:{status,reason:'Concrete finding',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};
  v.renderCard(root,h,c);assert.match(labels(root),new RegExp(`Audit ${status}`));
  if(status!=='verified')assert.match(labels(root),/Concrete finding/);
});
test('legacy cards visibly say unverified, not implicitly passed',()=>{const {root,h,c,v}=fixture();v.renderCard(root,h,c);assert.match(labels(root),/Audit unverified/);});
test('editing card content invalidates the displayed audit',()=>{const {root,h,c,v}=fixture();c.generation={batchId:'g',planId:'P1',factIds:['F1'],audit:{status:'verified',reason:'supported',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};c.back='new user wording';v.renderCard(root,h,c);assert.match(labels(root),/Audit unverified \(card changed\)/);});
test('changing captured source invalidates the displayed audit',()=>{const {root,h,c,v}=fixture();c.generation={batchId:'g',planId:'P1',factIds:['F1'],audit:{status:'verified',reason:'supported',content:cardAuditContent(c),sourceKey:generationSourceKey(h)}};h.text='Changed source';v.renderCard(root,h,c);assert.match(labels(root),/Audit unverified \(capture changed\)/);});
test('prior source conflicts remain visible after an intentional new batch',()=>{const {root,h,v}=fixture();h.cards=[];h.generation={version:1,id:'new',inputKey:'',instruction:'',phase:'preparing'};h.generationHistory=[{version:1,id:'old',inputKey:'old',instruction:'',phase:'complete',preparation:{facts:[],plan:[],exclusions:[],omissions:[],conflicts:[{quote:'Amber stores heat.',reason:'Earlier unresolved conflict'}]}}];v.renderHighlight(root,h);assert.match(labels(root),/Earlier unresolved conflict/);});

test('passage displays saved preparation, omissions and source conflicts',()=>{const {root,h,v}=fixture();h.cards=[];h.generation={version:1,id:'g',inputKey:'x',instruction:'',phase:'auditing',preparation:{facts:[],plan:[],exclusions:[{factIds:['F1'],reason:'Excluded by reader'}],omissions:[{factIds:['F2'],reason:'Batch limit'}],conflicts:[{quote:'Amber stores heat.',reason:'Conflict requires review'}]}};v.renderHighlight(root,h);assert.match(labels(root),/Preparation saved/);assert.match(labels(root),/Audit unverified/);assert.match(labels(root),/Batch limit/);assert.match(labels(root),/Excluded by reader/);assert.match(labels(root),/Conflict requires review/);});
