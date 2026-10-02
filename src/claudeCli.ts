import { execFile, spawn, type ChildProcess } from "child_process";
import { CLAUDE_CLI_MODELS } from "./modelRoles";
import { accessSync, constants } from "fs";
import { homedir } from "os";
import { delimiter, join } from "path";
import { z } from "zod";
import type { CompletionRequest, LlmBackend, TextRequest, TextStop } from "./backend";
import { extractJson, toStrictSchema } from "./codex";
import type { WikiLmSettings } from "./settings";

/**
 * Claude Code backend: shells out to Anthropic's `claude` CLI in print mode
 * (`claude -p`), which is signed in with the user's Claude subscription
 * (OAuth in the macOS keychain), so no API key is needed.
 *
 * Structured output comes from `--json-schema <inline JSON>` (the same strict
 * schema the Codex backend writes to a temp file, here passed as one argv
 * element, so no shell quoting is involved) and `--output-format json`, which
 * prints a single result envelope carrying both the raw text and the parsed
 * `structured_output`.
 *
 * Two rules this file must not break:
 *   - `--bare` is never passed. It disables keychain reads, and the claude.ai
 *     login lives in the keychain, so every call would fail "Not logged in".
 *   - ANTHROPIC_API_KEY is stripped from the child's environment, so a key
 *     exported in the user's shell can never silently move billing from the
 *     subscription to the metered API (the rule an earlier version of this
 *     plugin's claude-cli adapter follows).
 *
 * The prompt goes on stdin rather than as a positional argument, so 60,000
 * character paper texts never hit argument-length limits.
 *
 * This file must stay free of `obsidian` imports so the pure helpers can be
 * unit-tested under node (see test/claudeCli.test.mjs).
 */

export type ClaudeCliErrorKind = "not-found" | "timeout" | "auth" | "usage-limit" | "failed" | "aborted";

export class ClaudeCliError extends Error {
  constructor(
    public kind: ClaudeCliErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

export const PREAMBLE =
  "Reply with one message containing only the JSON object described by the output schema. Do not use tools, read files, or search; everything you need is in this message.";

/** The plain-text call's preamble: the same ban on tools, and no answer format of its own, since the prompt brings one. */
export const TEXT_PREAMBLE = "Do not use tools, read files, or search; everything you need is in this message.";

/**
 * Structured output costs one extra internal turn, so a one-shot answer needs
 * two. A plain-text answer needs one; it keeps the same cap, which is a
 * ceiling and costs nothing when the answer comes sooner.
 */
const MAX_TURNS = 2;

// ------------------------------------------------------------ pure helpers

/** Binary locations to try, in order. A configured path is authoritative. */
export function claudeCandidates(configured: string, env: NodeJS.ProcessEnv, home: string): string[] {
  if (configured.trim()) return [configured.trim()];
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
  ];
  const out: string[] = [];
  for (const d of dirs) {
    const p = join(d, "claude");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export interface ClaudeResult {
  structured: unknown | null;
  text: string | null;
  isError: boolean;
  message: string | null;
  subtype: string | null;
  apiErrorStatus: number | null;
}

/**
 * The single result envelope in `claude -p --output-format json` stdout: the
 * last non-empty line that parses as a JSON object with `type === "result"`.
 * Stray non-JSON lines (update notices, warnings) are skipped.
 */
function findResultEnvelope(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rec = value as Record<string, unknown>;
    if (rec.type === "result") return rec;
  }
  return null;
}

/** What the result envelope says: the answer, or the error and its details. */
export function parseClaudeResult(stdout: string): ClaudeResult {
  const rec = findResultEnvelope(stdout);
  if (!rec) return { structured: null, text: null, isError: false, message: null, subtype: null, apiErrorStatus: null };
  const isError = rec.is_error === true;
  const text = typeof rec.result === "string" ? rec.result : null;
  return {
    structured: rec.structured_output === undefined ? null : rec.structured_output ?? null,
    text,
    isError,
    message: isError ? text : null,
    subtype: typeof rec.subtype === "string" ? rec.subtype : null,
    apiErrorStatus: typeof rec.api_error_status === "number" ? rec.api_error_status : null,
  };
}

/**
 * Why a plain-text call's model stopped, from the envelope's `stop_reason`
 * (the Messages API's value for the last turn) and `terminal_reason` (why the
 * CLI's loop ended). Only a completed loop whose last turn ended with
 * `end_turn` is an end. `max_tokens` is a length. Everything else is unknown,
 * `stop_sequence` included: no stop sequence is sent, and the CLI reported it
 * on a call it had failed for exceeding its own output cap (captured in
 * test/claudeCli.test.mjs). That cap is an error envelope, which
 * completeText throws on before asking this.
 */
export function claudeTextStop(stdout: string): TextStop {
  const rec = findResultEnvelope(stdout);
  if (!rec) return "unknown";
  if (rec.stop_reason === "max_tokens" || rec.stop_reason === "model_context_window_exceeded") return "length";
  const completed = rec.terminal_reason === undefined || rec.terminal_reason === "completed";
  if (rec.stop_reason === "end_turn" && completed) return "end";
  return "unknown";
}

/**
 * The exact argv for one call. Order matters only for readability; what
 * matters is that `--bare` never appears (it disables keychain reads) and
 * that the schema, system prompt and model are separate argv elements.
 * Without `schemaJson` the call is plain text: the same argv minus
 * `--json-schema`, and the answer is the envelope's `result`.
 */
export function buildClaudeArgs(opts: { model: string; effort: string; schemaJson?: string; system: string; maxTurns: number }): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    ...(opts.schemaJson === undefined ? [] : ["--json-schema", opts.schemaJson]),
    "--system-prompt",
    opts.system,
    "--model",
    opts.model,
    "--effort",
    opts.effort,
    "--max-turns",
    String(opts.maxTurns),
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
  ];
}

