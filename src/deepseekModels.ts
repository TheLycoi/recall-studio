/**
 * The DeepSeek models the settings dropdown offers, and the two small
 * translations the DeepSeek API needs: its effort vocabulary, and the shape of
 * its model list.
 *
 * Pure: no `obsidian`, no `child_process` (test/deepseek.test.mjs bundles it
 * standalone). The network calls live in src/deepseek.ts.
 */

/** The OpenAI-compatible endpoint. `POST {base}/chat/completions`, `GET {base}/models`. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * DeepSeek's current models, for a settings dropdown that has never reached
 * the API. Clicking Test replaces this list with what `GET /models` returns,
 * which is the authoritative answer.
 *
 * The names matter: DeepSeek's pricing page says to use `deepseek-flash`, and
 * its legacy aliases (`deepseek-v4-flash`) are accepted only to keep old code
 * running, being served by a retired model. `deepseek-chat` and
 * `deepseek-reasoner` were retired on 2026-07-24, so they are not offered.
 *
 * deepseek-v4-pro reasons harder and costs more; deepseek-flash is the cheap
 * one and is what the API's own examples use.
 */
export const DEEPSEEK_FALLBACK_MODELS = ["deepseek-v4-pro", "deepseek-flash"];

/**
 * DeepSeek's `reasoning_effort` accepts none, low, high, max. Recall's five
 * levels collapse onto them: medium and xhigh have no DeepSeek equivalent and
 * land on high, which is the API's own documented mapping. "none" is never
 * returned — Recall always wants thinking on, since every call is either
 * writing cards or grading an answer.
 */
export function deepSeekEffort(effort: string): string {
  switch (effort) {
    case "low":
      return "low";
    case "max":
      return "max";
    default:
      return "high";
  }
}

/** Model ids from DeepSeek's `GET /models` body, or nothing when it is not that shape. */
export function readDeepSeekModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data.map((m) => (m && typeof (m as { id?: unknown }).id === "string" ? (m as { id: string }).id : "")).filter(Boolean);
}
