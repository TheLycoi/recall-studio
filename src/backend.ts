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
 * Why a plain-text answer ended, as far as the provider says: "end" when the
 * model finished, "length" when it hit the output-token cap (the text is cut
 * off), "other" for a reason the provider named that is neither, "unknown"
 * when the provider does not say. A backend that cannot tell must say
 * "unknown", never "end".
 */
export type TextStop = "end" | "length" | "other" | "unknown";

/**
 * One plain-text request: the model's answer comes back as it wrote it, with
 * no schema and no parsing. Upstream's wiki engine (src/upstream/llmAdapter.ts)
 * writes its own prompts and parses its own answers, so this is all it needs.
 */
export interface TextRequest {
  system: string;
  user: string;
  maxTokens: number;
  /** As in CompletionRequest. */
  effort?: "low" | "medium" | "high";
  /** As in CompletionRequest. */
  model?: string;
  /** Cancels this one call: a CLI backend kills its child, an HTTP backend stops waiting where it can. */
  signal?: AbortSignal;
  /**
   * Told why the model stopped, once, just before the text is returned; never
   * when the call throws. Upstream keeps a page's existing body when a
   * rewrite stopped at the token cap, and this is how it learns that.
   */
  onStop?: (stop: TextStop) => void;
}

/**
 * A model provider. LlmClient owns the prompts and schemas; a backend only
 * knows how to get a schema-shaped answer, or plain text, out of its provider.
 */
export interface LlmBackend {
  readonly name: ProviderName;
  /** One tiny request so the settings tab can say whether the provider works, on `model` when given. */
  probe(model?: string): Promise<{ model: string; via: string }>;
  /** The models this provider offers, for the settings dropdown; may throw when the provider cannot be reached. */
  listModels(): Promise<string[]>;
  complete<T>(req: CompletionRequest<T>): Promise<T>;
  /** The model's raw text for one request. */
  completeText(req: TextRequest): Promise<string>;
  /** Cancel in-flight work (kills child processes). Resolves once everything has stopped. */
  abort(): Promise<void>;
}
