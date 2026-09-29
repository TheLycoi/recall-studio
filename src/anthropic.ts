import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { requestUrl } from "obsidian";
import type { StopReason } from "@anthropic-ai/sdk/resources/messages/messages";
import type { CompletionRequest, LlmBackend, TextRequest, TextStop } from "./backend";
import { resolveApiKey, type KeySource } from "./keys";
import type { WikiLmSettings } from "./settings";

/**
 * The Messages API's stop reason as a TextStop. "max_tokens" and a full
 * context window cut the answer off. "pause_turn" and "tool_use" end a turn
 * that is not finished, but no tools are sent, so neither should occur.
 * "refusal" is thrown before this is asked. A missing or unfamiliar value
 * is unknown.
 */
const STOPS: Record<StopReason, TextStop> = {
  end_turn: "end",
  stop_sequence: "end",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  pause_turn: "other",
  tool_use: "other",
  refusal: "other",
};

export function anthropicStop(reason: StopReason | null | undefined): TextStop {
  return reason && Object.prototype.hasOwnProperty.call(STOPS, reason) ? STOPS[reason] : "unknown";
}

/**
 * Obsidian runs plugins inside an Electron renderer where plain fetch() is
 * subject to CORS. requestUrl() goes through the main process and is not.
 * This adapter lets the official SDK use it as its transport.
 */
function obsidianFetch(): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? undefined).forEach((v, k) => {
      headers[k] = v;
    });
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? rawBody : rawBody instanceof ArrayBuffer ? rawBody : undefined;
    const res = await requestUrl({
      url,
      method: init?.method ?? "GET",
      headers,
      body,
      throw: false,
    });
    const noBody = res.status === 204 || res.status === 205 || res.status === 304;
    return new Response(noBody ? null : res.arrayBuffer, { status: res.status, headers: res.headers });
  };
}

/** Anthropic Messages API with native structured outputs. Needs an API key. */
export class AnthropicBackend implements LlmBackend {
  readonly name = "anthropic" as const;

  constructor(private getSettings: () => WikiLmSettings) {}

  private client(): Anthropic {
    return this.clientWithSource().client;
  }

  private clientWithSource(): { client: Anthropic; source: KeySource } {
    const s = this.getSettings();
    const { key, source } = resolveApiKey(s.apiKey);
    if (!key) {
      throw new Error(
        "No Anthropic API key. Set one in WikiLM settings, export ANTHROPIC_API_KEY, add a keychain item named ANTHROPIC_API_KEY, or switch the provider to Codex.",
      );
    }
    const client = new Anthropic({
      apiKey: key,
      fetch: obsidianFetch(),
      dangerouslyAllowBrowser: true,
      maxRetries: 2,
      timeout: 5 * 60 * 1000,
    });
    return { client, source };
  }

  async probe(model?: string): Promise<{ model: string; via: string }> {
    const s = this.getSettings();
    const { client, source } = this.clientWithSource();
    const res = await client.messages.create({
      model: model ?? s.model,
      max_tokens: 5,
      messages: [{ role: "user", content: "Reply with the single word: ready" }],
    });
    return { model: res.model, via: `key from ${source}` };
  }

  async listModels(): Promise<string[]> {
    const { client } = this.clientWithSource();
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  }

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    const s = this.getSettings();
    const response = await this.client().messages.parse({
      model: req.model ?? s.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      // The call's own effort first, as the other backends read it, so a
      // request asking for "low" (keywords, relevance, aliases, duplicates,
      // the title scan) is not run at the global effort.
      output_config: { effort: req.effort ?? s.effort, format: zodOutputFormat(req.schema) },
      messages: [{ role: "user", content: req.user }],
    });
    if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
    const parsed = response.parsed_output;
    if (!parsed) throw new Error(`Model returned no parseable ${req.label}.`);
    return parsed as T;
  }

  /**
   * The same request without an output format; the answer is the response's
   * text blocks joined. An empty system prompt is left off, because the API
   * rejects an empty text block.
   */
  async completeText(req: TextRequest): Promise<string> {
    const s = this.getSettings();
    const response = await this.client().messages.create(
      {
        model: req.model ?? s.model,
        max_tokens: req.maxTokens,
        ...(req.system ? { system: [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }] } : {}),
        output_config: { effort: req.effort ?? s.effort },
        messages: [{ role: "user", content: req.user }],
      },
      { signal: req.signal },
    );
    if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    req.onStop?.(anthropicStop(response.stop_reason));
    return text;
  }

  async abort(): Promise<void> {
    // HTTP requests are left to time out; nothing to kill.
  }
}
