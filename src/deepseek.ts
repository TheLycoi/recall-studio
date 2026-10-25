import { requestUrl } from "obsidian";
import { z } from "zod";
import type { CompletionRequest, LlmBackend, TextRequest, TextStop } from "./backend";
import { assertAuthorized } from "./backend";
import { classifyStatus, DeepSeekError } from "./deepseekError";
import { DEEPSEEK_BASE_URL, deepSeekEffort, readDeepSeekModels } from "./deepseekModels";
import { resolveDeepSeekKey, type KeySource } from "./deepseekKey";
import { errorMessage, jsonPreamble, readChoice } from "./deepseekWire";
import { extractJson } from "./jsonOut";
import type { RecallSettings } from "./settings";
import { sanitizeDiagnostic } from "./providerDiagnostic";

/**
 * The error type and the status classification live in src/deepseekError.ts,
 * a pure module, so they can be tested without bundling `requestUrl`. They are
 * re-exported here because this is the module the rest of the plugin imports
 * the backend and its error from (src/llm.ts).
 */
export { DeepSeekError, type DeepSeekErrorKind } from "./deepseekError";

/** 5 minutes, matching the Codex backend's ceiling. */
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Headroom added to every call's token cap.
 *
 * DeepSeek counts its thinking tokens against `max_tokens`, which the Codex
 * backend's CLI does not, so a call sized for its answer alone can be cut off
 * before it writes one. The caller's cap is about how much answer it wants;
 * this is about what the model needs to get there. A cap that is somehow still
 * too small surfaces as `finish_reason: "length"`, reported as its own error.
 */
const REASONING_HEADROOM = 4096;

const TEXT_PREAMBLE = "Answer in plain text. Do not use any tools.";


/**
 * DeepSeek backend: plain HTTPS to the OpenAI-compatible endpoint at
 * api.deepseek.com, with an API key. No CLI, no ChatGPT sign-in.
 *
 * Structured output is JSON mode (`response_format: {"type": "json_object"}`),
 * not a schema the API enforces: DeepSeek guarantees the answer is valid JSON
 * and nothing about its shape. So the zod schema is described to the model in
 * the prompt and then enforced locally by `req.schema.safeParse`, which is the
 * same last line of defence the Codex backend uses. A shape mismatch is a
 * reported failure, never a silent bad card.
 *
 * Two documented quirks are handled here rather than left to the reader:
 *
 * - JSON mode "may occasionally return empty content". An empty or unparseable
 *   answer is retried once, because the failure is transient by the vendor's
 *   own description, and only then reported.
 * - `finish_reason: "length"` means the answer was cut off at the token cap.
 *   That is reported as its own error, not as "not valid JSON", so a truncated
 *   card list does not read like a broken schema.
 *
 * Obsidian runs plugins inside an Electron renderer where plain fetch() is
 * subject to CORS. requestUrl() goes through the main process and is not.
 */

export class DeepSeekBackend implements LlmBackend {
  readonly name = "deepseek" as const;

  constructor(private getSettings: () => RecallSettings) {}

  /** The key and where it came from; throws when there is none. */
  private key(): { key: string; source: KeySource } {
    const s = this.getSettings();
    const resolved = resolveDeepSeekKey(s.deepseekApiKey);
    if (!resolved.key) {
      throw new DeepSeekError(
        "no-key",
        "No DeepSeek API key. Paste one in Recall Studio settings, export DEEPSEEK_API_KEY, add a keychain item named DEEPSEEK_API_KEY, or switch the provider to Codex.",
      );
    }
    return resolved;
  }

