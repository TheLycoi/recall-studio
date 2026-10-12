// Pure builders for the Spaced Repetition export target.
//
// The Obsidian Spaced Repetition plugin (st3v3nmw/obsidian-spaced-repetition)
// exposes no API for other plugins: it indexes markdown files. So "sending a
// card" means writing a note its parser will accept. These builders are kept
// free of `obsidian` imports (see src/util.ts) so they can be unit-tested with
// node directly.
//
// The rules below were read from the plugin's own source at tag 1.15.4
// (src/parser.ts, src/data/settings.ts), not from its documentation:
//
//   - A line holding the single-line separator anywhere becomes a Q&A card,
//     and the FIRST occurrence splits it. The reversed separator is tested
//     before the plain one, so a `:::` anywhere on the line makes the card
//     reversed instead.
//   - A separator inside inline code is skipped (`markerInsideCodeBlock`) —
//     but only the FIRST occurrence on the line is tested. Backticks can
//     therefore not rescue a single-line card whose question contains one:
//     the card has to take the three-line form.
//   - The three-line form is the front, a line holding only `?`, then the
//     back. A `?` inside a line is harmless; only a line that is exactly `?`
//     is a separator.
//   - A line is a cloze when a cloze pattern matches it AND no inline
//     separator was found first. The default pattern is `==…==`, so a stray
//     `==` is a second deletion.
//   - A blank line ends a card, and comments are skipped unless they begin
//     `<!--SR:`, which is where this version keeps its review history.

import type { Card, Highlight } from "./model";
import { basenameNoExt, escapeRegExp, plainText, slugify } from "./util";

/** Frontmatter field naming the highlight a note was written from. */
export const SR_STAMP_FIELD = "recall-id";
/** Frontmatter field recording when the note was written. */
export const SR_EXPORTED_FIELD = "recall-exported";

export interface Separators {
  /** Splits a single-line Q&A card. */
  basic: string;
  /** Splits a single-line reversed card; checked before `basic`. */
  reversed: string;
  /** A line holding only this separates the two halves of a multi-line card. */
  multiline: string;
}

export interface SpacedSettings extends Separators {
  /** Vault folder the notes are written to. */
  folder: string;
  /** The plugin's flashcard tag, without a leading `#`. */
  tag: string;
  /** Sub-deck under the tag; empty writes the bare tag. */
  deck: string;
}

export function separators(s: Partial<Separators>): Separators {
  return {
    basic: (s.basic ?? "").trim() || "::",
    reversed: (s.reversed ?? "").trim() || ":::",
    multiline: (s.multiline ?? "").trim() || "?",
  };
}

/**
 * A valid Obsidian tag: letters, digits, hyphen, underscore, `/` between
 * segments. Anything else is dropped rather than replaced, so a deck named
 * "Q&A / week 3" becomes `q-a/week-3` and never a tag with a space.
 */
export function sanitizeTag(raw: string): string {
  return (raw ?? "")
    .split("/")
    .map((seg) =>
      seg
        .trim()
        .replace(/[^\p{L}\p{N}_-]+/gu, "-")
        .replace(/^-+|-+$/g, ""),
    )
    .filter(Boolean)
    .join("/")
    .toLowerCase();
}

