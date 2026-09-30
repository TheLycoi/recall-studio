/**
 * Upstream's model client, served by WikiLM's own backends.
 *
 * obsidian-llm-wiki's engine asks its client for text (`createMessage`) and
 * parses the answer itself. Upstream ships SDK clients that need an API key;
 * the reader's vault runs Claude Code under a subscription with no key stored,
 * so the engine is handed this adapter instead, and every call goes through
 * `LlmBackend.completeText` on the provider and model WikiLM's roles choose
 * (src/modelRoles.ts).
 *
 * Only `createMessage` is offered. Every upstream call site checks for the
 * optional `createMessageWithOutput` and `createMessageStream` before using
 * them and otherwise falls back to `createMessage` and its own JSON parsing,
 * which is the path upstream's Anthropic client has always taken.
 *
 * Pure apart from the backends it is given: no `obsidian` import, so
 * test/upstreamLlmAdapter.test.mjs bundles it with fake backends.
 */
import type { LlmBackend, ProviderName, TextRequest, TextStop } from "../backend";
import { resolveRole, type ModelRole } from "../modelRoles";
import type { WikiLmSettings } from "../settings";
import type { UpstreamFinishReason, UpstreamLLMClient } from "./vendor";

export type BackendLookup = (provider: ProviderName) => Pick<LlmBackend, "completeText">;

type CreateMessageParams = Parameters<UpstreamLLMClient["createMessage"]>[0];
type UpstreamMessage = CreateMessageParams["messages"][number];

/**
 * The role an upstream task label belongs to. Upstream names its steps at each
 * call site (`task: "extract"`, `"merge-triage"`, `"query-wiki"`...). Its query
 * steps start with "query", its lint steps with "lint" plus two fix runners;
 * every other step, labelled or not, builds pages from a source, which is
 * digest work.
 */
export function roleForTask(task: string | undefined): ModelRole {
  if (!task) return "digest";
  if (task.startsWith("query")) return "query";
  if (task.startsWith("lint") || task === "fix-dead-link" || task === "link-orphan") return "lint";
  return "digest";
}

function messageText(content: UpstreamMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      throw new Error("WikiLM's model backends take text only, so a file (a PDF) cannot be sent to them.");
    })
    .join("\n\n");
}

/**
 * The conversation as one user message. A single user turn goes through as
 * it is; longer conversations keep their order, each turn under its role.
 */
export function flattenMessages(messages: UpstreamMessage[]): string {
  if (messages.length === 1 && messages[0].role === "user") return messageText(messages[0].content);
  return messages.map((m) => `${m.role === "user" ? "User" : "Assistant"}:\n${messageText(m.content)}`).join("\n\n");
}

/** Upstream's thinking controls as WikiLM's effort; nothing asked means the backend's configured default. */
function effortFor(params: CreateMessageParams): TextRequest["effort"] {
  if (params.reasoningEffort) return params.reasoningEffort;
  if (params.enableThinking === false) return "low";
  return undefined;
}

/**
 * A backend's stop in upstream's words (LLMFinishReason in types.ts). Upstream
 * acts only on "length": it keeps a page's body rather than write a cut-off
 * rewrite over it, and halves an extract batch (finish-reason.ts captureFinish).
 */
const FINISH_REASON: Record<TextStop, UpstreamFinishReason> = {
  end: "stop",
  length: "length",
  other: "other",
  unknown: "unknown",
};

/** What upstream recognises as a cancel: the engine checks `name === "AbortError"` on a DOMException. */
function abortError(): DOMException {
  return new DOMException("The model call was cancelled.", "AbortError");
}

/**
 * The call's result, or an AbortError the moment the signal fires. The
 * backend is handed the same signal and stops its own work where it can
 * (a CLI child is killed); this makes sure the caller stops waiting even when
 * it cannot (an Obsidian requestUrl has no cancel).
 */
function untilAborted<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? abortError() : error);
      },
    );
  });
}

/**
 * The client upstream's engine calls. Settings are read on every call, so a
 * change of role or model in WikiLM's settings reaches the next model call
 * without rebuilding anything.
 *
 * Upstream's `model` parameter is not used: the role decides the model. The
 * other parameters WikiLM's backends have no use for (sampling, cache
 * breakpoints, output modes) are dropped; the table in the task 3 report
 * lists each one and why.
 *
 * `onFinish` is called once, just before the text is returned, as upstream's
 * own SDK clients do (llm-sdk/anthropic-sdk-client.ts); a call that throws or
 * is cancelled never reports. A backend that says nothing leaves the reason
 * "unknown".
 */
export function createUpstreamClient(getSettings: () => WikiLmSettings, backends: BackendLookup): UpstreamLLMClient {
  return clientOn(getSettings, backends, roleForTask);
}

/**
 * The same client with every call on one role, whatever upstream labels it.
 * Upstream's lint leaves some of its calls unlabelled (the duplicate merge,
 * the empty-page fill: wiki/lint/merge-duplicates.ts, fill-empty-page.ts),
 * and an unlabelled call is digest work to `roleForTask`; a lint run hands
 * upstream this client on the lint role instead.
 */
export function createRoleClient(getSettings: () => WikiLmSettings, backends: BackendLookup, role: ModelRole): UpstreamLLMClient {
  return clientOn(getSettings, backends, () => role);
}

function clientOn(getSettings: () => WikiLmSettings, backends: BackendLookup, roleFor: (task: string | undefined) => ModelRole): UpstreamLLMClient {
  return {
    async createMessage(params: CreateMessageParams): Promise<string> {
      const signal = params.abortSignal;
      if (signal?.aborted) throw abortError();
      const { provider, model } = resolveRole(getSettings(), roleFor(params.task));
      let stop: TextStop = "unknown";
      const call = backends(provider).completeText({
        system: params.system ?? "",
        user: flattenMessages(params.messages),
        maxTokens: params.max_tokens,
        effort: effortFor(params),
        model: model || undefined,
        signal,
        onStop: (s) => {
          stop = s;
        },
      });
      const text = await (signal ? untilAborted(call, signal) : call);
      params.onFinish?.({ finishReason: FINISH_REASON[stop] });
      return text;
    },
  };
}
