import { build } from 'esbuild';
import { sharedBuildOptions } from './esbuild-shared.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const vault = process.argv[2] || 'academicwiki';
const outDir = resolve(homedir(), '.hermes/cache/scratch/recall-candidate-host');
mkdirSync(outDir, { recursive: true });
const bundlePath = resolve(outDir, 'candidate.cjs');
const out = await build({ ...sharedBuildOptions(), entryPoints: ['scripts/candidate-host.mjs'], write: false, logLevel: 'silent' });
// Quiet Notice only; all view, lifecycle and CodeMirror APIs come from the host.
const bundle = `const nativeObsidian=require('obsidian'); const nativeRequire=require;
const QuietModal=class extends nativeObsidian.Modal {
  constructor(target){super(app);this.app=target;(target._probeModals??=[]).push(this);}
  open(){return this.onOpen();} close(){this.onClose?.();this.containerEl.remove();}
};
(function(require,module,exports){\n${out.outputFiles[0].text}\n})(id=>id==='obsidian'?{...nativeObsidian,Modal:QuietModal,Notice:class{hide(){}}}:nativeRequire(id),module,exports);`;
writeFileSync(bundlePath, bundle);
const css = readFileSync('styles.css', 'utf8');
const expression = `(async()=>{
  const fs=require('fs'), crypto=require('crypto');
  const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
  if(app.vault.getName()!==${JSON.stringify(vault)})throw Error('Wrong vault');
  const live=app.plugins.plugins['review-inbox'];
  const leaf=app.workspace.getLeavesOfType('review-inbox')[0];
  if(!live||!leaf)throw Error('Existing plugin/view unavailable');
  const liveView=leaf.view;
  const snapshot=()=>hash({settings:live.settings,data:live.store?.data,workspace:app.workspace.getLayout(),
    interaction:{panel:liveView.panel,editing:liveView.editing,turns:liveView.chat?.turns,draft:liveView.chat?.draftQuestion},
    editors:app.workspace.getLeavesOfType('markdown').map(l=>({path:l.view.file?.path,text:l.view.editor?.getValue()}))});
  const before=snapshot(); const focus=document.activeElement;
  const id='recall-candidate-probe';
  const bytes=fs.readFileSync(${JSON.stringify(bundlePath)},'utf8');
  const manager={isEnabled:()=>true,plugins:{},manifests:{[id]:{id,name:'Candidate probe',version:'0.0.0',dir:'synthetic-only'}},
    app:{_probeLeaf:leaf,vault:{adapter:{read:async path=>{if(path!=='synthetic-only/main.js')throw Error('Unexpected loader read');return bytes;}}}}};
  const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.appendChild(style);
  let candidate;
  try{
    candidate=await app.plugins.loadPlugin.call(manager,id);
    const result=candidate.result;
    if(snapshot()!==before)throw Error('Live data or interaction changed during probe');
    return JSON.stringify({vault:app.vault.getName(),installedVersion:live.manifest.version,installedName:live.manifest.name,
      liveStatePreserved:true,installedRegistrationPreserved:app.plugins.plugins['review-inbox']===live&&!app.plugins.plugins[id],
      candidateBundleSha256:crypto.createHash('sha256').update(bytes).digest('hex'),...result});
  }finally{
    (candidate??manager.plugins[id])?.unload();style.remove();
    if(focus?.isConnected&&document.activeElement!==focus)focus.focus({preventScroll:true});
  }
})()`;
const output = execFileSync('obsidian', [`vault=${vault}`, 'eval', `code=${expression}`], { encoding: 'utf8', timeout: 45000 });
writeFileSync(resolve(outDir, 'host-output.txt'), output);
console.log(output);
const match = output.match(/=> (\{[^\n]+\})/);
if (!match) throw Error('Host verification failed; see host-output.txt');
const result = JSON.parse(match[1]);
if (!result.liveStatePreserved || !result.installedRegistrationPreserved || !result.checks?.length) throw Error('Incomplete host result');
writeFileSync(resolve(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`Evidence: ${outDir}`);
