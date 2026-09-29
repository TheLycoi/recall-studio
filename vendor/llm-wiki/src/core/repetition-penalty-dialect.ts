/**
 * Issue #414: per-provider wire-field spelling for the
 * `repetitionPenalty` user setting. `lmstudio` / `ollama` accept the
 * llama.cpp spelling (`repeat_penalty`, no `-ion` — verified by
 * DocTpoint #414 type-error test on LM Studio / gemma-4-12b).
 * `kimi` / `openrouter` / `custom` accept the OpenAI-spec spelling
 * (`repetition_penalty`, snake_case). Other backends (`deepseek` /
 * `gemini` / `minimax` / `glm`) do not document the field, so the
 * caller drops it silently rather than emitting a key the backend
 * will ignore.
 *
 * Module-level lookup table (rather than chained if/return) so
 * adding a new provider is one line and the table is itself the
 * documentation. Lives in core so both the SDK client (which emits
 * the field) and the error-hint helper (which decides whether the
 * setting could have caused a failure) share one definition of
 * "does this provider put the field on the wire".
 */
const REPETITION_PENALTY_WIRE_FIELD: Readonly<Record<string, 'repeat_penalty' | 'repetition_penalty'>> = {
  lmstudio: 'repeat_penalty',
  ollama: 'repeat_penalty',
  kimi: 'repetition_penalty',
  openrouter: 'repetition_penalty',
  custom: 'repetition_penalty',
};

/**
 * Returns the wire-field name for `repetitionPenalty` on a provider, or
 * `null` when the provider drops the field (the caller must not emit it).
 * `null` also gates the UX hint: a setting that never reaches the backend
 * must not be named as a failure cause.
 */
export function repetitionPenaltyWireField(provider: string): 'repeat_penalty' | 'repetition_penalty' | null {
  return REPETITION_PENALTY_WIRE_FIELD[provider] ?? null;
}
