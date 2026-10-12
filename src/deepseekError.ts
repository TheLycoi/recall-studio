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
  | "unparseable"
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
 * How much of a server-supplied detail reaches a message. The detail ends up in
 * a Notice and, via Highlight.error, in inbox.json — a vault file that syncs
 * through iCloud — so a huge body must not be able to flood it.
 */
const MAX_DETAIL_LENGTH = 200;

/**
 * Strip credential-shaped text from a server-supplied detail and cap its
 * length. The detail is whatever came back in the response body, and the
 * message built from it is shown to the reader and persisted as a highlight's
 * error. If a proxy or the API ever reflected the Authorization header into
 * that body, the raw text would carry the key straight to disk. Only the
 * detail passes through here; the advice the caller adds around it does not.
 */
export function redactDetail(detail: string | null): string | null {
  if (!detail) return null;
  const stripped = detail
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/gi, "[redacted]")
    .trim();
  if (!stripped) return null;
  return stripped.length > MAX_DETAIL_LENGTH ? `${stripped.slice(0, MAX_DETAIL_LENGTH)}…` : stripped;
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
  const safe = redactDetail(detail);
  const tail = safe ? `: ${safe}` : "";
  if (status === 401 || status === 403) {
    return new DeepSeekError("auth", `DeepSeek rejected the API key${tail}. Check the key in Review Inbox settings.`);
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
