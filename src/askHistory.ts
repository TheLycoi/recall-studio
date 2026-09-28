// The conversation an Ask sends with a question: which earlier turns count as
// conversation, and how many of them. Pure — no `obsidian` import — so the
// rules are testable without the panel.

/** A chat turn as this module needs to see it; the panel's own turns fit. */
export interface HistoryTurnLike {
  role: string;
  text: string;
  error?: unknown;
  chips?: unknown;
  quiz?: unknown;
  /** Written by the plugin rather than the model: a refusal such as "Your notes don't cover this". */
  canned?: boolean;
  /** A typed studio command ("send it", "quiz me"): the reader's line, but not a question. */
  command?: boolean;
}

/** An `[n]` citation marker and the space before it. */
const CITATION = /\s*\[\d+\](?!\()/g;

/**
 * The turns worth replaying to the model, oldest first.
 *
 * - Only user and assistant turns with text. System turns are the panel
 *   narrating itself, chips have no text, errors are not speech, and quiz
 *   turns are a drill rather than a conversation about the notes.
 * - Canned turns are dropped: a refusal the plugin wrote would otherwise be
 *   replayed as something the model said.
 * - A question whose reply was canned or an error goes with it: left behind,
 *   it would sit next to the following question as two user turns in a row,
 *   and a two-entry window could be that lone unanswered question. A question
 *   with no reply yet is the pending one, which `excludeLast` handles.
 * - Command turns are dropped: "send it" is something the panel did, not
 *   something to answer on the next Ask.
 * - `excludeLast` drops a trailing user turn, the question now being asked,
 *   which the prompt carries on its own and must not see twice.
 * - `[n]` markers are stripped from assistant text: they number evidence the
 *   next call will not see.
 * - The last `maxEntries` are kept, trimmed to start on a user turn when the
 *   window holds one, so two entries is one exchange: a question and its
 *   answer, never an answer without its question.
 */
export function historyFor(
  turns: HistoryTurnLike[],
  opts: { maxEntries: number; excludeLast?: boolean },
): Array<{ role: "user" | "assistant"; text: string }> {
  const speech = (t: HistoryTurnLike) => t.role === "user" || t.role === "assistant";
  const failed = (t: HistoryTurnLike | undefined) => !!t && t.role === "assistant" && (!!t.canned || !!t.error);
  // The reply a user turn got: the next user or assistant turn, skipping system lines.
  const replyTo = (i: number) => turns.slice(i + 1).find(speech);
  const kept = turns.filter(
    (t, i): t is HistoryTurnLike & { role: "user" | "assistant" } =>
      speech(t) &&
      !(t.role === "user" && failed(replyTo(i))) &&
      !t.error &&
      !t.chips &&
      !t.quiz &&
      !t.canned &&
      !t.command &&
      t.text.trim().length > 0,
  );
  if (opts.excludeLast && kept.length > 0 && kept[kept.length - 1].role === "user") kept.pop();

  const max = Math.max(0, Math.floor(opts.maxEntries));
  let window = max === 0 ? [] : kept.slice(-max);
  const firstUser = window.findIndex((t) => t.role === "user");
  if (firstUser > 0) window = window.slice(firstUser);

  return window.map((t) => ({
    role: t.role,
    text: t.role === "assistant" ? t.text.replace(CITATION, "").trim() : t.text,
  }));
}