/** The deck tag a note carries: `<tag>` or `<tag>/<deck>`. */
export function deckTag(s: Pick<SpacedSettings, "tag" | "deck">): string {
  const base = sanitizeTag((s.tag ?? "").replace(/^#+/, "")) || "flashcards";
  const deck = sanitizeTag(s.deck);
  return `#${[base, deck].filter(Boolean).join("/")}`;
}

/** Longest first, so `:::` is matched before `::` in one pass. */
function inlinePattern(sep: Separators): RegExp | null {
  const list = [sep.basic, sep.reversed].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  return new RegExp(`(${list.map(escapeRegExp).join("|")})`, "g");
}

export function hasInlineSeparator(text: string, sep: Separators): boolean {
  return [sep.basic, sep.reversed].some((s) => s && text.includes(s));
}

/**
 * Neutralise the single-line separators in a run of text by wrapping each in
 * backticks, which is the plugin's own rule for ignoring a marker
 * (`markerInsideCodeBlock`). The text reads as inline code when the card is
 * reviewed; it does not change the shape of the card.
 */
export function fenceSeparators(text: string, sep: Separators): string {
  const re = inlinePattern(sep);
  return re ? text.replace(re, "`$1`") : text;
}

/** One line: a newline inside a card would end it, or start a second one. */
function oneLine(s: string): string {
  return (s ?? "").replace(/\r?\n/g, "<br>").trim();
}

export type Serialized = { ok: true; text: string } | { ok: false; reason: string };

const CLOZE = /\{\{c\d+::([\s\S]*?)\}\}/g;

/**
 * One card as the line or lines the plugin parses. Refuses rather than
 * approximates: a card the plugin would misread is reported so the reader can
 * fix it, never written in a shape that asks a different question.
 */
export function serializeCard(card: Card, settings: Partial<Separators>): Serialized {
  const sep = separators(settings);
  return card.kind === "cloze" ? serializeCloze(card, sep) : serializeQa(card, sep);
}

function serializeQa(card: Card, sep: Separators): Serialized {
  const front = oneLine(card.front);
  const back = oneLine(card.back);
  if (!front) return { ok: false, reason: "the question is empty" };
  if (!back) return { ok: false, reason: "the answer is empty" };
  // A `==…==` on the question line is read as a cloze before the separator is
  // ever reached, so the card would arrive as a different kind of card.
  if (front.includes("==")) {
    return { ok: false, reason: "the question contains ==, which the plugin reads as a cloze deletion" };
  }
  if (!hasInlineSeparator(front, sep) && !hasInlineSeparator(back, sep)) {
    return { ok: true, text: `${front}${sep.basic}${back}` };
  }
  // The three-line form. Both halves carry their separators fenced, so the
  // question line is not read as a single-line card and the answer line does
  // not begin a second card of its own.
  const f = fenceSeparators(front, sep);
  const b = fenceSeparators(back, sep);
  if (f === sep.multiline) {
    return {
      ok: false,
      reason: `the question is only "${sep.multiline}", which the plugin reads as a multi-line separator`,
    };
  }
  return { ok: true, text: `${f}\n${sep.multiline}\n${b}` };
}

function serializeCloze(card: Card, sep: Separators): Serialized {
  const raw = card.text ?? "";
  if (!raw.trim()) return { ok: false, reason: "the cloze text is empty" };
  // Everything outside the `{{cN::…}}` markers stays in the note, so a `==`
  // there would be read as a second deletion.
  if (raw.replace(CLOZE, "\u0000").includes("==")) {
    return { ok: false, reason: "the card text contains ==, which the plugin reads as a second deletion" };
  }
  let converted = 0;
  let bad = "";
  const line = raw.replace(CLOZE, (_m, body: string) => {
    const cut = body.indexOf("::");
    const text = oneLine(cut >= 0 ? body.slice(0, cut) : body);
    const hint = cut >= 0 ? oneLine(body.slice(cut + 2)) : "";
    if (!text) {
      bad = "a cloze deletion is empty";
      return "";
    }
    if (text.includes("==")) {
      bad = "a cloze deletion contains ==";
      return "";
    }
    converted++;
    return hint ? `==${text}==^[${hint}]` : `==${text}==`;
  });
  if (bad) return { ok: false, reason: bad };
  if (!converted) return { ok: false, reason: "the card has no cloze deletion" };
  return { ok: true, text: oneLine(fenceSeparators(line, sep)) };
}

/**
 * A provenance line the plugin will not read as a card. The quote keeps its
 * words; `==` is dropped because the plugin would read it as a deletion, and
 * separators are fenced for the same reason.
 */
function provenance(h: Highlight, sep: Separators): string[] {
  const quote = oneLine(plainText(h.text).replace(/==/g, ""));
  const source = h.sourcePath.replace(/\.md$/i, "");
  const where = h.page ? ` › p. ${h.page}` : h.heading ? ` › ${h.heading}` : "";
  const lines: string[] = [];
  if (quote) lines.push(`> ${fenceSeparators(quote, sep)}`);
  lines.push(`Source: [[${source}]]${fenceSeparators(where, sep)}`);
  return lines;
}

/**
 * The note a highlight's cards are written into. One note per send: the deck
 * tag, then a heading, then the provenance, then the cards.
 *
 * The tag is written inline, which is the form the plugin's own documentation
 * and examples use. Both inline and frontmatter tags arrive through Obsidian's
 * metadata cache (`getAllTagsFromCache`), so the note is picked up on the
 * plugin's next rescan once Obsidian has indexed it; neither form is faster to
 * appear. The note is therefore written once and never rewritten.
 */
export function buildNoteBody(h: Highlight, cards: string[], settings: SpacedSettings): string {
  const sep = separators(settings);
  const heading = (h.title || h.heading || h.sourceTitle || h.id).trim();
  const parts = [
    deckTag(settings),
    "",
    `## ${fenceSeparators(heading, sep)}`,
    "",
    ...provenance(h, sep),
    "",
    ...cards.flatMap((c) => [c, ""]),
  ];
  const front = ["---", `${SR_STAMP_FIELD}: ${h.id}`, `${SR_EXPORTED_FIELD}: ${new Date().toISOString()}`, "---", ""];
  return [...front, ...parts].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** The vault path a highlight's note takes. `index` > 0 picks a suffixed name. */
export function notePath(settings: Pick<SpacedSettings, "folder">, h: Highlight, index = 0): string {
  const folder = (settings.folder || "Recall/spaced").replace(/^\/+|\/+$/g, "") || "Recall/spaced";
  const title = slugify(h.title) || slugify(basenameNoExt(h.sourceTitle)) || h.id;
  return `${folder}/${title}${index > 0 ? `-${index + 1}` : ""}.md`;
}

/**
 * The plugin's settings as this module wants them, so the caller passes fields
 * rather than this module importing src/settings.ts (which pulls in `obsidian`
 * and would make these builders untestable with node).
 */
export function spacedSettings(s: {
  srFolder: string;
  srTag: string;
  srDeck: string;
  srBasicSeparator: string;
  srReversedSeparator: string;
  srMultilineSeparator: string;
}): SpacedSettings {
  return {
    folder: s.srFolder,
    tag: s.srTag,
    deck: s.srDeck,
    basic: s.srBasicSeparator,
    reversed: s.srReversedSeparator,
    multiline: s.srMultilineSeparator,
  };
}