/**
 * The environment handed to the child: process.env minus ANTHROPIC_API_KEY, so
 * an exported key can never switch billing off the subscription, and minus
 * CLAUDE_CODE_SIMPLE, which changes the CLI's output mode.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.ANTHROPIC_API_KEY;
  delete out.CLAUDE_CODE_SIMPLE;
  return out;
}

export interface ClassifyInput {
  spawnError?: NodeJS.ErrnoException | null;
  timedOut?: boolean;
  aborted?: boolean;
  code?: number | null;
  stderr?: string;
  parsed?: Pick<ClaudeResult, "isError" | "message" | "apiErrorStatus"> | null;
}

export function classifyClaude(input: ClassifyInput): ClaudeCliError {
  const { spawnError = null, timedOut = false, aborted = false, code = null, stderr = "", parsed = null } = input;
  if (aborted) return new ClaudeCliError("aborted", "Cancelled because WikiLM was unloaded.");
  if (spawnError?.code === "ENOENT") {
    binaryCache = null;
    return new ClaudeCliError(
      "not-found",
      `Claude Code CLI could not be started (${spawnError.path ?? "unknown path"}). Check “Claude Code CLI path” in WikiLM settings.`,
    );
  }
  if (spawnError) return new ClaudeCliError("failed", `Could not start Claude Code: ${spawnError.message}`);
  if (timedOut) return new ClaudeCliError("timeout", `Claude Code did not answer within ${Math.round(TIMEOUT_MS / 60000)} minutes.`);

  const message = parsed?.message ?? null;
  const cleaned = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  const status = parsed?.apiErrorStatus ?? null;
  const text = `${message ?? ""}\n${cleaned}\n${status ?? ""}`;

  if (/not logged in|\/login|unauthori[sz]ed|\b401\b|oauth/i.test(text)) {
    return new ClaudeCliError(
      "auth",
      `Claude Code is not signed in: ${message ?? cleaned.split("\n")[0] ?? "run `claude` in a terminal and sign in"}`,
    );
  }
  if (/usage limit|rate limit|\b429\b|too many requests|overloaded|\b529\b/i.test(text)) {
    return new ClaudeCliError("usage-limit", `Claude Code usage limit reached: ${message ?? cleaned.split("\n")[0] ?? "try again later"}`);
  }
  const detail = message || cleaned || (status !== null ? `API error ${status}` : `exit code ${code ?? "?"}`);
  return new ClaudeCliError("failed", `Claude Code failed: ${detail}`);
}

// -------------------------------------------------------- process plumbing

let binaryCache: { configured: string; path: string; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export function resolveClaudeBinary(configured: string): string {
  if (binaryCache && binaryCache.configured === configured && Date.now() - binaryCache.at < CACHE_MS) return binaryCache.path;
  const candidates = claudeCandidates(configured, process.env, homedir());
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      binaryCache = { configured, path: c, at: Date.now() };
      return c;
    } catch {
      // try the next one
    }
  }
  const hint = configured.trim() ? `Nothing runnable at "${configured.trim()}".` : "Not on Obsidian's PATH, in ~/.local/bin, or in the usual bin directories.";
  throw new ClaudeCliError(
    "not-found",
    `Claude Code CLI not found. ${hint} Set “Claude Code CLI path” in WikiLM settings to the output of \`which claude\`, or install the CLI and run \`claude\` once to sign in.`,
  );
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError: NodeJS.ErrnoException | null;
}

interface Live {
  child: ChildProcess;
  aborted: boolean;
  done: Promise<void>;
  kill: () => void;
}

const live = new Set<Live>();
const TIMEOUT_MS = 5 * 60 * 1000;
const KILL_GRACE_MS = 5000;

function runClaude(bin: string, args: string[], stdin: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: childEnv(process.env), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let resolveDone: () => void = () => {};
    const entry: Live = {
      child,
      aborted: false,
      done: new Promise<void>((r) => (resolveDone = r)),
      kill: () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
        setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, KILL_GRACE_MS).unref?.();
      },
    };
    live.add(entry);

    // One call's own cancel (upstream's engine passes one) kills this child
    // the way plugin unload kills them all.
    const onAbort = () => {
      entry.aborted = true;
      entry.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      entry.kill();
    }, TIMEOUT_MS);

    const finish = (partial: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      live.delete(entry);
      resolveDone();
      resolve({ stdout, stderr, code: null, signal: null, timedOut, aborted: entry.aborted, spawnError: null, ...partial });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (stdout += d));
    child.stderr?.on("data", (d: string) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) => finish({ spawnError: e }));
    child.on("close", (code, signal) => finish({ code, signal }));

    // If claude exits before reading stdin the write raises EPIPE; an unhandled
    // stream error would take the renderer down, so listen before writing.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

function runQuick(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env: childEnv(process.env), encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code as number | undefined) ?? 1 : 0;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: typeof code === "number" ? code : 1 });
    });
  });
}


export class ClaudeCliBackend implements LlmBackend {
  readonly name = "claudecli" as const;

  constructor(private getSettings: () => WikiLmSettings) {}

  private settings(): { path: string; model: string; effort: string } {
    const s = this.getSettings();
    return { path: s.claudeCliPath, model: s.claudeCliModel || "sonnet", effort: s.effort };
  }

  async probe(model?: string): Promise<{ model: string; via: string }> {
    const s = this.settings();
    const bin = resolveClaudeBinary(s.path);
    const status = await runQuick(bin, ["auth", "status"]);
    const firstLine = (text: string) =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)[0] ?? "";
    let auth: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(status.stdout.trim());
      if (!value || typeof value !== "object") throw new Error("not an object");
      auth = value as Record<string, unknown>;
    } catch {
      throw new ClaudeCliError(
        "auth",
        `Claude Code at ${bin} could not report its login status: ${firstLine(status.stderr) || firstLine(status.stdout) || `exit code ${status.code}`}`,
      );
    }
    if (status.code !== 0 || auth.loggedIn !== true) {
      throw new ClaudeCliError("auth", `Claude Code at ${bin} is not signed in. Run \`claude\` in a terminal and sign in to your Claude account.`);
    }
    await this.complete({
      system: "You answer with JSON only.",
      user: "Set ready to true.",
      schema: z.object({ ready: z.boolean() }),
      label: "probe",
      maxTokens: 50,
      model,
    });
    return { model: model ?? s.model, via: bin };
  }

  async listModels(): Promise<string[]> {
    // The CLI has no model-listing call; these are the aliases it accepts.
    return [...CLAUDE_CLI_MODELS];
  }

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    const s = this.settings();
    const bin = resolveClaudeBinary(s.path);
    const args = buildClaudeArgs({
      model: req.model ?? s.model,
      effort: req.effort ?? s.effort,
      schemaJson: JSON.stringify(toStrictSchema(req.schema)),
      system: req.system,
      maxTurns: MAX_TURNS,
    });
    const prompt = [PREAMBLE, req.user].join("\n\n");
    const r = await runClaude(bin, args, prompt);
    const parsed = parseClaudeResult(r.stdout);
    const failed = r.spawnError || r.timedOut || r.aborted || r.code !== 0 || parsed.isError;
    if (failed) {
      throw classifyClaude({ spawnError: r.spawnError, timedOut: r.timedOut, aborted: r.aborted, code: r.code, stderr: r.stderr, parsed });
    }

    let value: unknown = parsed.structured;
    if (value === null) {
      if (parsed.text === null) throw new ClaudeCliError("failed", `Claude Code produced no answer for the ${req.label}.`);
      try {
        value = JSON.parse(extractJson(parsed.text));
      } catch {
        throw new ClaudeCliError("failed", `Claude Code returned ${req.label} that were not valid JSON.`);
      }
    }
    const result = req.schema.safeParse(value);
    if (!result.success) {
      throw new ClaudeCliError("failed", `Claude Code returned ${req.label} in the wrong shape: ${result.error.issues[0]?.message ?? "schema mismatch"}.`);
    }
    return result.data;
  }

  /**
   * The same process as `complete` without `--json-schema`: the answer is the
   * envelope's `result`, returned as the model wrote it. An empty answer is
   * returned empty, for the caller to judge; a missing one is an error.
   */
  async completeText(req: TextRequest): Promise<string> {
    if (req.signal?.aborted) throw new ClaudeCliError("aborted", "Cancelled.");
    const s = this.settings();
    const bin = resolveClaudeBinary(s.path);
    const args = buildClaudeArgs({
      model: req.model ?? s.model,
      effort: req.effort ?? s.effort,
      system: req.system,
      maxTurns: MAX_TURNS,
    });
    const prompt = [TEXT_PREAMBLE, req.user].join("\n\n");
    const r = await runClaude(bin, args, prompt, req.signal);
    if (r.aborted && req.signal?.aborted) throw new ClaudeCliError("aborted", "Cancelled.");
    const parsed = parseClaudeResult(r.stdout);
    const failed = r.spawnError || r.timedOut || r.aborted || r.code !== 0 || parsed.isError;
    if (failed) {
      throw classifyClaude({ spawnError: r.spawnError, timedOut: r.timedOut, aborted: r.aborted, code: r.code, stderr: r.stderr, parsed });
    }
    if (parsed.text === null) throw new ClaudeCliError("failed", "Claude Code produced no answer.");
    req.onStop?.(claudeTextStop(r.stdout));
    return parsed.text;
  }

  async abort(): Promise<void> {
    const all = [...live];
    for (const l of all) {
      l.aborted = true;
      l.kill();
    }
    await Promise.all(all.map((l) => l.done));
  }
}
