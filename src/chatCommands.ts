// Deciding what a line typed into the Ask box means: an action to run, or a
// question for the notes. Pure — no `obsidian` import — so the whole decision
// table is testable.
//
// Policy (chat-studio design, 2026-09-17): the chat is the studio. A plain
// phrase with a verb and a target runs the action; a target that fits two
// files is offered as chips rather than guessed; everything else is a
// question. A leading slash is tolerated and means the same thing, so older
// habits keep working, but no slash grammar is documented.

import { parseQuizCommand } from "./quiz";

export interface CommandLike {
  id: string;
  name: string;
  aliases: string[];
}

/** What an action is about: the open file, a page, a class, a PDF, a manifest, or words. */
export type Target =
  | { kind: "active" }
  | { kind: "page"; path: string; title: string }
  | { kind: "class"; code: string }
  | { kind: "pdf"; path: string; basename: string }
  | { kind: "manifest"; path: string }
  | { kind: "query"; words: string };

/** What a typed line means. `ambiguous` is the panel's cue to ask rather than guess. */
export type Intent =
  | { kind: "quiz"; target: Target }
  | { kind: "digest"; target: Target }
  | { kind: "highlight"; target: Target }
  | { kind: "lint" }
  | { kind: "export" }
  | { kind: "inbox" }
  | { kind: "send-answer" }
  | { kind: "help" }
  | { kind: "command"; id: string }
  | { kind: "ambiguous"; verb: "digest" | "highlight"; words: string; candidates: Target[] }
  | {
      kind: "question";
      /** The class the question is scoped to, when the phrase named one: "ask HBIO408 …", "… in HBIO408". */
      classCode?: string;
      /** The question with the scope words removed; absent for an unscoped question. */
      text?: string;
    };

/** One page of the retrieval index, as the matcher needs to see it. */
export interface IntentPage {
  path: string;
  title: string;
  aliases: string[];
  classCodes: string[];
  hasPdfLinks: boolean;
}

/** Everything in the vault a target could name, plus the palette. */
export interface IntentContext {
  pages: IntentPage[];
  pdfs: Array<{ path: string; basename: string }>;
  manifests: string[];
  commands: CommandLike[];
}

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

/** Words of the target, folded, two characters or longer. */
function tokens(s: string): string[] {
  return fold(s).split(" ").filter((w) => w.length >= 2);
}

function pageFor(words: string, ctx: IntentContext): IntentPage | null {
  const k = fold(words);
  if (!k) return null;
  return ctx.pages.find((p) => fold(p.title) === k || p.aliases.some((a) => fold(a) === k)) ?? null;
}

function classFor(words: string, ctx: IntentContext): string | null {
  const k = fold(words).replace(/\s+/g, "");
  for (const p of ctx.pages) for (const c of p.classCodes) if (fold(c).replace(/\s+/g, "") === k) return c;
  return null;
}

/** Files whose name holds every word of the target. */
function matchingFiles(words: string, ctx: IntentContext, allowNotes: boolean): Target[] {
  const ws = tokens(words);
  if (ws.length === 0) return [];
  const has = (name: string) => {
    const f = ` ${fold(name)} `;
    return ws.every((w) => f.includes(w));
  };
  const out: Target[] = [];
  for (const pdf of ctx.pdfs) if (has(pdf.basename)) out.push({ kind: "pdf", path: pdf.path, basename: pdf.basename });
  if (allowNotes) for (const p of ctx.pages) if (p.hasPdfLinks && (has(p.title) || p.aliases.some(has))) out.push({ kind: "page", path: p.path, title: p.title });
  for (const m of ctx.manifests) if (has(m.split("/").pop()?.replace(/\.md$/i, "") ?? m)) out.push({ kind: "manifest", path: m });
  return out;
}

/**
 * Files fitting the target, words as typed first.
 *
 * `stripArticles` drops a trailing "notes", "pdf", "deck" so "the doping pdf"
 * finds a PDF that never says "pdf" in its name. That same strip turns
 * "ch3 notes" — the exact name of a file — into "ch3", which fits three files
 * and would be handed back as a question to answer. So the words as typed are
 * tried first, and the stripped form only when they fit nothing: naming a file
 * exactly can never be made ambiguous by a word another file happens to share.
 */
