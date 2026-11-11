// Production storage/export regressions; only synthetic vault data is written.
// All source is bundled from the pinned worktree; IO and transport are synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Module, { createRequire } from 'node:module';
const ROOT = process.cwd();
const require = createRequire(`${ROOT}/package.json`);
const { build } = require('esbuild');
const notices = [];
let requestImpl = () => { throw Error("NETWORK FORBIDDEN"); };
const buttons = [];
const element = () => ({ createEl: element, createDiv: element, empty() {} });
class Setting {
  addButton(f) { const b = { setButtonText(t) { this.text = t; return this; }, onClick(fn) { buttons.push({ text: this.text, fn }); return this; } }; f(b); return this; }
}
class Modal {
  constructor() { this.contentEl = element(); }
  open() { buttons.length = 0; this.onOpen(); const b = buttons.find(b => b.text === 'Export despite warnings'); assert.ok(b); b.fn(); }
  close() { this.onClose?.(); }
}
const host = new Proxy({
  Notice: class { constructor(s) { notices.push(String(s)); } hide() {} },
  normalizePath: p => p, Setting, Modal,
  requestUrl: req => requestImpl(req),
}, { get: (o,k) => o[k] ?? class {} });
const built = await build({ stdin: { contents: `
export { default as RecallPlugin } from './src/main';
export * from './src/store'; export * from './src/model';
export * from './src/anki'; export * from './src/inboxData';
export * from './src/cardActions'; export { DEFAULT_SETTINGS } from './src/settings';
`, resolveDir: ROOT, sourcefile: 'storage-audit-entry.ts', loader: 'ts' }, bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
const mod = new Module(`${ROOT}/storage-audit-bundle.cjs`);
mod.require = id => id === 'obsidian' ? host : require(id);
mod._compile(built.outputFiles[0].text, `${ROOT}/storage-audit-bundle.cjs`);
const m = mod.exports;
globalThis.window = globalThis;
const DIR = 'synthetic';
const LIVE = `${DIR}/inbox.json`;
function vault(seed = {}) {
  const files = new Map(Object.entries(seed)), dirs = new Set([DIR]), operations = [];
  const adapter = {
    async exists(p) { return files.has(p) || dirs.has(p); },
    async mkdir(p) { dirs.add(p); operations.push(['mkdir',p]); },
    async read(p) { assert.ok(files.has(p), `missing ${p}`); return files.get(p); },
    async write(p,s) { assert.ok(dirs.has(p.slice(0,p.lastIndexOf('/')))); files.set(p,s); operations.push(['write',p]); },
    async rename(a,b) { assert.ok(files.has(a), `missing ${a}`); assert.equal(files.has(b),false, `destination exists ${b}`); files.set(b,files.get(a)); files.delete(a); operations.push(['rename',a,b]); },
    async remove(p) { assert.ok(files.has(p)); files.delete(p); operations.push(['remove',p]); },
  };
  const app = { vault: { adapter, getName: () => 'Synthetic audit', createFolder: async p => dirs.add(p),
    create: async (p,s) => { assert.equal(files.has(p),false); files.set(p,s); return {path:p}; } }, metadataCache: { getFirstLinkpathDest: () => null } };
  return { app, adapter, files, dirs, operations };
}
function highlight(id = 'h') {
  const h = m.makeHighlight({ id, sourcePath: `${id}.md`, sourceTitle: 'Receptors', text: 'Affinity measures binding strength.', status: 'ready' });
  h.cards = [m.makeCard(h.id, { id: `c-${id}`, kind: 'qa', front: 'What does affinity measure?', back: 'Binding strength.' })];
  return h;
}
function data(hs) { return JSON.stringify({version:1, highlights:hs}); }
async function setup(seed = {}) {
  const v = vault(seed), store = new m.InboxStore(v.app, DIR); await store.load();
  const plugin = new m.RecallPlugin(); plugin.app = v.app; plugin.store = store;
  plugin.settings = {...m.DEFAULT_SETTINGS, includeExtra: true, exportFolder: 'export', defaultDeck: 'Synthetic'};
  const sent = [];
  plugin.anki = { createDeck: async () => 1, findNotes: async () => [], addNotes: async notes => { sent.push(...structuredClone(notes)); return [8000 + sent.length]; } };
  return {...v, store, plugin, sent};
}


for (const method of ['exportHighlights','exportAsTextFile']) {
  for (const unavailable of ['preload','closed','future-version']) test(`STORE-001 ${method} refuses ${unavailable} storage`, async () => {
    const f=await setup(unavailable==='future-version'?{[LIVE]:JSON.stringify({version:2,highlights:[]})}:{});
    if(unavailable==='preload'){f.store.close();f.store=new m.InboxStore(f.app,DIR);f.plugin.store=f.store;}
    const h=highlight();f.store.add(h);if(unavailable==='closed')f.store.close();
    try {
      await f.plugin[method]([h]);
      assert.equal(f.sent.length,0);assert.equal(h.cards[0].status,'pending');
      assert.equal([...f.files.keys()].some(p=>p.endsWith('.txt')),false);assert.equal(f.store.hasUnsavedChanges,true);
    } finally {f.store.close();}
  });
}
for (const change of ['settings','membership','archive']) test(`STORE-007 ${change} during folder preparation revokes file dispatch`,async()=>{
  const f=await setup();const h=highlight();f.store.add(h);const exists=f.adapter.exists;
  f.adapter.exists=async p=>{if(p==='export'){
    if(change==='settings')f.plugin.settings.defaultDeck='Changed';
    if(change==='membership')h.cards=[];
    if(change==='archive')h.archived=true;
    return true;
  }return exists(p);};
  const card=h.cards[0];let written=0;f.app.vault.create=async()=>{written++;};
  try{await f.plugin.exportAsTextFile([h]);assert.equal(written,0);assert.equal(card.status,'pending');assert.equal(card.textExport,undefined);}
  finally{f.store.close();}
});
for(const boundary of ['findNotes','storeMediaFile'])test(`STORE-006 endpoint changes at ${boundary} stop later network requests`,async()=>{
  const f=await setup();const h=highlight();h.cards[0].extra='![[local.png]]';f.store.add(h);const calls=[];
  f.app.metadataCache.getFirstLinkpathDest=()=>({path:'local.png'});f.app.vault.readBinary=async()=>new Uint8Array([1,2,3]).buffer;
  f.plugin.settings.ankiConnectUrl='http://first.synthetic.invalid';f.plugin.anki=new m.AnkiClient(()=>f.plugin.settings.ankiConnectUrl);
  requestImpl=async req=>{const b=JSON.parse(req.body);calls.push([b.action,req.url]);
    if(b.action===boundary)f.plugin.settings.ankiConnectUrl='http://second.synthetic.invalid';
    return{status:200,json:{error:null,result:b.action==='findNotes'?[]:b.action==='storeMediaFile'?b.params.filename:1}};};
  try{await f.plugin.exportHighlights([h]);assert.equal(calls.at(-1)[0],boundary);assert.ok(calls.every(c=>c[1]==='http://first.synthetic.invalid'));assert.equal(h.cards[0].status,'pending');}
  finally{f.store.close();requestImpl=()=>{throw Error('NETWORK FORBIDDEN');};}
});

test('STORE-007 a completed file keeps its exact payload receipt without certifying later edits', async () => {
  const f=await setup(); const h=highlight(); h.topicPath='old-topic.md'; f.store.add(h); let outgoing;
  f.app.vault.create=async(p,s)=>{outgoing=s;h.topicPath='new-topic.md';return{path:p};};
  try {
    await f.plugin.exportAsTextFile([h]);
    assert.match(outgoing,/old-topic/); assert.equal(h.cards[0].status,'pending');
    assert.match(h.cards[0].textExport.content,/old-topic/); assert.doesNotMatch(h.cards[0].textExport.content,/new-topic/);
    assert.equal(h.cards[0].ankiNoteId,undefined);
    const fresh=new m.InboxStore(f.app,DIR); await fresh.load();
    assert.deepEqual(fresh.get(h.id).cards[0].textExport,h.cards[0].textExport);fresh.close();
  } finally {f.store.close();}
});


for (const live of [undefined, data([highlight('current')])]) test(`STORE-004 preserves future backup and pending bytes; live=${!!live}`, async () => {
  const future = JSON.stringify({version:2,highlights:[highlight('future')],future:true});
  const seed = {[`${LIVE}.backup`]:future,[`${LIVE}.pending-newer`]:future};
  if (live !== undefined) seed[LIVE] = live;
  const v = vault(seed), store = new m.InboxStore(v.app,DIR); await store.load();
  try {
    store.add(highlight('unsaved')); await store.flush();
    assert.deepEqual(Object.fromEntries(v.files), seed); assert.deepEqual(v.operations,[]);
    assert.equal(store.hasUnsavedChanges,true);
  } finally {store.close();}
});


test('STORE-006 a changed Anki endpoint revokes later requests through the real client', async () => {
  const f = await setup(); const h = highlight(); f.store.add(h); const calls = [];
  f.plugin.settings.ankiConnectUrl = 'http://first.synthetic.invalid';
  f.plugin.anki = new m.AnkiClient(() => f.plugin.settings.ankiConnectUrl);
  requestImpl = async req => {
    const body = JSON.parse(req.body); calls.push([body.action, req.url]);
    if (body.action === 'createDeck') f.plugin.settings.ankiConnectUrl = 'http://second.synthetic.invalid';
    return {status:200,json:{result:body.action==='findNotes'?[]:body.action==='addNotes'?[9201]:1,error:null}};
  };
  try {
    await f.plugin.exportHighlights([h]);
    assert.deepEqual(calls, [['createDeck','http://first.synthetic.invalid']]);
    assert.equal(h.cards[0].status, 'pending');
  } finally { f.store.close(); requestImpl = () => {throw Error('NETWORK FORBIDDEN');}; }
});


test('STORE candidate: archive during Anki identity await revokes dispatch', async () => {
  const f=await setup();const h=highlight();f.store.add(h);
  f.plugin.anki.findNotes=async()=>{h.archived=true;return[];};
  try {
    await f.plugin.exportHighlights([h]);
    assert.equal(f.sent.length,0);assert.equal(h.cards[0].status,'pending');assert.equal(h.archived,true);
  } finally {f.store.close();}
});


test('STORE candidate: changed topic backlink while text export awaits folder check revokes the file write', async () => {
  const f=await setup(); const h=highlight(); h.topicPath='old-topic.md'; f.store.add(h);
  const exists=f.adapter.exists; f.adapter.exists=async p=>{if(p==='export'){h.topicPath='new-topic.md';return true;}return exists(p);};
  const written=[];f.app.vault.create=async(p,s)=>{written.push(s);return{path:p};};
  try {
    await f.plugin.exportAsTextFile([h]);
    assert.equal(written.length,0);
    assert.equal(h.cards[0].status,'pending');assert.equal(h.topicPath,'new-topic.md');
  } finally {f.store.close();}
});


test('STORE candidate: mixed text-file partial failure preserves its completed receipt and retries only the remainder', async () => {
  const f=await setup(); const qa=highlight('qa'), cloze=highlight('cloze');
  cloze.cards=[m.makeCard(cloze.id,{id:'c-cloze',kind:'cloze',text:'Affinity measures {{c1::binding strength}}.'})];
  f.store.add(qa);f.store.add(cloze); const written=[]; let call=0,fail=true;
  f.app.vault.create=async(p,s)=>{call++;if(fail&&call===2)throw Error('synthetic second-file failure');written.push({p,s});return{path:p};};
  try {
    await f.plugin.exportAsTextFile([qa,cloze]);
    assert.equal(written.length,1); assert.deepEqual([qa.cards[0].status,cloze.cards[0].status],['exported','pending']);
    const saved = JSON.parse(f.files.get(LIVE));
    assert.equal(saved.highlights.find(h=>h.id===qa.id).cards[0].status, 'exported');
    assert.ok(qa.cards[0].textExport?.path);
    assert.ok(notices.some(n=>n.includes(qa.cards[0].textExport.path)));
    fail=false; await f.plugin.exportAsTextFile([qa,cloze]);
    assert.equal(written.length,2);
    assert.notEqual(written[0].s,written[1].s);
    assert.deepEqual([qa.cards[0].status,cloze.cards[0].status],['exported','exported']);
  } finally {f.store.close();}
});


for (const method of ['exportHighlights','exportAsTextFile']) {
  for (const mapping of [
    {basicFrontField:''}, {basicBackField:' '}, {basicFrontField:'Same',basicBackField:'Same'},
    {basicExtraField:'Front'}, {basicExtraField:'Back'}, {basicFrontField:' Front '},
  ]) test(`STORE-008 ${method} refuses invalid Basic field mapping ${JSON.stringify(mapping)}`, async () => {
    const f = await setup(); const h = highlight(); f.store.add(h);
    Object.assign(f.plugin.settings, mapping); const before = structuredClone(h);
    try {
      await f.plugin[method]([h]);
      assert.equal(f.sent.length, 0); assert.deepEqual(h,before);
      assert.equal([...f.files.keys()].some(p => p.endsWith('.txt')), false);
      assert.equal(f.operations.filter(([op])=>op==='write').length,0);
      assert.ok(notices.some(n => /Basic.*field/i.test(n)));
    } finally {f.store.close();}
  });
}


for (const separateAdapters of [false, true]) test(`STORE-002 serializes commits for one vault; separate adapters=${separateAdapters}`, async () => {
  const v = vault({[LIVE]: data([highlight('original')])});
  v.adapter.getBasePath = () => `synthetic-${separateAdapters}`;
  const otherApp = separateAdapters ? {vault: {adapter: {...v.adapter}}} : v.app;
  const a = new m.InboxStore(v.app, DIR), b = new m.InboxStore(otherApp, DIR);
  await Promise.all([a.load(), b.load()]);
  let release, entered;
  const gate = new Promise(r => release = r), paused = new Promise(r => entered = r);
  const write = v.adapter.write; let writes = 0;
  const intercept = async (p,s) => { writes++; if (writes === 1) { entered(); await gate; } return write(p,s); };
  v.adapter.write = intercept; otherApp.vault.adapter.write = intercept;
  a.add(highlight('from-a')); b.add(highlight('from-b'));
  const first = a.flush(); await paused;
  const second = b.flush(); void second.catch(() => {});
  try {
    await new Promise(r => setImmediate(r));
    assert.equal(writes, 1, 'a second writer cannot enter while the first owns the commit');
    release(); await first; await assert.rejects(second, /changed|conflict/i);
    assert.deepEqual(JSON.parse(v.files.get(LIVE)).highlights.map(h => h.id), ['from-a', 'original']);
    assert.equal(b.hasUnsavedChanges, true);
  } finally { release(); await Promise.allSettled([first, second]); a.close(); b.close(); }
});


test('STORE candidate: overlapping store lifetimes refuse to overwrite unrelated committed captures', async () => {
  const v=vault({[LIVE]:data([highlight('original')])});
  const a=new m.InboxStore(v.app,DIR), b=new m.InboxStore(v.app,DIR); await Promise.all([a.load(),b.load()]);
  try {
    a.add(highlight('from-a')); b.add(highlight('from-b'));
    await a.flush(); const first=JSON.parse(v.files.get(LIVE)).highlights.map(h=>h.id);
    await assert.rejects(b.flush(), /changed|conflict/i); const final=JSON.parse(v.files.get(LIVE)).highlights.map(h=>h.id);
    assert.ok(first.includes('from-a')); assert.ok(final.includes('from-a')); assert.equal(final.includes('from-b'),false); assert.equal(b.hasUnsavedChanges,true); assert.ok(final.includes('original'));
    assert.equal([...v.files.keys()].some(p=>p.includes('.backup')||p.includes('.pending')),false);
  } finally {a.close();b.close();}
});


test('STORE candidate: future live version is preserved instead of downgraded from old backup', async () => {
  const future = JSON.stringify({version:2, highlights:[highlight('newer')], futureState:{kept:true}});
  const old = data([highlight('older')]);
  const v = vault({[LIVE]:future, [`${LIVE}.backup`]:old});
  const store = new m.InboxStore(v.app,DIR); await store.load();
  try {
    assert.deepEqual(store.allHistory(), []);
    assert.equal(v.files.get(LIVE), future);
    assert.equal(v.files.get(`${LIVE}.backup`), old);
    assert.deepEqual(v.operations, []);
    store.add(highlight('blocked')); await store.flush();
    assert.equal(store.hasUnsavedChanges, true);
    assert.equal(v.files.get(LIVE), future);
  } finally { store.close(); }
});

test('STORE controls: current authoritative empty live and legacy fields survive; future-only file stays untouched', async () => {
  const legacy=highlight('legacy');legacy.topicPath='topic.md';legacy.extraLegacy={untouched:true};
  const f=await setup({[LIVE]:data([legacy])});try{await f.store.flush();assert.deepEqual(JSON.parse(f.files.get(LIVE)).highlights[0],legacy);}finally{f.store.close();}
  const v=vault({[LIVE]:data([]),[`${LIVE}.backup`]:data([highlight('older')])});const store=new m.InboxStore(v.app,DIR);await store.load();assert.deepEqual(store.allHistory(),[]);store.close();
  const raw=JSON.stringify({version:2,highlights:[legacy]});const future=await setup({[LIVE]:raw});try{future.store.add(highlight('blocked'));await future.store.flush();assert.equal(future.files.get(LIVE),raw);}finally{future.store.close();}
});


test('STORE candidate: malformed topicPath restores the valid backup before consumer use', async () => {
  const h = highlight(); h.topicPath = 123;
  const raw = data([h]), backup = data([highlight('recoverable')]);
  assert.equal(m.parseInboxJson(raw).ok,false);
  const f = await setup({[LIVE]:raw,[`${LIVE}.backup`]:backup});
  try {
    assert.equal(f.files.has(`${LIVE}.backup`),false);
    assert.equal(f.store.allHistory()[0].id, 'recoverable');
    assert.ok([...f.files.values()].includes(raw));
    assert.doesNotThrow(()=>m.buildNote(f.store.allHistory()[0].cards[0],f.store.allHistory()[0],{settings:f.plugin.settings,vaultName:'Synthetic',deck:'Synthetic'}));
  } finally { f.store.close(); }
});


test('STORE candidate: first mkdir failure retains unsaved acceptance and blocks export dispatch', async () => {
  const v = vault(); v.dirs.clear(); v.adapter.mkdir = async () => { throw Error('synthetic first mkdir failed'); };
  const store = new m.InboxStore(v.app,DIR); await store.load();
  const plugin = new m.RecallPlugin(); plugin.app=v.app; plugin.store=store;
  plugin.settings={...m.DEFAULT_SETTINGS,includeExtra:true,defaultDeck:'Synthetic'};
  const sent=[]; plugin.anki={createDeck:async()=>1,findNotes:async()=>[],addNotes:async notes=>{sent.push(...notes);return[9001];}};
  const h=highlight(); h.cards[0].critiqueReason='Synthetic warning requiring explicit acceptance'; store.add(h);
  try {
    await plugin.exportHighlights([h]);
    assert.equal(sent.length,0); assert.equal(h.cards[0].status,'pending');
    assert.ok(h.cards[0].exportAcceptance); assert.equal(v.files.has(LIVE),false); assert.equal(store.hasUnsavedChanges,true);
  } finally { store.close(); }
});

test('STORE control: a rejected first write blocks transport and a retry persists acceptance before transport', async () => {
  const f=await setup(); const h=highlight(); h.cards[0].critiqueReason='Synthetic warning'; f.store.add(h);
  const write=f.adapter.write; let failed=true;
  f.adapter.write=async(...args)=>{if(failed)throw Error('synthetic first write failed');return write(...args);};
  try {
    await f.plugin.exportHighlights([h]); assert.equal(f.sent.length,0); assert.equal(h.cards[0].status,'pending'); assert.equal(f.store.hasUnsavedChanges,true);
    failed=false;
    f.plugin.anki.addNotes=async notes=>{assert.ok(JSON.parse(f.files.get(LIVE)).highlights[0].cards[0].exportAcceptance);f.sent.push(...notes);return[9002];};
    await f.plugin.exportHighlights([h]); await f.store.flush();
    assert.equal(f.sent.length,1); assert.equal(JSON.parse(f.files.get(LIVE)).highlights[0].cards[0].ankiNoteId,9002);
  } finally {f.store.close();}
});
