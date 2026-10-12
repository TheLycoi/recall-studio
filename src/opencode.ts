// execFile and spawn only, always with an argument array: no shell is involved,
// so no model id, path or prompt can be read as a command.
import { execFile, spawn, type ChildProcess } from "child_process";
import { accessSync, constants, mkdirSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { z } from "zod";
import type { CompletionRequest, LlmBackend, TextRequest } from "./backend";
import { extractJson, jsonPreamble } from "./jsonOut";
import type { RecallSettings } from "./settings";

/**
 * OpenCode backend: shells out to the `opencode` CLI (`opencode run`), which
 * owns its own credentials. Recall holds no key and resolves none, so there is
 * no keychain path here the way the DeepSeek backend has one.
 *
 * Three things the CLI does not offer, and what stands in for each. All three
 * were measured against opencode 2.0.26 rather than assumed:
 *
 * - No `--no-tools`. `opencode run` uses the all-permissions `build` agent, and
 *   a prompt that asks it to read a file really does read one. Recall generates
 *   cards from text it already has and must never touch the vault, so every run
 *   passes `--agent recall` and the scratch directory it runs in carries an
 *   `opencode.json` defining that agent as deny-everything. The agent is the
 *   lockdown; the directory only supplies it.
 * - No `--no-session`. `run` writes a session row into opencode's database.
 *   Each run's id comes back in its own event stream, so it is deleted after
 *   the answer is read. Cleanup is never allowed to fail the call.
 * - No `--json-schema`. Structured output goes through the same prompt-embedded
 *   schema and local zod validation the DeepSeek backend uses, which is the same
 *   last line of defence a schema-enforcing provider would need anyway.
 *
 * `--format json` gives one JSON object per line, so the reply is read from
 * structured events instead of the banner text a plain `run` prints.
 *
 * The common run is deliberately NOT `--standalone`. A standalone server gets
 * its credentials only from the environment, which for a plugin launched by a
 * GUI app is not guaranteed; the shared background service keeps opencode's own
 * `service.json` environment and answers keylessly, verified from a shell with
 * `DEEPSEEK_API_KEY` unset.
 *
 * This file must stay free of `obsidian` imports so it can be unit-tested under
 * node (see test/opencode.test.mjs).
 */

/** The opencode models the settings dropdown offers before a Test lists the real ones. */
export const OPENCODE_FALLBACK_MODELS = ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"];

/** The agent every run uses: defined in the scratch `opencode.json` as allow-nothing. */
export const OPENCODE_AGENT = "recall";

export type OpenCodeErrorKind = "not-found" | "timeout" | "model" | "failed" | "aborted";

export class OpenCodeError extends Error {
  constructor(
    public kind: OpenCodeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeError";
  }
}

// ------------------------------------------------------------ pure helpers

/** Binary locations to try, in order. A configured path is authoritative. */
export function opencodeCandidates(configured: string, env: NodeJS.ProcessEnv, home: string): string[] {
  if (configured.trim()) return [configured.trim()];
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter(Boolean),
    join(home, ".opencode", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
  ];
  const out: string[] = [];
  for (const d of dirs) {
    const p = join(d, "opencode");
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

export interface RunEvents {
  /** The final assistant message, or null when the run produced none. */
  text: string | null;
  /** The message from an `error` event, if the run reported one. */
  error: string | null;
  /** The session this run wrote, so the caller can delete it. Null when none was reported. */
  sessionId: string | null;
}

/**
 * Read `opencode run --format json` output: one JSON object per line.
 *
 * The last assistant message wins, matching the Codex backend's rule. Text for
 * one message may arrive as several parts, so parts are joined by their
 * `messageID` rather than treated as separate answers. Unparseable lines are
 * skipped: the CLI writes a plain-text banner and warnings to the same stream
 * on some paths.
 */
export function parseOpencodeEvents(stdout: string): RunEvents {
  const order: string[] = [];
  const byMessage = new Map<string, string[]>();
  let anon = 0;
  let error: string | null = null;
  let sessionId: string | null = null;

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

    if (typeof rec.sessionID === "string" && rec.sessionID && !sessionId) sessionId = rec.sessionID;

    if (rec.type === "error") {
      const err = rec.error;
      const msg =
        typeof err === "string"
          ? err
          : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
            ? ((err as { message: string }).message)
            : null;
      if (msg) error = msg;
      continue;
    }

    const part = rec.part as Record<string, unknown> | undefined;
    if (!part || typeof part !== "object") continue;
    if (part.type !== "text" || typeof part.text !== "string") continue;

    const key = typeof part.messageID === "string" && part.messageID ? part.messageID : `__anon_${anon++}`;
    const chunks = byMessage.get(key);
    if (chunks) chunks.push(part.text);
    else {
      order.push(key);
      byMessage.set(key, [part.text]);
    }
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const text = (byMessage.get(order[i]) ?? []).join("");
    if (text.trim()) return { text, error, sessionId };
  }
  return { text: null, error, sessionId };
}

/**
 * Model ids from `opencode models`, one `provider/model` per line. Lines that
 * are not that shape are dropped, so a warning or a blank line cannot become a
 * model the dropdown offers and the CLI then refuses.
 */
export function readOpencodeModels(stdout: string): string[] {
  const out: string[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || !/^[A-Za-z0-9._-]+\/\S+$/.test(line)) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

// -------------------------------------------------------- process plumbing

let binaryCache: { configured: string; path: string; at: number } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export function resolveOpencodeBinary(configured: string): string {
  if (binaryCache && binaryCache.configured === configured && Date.now() - binaryCache.at < CACHE_MS) return binaryCache.path;
  const candidates = opencodeCandidates(configured, process.env, homedir());
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      binaryCache = { configured, path: c, at: Date.now() };
      return c;
    } catch {
      // try the next one
    }
  }
  const hint = configured.trim() ? `Nothing runnable at "${configured.trim()}".` : "Not on Obsidian's PATH.";
  throw new OpenCodeError(
    "not-found",
    `OpenCode CLI not found. ${hint} Set “OpenCode CLI path” in Recall settings to the output of \`which opencode\`, or install it with \`brew install sst/tap/opencode\`.`,
  );
}

/**
 * The directory every run works in, holding the `opencode.json` that defines
 * the no-tools agent. Stable rather than per-call so opencode maps it to one
 * project instead of a new one per card.
 */
export function scratchDir(): string {
  return join(tmpdir(), "recall-opencode");
}

/**
 * The agent definition that makes "no tools" true rather than merely asked for:
 * opencode's default agent is allow-everything, and a model told to read a file
 * really will.
 *
 * Exported because it is the whole security story of this backend, and a test
 * asserts it still denies everything.
 */
export function opencodeAgentConfig(): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      agents: {
        [OPENCODE_AGENT]: {
          mode: "primary",
          description: "Recall's card writer: answers from the prompt, with no tools.",
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        },
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The argv for one run. Pure and exported because two of its members are the
 * contract: `--format json` is what makes the reply parseable, and `--agent`
 * plus the scratch config is the only thing stopping the model from touching
 * the vault.
 *
 * The model id is passed through untouched. It may carry a variant suffix
 * (`deepseek/deepseek-flash#high`), which is opencode's own syntax; Recall does
 * not build one, because an id naming a variant the model does not offer is a
 * hard failure (`Variant unavailable`) rather than an ignored flag.
 */
export function opencodeArgs(model: string): string[] {
  return ["run", "--format", "json", "--agent", OPENCODE_AGENT, "--model", model];
}

/**
 * The environment for one run: the parent's, with PWD pointing at the directory
 * the run works in.
 *
 * PWD is load-bearing, not cosmetic. Node's `cwd` spawn option changes the
 * child's working directory but leaves PWD holding the parent's, and opencode
 * resolves its project `opencode.json` (which defines the no-tools agent) from
 * PWD. Without this the agent is "not found" and every call fails; a shell sets
 * PWD on `cd`, which is why the same command works by hand and not from a spawn.
 *
 * Pure and exported so a test can pin it: this is the bug that shipped once.
 */
export function opencodeEnv(parent: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  return { ...parent, PWD: cwd };
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

function runOpencode(bin: string, args: string[], cwd: string, stdin: string, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, env: opencodeEnv(process.env, cwd), stdio: ["pipe", "pipe", "pipe"] });
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

    // If opencode exits before reading stdin the write raises EPIPE; an
    // unhandled stream error would take the renderer down, so listen first.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

/** `opencode models`, through the CLI the plugin is configured to use. */
function listOpencodeModels(bin: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      ["models"],
      // PWD as well as cwd, for the reason given on opencodeEnv.
      { cwd, env: opencodeEnv(process.env, cwd), encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const raw = err ? ((err as NodeJS.ErrnoException & { code?: unknown }).code as number | undefined) : 0;
        const code = typeof raw === "number" ? raw : 1;
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
      },
    );
  });
}

