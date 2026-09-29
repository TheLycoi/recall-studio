import { getText } from './i18n';
import { repetitionPenaltyWireField } from './repetition-penalty-dialect';

/**
 * Localized hint appended to the "Source analysis failed" error when the
 * user opted into a custom `repetitionPenalty` AND the current provider
 * actually puts the field on the wire (see repetition-penalty-hint.test.ts
 * for the E2E rationale).
 *
 * Returns a leading-space hint string (ready to append) for any DEFINED
 * value — deliberately present-any-value, not threshold-based, so the hint
 * surfaces for the exact failure class — or '' when the setting is unset
 * or the provider drops the field (`repetitionPenaltyWireField` returns
 * null, e.g. anthropic/deepseek/gemini/minimax/glm): naming a setting that
 * was never sent would misattribute the failure. The actionable advice
 * lives in the i18n key `repetitionPenaltyErrorHint`.
 */
export function buildRepetitionPenaltyHint(
  language: string,
  value: number | undefined,
  provider: string,
): string {
  if (value === undefined) return '';
  if (repetitionPenaltyWireField(provider) === null) return '';
  return ' ' + getText(language, 'repetitionPenaltyErrorHint', { value: String(value) });
}
