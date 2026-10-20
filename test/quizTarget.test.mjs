import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import Module from 'node:module';
let resolveQuizTarget;
before(async()=>{
  const out=await build({entryPoints:['src/quizTarget.ts'],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'});
  const mod=new Module('quiz-target');mod._compile(out.outputFiles[0].text,'quiz-target');
  ({resolveQuizTarget}=mod.exports);
});
const notes=[{path:'biology/Receptors.md',name:'Receptors',aliases:['Binding sites'],tags:['#bio/receptors']},{path:'physics/Receptors.md',name:'Receptors',aliases:[],tags:['#physics']},{path:'biology/Cells.md',name:'Cells',aliases:[],tags:['#bio']}];
test('explicit note paths, aliases and tags resolve without broadening',()=>{
  assert.deepEqual(resolveQuizTarget('biology/Receptors.md',notes,null).paths,['biology/Receptors.md']);
  assert.deepEqual(resolveQuizTarget('[[Binding sites]]',notes,null).paths,['biology/Receptors.md']);
  assert.deepEqual(resolveQuizTarget('#bio',notes,null).paths,['biology/Receptors.md','biology/Cells.md']);
  assert.equal(resolveQuizTarget('#missing',notes,null).kind,'missing');
  assert.equal(resolveQuizTarget('missing.md',notes,null).kind,'missing');
});
test('bare quiz uses only the active eligible note',()=>{
  assert.deepEqual(resolveQuizTarget('',notes,'biology/Cells.md').paths,['biology/Cells.md']);
  assert.equal(resolveQuizTarget('',notes,'secret.md').kind,'missing');
});
test('duplicate note names require a choice and topic matches are suggestions only',()=>{
  const ambiguous=resolveQuizTarget('Receptors',notes,null);
  assert.equal(ambiguous.kind,'choices');assert.equal(ambiguous.choices.length,2);assert.equal(ambiguous.paths,undefined);
  const topic=resolveQuizTarget('biology',notes,null);
  assert.equal(topic.kind,'choices');assert.equal(topic.paths,undefined);
});