function classify(r: RunResult, events: RunEvents, model: string): OpenCodeError {
  if (r.aborted) return new OpenCodeError("aborted", "Cancelled because Recall was unloaded.");
  if (r.spawnError?.code === "ENOENT") {
    binaryCache = null;
    return new OpenCodeError("not-found", `OpenCode CLI could not be started (${r.spawnError.path ?? "unknown path"}). Check “OpenCode CLI path” in Recall settings.`);
  }
  if (r.spawnError) return new OpenCodeError("failed", `Could not start opencode: ${r.spawnError.message}`);
  if (r.timedOut) return new OpenCodeError("timeout", `OpenCode did not answer within ${Math.round(TIMEOUT_MS / 60000)} minutes.`);
  const text = `${events.error ?? ""}\n${r.stderr}`;
  if (/model unavailable|no-route|not found.*model/i.test(text)) {
    return new OpenCodeError(
      "model",
      `OpenCode does not serve ${model}: ${events.error ?? r.stderr.split("\n")[0]}. Click Test in Recall settings to list the models this machine has.`,
    );
  }
  if (/unauthori[sz]ed|no api key|missing api key|\b401\b/i.test(text)) {
    return new OpenCodeError(
      "failed",
      `OpenCode is not signed in for that provider: ${events.error ?? r.stderr.split("\n")[0]}. Run \`opencode auth login\` in a terminal.`,
    );
  }
  // A v1 CLI has no `--format json`, so it prints usage text and no events at
  // all. Naming the version beats naming an empty answer.
  if (!events.error && /unrecognized flag|unknown flag|USAGE/i.test(`${r.stdout}\n${r.stderr}`)) {
    return new OpenCodeError("failed", "This opencode is too old: `opencode run` has no `--format json`. Update OpenCode and try again.");
  }
  const detail = events.error || r.stderr.split("\n").find((l) => l.trim()) || r.stdout.split("\n").find((l) => l.trim()) || `exit code ${r.code ?? "?"}`;
  return new OpenCodeError("failed", `OpenCode produced no message for ${model}: ${detail}`);
}

