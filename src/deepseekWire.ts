import type { TextStop } from "./backend";

/**
 * Reading a DeepSeek chat-completions response.
 *
 * Pure: no `obsidian`, no network. test/deepseek.test.mjs bundles it standalone,
 * which is why these live apart from src/deepseek.ts (that file imports
 * `requestUrl` from obsidian and cannot be bundled for a node test).
 *
 * `jsonPreamble` is defined in src/jsonOut.ts alongside the other
 * provider-neutral JSON helpers and re-exported here, because this is the
 * module the DeepSeek tests read it from.
 */
export { jsonPreamble } from "./jsonOut";

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
