import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let anki, Generator;
let ankiResponse;
before(async () => {
  async function load(file) {
    const out = await build({entryPoints:[file], bundle:true, write:false, format:'cjs', platform:'node', external:['obsidian'], logLevel:'silent'});
    const mod = new Module(file);
    mod.require = id => id === 'obsidian' ? { ItemView: class {}, Notice: class {}, requestUrl: async () => ({status:200,json:ankiResponse}) } : Module.createRequire(import.meta.url)(id);
    mod._compile(out.outputFiles[0].text, file);
    return mod.exports;
  }
  anki = await load('src/anki.ts');
  Generator = (await load('src/generator.ts')).Generator;
});
test('identity preserves distinctions lost by slugification', () => {
  assert.notEqual(anki.cardIdentityTag('A B','c_x'),anki.cardIdentityTag('A-B','c_x'));
});
test('malformed Anki responses cannot supply note identities', async () => {
  const client = new anki.AnkiClient(() => 'http://127.0.0.1:8765');
  for (const response of [null, {}, {error:null,result:'123'}, {error:null,result:[-1]}, {error:null,result:['123']}]) {
    ankiResponse=response;
    await assert.rejects(client.findNotes('tag:test'), /Invalid/);
  }
  ankiResponse={error:null,result:[123]};
  assert.deepEqual(await client.findNotes('tag:test'),[123]);
});
test('media filenames are content-addressed instead of overwriting basenames', async () => {
  const fields=[]; const names=[];
  const fake={createDeck:async()=>1,findNotes:async()=>[],addNotes:async notes=>{fields.push(notes[0].fields);return [123];},storeMediaFile:async n=>{names.push(n);return n;}};
  const h={status:'ready',sourcePath:'a.md',sourceTitle:'A',text:'quote',cards:[]};
  const c={id:'c1',highlightId:'h1',status:'approved',kind:'qa',front:'Question',back:'![[photo.png]]',extra:''};h.cards=[c];
  const ctx={vaultName:'A',deck:'D',settings:{basicModel:'Basic',basicFrontField:'Front',basicBackField:'Back',basicExtraField:'',extraTags:'',includeExtra:true},resolveMedia:async()=>({path:'photo.png',data:Uint8Array.from([1,2,3]).buffer})};
  await anki.exportToAnki(fake,[{card:c,highlight:h}],ctx);
  assert.match(names[0],/^review-inbox-[a-f0-9]{64}\.png$/);
  assert.ok(fields[0].Back.includes(names[0]));
});

test('an unapproved card changed during identity lookup is not sent', async () => {
  const c={id:'c2',status:'approved',kind:'qa',front:'Q',back:'A',extra:''};
  const h={status:'ready',cards:[c],sourcePath:'a.md',sourceTitle:'A',text:'A'};
  let adds=0;
  const fake={createDeck:async()=>1,findNotes:async()=>{c.status='pending';return [];},addNotes:async()=>{adds++;return [1];}};
  await anki.exportToAnki(fake,[{card:c,highlight:h}],{vaultName:'A',deck:'D',settings:{basicModel:'Basic',basicFrontField:'Front',basicBackField:'Back',extraTags:''}});
  assert.equal(adds,0);
  assert.equal(c.status,'pending');
});

test('dismissal during background generation is not undone by its response', async () => {
  let finish;
  const response=new Promise(resolve=>{finish=resolve;});
  const h={id:'h',text:'A is B.',instruction:'',cards:[],status:'queued'};
  const plugin={settings:{critiquePass:false,lintMode:'badge',notifyWhenReady:false},store:{touch(){},all:()=>[h],async flush(){}},llm:{generationContext:()=>response,prepareGeneration(){throw Error('dismissed capture must not reach the provider');}}};
  const g=new Generator(plugin);
  const run=g.run(h);
  h.status='dismissed';
  finish({maxCards:1,language:'',instructions:'',rules:'',examples:''});
  await run;
  assert.equal(h.status,'dismissed');
  assert.equal(h.cards.length,0);
});
