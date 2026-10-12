import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
let View, chat;
before(async () => {
  async function load(file) {
    const out = await build({ entryPoints: [file], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
    const mod = new Module(file);
    mod.require = id => id === 'obsidian' ? { ItemView: class {}, Notice: class {} } : Module.createRequire(import.meta.url)(id);
    mod._compile(out.outputFiles[0].text, file);
    return mod.exports;
  }
  View = (await load('src/reviewChatView.ts')).ChatView;
  chat = await load('src/reviewChat.ts');
});
const seed = (path, text) => ({ path, title: path, page: null, line: 1, kind: 'note', text });
function harness(notes, ignored = []) {
  const reads = [], requests = [], added = [];
  const files = Object.entries(notes).map(([path,text]) => ({ path, basename:path.replace('.md',''), stat: {size:text.length} }));
  const host = { app: { vault: { configDir:'.obsidian', getMarkdownFiles:()=>files, cachedRead:async f=>{reads.push(f.path);return notes[f.path];} }, metadataCache:{isUserIgnored:p=>ignored.includes(p)} }, settings:{schemaFolder:'Review Inbox',exportFolder:'exports'}, store:{all:()=>[],add:h=>{added.push(h);return h;}}, generator:{enqueue(){}}, openInbox(){}, llm:{answerSelected:async args=>{
    requests.push(args);
    const e=args.evidence[0];
    return {coverage:'full',quotes:[{n:1,quote:e.text}],sentences:[{text:e.text,kind:'claim',cited:[1]}]};
  } } };
  const view = new View({},host); view.render=()=>{};
  return {view,reads,requests,added,files};
}
test('zero-selection Chat retrieves relevant vault evidence and sends a grounded answer to Inbox', async () => {
  const h=harness({'unrelated.md':'Bananas are yellow.','late.md':'The mnemonic lunacat means lunar navigation.'});
  h.view.draftQuestion='What does lunacat mean?'; await h.view.ask();
  assert.equal(h.requests.length,1);
  assert.deepEqual(h.requests[0].evidence.map(x=>x.path),['late.md']);
  const turn=h.view.turns.find(x=>x.report); assert.equal(turn.report.refused,false);
  assert.equal(chat.resolveCitationPath(1,turn.evidence,turn.selectedPaths),'late.md');
  await h.view.sendToInbox(turn); await h.view.sendToInbox(turn);
  assert.equal(h.added.length,1); assert.equal(h.added[0].sourcePath,'late.md');
});
test('automatic retrieval skips hidden, ignored, plugin-managed and oversized notes before reading',async()=>{
  const h=harness({'.secret.md':'lunacat secret','private.md':'lunacat private','Review Inbox/rules.md':'lunacat rules','exports/cards.md':'lunacat card','huge.md':'lunacat huge','ok.md':'lunacat is a fixture'},['private.md']);
  h.files.find(f=>f.path==='huge.md').stat.size=2_000_000;
  h.view.draftQuestion='lunacat';await h.view.ask();
  assert.deepEqual(h.reads,['ok.md']);
  assert.equal(h.requests[0].evidence[0].path,'ok.md');
});
test('optional source narrowing excludes all other note reads and earlier history',async()=>{
  const h=harness({'a.md':'Lunacat is selected.','excluded.md':'Lunacat EXCLUDED_SECRET.'});
  h.view.selected.add('a.md');h.view.turns=[{role:'assistant',text:'EXCLUDED_SECRET'}];
  h.view.draftQuestion='lunacat';await h.view.ask();
  assert.deepEqual(h.reads,['a.md']);assert.ok(!JSON.stringify(h.requests).includes('EXCLUDED_SECRET'));
});
test('no lexical evidence refuses locally without sending unrelated vault text',async()=>{
  const h=harness({'a.md':'Bananas are yellow.'});h.view.draftQuestion='Explain superconductivity';await h.view.ask();
  assert.equal(h.requests.length,0);assert.match(h.view.turns.at(-1).text,/no relevant|could not find/i);
});
test('relevance ranking reaches a late passage and preserves exact line provenance',()=>{
  const seeds=[seed('a.md','Noise.\n\n'.repeat(100)+'Lunacat means lunar navigation.')];
  const ranked=chat.selectChatPassages(seeds,'What is lunacat?');
  assert.equal(ranked[0].text,'Lunacat means lunar navigation.');assert.equal(ranked[0].line,201);
});
test('retrieval ranks before bounding and limits passage size, count, and prompt bytes',()=>{
  const seeds=Array.from({length:100},(_,i)=>seed(`${i}.md`,'Lunacat '+('description '.repeat(500))));
  const selected=chat.selectChatPassages(seeds,'lunacat',40);
  assert.ok(selected.length<=40);assert.ok(selected.every(s=>s.text.length<=1200));
  const {evidence}=chat.buildChatEvidence(selected);assert.ok(evidence.reduce((n,e)=>n+e.text.length,0)<=12000);
});
test('UI defaults to a collapsed optional scope and the export button says Export',()=>{
  const view=readFileSync('src/reviewChatView.ts','utf8');
  assert.match(view,/details\.open = false/);assert.ok(!view.includes('Select at least one source'));
  assert.match(readFileSync('src/inboxView.ts','utf8'),/const exportAll[^\n]*text: "Export"/);
});
