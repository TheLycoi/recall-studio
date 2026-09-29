import { execFile, spawn, type ChildProcess } from "child_process";
import { CODEX_FALLBACK_MODELS, readCodexModels } from "./modelRoles";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { z } from "zod";
import type { CompletionRequest, LlmBackend, TextRequest } from "./backend";
import type { WikiLmSettings } from "./settings";

/**
 * Codex backend: shells out to OpenAI's Codex CLI (`codex exec`), which is
 * signed in with the user's ChatGPT subscription, so no API key is needed.
 *
 * Structured output comes from `--output-schema` (a strict JSON Schema
 * derived from the same zod schema the Anthropic backend uses) and the final
 * agent message is read from the `--json` event stream. The process runs in
 * a throwaway temp directory with a read-only sandbox and the user's
 * config.toml ignored, so no notify hooks, plugins or MCP servers fire and
 * the agent never sees the vault.
 *
 * This file must stay free of `obsidian` imports so the pure helpers can be
 * unit-tested under node (see test/codex.test.mjs).
 */

export const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"] as const;
export const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

export type CodexErrorKind = "not-found" | "timeout" | "auth" | "usage-limit" | "effort" | "failed" | "aborted";

export class CodexError extends Error {
  constructor(
    public kind: CodexErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "CodexError";
  }
}

// ------------------------------------------------------------ pure helpers

/** Highest effort <= requested that the model supports; falls back to the request itself. */
export function clampEffort(requested: string, supported: readonly string[]): string {
  if (supported.includes(requested)) return requested;
  const idx = (EFFORT_ORDER as readonly string[]).indexOf(requested);
  if (idx < 0) return requested;
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(EFFORT_ORDER[i])) return EFFORT_ORDER[i];
  }
  return requested;
}

const STATIC_EFFORTS: Record<string, readonly string[]> = {
  "gpt-5.5": ["low", "medium", "high", "xhigh"],
};

/** Reads `models[].supported_reasoning_levels[].effort` from ~/.codex/models_cache.json; static fallback otherwise. */
export function readSupportedEfforts(model: string, cacheJson: string | null): string[] {
  if (cacheJson) {
    try {
      const data = JSON.parse(cacheJson) as { models?: unknown };
      const models = Array.isArray(data?.models) ? (data.models as Array<Record<string, unknown>>) : [];
      const entry = models.find((m) => m && m.slug === model);
      const levels = entry?.supported_reasoning_levels;
      if (Array.isArray(levels)) {
        const out = levels
          .map((l) => (typeof l === "string" ? l : (l as { effort?: unknown })?.effort))
          .filter((x): x is string => typeof x === "string");
        if (out.length) return out;
      }
    } catch {
      // fall through to the static table
    }
  }
  return [...(STATIC_EFFORTS[model] ?? EFFORT_ORDER)];
}

/**
 * Pull the final agent message (and any failure message) out of a
 * `codex exec --json` JSON Lines stream. Last agent message wins; a completed
 * item's text is never overwritten by a later in-progress event for the same
 * id. Unparseable lines are skipped.
 */
export function parseCodexEvents(stdout: string): { text: string | null; error: string | null } {
  const order: string[] = [];
  const byKey = new Map<string, { text: string; completed: boolean }>();
  let anon = 0;
  let error: string | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const rec = event as Record<string, unknown>;
    const type = typeof rec.type === "string" ? rec.type : "";

    if (type === "turn.failed" || type === "error") {
      const err = rec.error as Record<string, unknown> | undefined;
      const msg =
        (typeof rec.message === "string" && rec.message) ||
        (err && typeof err.message === "string" && err.message) ||
        (typeof rec.error === "string" && rec.error) ||
        null;
      if (msg) error = msg;
      continue;
    }

    if (!type.startsWith("item.")) continue;
    const item = rec.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== "object") continue;
    if (item.type !== "agent_message" || typeof item.text !== "string") continue;

    const key = typeof item.id === "string" && item.id ? item.id : `__anon_${anon++}`;
    const completed = type === "item.completed";
    const existing = byKey.get(key);
    if (!existing) {
      order.push(key);
      byKey.set(key, { text: item.text, completed });
    } else if (completed || !existing.completed) {
      existing.text = item.text;
      existing.completed = existing.completed || completed;
    }
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const entry = byKey.get(order[i]);
    if (entry && entry.text.trim()) return { text: entry.text, error };
  }
  return { text: null, error };
}