/** The prompt preamble: the schema, and the tool ban the deny-all agent backs up. */
const TOOLS_BAN = "Do not run commands, read files, or search the web; everything you need is in this message.";

function preamble(schema: z.ZodType): string {
  return [jsonPreamble(schema), TOOLS_BAN].join("\n\n");
}

/**
 * Delete the session a run wrote. Fire and forget: the session list is tidiness,
 * and a failure here must never turn a good answer into an error.
 */
function forgetSession(bin: string, cwd: string, sessionId: string | null): void {
  if (!sessionId) return;
  try {
    const child = execFile(bin, ["session", "delete", sessionId], { cwd, env: { ...process.env }, timeout: 15000 }, () => {});
    child.unref?.();
  } catch {
    // nothing to do: the run already succeeded
  }
}

export class OpenCodeBackend implements LlmBackend {
  readonly name = "opencode" as const;

  constructor(private getSettings: () => RecallSettings) {}

  /** The scratch directory, with its agent definition written fresh each run. */
  private workspace(): string {
    const dir = scratchDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "opencode.json"), opencodeAgentConfig());
    return dir;
  }

  /**
   * One `opencode run`, returning the model's message. `cwd` is the scratch
   * directory, which is what makes `--agent recall` resolvable.
   *
   * This owns the run's whole lifecycle, the session it writes included, so the
   * cleanup sits here rather than in the callers: a run that fails still wrote a
   * session, and the failure paths are exactly the ones that would otherwise
   * leave a row behind. The id is read from the event stream, which carries it
   * whether or not the run produced an answer.
   *
   * A run that produced no message is classified here too, because the process
   * details that say why (a missing binary, a timeout, a provider refusal) are
   * only in scope at this layer.
   */
  private async exec(req: TextRequest, prompt: string): Promise<string> {
    if (req.signal?.aborted) throw new OpenCodeError("aborted", "Cancelled.");
    const s = this.getSettings();
    const bin = resolveOpencodeBinary(s.opencodePath);
    const model = req.model ?? s.opencodeModel;
    const cwd = this.workspace();
    const r = await runOpencode(bin, opencodeArgs(model), cwd, prompt, req.signal);
    const events = parseOpencodeEvents(r.stdout);
    // Before any throw, never after: cleanup is fire-and-forget, so it cannot
    // turn a good answer into an error either way.
    forgetSession(bin, cwd, events.sessionId);
    if (r.aborted && req.signal?.aborted) throw new OpenCodeError("aborted", "Cancelled.");
    if (!events.text) throw classify(r, events, model);
    return events.text;
  }

  async probe(model?: string): Promise<{ model: string; via: string }> {
    const s = this.getSettings();
    const bin = resolveOpencodeBinary(s.opencodePath);
    const chosen = model ?? s.opencodeModel;
    await this.complete({
      system: "You answer with JSON only.",
      user: "Set ready to true.",
      schema: z.object({ ready: z.boolean() }),
      label: "probe",
      maxTokens: 50,
      model: chosen,
    });
    return { model: chosen, via: bin };
  }

  async listModels(): Promise<string[]> {
    const s = this.getSettings();
    const bin = resolveOpencodeBinary(s.opencodePath);
    const r = await listOpencodeModels(bin, this.workspace());
    const ids = readOpencodeModels(r.stdout);
    if (!ids.length) throw new OpenCodeError("failed", `OpenCode listed no models. Run \`${bin} models\` in a terminal to see what it reports.`);
    return ids;
  }

  async complete<T>(req: CompletionRequest<T>): Promise<T> {
    const text = await this.exec(req, [preamble(req.schema), req.system, req.user].join("\n\n"));
    let value: unknown;
    try {
      value = JSON.parse(extractJson(text));
    } catch {
      throw new OpenCodeError("failed", `OpenCode returned ${req.label} that were not valid JSON.`);
    }
    const parsed = req.schema.safeParse(value);
    if (!parsed.success) {
      throw new OpenCodeError("failed", `OpenCode returned ${req.label} in the wrong shape: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`);
    }
    return parsed.data;
  }

  /**
   * The same run without a schema: the model's own text. The stop is always
   * unknown — the `--format json` events carry the answer, the errors and the
   * turn's usage, and none of them says why the model stopped.
   */
  async completeText(req: TextRequest): Promise<string> {
    const text = await this.exec(req, [TOOLS_BAN, req.system, req.user].filter(Boolean).join("\n\n"));
    req.onStop?.("unknown");
    return text;
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
