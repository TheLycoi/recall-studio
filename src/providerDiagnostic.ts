/** Redact diagnostics, never successful model output. Do this before truncation. */
export function sanitizeDiagnostic(message: string, secrets: readonly string[] = []): string {
  let safe = message;
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/((?:["']?(?:[\w-]*api[_ -]?key|access[_-]?token|refresh[_-]?token)["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\[\]]+)/gi, "$1[redacted]");
}
