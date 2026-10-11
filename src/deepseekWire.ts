import { z } from "zod";
import type { TextStop } from "./backend";
import { schemaJson } from "./jsonOut";

/**
 * Reading a DeepSeek chat-completions response, and describing a zod schema to
 * a model that has no native structured-output support.
 *
 * Pure: no `obsidian`, no network. test/deepseek.test.mjs bundles it
 * standalone, which is why these live apart from src/deepseek.ts (that file
 * imports `requestUrl` from obsidian and cannot be bundled for a node test).
 */

/**
 * JSON mode needs the word "json" somewhere in the prompt, and the shape has
 * to be spelled out because the API does not enforce one: it guarantees valid
 * JSON and nothing about its structure. Both requirements are met here, in the
 * preamble every schema call carries.
 */
export function jsonPreamble(schema: z.ZodType): string {
  return [
    "Reply with one message containing only a JSON object, and nothing else: no prose, no explanation, no code fence.",
    "The object must satisfy this JSON Schema exactly, with every required property present:",
    "",
    JSON.stringify(schemaJson(schema), null, 2),
  ].join("\n");
}

/** DeepSeek's `finish_reason` mapped onto Recall's vocabulary. */
export function toStop(finishReason: unknown): TextStop {
  if (finishReason === "stop") return "end";
  if (finishReason === "length") return "length";
  if (typeof finishReason === "string" && finishReason) return "other";
  return "unknown";
}

/** The message DeepSeek puts in a failed response body, if it is there at all. */
export function errorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const err = (body as { error?: unknown }).error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return null;
}

/** The assistant's text out of a chat-completions body, plus why it stopped. */
export function readChoice(body: unknown): { content: string; stop: TextStop } {
  if (!body || typeof body !== "object") return { content: "", stop: "unknown" };
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { content: "", stop: "unknown" };
  const first = choices[0] as { message?: { content?: unknown }; finish_reason?: unknown } | undefined;
  const raw = first?.message?.content;
  return { content: typeof raw === "string" ? raw : "", stop: toStop(first?.finish_reason) };
}
