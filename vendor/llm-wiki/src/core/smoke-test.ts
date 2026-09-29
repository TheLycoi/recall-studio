// smoke-test.ts — LLM Configuration smoke test
//
// Async side-effectful function (network I/O). Runs a minimal LLM
// call to verify the plugin's provider/apiKey/model configuration is
// functional — used by the Welcome note's `## Configuration Test`
// section to surface a real LLM smoke-test result to the user.
//
// Design: dependency-inverted via an injected probe function. The
// probe abstracts "make a minimal LLM call" so the smokeTest wrapper
// can be tested with a mock probe. Production wiring (in
// ensure-welcome-note.ts) constructs a probe that calls
// OpenAICompatibleClient.createMessage or AnthropicClient.createMessage
// with a one-token prompt.
//
// Why dependency injection: smokeTest catches probe errors and
// converts them to a structured LlmConfigStatus, never re-throws.
// This decouples the welcome-note template from "did the LLM work"
// and ensures the welcome note is always generated (the user can fix
// the LLM later).

export interface LlmConfigStatus {
  ok: boolean;
  provider?: string;
  model?: string;
  /** Set when ok=false. Human-readable reason. */
  error?: string;
}

/**
 * Run the LLM smoke test.
 *
 * @param probe async function that performs a minimal LLM call. May
 *              throw on network / auth / provider errors.
 * @returns     LlmConfigStatus — never throws; errors are converted
 *              to { ok: false, error: ... }.
 */
export async function smokeTest(
  probe: () => Promise<LlmConfigStatus>,
): Promise<LlmConfigStatus> {
  try {
    return await probe();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: message };
  }
}