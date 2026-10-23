import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { build } from 'esbuild';
let m;
before(async () => {
  const out = await build({stdin:{contents:"export {lintCard} from './src/lint'; export {makeCard,makeHighlight} from './src/model'; export * from './src/cardActions';",resolveDir:process.cwd()},bundle:true,write:false,format:'cjs',platform:'node'});
  const mod = new Module('cloze-answer-leak');
  mod._compile(out.outputFiles[0].text,'cloze-answer-leak');
  m=mod.exports;
});
const cases = [
  ['visible sibling phrase', 'Wool and cork are examples of {{c1::insulating materials}}; they are {{c2::not the only insulating materials}}.', true],
  ['ordinary visible text', 'Dopamine is the transmitter {{c1::dopamine}}.', true],
  ['visible answer hint', 'The transmitter is {{c1::dopamine::dopamine}}.', true],
  ['same-number spans hidden together', '{{c1::dopamine}} is also called {{c1::dopamine}}.', false],
  ['different-number duplicate', '{{c1::dopamine}} is also called {{c2::dopamine}}.', true],
  ['whole-token boundary on', 'Contemplation focuses {{c1::on}} change.', false],
  ['whole-token boundary can', 'Cannot implies the opposite of {{c1::can}}.', false],
  ['hidden slot separates visible phrase', 'alpha {{c1::alpha beta}} beta', false],
  ['other-number hint is not visible when revealed', 'A {{c1::alpha}} B {{c2::beta::alpha}}.', false],
  ['same-number hint remains visible', 'A {{c1::alpha}} B {{c1::beta::alpha}}.', true],
  ['normalized accented phrase', 'La RÉPLICATION est {{c1::réplication}}.', true],
  ['multiple independent clean deletions', 'First {{c1::disconnect power}}, then {{c2::attach cable}}, finally {{c3::reconnect power}}.', false],
];
for (const [name,text,leaks] of cases) test(`cloze answer leakage: ${name}`, () => {
  const source=text.replace(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g,'$1');
  const h=m.makeHighlight({text:source,sourceTitle:'Synthetic',sourcePath:'synthetic.md',status:'ready'});
  const c=m.makeCard(h.id,{kind:'cloze',text});
  const failures=m.lintCard(c,h,[]).failures;
  assert.equal(failures.includes('answer-in-question'),leaks,JSON.stringify(failures));
  assert.equal(failures.filter(x=>x==='answer-in-question').length,leaks?1:0);
});
test('a positive model verdict cannot authorize a leaking cloze replacement', async () => {
  const h=m.makeHighlight({text:'Examples of insulating materials include wool and cork; these are not the only insulating materials.',sourceTitle:'Insulators',sourcePath:'synthetic.md',status:'ready'});
  const c=m.makeCard(h.id,{kind:'qa',front:'What is the example category?',back:'insulating materials'});
  h.cards=[c];
  c.userCheck={content:m.cardContent(c,h),at:'test',issues:['Use a precise cue.']};
  const before=structuredClone(c);
  await assert.rejects(m.checkAndRepairCard(c,h,async()=>[{verdict:'keep'}],async()=>({kind:'cloze',front:'',back:'',text:'Wool and cork are examples of {{c1::insulating materials}}; they are {{c2::not the only insulating materials}}.'})),/replacement did not pass.*answer in question/i);
  assert.deepEqual(c,before);
});
