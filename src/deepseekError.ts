/**
 * The DeepSeek backend's error type and its reading of a failed response.
 *
 * Pure: no `obsidian`, no network (test/deepseek.test.mjs bundles it
 * standalone). It lives apart from src/deepseek.ts because that file imports
 * `requestUrl` from obsidian, which cannot be bundled for a node test — and
 * the status classification is exactly the part worth testing.
 */

export type DeepSeekErrorKind =
  | "no-key"
  | "auth"
  | "balance"
  | "rate-limit"
  | "bad-request"
  | "overloaded"
  | "timeout"
  | "truncated"
  | "empty"
  | "failed"
  | "aborted";

export class DeepSeekError extends Error {
  constructor(
    public kind: DeepSeekErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

/**
 * Turn an HTTP status into a typed error the reader can act on. Each message
 * says what to do about it, because "DeepSeek error 402" is not something a
 * reader can respond to and "top up at platform.deepseek.com" is.
 *
 * 401 and 403 are one case: a revoked key and a key without access are the
 * same fix from the reader's side. 400, 404 and 422 are one case too: a model
 * id the API does not serve is what almost always produces them here.
 */
export function classifyStatus(status: number, detail: string | null): DeepSeekError {
  const tail = detail ? `: ${detail}` : "";
  if (status === 401 || status === 403) {
    return new DeepSeekError("auth", `DeepSeek rejected the API key${tail}. Check the key in Recall settings.`);
  }
  if (status === 402) {
    return new DeepSeekError("balance", `DeepSeek reports insufficient balance${tail}. Top up at platform.deepseek.com.`);
  }
  if (status === 429) {
    return new DeepSeekError("rate-limit", `DeepSeek is rate limiting this key${tail}. Try again shortly, or lower “Parallel requests”.`);
  }
  if (status === 503) {
    return new DeepSeekError("overloaded", `DeepSeek is overloaded right now${tail}. Try again shortly.`);
  }
  if (status === 400 || status === 404 || status === 422) {
    return new DeepSeekError("bad-request", `DeepSeek refused the request${tail}. A model id it does not serve is the usual cause.`);
  }
  return new DeepSeekError("failed", `DeepSeek error ${status}${tail}`);
}