/** Strip ``` fences and any prose around the outermost JSON value. */
export function extractJson(text: string): string {
  let t = text.trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(t);
  if (fence) t = fence[1].trim();
  if (t.startsWith("{") || t.startsWith("[")) return t;
  const open = t.search(/[[{]/);
  const close = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (open >= 0 && close > open) return t.slice(open, close + 1);
  return t;
}

/** JSON Schema for `--output-schema`: zod's output minus the `$schema` keyword, which strict mode rejects. */
export function toStrictSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/** Binary locations to try, in order. A configured path is authoritative. */
export function codexCandidates(configured: string, env: NodeJS.ProcessEnv, home: string): string[] {
  if (configured.trim()) return [configured.trim()];
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
  ];
  const out: string[] = [];
  for (const d of dirs) {
    const p = join(d, "codex");
    if (!out.includes(p)) out.push(p);
  }
  out.push(BUNDLED_CODEX);
  return out;
}

/** Drop codex's chatter so stderr can be shown to the user. */
export function cleanStderr(stderr: string): string {
  return stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^reading prompt from stdin/i.test(l) && !/^warning: /i.test(l))
    .join("\n")
    .trim();
}

// -------------------------------------------------------- process plumbing

let binaryCache: { configured: string; path: string; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export function resolveCodexBinary(configured: string): string {
  if (binaryCache && binaryCache.configured === configured && Date.now() - binaryCache.at < CACHE_MS) return binaryCache.path;
  const candidates = codexCandidates(configured, process.env, homedir());
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      binaryCache = { configured, path: c, at: Date.now() };
      return c;
    } catch {
      // try the next one
    }
  }
  const hint = configured.trim()
    ? `Nothing runnable at "${configured.trim()}".`
    : `Not on Obsidian's PATH and the ChatGPT app is not installed at ${BUNDLED_CODEX}.`;
  throw new CodexError(
    "not-found",
    `Codex CLI not found. ${hint} Set “Codex CLI path” in WikiLM settings to the output of \`which codex\`, or install the ChatGPT desktop app.`,
  );
}

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function readModelsCache(): string | null {
  try {
    return readFileSync(join(codexHome(), "models_cache.json"), "utf8");
  } catch {
    return null;
  }
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

function runCodex(bin: string, args: string[], stdin: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
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

    // If codex exits before reading stdin the write raises EPIPE; an unhandled
    // stream error would take the renderer down, so listen before writing.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

function runQuick(bin: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { env: { ...process.env }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code as number | undefined) ?? 1 : 0;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: typeof code === "number" ? code : 1 });
    });
  });
}

function classify(r: RunResult, eventError: string | null): CodexError {
  if (r.aborted) return new CodexError("aborted", "Cancelled because WikiLM was unloaded.");
  if (r.spawnError?.code === "ENOENT") {
    binaryCache = null;
    return new CodexError("not-found", `Codex CLI could not be started (${r.spawnError.path ?? "unknown path"}). Check “Codex CLI path” in WikiLM settings.`);
  }
  if (r.spawnError) return new CodexError("failed", `Could not start Codex: ${r.spawnError.message}`);
  if (r.timedOut) return new CodexError("timeout", `Codex did not answer within ${Math.round(TIMEOUT_MS / 60000)} minutes.`);
  const stderr = cleanStderr(r.stderr);
  const text = `${eventError ?? ""}\n${stderr}`;
  if (/not logged in|login required|please (run|sign)|unauthori[sz]ed|\b401\b|refresh_token_failed/i.test(text)) {
    return new CodexError("auth", "Codex is not signed in. Open the ChatGPT app and sign in, or run `codex login` in a terminal.");
  }
  if (/usage limit|rate limit|\b429\b|too many requests|insufficient_quota|quota/i.test(text)) {
    return new CodexError("usage-limit", `Codex usage limit reached: ${eventError ?? stderr.split("\n")[0]}`);
  }
  if (/supported reasoning efforts|reasoning effort/i.test(text)) {
    return new CodexError("effort", `Codex rejected the effort level: ${eventError ?? stderr.split("\n")[0]}`);
  }
  const detail = eventError || stderr || (r.signal ? `killed by ${r.signal}` : `exit code ${r.code ?? "?"}`);
  return new CodexError("failed", `Codex failed: ${detail}`);
}

