import type { z } from "zod";

export type ProviderName = "anthropic" | "gemini" | "codex" | "claudecli";

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
  /** The model for this one call (a role's own choice, src/modelRoles.ts); the provider's configured model otherwise. */
  model?: string;
}

/**
 * A model provider. LlmClient owns the prompts and schemas; a backend only
 * knows how to get a schema-shaped answer out of its provider.
 */
export interface LlmBackend {
  readonly name: ProviderName;
  /** One tiny request so the settings tab can say whether the provider works, on `model` when given. */
  probe(model?: string): Promise<{ model: string; via: string }>;
  /** The models this provider offers, for the settings dropdown; may throw when the provider cannot be reached. */
  listModels(): Promise<string[]>;
  complete<T>(req: CompletionRequest<T>): Promise<T>;
  /** Cancel in-flight work (kills child processes). Resolves once everything has stopped. */
  abort(): Promise<void>;
}