function filesFor(words: string, ctx: IntentContext, allowNotes: boolean): Target[] {
  const literal = matchingFiles(words, ctx, allowNotes);
  if (literal.length > 0) return literal;
  return matchingFiles(stripArticles(words), ctx, allowNotes);
}

function quizTarget(words: string, ctx: IntentContext): Target {
  const w = words.trim().replace(TARGET_LEAD, "").trim();
  if (!w || THIS.test(w)) return { kind: "active" };
  const page = pageFor(w, ctx) ?? pageFor(stripArticles(w), ctx);
  if (page) return { kind: "page", path: page.path, title: page.title };
  const code = classFor(w, ctx);
  if (code) return { kind: "class", code };
  return { kind: "query", words: w };
}

/**
 * A digest or highlight target, which must be a real file: a quiz can fall
 * back to searching the index for words, but nothing can be digested that is
 * not a PDF, a manifest, or a note citing one. A name that fits two files, or
 * none, is returned as `ambiguous` for the panel to ask about.
 */
function fileIntent(verb: "digest" | "highlight", words: string, ctx: IntentContext): Intent {
  const w = words.trim().replace(TARGET_LEAD, "").trim();
  if (!w || THIS.test(w)) return { kind: verb, target: { kind: "active" } };
  if (verb === "digest") {
    const page = pageFor(w, ctx) ?? pageFor(stripArticles(w), ctx);
    if (page) return page.hasPdfLinks ? { kind: verb, target: { kind: "page", path: page.path, title: page.title } } : { kind: "ambiguous", verb, words: w, candidates: [] };
  }
  const found = filesFor(w, ctx, verb === "digest");
  if (found.length === 1) return { kind: verb, target: found[0] };
  return { kind: "ambiguous", verb, words: w, candidates: found.slice(0, 3) };
}

export function matchIntent(text: string, ctx: IntentContext): Intent {
  const t = normalize(text);
  if (!t) return { kind: "question" };

  if (/^(?:help|what can you do|what can i say|commands)$/.test(t)) return { kind: "help" };

  // `parseQuizCommand` reads "quiz me on X" and "quiz on X" but not the bare
  // "quiz X" that a stripped "/quiz receptors" leaves behind. Rewriting that
  // one shape into a form it already knows keeps the old slash habit working.
  //
  // Only the verb "quiz" opens it: "test" and "drill" lead ordinary sentences
  // ("test the hypothesis", "drill down into receptors") that must stay
  // questions, and they are reachable as "test me on X" either way. The target
  // has to be a page, an alias or a class code as well — a bare "quiz" plus
  // loose words is prose ("quiz results are in"), and the reader who means a
  // subject can say "quiz me about it".
  // "quiz all" and "quiz everything" name the whole vault, which
  // `parseQuizCommand`'s plain-phrase grammar also does not reach in this
  // shape; an empty query is how the panel reads the all-vault scope.
  if (/^quiz\s+(?:all|everything)$/.test(t)) return { kind: "quiz", target: { kind: "query", words: "" } };
  const bare = /^quiz\s+(?!me\b|all\b|everything\b|on\b|about\b|from\b|over\b)(.+)$/.exec(t);
  if (bare) {
    const named = quizTarget(bare[1], ctx);
    if (named.kind === "page" || named.kind === "class") return { kind: "quiz", target: named };
  }
  const quiz = parseQuizCommand(t, false);
  if (quiz && quiz.kind === "start") {
    if (quiz.scope === "this") return { kind: "quiz", target: { kind: "active" } };
    if (quiz.scope === "all") return { kind: "quiz", target: { kind: "query", words: "" } };
    return { kind: "quiz", target: quizTarget(quiz.query, ctx) };
  }

  const digest = /^(?:ai[- ])?digest(?:\s+(.*))?$/.exec(t);
  if (digest) return fileIntent("digest", digest[1] ?? "", ctx);
  const highlight = /^(?:(?:ai[- ])?highlight|suggest highlights?|ai[- ]suggest)(?:\s+(.*))?$/.exec(t);
  if (highlight) return fileIntent("highlight", highlight[1] ?? "", ctx);

  if (/^(?:lint(?: the)?(?: wiki)?|check the wiki|wiki check|check my wiki)$/.test(t)) return { kind: "lint" };
  if (/^export(?: (?:all|reviewed|cards|the cards|to anki|reviewed cards to anki|reviewed cards|cards to anki))*$/.test(t)) return { kind: "export" };
  // Before the bare "inbox" rule below, whose phrasing this overlaps. Anchored
  // whole-line and led by a verb, so a question that merely mentions the words
  // ("what does the inbox send to the writer?") stays a question.
  if (/^(?:send (?:it |this |that |the answer )?to (?:the )?inbox|send to inbox|card (?:it|this|that)|make (?:cards|flashcards)|flashcard (?:it|this|that))$/.test(t)) {
    return { kind: "send-answer" };
  }
  if (/^(?:open (?:the )?inbox|show (?:the )?inbox|inbox)$/.test(t)) return { kind: "inbox" };

  // A palette name or alias typed exactly: unambiguous enough to run.
  const key = t.replace(/[…\s]+$/, "");
  for (const c of ctx.commands) {
    if (key === c.id.toLowerCase() || key === c.name.toLowerCase().replace(/[…\s]+$/, "") || c.aliases.some((a) => key === a.toLowerCase())) {
      return { kind: "command", id: c.id };
    }
  }
  return scopedQuestion(text, ctx) ?? { kind: "question" };
}

