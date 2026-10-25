import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { loadQuiz } from './quizHarness.mjs';

const retired = ['chatRetrieval', 'examples', 'preferences', 'prompt', 'quizPrompt', 'quizSchemas',
  'quizSources', 'quizTarget', 'quizValidation', 'quizView', 'recall', 'reviewChat', 'reviewChatView',
  'schemaFile', 'schemaNote', 'sentences', 'study', 'studyGuidePdf', 'studySchemas'];
test('retired feature modules are absent from disk and the production dependency graph', async () => {
  const out = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'cjs',
    platform: 'node', packages: 'external', metafile: true, logLevel: 'silent' });
  for (const name of retired) {
    const file = `src/${name}.ts`;
    assert.equal(Object.hasOwn(out.metafile.inputs, file), false, file);
    assert.equal(existsSync(file), false, file);
  }
  // These names are shared capture, storage, source/export and safety code, not retirement candidates.
  for (const name of ['capture', 'pageIndex', 'quiz', 'unitSource', 'sourceVisibility', 'srRecognition',
    'store', 'inboxData', 'anki', 'paths', 'generation', 'writerMethod']) {
    assert.ok(Object.hasOwn(out.metafile.inputs, `src/${name}.ts`), name);
  }
});
test('the client keeps flashcard APIs but no retired chat, quiz or study entrypoints', async () => {
  const { LlmClient } = await loadQuiz('src/llm.ts');
  for (const method of ['answerSelected', 'verifySelected', 'expandChatQuery', 'selectStudyEvidence',
    'quizQuestionAudit', 'quizMultipleChoice', 'quizChoiceAudit', 'quizGradeAudit', 'quizQuestion', 'quizRecallGrade']) {
    assert.equal(LlmClient.prototype[method], undefined, method);
  }
  for (const method of ['probe', 'listModels', 'abort', 'requestAuthorization', 'generationContext',
    'prepareGeneration', 'writeGroundedCards', 'repairGeneration', 'auditGeneration',
    'writeCards', 'critiqueCards', 'rewriteCard', 'rewriteCards']) {
    assert.equal(typeof LlmClient.prototype[method], 'function', method);
  }
});

test('shared readers still handle frozen legacy quiz output without reviving its producer', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-quiz-reveal.json', import.meta.url), 'utf8'));
  const { inlineMarkdownToHtml } = await loadQuiz('src/util.ts');
  const html = inlineMarkdownToHtml(fixture.markdown);
  assert.doesNotMatch(html, /<script>|<img/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  const { indexPage } = await loadQuiz('src/pageIndex.ts');
  const units = indexPage('legacy-output.md', fixture.markdown);
  assert.ok(units.some(u => u.text.includes(fixture.sourceText)));
  assert.equal(units.some(u => u.text === 'Zeta › Calibration'), false, 'A provenance-only link is not evidence');
  assert.equal(fixture.producer, 'bcb4099a37a992ccc475121004df6ddc6565e473:src/recall.ts#renderRevealMarkdown');
});
