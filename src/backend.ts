import type { z } from "zod";

export type ProviderName = "anthropic" | "codex" | "claudecli";

/** One structured-output request: a system prompt, a user message, and the zod schema the answer must satisfy. */
export interface CompletionRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Plural noun for error messages ("cards", "highlights"). */
  label: string;
  maxTokens: number;
  /**
   * Reasoning effort for this one call, overriding the configured default.
   *
   * Set to "low" for work that is reading rather than reasoning. Answering
   * from evidence already on screen does not improve with extended thinking,
   * but it does wait for it: the same question took a noticeably long time to
   * come back because every Ask ran at the effort a card critique needs.
   */
  effort?: "low" | "medium" | "high";
}

/**
 * A model provider. LlmClient owns the prompts and schemas; a backend only
 * knows how to get a schema-shaped answer out of its provider.
 */
export interface LlmBackend {
  readonly name: ProviderName;
  /** One tiny request so the settings tab can say whether the provider works. */
  probe(): Promise<{ model: string; via: string }>;
  complete<T>(req: CompletionRequest<T>): Promise<T>;
  /** Cancel in-flight work (kills child processes). Resolves once everything has stopped. */
  abort(): Promise<void>;
}
