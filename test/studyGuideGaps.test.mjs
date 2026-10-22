import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadQuiz } from './quizHarness.mjs';

let StudyEvidenceOut, STUDY_GUIDE_MAX_CHARS, studyGuideLines, validateStudyEvidence, validateStudyInput;
before(async () => {
  ({ StudyEvidenceOut, STUDY_GUIDE_MAX_CHARS, studyGuideLines, validateStudyEvidence, validateStudyInput } = await loadQuiz('src/studySchemas.ts'));
});

test('all 8001 nonempty guide lines can be coverage gaps', () => {
  const guide = 'x\n'.repeat(8000) + 'x';
  const draft = { selections: [], gaps: Array.from({ length: 8001 }, (_, i) => i + 1) };
  assert.doesNotThrow(() => validateStudyInput({ topic: 'coverage', guide, passages: [], authorized: () => true }));
  assert.deepEqual(validateStudyEvidence(draft, [], guide), { passages: [], gaps: Array(8001).fill('x') });
  assert.equal(StudyEvidenceOut.safeParse(draft).success, true);
});

test('the character-bound maximum of nonempty guide lines can all be gaps', () => {
  const maxLines = Math.floor((STUDY_GUIDE_MAX_CHARS + 1) / 2);
  const guide = 'x\n'.repeat(maxLines - 1) + 'xx';
  const draft = { selections: [], gaps: Array.from({ length: maxLines }, (_, i) => i + 1) };
  assert.equal(maxLines, 32000);
  assert.equal(guide.length, STUDY_GUIDE_MAX_CHARS);
  assert.equal(studyGuideLines(guide).length, maxLines);
  assert.doesNotThrow(() => validateStudyInput({ topic: 'coverage', guide, passages: [], authorized: () => true }));
  assert.equal(StudyEvidenceOut.safeParse(draft).success, true);
  assert.deepEqual(validateStudyEvidence(draft, [], guide), { passages: [], gaps: [...Array(maxLines - 1).fill('x'), 'xx'] });
});

test('one more nonempty line exceeds both the raw guide and gap-count bounds', () => {
  const maxLines = Math.floor((STUDY_GUIDE_MAX_CHARS + 1) / 2);
  const guide = 'x\n'.repeat(maxLines) + 'x';
  const draft = { selections: [], gaps: Array.from({ length: maxLines + 1 }, (_, i) => i + 1) };
  assert.equal(guide.length, STUDY_GUIDE_MAX_CHARS + 1);
  assert.throws(() => validateStudyInput({ topic: 'coverage', guide, passages: [], authorized: () => true }), /Invalid study topic, guide or authorization\./);
  const parsed = StudyEvidenceOut.safeParse(draft);
  assert.equal(parsed.success, false);
  assert.ok(parsed.error.issues.some(issue => issue.code === 'too_big' && issue.path[0] === 'gaps' && issue.maximum === maxLines));
  assert.throws(() => validateStudyEvidence(draft, [], guide), /Invalid study evidence selection\./);
});

for (const [name, lastGap] of [['duplicate', 8000], ['out-of-range', 8002]]) {
  test(`an otherwise valid 8001-entry gap list still rejects a ${name} index`, () => {
    const guide = 'x\n'.repeat(8000) + 'x';
    const gaps = Array.from({ length: 8001 }, (_, i) => i + 1);
    gaps[gaps.length - 1] = lastGap;
    const draft = { selections: [], gaps };
    assert.equal(StudyEvidenceOut.safeParse(draft).success, true);
    assert.throws(() => validateStudyEvidence(draft, [], guide), /Invalid study coverage gap reference\./);
  });
}

test('a gap index beyond the longest legal guide remains out of range', () => {
  const maxLines = Math.floor((STUDY_GUIDE_MAX_CHARS + 1) / 2);
  const guide = 'x\n'.repeat(maxLines - 1) + 'xx';
  const draft = { selections: [], gaps: [maxLines + 1] };
  assert.equal(StudyEvidenceOut.safeParse(draft).success, true);
  assert.throws(() => validateStudyEvidence(draft, [], guide), /Invalid study coverage gap reference\./);
});

for (const index of [-1, 0, 1.5, '1']) {
  test(`gap indices remain positive integers without coercion: ${JSON.stringify(index)}`, () => {
    const draft = { selections: [], gaps: [index] };
    assert.equal(StudyEvidenceOut.safeParse(draft).success, false);
    assert.throws(() => validateStudyEvidence(draft, [], 'First topic.\nSecond topic.'), /Invalid study evidence selection\./);
  });
}

test('ordinary gaps retain trimmed nonempty line numbering and vault-only evidence', () => {
  const guide = '\r\n First topic. \r\n\t\r\n Second topic.\nThird topic.\n';
  const passage = { id: '1', path: 'notes/lecture.md', title: 'Lecture', text: 'The vault supplies answer evidence.', line: 1, page: null };
  const selections = [{ id: passage.id, quote: passage.text }];
  const draft = { selections, gaps: [3, 1] };
  assert.doesNotThrow(() => validateStudyInput({ topic: 'coverage', guide, passages: [passage], authorized: () => true }));
  assert.equal(StudyEvidenceOut.safeParse(draft).success, true);
  assert.deepEqual(studyGuideLines(guide), ['First topic.', 'Second topic.', 'Third topic.']);
  assert.deepEqual(validateStudyEvidence(draft, [passage], guide), { passages: [passage], gaps: ['Third topic.', 'First topic.'] });
  assert.deepEqual(validateStudyEvidence({ selections, gaps: [] }, [passage], guide), { passages: [passage], gaps: [] });
});