  private headers(key: string): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
  }

  /**
   * One request. Non-2xx statuses are turned into a typed error here, so every
   * caller gets the same classification. A timeout or an abort rejects without
   * cancelling the underlying request, which requestUrl does not support.
   */
  private async post(path: string, body: unknown, signal?: AbortSignal, authorized?: () => boolean): Promise<unknown> {
    assertAuthorized({ authorized });
    const { key } = this.key();
    if (signal?.aborted) throw new DeepSeekError("aborted", "Cancelled.");
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new DeepSeekError("timeout", `DeepSeek did not answer within ${Math.round(TIMEOUT_MS / 60000)} minutes.`));
      }, TIMEOUT_MS);
    });
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DeepSeekError("aborted", "Cancelled."));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const request = {
        url: `${DEEPSEEK_BASE_URL}${path}`,
        method: "POST",
        headers: this.headers(key),
        body: JSON.stringify(body),
        throw: false,
      };
      assertAuthorized({ authorized });
      const res = await Promise.race([
        requestUrl(request),
        timeout,
        aborted,
      ]);
      if (res.status < 200 || res.status >= 300) {
        let detail: string | null = null;
        try {
          detail = sanitizeDiagnostic(errorMessage(res.json) ?? "", [key]);
        } catch {
          detail = null;
        }
        throw classifyStatus(res.status, detail);
      }
      return res.json;
    } catch (e) {
      if (e instanceof DeepSeekError) throw new DeepSeekError(e.kind, sanitizeDiagnostic(e.message, [key]));
      if (timedOut) throw new DeepSeekError("timeout", `DeepSeek did not answer within ${Math.round(TIMEOUT_MS / 60000)} minutes.`);
      throw new DeepSeekError("failed", `Could not reach DeepSeek: ${sanitizeDiagnostic(e instanceof Error ? e.message : String(e), [key])}`);
    } finally {
      // The listener outlives the request otherwise: the caller's signal is
      // long-lived, and every request would add another listener to it.
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    }
  }

  /** The request body both call shapes share. */
  private body(model: string, system: string, user: string, maxTokens: number, effort: string): Record<string, unknown> {
    return {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens + REASONING_HEADROOM,
      // Thinking is on by default, and every call here either writes cards or
      // grades an answer, so it is asked for explicitly rather than relied on.
      thinking: { type: "enabled" },
      reasoning_effort: deepSeekEffort(effort),
    };
  }

  async probe(model?: string): Promise<{ model: string; via: string }> {
    const s = this.getSettings();
    const { source } = this.key();
    const chosen = model ?? s.deepseekModel;
    await this.complete({
      system: "You answer with JSON only.",
      user: "Set ready to true.",
      schema: z.object({ ready: z.boolean() }),
      label: "probe",
      maxTokens: 50,
      effort: "low",
      model: chosen,
    });
    return { model: chosen, via: `key from ${source}` };
  }

  async listModels(): Promise<string[]> {
    const { key } = this.key();
    try {
      const res = await requestUrl({ url: `${DEEPSEEK_BASE_URL}/models`, method: "GET", headers: this.headers(key), throw: false });
      if (res.status < 200 || res.status >= 300) {
        let detail: string | null = null;
        try {
          detail = sanitizeDiagnostic(errorMessage(res.json) ?? "", [key]);
        } catch {
          detail = null;
        }
        throw classifyStatus(res.status, detail);
      }
      const ids = readDeepSeekModels(res.json);
      if (!ids.length) throw new DeepSeekError("failed", "DeepSeek returned no models.");
      return ids;
    } catch (e) {
      const kind = e instanceof DeepSeekError ? e.kind : "failed";
      const detail = sanitizeDiagnostic(e instanceof Error ? e.message : String(e), [key]);
      throw new DeepSeekError(kind, e instanceof DeepSeekError ? detail : `Could not list DeepSeek models: ${detail}`);
    }
  }

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    const text = await this.jsonText(req, req.label, req.schema);
    let value: unknown;
    try {
      value = JSON.parse(extractJson(text));
    } catch {
      throw new DeepSeekError("failed", `DeepSeek returned ${req.label} that were not valid JSON.`);
    }
    const parsed = req.schema.safeParse(value);
    if (!parsed.success) {
      throw new DeepSeekError(
        "failed",
        `DeepSeek returned ${req.label} in the wrong shape: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`,
      );
    }
    return parsed.data;
  }

  async completeText(req: TextRequest): Promise<string> {
    const text = await this.plainText(req, "answer");
    req.onStop?.(text.stop);
    return text.content;
  }

  /**
   * One JSON-mode call, retried once when the answer comes back empty.
   * DeepSeek documents empty content under JSON mode as an occasional
   * occurrence, and a second identical request is the cheap fix; the failure
   * is only reported when the retry fails too.
   *
   * A truncated answer is not retried: the token cap is per call and nothing
   * about a second identical call would raise it.
   */
  private async jsonText(req: TextRequest & { retryInvalidResponse?: boolean }, label: string, schema: z.ZodType): Promise<string> {
    const attempt = async (): Promise<string> => {
      const system = [jsonPreamble(schema), req.system].join("\n\n");
      const { content, stop } = await this.chat(req, system, req.user, label, true);
      if (stop === "length") {
        throw new DeepSeekError(
          "truncated",
          `DeepSeek ran out of output tokens partway through the ${label}. Try again, or give that call less to write.`,
        );
      }
      if (!content.trim()) throw new DeepSeekError("empty", `DeepSeek returned an empty answer for the ${label}.`);
      try {
        JSON.parse(extractJson(content));
      } catch {
        throw new DeepSeekError("unparseable", `DeepSeek's answer for the ${label} was not JSON.`);
      }
      return content;
    };
    try {
      return await attempt();
    } catch (e) {
      // A bad key, a refused request or a timeout will fail again identically,
      // so only the empty and unparseable answers are worth a second call: a
      // second identical request is the cheap fix for a model slip.
      if (req.retryInvalidResponse === false || !(e instanceof DeepSeekError) || (e.kind !== "empty" && e.kind !== "unparseable") || req.signal?.aborted) throw e;
      return attempt();
    }
  }

  /** One plain-text call, retried once on an empty answer for the same reason. */
  private async plainText(req: TextRequest, label: string): Promise<{ content: string; stop: TextStop }> {
    const system = [TEXT_PREAMBLE, req.system].join("\n\n");
    const attempt = async (): Promise<{ content: string; stop: TextStop }> => {
      const out = await this.chat(req, system, req.user, label, false);
      if (out.stop === "length") {
        throw new DeepSeekError(
          "truncated",
          `DeepSeek ran out of output tokens partway through the ${label}. Try again, or give that call less to write.`,
        );
      }
      if (!out.content.trim()) throw new DeepSeekError("empty", `DeepSeek returned an empty answer for the ${label}.`);
      return out;
    };
    try {
      return await attempt();
    } catch (e) {
      if (!(e instanceof DeepSeekError) || e.kind !== "empty" || req.signal?.aborted) throw e;
      return attempt();
    }
  }

  /** The POST itself: build the body, send it, read the assistant's text. */
  private async chat(
    req: TextRequest,
    system: string,
    user: string,
    label: string,
    json: boolean,
  ): Promise<{ content: string; stop: TextStop }> {
    const s = this.getSettings();
    const model = req.model ?? s.deepseekModel;
    const body = this.body(model, system, user, req.maxTokens, req.effort ?? s.effort);
    if (json) body.response_format = { type: "json_object" };
    const res = await this.post("/chat/completions", body, req.signal, req.authorized);
    const { content, stop } = readChoice(res);
    if (!content.trim() && stop === "unknown") {
      throw new DeepSeekError("failed", `DeepSeek produced no message for the ${label}.`);
    }
    return { content, stop };
  }

  async abort(): Promise<void> {
    // HTTP requests are left to time out; requestUrl cannot be cancelled.
  }
}