/**
 * A question that names its class: "ask HBIO408 what is impulse", "what is
 * impulse in HBIO408", "in HBIO408, what is impulse". The code has to be one
 * some page carries, or the words are left as an ordinary question — "in the
 * cell" is not a scope. The question keeps its own casing; only the scope
 * words and a trailing question mark are removed.
 */
function scopedQuestion(text: string, ctx: IntentContext): Intent | null {
  const raw = text.trim().replace(/^\/+/, "").replace(new RegExp(POLITENESS.source, "i"), "").trim();
  const scoped = (codeWords: string, rest: string): Intent | null => {
    const code = classFor(codeWords, ctx);
    const question = rest.trim().replace(/[?!.]+$/, "").trim();
    return code && question ? { kind: "question", classCode: code, text: question } : null;
  };
  let m = /^ask\s+(\S+)\s+(.+)$/i.exec(raw);
  if (m) return scoped(m[1], m[2]);
  m = /^in\s+(\S+?),?\s+(.+)$/i.exec(raw);
  if (m) {
    const hit = scoped(m[1], m[2]);
    if (hit) return hit;
  }
  m = /^(.+?)\s+in\s+(\S+?)\s*[?!.]*$/i.exec(raw);
  if (m) return scoped(m[2], m[1]);
  return null;
}

/** What the box understands, one phrase per line. Shown for "help". */
export function renderHelp(): string {
  return [
    "- **quiz me** — questions on the open note until the edge of what you know shows; **quiz me on Receptors**, **quiz me on HBIO250**, **quiz me on everything**",
    "- **digest** — group the open PDF's highlights into concept and entity pages; **digest Doping** names a PDF or a note with PDF++ links",
    "- **highlight** — let the model pick spans in the open PDF, each checked against the text layer; **highlight Ch3**",
    "- **lint** — check the wiki for wrong quotes, dead links and duplicate pages",
    "- **export** — send every reviewed card to Anki",
    "- **inbox** — open the inbox",
    "- **send to inbox** — card the last answer, one inbox item per source it rested on",
    "- while a quiz runs: **hint**, **skip**, **stop**",
    "",
    "Anything else is a question for your notes. **ask HBIO250 …** or **… in HBIO250** keeps it to one class.",
  ].join("\n");
}
