import { build } from 'esbuild';
import Module from 'node:module';
export async function loadQuiz(entry='src/quizView.ts',overrides={}) {
  const out=await build({entryPoints:[entry],bundle:true,write:false,format:'cjs',platform:'node',external:['obsidian'],logLevel:'silent'});
  const mod=new Module('quiz-view');
  const host={ItemView:class {constructor(leaf){this.contentEl=leaf.contentEl;}registerDomEvent(){}registerEvent(){}},MarkdownView:class {},Notice:class {},setIcon(){},...overrides};
  mod.require=id=>id==='obsidian'?new Proxy(host,{get:(o,k)=>o[k]??class{}}):Module.createRequire(import.meta.url)(id);
  mod._compile(out.outputFiles[0].text,'quiz-view');return mod.exports;
}
const parents = new WeakMap();
export function element(tag='div',options={}) {
  return {tagName:tag.toUpperCase(),options,children:[],dataset:{},events:{},scrollTop:0,value:'',text:options.text??'',classes:(options.cls??'').split(/\s+/),
    createEl(tag,opts){const e=element(tag,opts);parents.set(e,this);this.children.push(e);return e;},createDiv(o){return this.createEl('div',o);},createSpan(o){return this.createEl('span',o);},
    addClass(c){this.classes.push(c);},removeClass(c){this.classes=this.classes.filter(x=>x!==c);},hasClass(c){return this.classes.includes(c);},toggleClass(c,on){if(on)this.addClass(c);else this.removeClass(c);},
    setText(s){this.text=s;},appendText(s){this.text+=s;},setAttribute(k,v){this[k]=v;},addEventListener(k,v){this.events[k]=v;},empty(){this.children=[];},querySelector(){return null;},focus(){},
    querySelectorAll(selector){
      if(!/^\.[\w.-]+$/.test(selector))throw new Error(`Unsupported fixture selector: ${selector}`);
      return nodes(this).slice(1).filter(n=>selector.slice(1).split('.').every(c=>n.hasClass(c)));
    },
    closest(selector){
      for(let n=this;n;n=parents.get(n)) {
        if(selector.split(',').some(s=>s.trim().startsWith('.')?s.trim().slice(1).split('.').every(c=>n.hasClass(c)):n.tagName===s.trim().toUpperCase()))return n;
      }
      return null;
    },
  };
}
export const nodes=e=>[e,...e.children.flatMap(nodes)];
export const text=e=>nodes(e).map(n=>n.text).join('\n');
export const button=(root,label)=>nodes(root).find(n=>n.tagName==='BUTTON'&&n.text===label);
export const SOURCE='Affinity is the strength with which a drug binds its receptor.';
export function harness(QuizView) {
  const root=element();const file={path:'biology/Receptors.md',basename:'Receptors',extension:'md',stat:{mtime:1,size:SOURCE.length}};
  let raw=SOURCE,ignored=false;const rows=[],queued=[],editors=[];const events={};
  const app={vault:{configDir:'.obsidian',getFiles:()=>[file],getAbstractFileByPath:p=>p===file.path?file:null,read:async()=>raw,on:(name,fn)=>{events[name]=fn;return{};}},
    metadataCache:{isUserIgnored:()=>ignored,getFileCache:()=>({frontmatter:{aliases:['Binding sites'],tags:['bio']},tags:[{tag:'#bio/receptors'}]})},
    workspace:{getActiveFile:()=>file,getLeavesOfType:()=>editors,on:(name,fn)=>{events[name]=fn;return{};},openLinkText:async()=>{}}};
  const calls=[];
  const host={app,settings:{},store:{all:()=>rows,allHistory:()=>rows,touch:()=>{},add:h=>{rows.push(h);return h;},hasDuplicate:(p,t)=>rows.some(h=>h.sourcePath===p&&h.text.replace(/\s+/g,' ').trim()===t)},generator:{enqueue:h=>queued.push(h),more:()=>{throw Error('must not request more');}},openInbox(){},llm:{
    requestAuthorization:(check=()=>true)=>check,
    selectStudyEvidence:async args=>({selections:args.passages.map(p=>({id:p.id,quote:p.text})),gaps:[]}),
    quizQuestion:async args=>{calls.push(['question',args]);return{question:'What does affinity mean?',shape:'concept',expects:[1]};},
    quizQuestionAudit:async()=>({supported:true}),
    quizRecallGrade:async args=>{calls.push(['grade',args]);return{points:[{n:1,status:'recalled',said:args.answer,note:'',cue:''}],feedback:'Untrusted feedback'};},
    quizGradeAudit:async args=>{calls.push(['audit',args]);return{points:[{n:1,agrees:true}]};},
  }};
  const view=new QuizView(root,host);
  return {root,view,host,file,rows,queued,calls,events,editors,setRaw:s=>{raw=s;},ignore:()=>{ignored=true;}};
}
export async function prepare(h,request='quiz me on Receptors') {
  h.view.draftQuestion=request;await h.view.ask();
  if(h.view.awaitingTopic){h.view.draftQuestion='Receptors';await h.view.ask();}
  h.view.draftQuestion='Test the definition and mechanism.';await h.view.ask();
}
export async function start(h,mode='Free response',request='quiz me on Receptors') {
  await prepare(h,request);
  const b=button(h.root,mode);if(!b)throw Error('Mode button missing: '+text(h.root));await b.events.click();
}
