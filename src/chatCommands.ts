// Deciding what a line typed into the quiz panel means: a quiz to start, one
// of Recall's commands, or something the panel does not do. Pure, with no
// `obsidian` import, so the whole decision table is testable.
//
// A leading slash is tolerated and means the same thing, so older habits keep
// working, but no slash grammar is documented.

import { COMMAND_TABLE } from "./commandTable";
import { parseQuizCommand } from "./quiz";

export interface CommandLike {
  id: string;
  name: string;
  aliases: string[];
}

/** What a quiz phrase points at. */
export type Target =
  | { kind: "active" }
  | { kind: "page"; path: string; title: string }
  | { kind: "query"; words: string };

/** What a typed line means. "unknown" is anything the quiz panel does not do. */
export type Intent =
  | { kind: "quiz"; target: Target }
  | { kind: "export" }
  | { kind: "inbox" }
  | { kind: "send-misses" }
  | { kind: "help" }
  | { kind: "command"; id: string }
  | { kind: "unknown" };

export interface IntentPage {
  path: string;
  title: string;
  aliases: string[];
}

export interface IntentContext {
  pages: IntentPage[];
  commands: CommandLike[];
}

const SEND_MISSES = new RegExp(
  "^(?:" +
    [
      "(?:send|add) (?:(?:it|this|that|them|these|the misses|my misses) )?to (?:the |my )?inbox",
      "send (?:it|this|that|them)",
      "card (?:it|this|that|them|the misses|my misses)",
      "make (?:cards|flashcards)",
      "flashcard (?:it|this|that|them)",
    ].join("|") +
    ")$",
);

const POLITENESS = /^(?:please |ok |okay |hey |can you |could you |would you |will you )+/;
const TARGET_LEAD = /^(?:on|about|from|over|in|for|of)\s+/;
const THIS = /^(?:this|this note|this pdf|this file|the active note|the open note|the current note|here)$/;

function normalize(text: string): string {
  return text
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(POLITENESS, "")
    .trim();
}

function fold(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function stripArticles(s: string): string {
  return s.replace(/^(?:the|a|an|my)\s+/, "").replace(/\s+(?:pdf|deck|file|note|notes|page|lecture)$/, "").trim();
}

function pageFor(words: string, ctx: IntentContext): IntentPage | null {
  const k = fold(words);
  if (!k) return null;
  return ctx.pages.find((p) => fold(p.title) === k || p.aliases.some((a) => fold(a) === k)) ?? null;
}

function quizTarget(words: string, ctx: IntentContext): Target {
  const w = words.trim().replace(TARGET_LEAD, "").trim();
  if (!w || THIS.test(w)) return { kind: "active" };
  const page = pageFor(w, ctx) ?? pageFor(stripArticles(w), ctx);
  if (page) return { kind: "page", path: page.path, title: page.title };
  return { kind: "query", words: w };
}

export function matchIntent(text: string, ctx: IntentContext): Intent {
  const t = normalize(text);
  if (!t) return { kind: "unknown" };

  if (/^(?:help|what can you do|what can i say|commands)$/.test(t)) return { kind: "help" };

  // `parseQuizCommand` reads "quiz me on X" and "quiz on X" but not the bare
  // "quiz X" that a stripped "/quiz receptors" leaves behind. Rewriting that
  // one shape into a form it already knows keeps the old slash habit working.
  //
  // Only the verb "quiz" opens it: "test" and "drill" lead ordinary sentences
  // ("test the hypothesis", "drill down into receptors"), and they are
  // reachable as "test me on X" either way. The target has to be a page or an
  // alias as well. A bare "quiz" plus loose words is prose ("quiz results are
  // in"), and the reader who means a subject can say "quiz me about it".
  // "quiz all" and "quiz everything" name the whole wiki folder, which
  // `parseQuizCommand`'s plain-phrase grammar also does not reach in this
  // shape. An empty query is how the panel reads that scope.
  if (/^quiz\s+(?:all|everything)$/.test(t)) return { kind: "quiz", target: { kind: "query", words: "" } };
  const bare = /^quiz\s+(?!me\b|all\b|everything\b|on\b|about\b|from\b|over\b)(.+)$/.exec(t);
  if (bare) {
    const named = quizTarget(bare[1], ctx);
    if (named.kind === "page") return { kind: "quiz", target: named };
  }
  const quiz = parseQuizCommand(t, false);
  if (quiz && quiz.kind === "start") {
    if (quiz.scope === "this") return { kind: "quiz", target: { kind: "active" } };
    if (quiz.scope === "all") return { kind: "quiz", target: { kind: "query", words: "" } };
    return { kind: "quiz", target: quizTarget(quiz.query, ctx) };
  }

  if (/^export(?: (?:all|reviewed|cards|the cards|to anki|reviewed cards to anki|reviewed cards|cards to anki))*$/.test(t)) return { kind: "export" };
  // Before the bare "inbox" rule below, whose phrasing this overlaps. Anchored
  // whole-line and led by a verb, so a line that merely mentions the words
  // ("what does the inbox send to the writer?") is not a send. Bare "send" is
  // not here: it is the palette alias of "Send selection to inbox" and reaches
  // that command through the exact-alias match below.
  if (SEND_MISSES.test(t)) return { kind: "send-misses" };
  if (/^(?:open (?:the )?inbox|show (?:the )?inbox|inbox)$/.test(t)) return { kind: "inbox" };

  // A palette name or alias typed exactly: unambiguous enough to run.
  const key = t.replace(/[…\s]+$/, "");
  for (const c of ctx.commands) {
    if (key === c.id.toLowerCase() || key === c.name.toLowerCase().replace(/[…\s]+$/, "") || c.aliases.some((a) => key === a.toLowerCase())) {
      return { kind: "command", id: c.id };
    }
  }
  return { kind: "unknown" };
}

/**
 * The commands that left the palette but still answer to a word here. They
 * are listed so a reader who had a hotkey for one can find where it went.
 */
function chatOnlyLine(): string {
  const hidden = COMMAND_TABLE.filter((c) => c.hidden);
  // The part of the name after a colon says what the command does; a name
  // with no colon already is that sentence.
  const what = (name: string) => (name.includes(":") ? name.slice(name.indexOf(":") + 1) : name).trim().toLowerCase();
  return `- quiz panel only: ${hidden.map((c) => `**${c.aliases[0]}** (${what(c.name)})`).join(", ")}`;
}

/** What the box understands, one phrase per line. Shown for "help". */
export function renderHelp(): string {
  return [
    "- **quiz me**: one question on each section of the open note, answered in a few sentences. **quiz me on Receptors** names a wiki page. **quiz me on everything** covers the whole wiki folder.",
    "- while a quiz runs: **hint**, **skip**, **stop**",
    "- **send to inbox**: after a quiz, turn what you missed into cards. Also **card it**.",
    "- **export**: send every card in the inbox to Anki, except flagged and discarded ones",
    "- **inbox**: open the inbox",
    chatOnlyLine(),
  ].join("\n");
}
