// Synthetic judgments for transport/lifecycle tests, never measured model quality.
// Contract-adversarial tests construct their own incomplete/invalid responses.
import { loadQuiz } from './quizHarness.mjs';
const { renderedCardReviews } = await loadQuiz('src/qualityAcceptance.ts');
const { isHardLintFailure } = await loadQuiz('src/lint.ts');

export function auditVerdict(card, verdict) {
  const status = verdict.status;
  return {
    contractVersion: 1,
    reviews: (card.reviews ?? renderedCardReviews(card)).map(review => ({
      ordinal: review.ordinal, status, reason: verdict.reason,
      identifyingCue: status === 'verified' ? review.visibleCue : '',
      relationCue: status === 'verified' ? review.visibleCue : '',
      answerable: status === 'verified', effortful: status === 'verified',
    })),
    checks: (card.checks ?? []).map(({ id }) => ({ id,
      resolution: !['duplicate-card', 'shared-answer', 'cross-interference'].includes(id) && isHardLintFailure(id) ? 'defect' : 'accepted',
      reason: 'Synthetic check decision for this fixture, not semantic verification.',
    })),
    reassessments: [], conflicts: [], ...verdict,
  };
}
