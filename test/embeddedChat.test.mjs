import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('the production entrypoint excludes both retired chat view implementations', async () => {
  const out = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false,
    format: 'cjs', platform: 'node', packages: 'external', metafile: true, logLevel: 'silent' });
  const inputs = Object.keys(out.metafile.inputs);
  assert.equal(inputs.includes('src/quizView.ts'), false);
  assert.equal(inputs.includes('src/reviewChatView.ts'), false);
});
