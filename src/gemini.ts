import { requestUrl } from "obsidian";
import { z } from "zod";
import type { CompletionRequest, LlmBackend, TextRequest } from "./backend";
import { resolveGeminiKey, type KeySource } from "./keys";
import { readGeminiModels } from "./modelRoles";
import type { Effort, WikiLmSettings } from "./settings";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export type GeminiErrorKind = "auth" | "rate" | "failed";

export class GeminiError extends Error {
  constructor(
    public kind: GeminiErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/**
 * Gemini 3 takes `thinkingLevel`, not a token budget. Its scale stops at
 * "high", so the two levels above it collapse down rather than erroring —
 * the same rounding-down the Codex backend does for efforts gpt-5.5 lacks.
 */
const THINKING_LEVEL: Record<Effort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

/**
 * Gemini's structured output accepts a subset of JSON Schema and rejects the
 * `$schema` and `additionalProperties` keywords zod emits. Strip them
 * everywhere, not just at the root: nested objects carry them too.
 */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$schema" || k === "additionalProperties") continue;
      out[k] = strip(v);
    }
    return out;
  };
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}

/** Pull the model's text out of a generateContent response, or say why there is none. */
export function readGeminiText(body: unknown): { text: string | null; error: string | null } {
  if (!body || typeof body !== "object") return { text: null, error: null };
  const b = body as Record<string, any>;
  if (b.error?.message) return { text: null, error: String(b.error.message) };
  const candidate = b.candidates?.[0];
  if (!candidate) {
    const blocked = b.promptFeedback?.blockReason;
    return { text: null, error: blocked ? `The request was blocked (${blocked}).` : null };
  }
  if (candidate.finishReason === "SAFETY" || candidate.finishReason === "PROHIBITED_CONTENT") {
    return { text: null, error: "The model declined this request." };
  }
  const parts = candidate.content?.parts;
  if (!Array.isArray(parts)) {
    // MAX_TOKENS with no parts means the whole budget went to thinking.
    if (candidate.finishReason === "MAX_TOKENS") return { text: null, error: "The model ran out of output tokens before answering." };
    return { text: null, error: null };
  }
  const text = parts
    .filter((p: any) => typeof p?.text === "string" && !p.thought)
    .map((p: any) => p.text)
    .join("");
  return { text: text || null, error: null };
}

/** Google Gemini via the generateContent REST API with a JSON response schema. Needs an API key. */
export class GeminiBackend implements LlmBackend {
  readonly name = "gemini" as const;

  constructor(private getSettings: () => WikiLmSettings) {}

  private key(): { key: string; source: KeySource } {
    const { key, source } = resolveGeminiKey(this.getSettings().geminiApiKey);
    if (!key) {
      throw new GeminiError(
        "auth",
        "No Gemini API key. Set one in WikiLM settings, export GEMINI_API_KEY, add a keychain item named GEMINI_API_KEY, or switch the provider.",
      );
    }
    return { key, source };
  }

  private async call<T>(req: CompletionRequest<T>, key: string): Promise<T> {
    const text = await this.generate(req, key, req.label, req.schema);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new GeminiError("failed", `Gemini returned ${req.label} that were not valid JSON.`);
    }
    const parsed = req.schema.safeParse(value);
    if (!parsed.success) {
      throw new GeminiError("failed", `Gemini returned ${req.label} in the wrong shape: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`);
    }
    return parsed.data;
  }

  /**
   * One generateContent request, returning the model's text or throwing with
   * the reason there is none. With a schema the answer is JSON in that shape;
   * without one it is plain text, and an empty system prompt is left off.
   * requestUrl cannot be cancelled, so a signal is only checked on either side
   * of the request.
   */
  private async generate(req: TextRequest, key: string, label: string, schema?: z.ZodType): Promise<string> {
    const s = this.getSettings();
    const effort = req.effort ?? s.effort;
    if (req.signal?.aborted) throw new GeminiError("failed", "Cancelled.");
    const res = await requestUrl({
      url: `${API_BASE}/${encodeURIComponent(req.model ?? s.geminiModel)}:generateContent`,
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        ...(schema || req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig: {
          maxOutputTokens: req.maxTokens,
          ...(schema ? { responseMimeType: "application/json", responseSchema: toGeminiSchema(schema) } : {}),
          thinkingConfig: { thinkingLevel: THINKING_LEVEL[effort] },
        },
      }),
      throw: false,
    });
    if (req.signal?.aborted) throw new GeminiError("failed", "Cancelled.");

    let body: unknown;
    try {
      body = res.json;
    } catch {
      body = null;
    }
    const { text, error } = readGeminiText(body);

    if (res.status === 401 || res.status === 403) {
      throw new GeminiError("auth", `Gemini rejected the API key${error ? `: ${error}` : "."}`);
    }
    if (res.status === 429) {
      throw new GeminiError("rate", "Rate limited by the Gemini API; will retry later.");
    }
    if (res.status >= 400) {
      throw new GeminiError("failed", `Gemini API error ${res.status}${error ? `: ${error}` : ""}.`);
    }
    if (error) throw new GeminiError("failed", error);
    if (!text) throw new GeminiError("failed", `Gemini returned no ${label}.`);
    return text;
  }

  async probe(model?: string): Promise<{ model: string; via: string }> {
    const s = this.getSettings();
    const { key, source } = this.key();
    await this.call(
      {
        system: "You answer with JSON only.",
        user: "Set ready to true.",
        schema: z.object({ ready: z.boolean() }),
        label: "probe",
        maxTokens: 500,
        effort: "low",
        model,
      },
      key,
    );
    return { model: model ?? s.geminiModel, via: `key from ${source}` };
  }

  async listModels(): Promise<string[]> {
    const { key } = this.key();
    const res = await requestUrl({ url: `${API_BASE}?pageSize=200`, method: "GET", headers: { "x-goog-api-key": key }, throw: false });
    if (res.status >= 400) {
      throw new GeminiError(res.status === 401 || res.status === 403 ? "auth" : "failed", `Gemini could not list its models (HTTP ${res.status}).`);
    }
    return readGeminiModels(res.json);
  }

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    return this.call(req, this.key().key);
  }

  async completeText(req: TextRequest): Promise<string> {
    return this.generate(req, this.key().key, "answer");
  }

  async abort(): Promise<void> {
    // HTTP requests are left to time out; nothing to kill.
  }
}