const PREAMBLE =
  "Reply with one message containing only the JSON object described by the output schema. Do not run commands, read files, or search the web; everything you need is in this message.";

/** The plain-text run's preamble: the same ban, and no answer format of its own, since the prompt brings one. */
const TEXT_PREAMBLE = "Do not run commands, read files, or search the web; everything you need is in this message.";

export class CodexBackend implements LlmBackend {
  readonly name = "codex" as const;

  constructor(private getSettings: () => WikiLmSettings) {}

  async probe(model?: string): Promise<{ model: string; via: string }> {
    const s = this.getSettings();
    const bin = resolveCodexBinary(s.codexPath);
    const status = await runQuick(bin, ["login", "status"]);
    const statusText = `${status.stdout}\n${status.stderr}`;
    if (status.code !== 0 || /not logged in/i.test(statusText) || !/logged in/i.test(statusText)) {
      throw new CodexError("auth", `Codex at ${bin} is not signed in. Open the ChatGPT app and sign in, or run \`codex login\` in a terminal.`);
    }
    await this.complete({
      system: "You answer with JSON only.",
      user: "Set ready to true.",
      schema: z.object({ ready: z.boolean() }),
      label: "probe",
      maxTokens: 50,
      model,
    });
    return { model: model ?? s.codexModel, via: bin };
  }

  async listModels(): Promise<string[]> {
    const found = readCodexModels(readModelsCache());
    return found.length > 0 ? found : [...CODEX_FALLBACK_MODELS];
  }

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    const text = await this.exec(req, req.label, req.schema);
    let value: unknown;
    try {
      value = JSON.parse(extractJson(text));
    } catch {
      throw new CodexError("failed", `Codex returned ${req.label} that were not valid JSON.`);
    }
    const parsed = req.schema.safeParse(value);
    if (!parsed.success) {
      throw new CodexError("failed", `Codex returned ${req.label} in the wrong shape: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`);
    }
    return parsed.data;
  }

  /** The same run as `complete` without `--output-schema`: the final agent message, as the model wrote it. */
  async completeText(req: TextRequest): Promise<string> {
    return this.exec(req, "answer");
  }

  /**
   * One `codex exec` run in a throwaway directory, returning the final agent
   * message. With a schema the message is JSON in that shape; without one it
   * is plain text.
   */
  private async exec(req: TextRequest, label: string, schema?: z.ZodType): Promise<string> {
    if (req.signal?.aborted) throw new CodexError("aborted", "Cancelled.");
    const s = this.getSettings();
    const bin = resolveCodexBinary(s.codexPath);
    const model = req.model ?? s.codexModel;
    const effort = clampEffort(req.effort ?? s.effort, readSupportedEfforts(model, readModelsCache()));
    const dir = mkdtempSync(join(tmpdir(), "wikilm-codex-"));
    try {
      const schemaPath = join(dir, "schema.json");
      if (schema) writeFileSync(schemaPath, JSON.stringify(toStrictSchema(schema)));
      const args = [
        "exec",
        "--json",
        "--ephemeral",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "--color",
        "never",
        "-s",
        "read-only",
        "-C",
        dir,
        "-m",
        model,
        "-c",
        `model_reasoning_effort="${effort}"`,
        ...(schema ? ["--output-schema", schemaPath] : []),
        "-",
      ];
      const prompt = (schema ? [PREAMBLE, req.system, req.user] : [TEXT_PREAMBLE, req.system, req.user].filter(Boolean)).join("\n\n");
      const r = await runCodex(bin, args, prompt, req.signal);
      if (r.aborted && req.signal?.aborted) throw new CodexError("aborted", "Cancelled.");
      const { text, error } = parseCodexEvents(r.stdout);
      const failed = r.spawnError || r.timedOut || r.aborted || r.code !== 0;
      if (failed) throw classify(r, error);
      if (!text) {
        throw error ? classify(r, error) : new CodexError("failed", `Codex produced no final message for the ${label}.`);
      }
      return text;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
