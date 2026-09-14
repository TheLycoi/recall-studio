import { addIcon } from "obsidian";

/**
 * Recall's icon set.
 *
 * Every glyph is drawn on the same 100x100 grid Obsidian gives addIcon, but
 * laid out to Lucide's proportions so ours sit beside the built-in icons
 * without looking heavier or larger: a 24-unit Lucide grid scaled by ~4.17,
 * which puts the 2px Lucide stroke at 8 and the usual 2-unit margin at 8.
 * Shapes stay inside x/y 12..88 for the same optical weight as a Lucide box.
 *
 * The idea running through the set is the flashcard: a rounded landscape
 * rectangle with a line of text in it. Actions are that card plus one mark
 * (a nib, a spark, a cross), so the inbox reads as one family rather than a
 * row of borrowed pictograms.
 */

const ICON_PREFIX = "recall";

/** The base icon: a single flashcard. */
export const RECALL_ICON = `${ICON_PREFIX}`;
/** A stack of cards — decks, and the inbox's deck picker. */
export const RECALL_STACK_ICON = `${ICON_PREFIX}-stack`;
/** Card with an upward arrow — export to Anki. */
export const RECALL_SEND_ICON = `${ICON_PREFIX}-send`;
/** Card with a spark — ask the model to write or rewrite. */
export const RECALL_SPARK_ICON = `${ICON_PREFIX}-spark`;
/** Card with a plus — add one by hand. */
export const RECALL_ADD_ICON = `${ICON_PREFIX}-add`;
/** Card with a nib — edit. */
export const RECALL_EDIT_ICON = `${ICON_PREFIX}-edit`;
/** Card being swept away — delete or dismiss. */
export const RECALL_DISCARD_ICON = `${ICON_PREFIX}-discard`;
/** Circular arrow over a card — retry a failed highlight. */
export const RECALL_RETRY_ICON = `${ICON_PREFIX}-retry`;
/** Card with a wrench mark — apply the linter's fix. */
export const RECALL_FIX_ICON = `${ICON_PREFIX}-fix`;
/** Card with brackets — convert to cloze. */
export const RECALL_CLOZE_ICON = `${ICON_PREFIX}-cloze`;
/** Card with a question mark — convert to Q&A. */
export const RECALL_QA_ICON = `${ICON_PREFIX}-qa`;
/** Card with a down arrow — write the deck out as a file. */
export const RECALL_FILE_ICON = `${ICON_PREFIX}-file`;
/** Marker nib — highlighter mode. */
export const RECALL_HIGHLIGHT_ICON = `${ICON_PREFIX}-highlight`;
/** Three dots — the overflow menu. */
export const RECALL_MORE_ICON = `${ICON_PREFIX}-more`;
/** Disclosure chevrons, drawn to match the rest of the set. */
export const RECALL_CHEVRON_DOWN_ICON = `${ICON_PREFIX}-chevron-down`;
export const RECALL_CHEVRON_RIGHT_ICON = `${ICON_PREFIX}-chevron-right`;

/**
 * Shared stroke wrapper. currentColor everywhere so the set follows the theme
 * and Obsidian's own hover/accent states without any extra CSS.
 */
const stroke = (body: string, width = 8): string =>
  `<g fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;

/**
 * The card body every glyph is built on. Landscape, optically centred, with a
 * radius that reads as a card rather than a bubble. Action glyphs pass a
 * shorter width so the mark beside them has room without the icon growing.
 */
const card = (x: number, y: number, w: number, h: number, rx = 9): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;

const ICONS: Record<string, string> = {
  // Base card. Two text lines — one long, one short — so the glyph still reads
  // as "card with writing on it" at 16px, where a single line looked like a
  // struck-through box.
  [RECALL_ICON]: stroke(`
    ${card(12, 26, 76, 48)}
    <path d="M30 46h40"/>
    <path d="M30 60h24"/>`),

  // Two offset cards. The back card is clipped to a corner rather than drawn
  // whole, which keeps the stack legible when it is 14px wide.
  [RECALL_STACK_ICON]: stroke(`
    <path d="M28 30v-4a9 9 0 0 1 9-9h39a9 9 0 0 1 9 9v30a9 9 0 0 1-9 9h-4"/>
    ${card(12, 34, 60, 42, 9)}
    <path d="M28 55h28"/>`),

  // Card with an arrow leaving it: export.
  [RECALL_SEND_ICON]: stroke(`
    ${card(10, 20, 62, 44, 8)}
    <path d="M26 38h30"/>
    <path d="M74 92V64"/>
    <path d="M62 76l12-12 12 12"/>`),

  // Card with a four-point spark: anything the model writes.
  [RECALL_SPARK_ICON]: stroke(`
    ${card(10, 20, 62, 44, 8)}
    <path d="M26 38h30"/>
    <path d="M72 58l6 14 14 6-14 6-6 14-6-14-14-6 14-6z"/>`),

  // Card with a plus: add by hand.
  [RECALL_ADD_ICON]: stroke(`
    ${card(10, 20, 62, 44, 8)}
    <path d="M26 38h30"/>
    <path d="M74 62v28"/>
    <path d="M60 76h28"/>`),

  // Card with a nib running across it: edit.
  [RECALL_EDIT_ICON]: stroke(`
    ${card(10, 20, 58, 44, 8)}
    <path d="M26 38h26"/>
    <path d="M90 56L64 82l-14 4 4-14 26-26a7 7 0 0 1 10 10z"/>`),

  // Card with a cross: dismiss and delete. Reads as "set aside" rather than a
  // bin, which matches what the action does — the highlight is kept, just
  // moved out of the way.
  [RECALL_DISCARD_ICON]: stroke(`
    ${card(10, 20, 58, 44, 8)}
    <path d="M26 38h26"/>
    <path d="M62 64l26 26"/>
    <path d="M88 64L62 90"/>`),

  // Card under a circular arrow: retry.
  [RECALL_RETRY_ICON]: stroke(`
    ${card(10, 20, 58, 44, 8)}
    <path d="M26 38h26"/>
    <path d="M92 78a17 17 0 1 1-5-12"/>
    <path d="M92 60v18H74"/>`),

  // Card with a check: the linter's fix, accepted. A wrench turned to mush at
  // 16px; a check reads instantly and still means "resolve this".
  [RECALL_FIX_ICON]: stroke(`
    ${card(10, 20, 58, 44, 8)}
    <path d="M26 38h26"/>
    <path d="M58 76l12 12 22-24"/>`),

  // Cloze: a card whose middle word is blanked out. The gap in the text line is
  // the whole idea, so the card stays whole and the line breaks instead —
  // brackets around the card read as a battery at small sizes.
  [RECALL_CLOZE_ICON]: stroke(`
    ${card(12, 26, 76, 48)}
    <path d="M26 44h14"/>
    <path d="M60 44h14"/>
    <path d="M44 56h12"/>`),

  // Q&A: a card split into a question side and an answer side. The divider is
  // what distinguishes it from the base card, and it survives 16px where a
  // drawn question mark did not.
  [RECALL_QA_ICON]: stroke(`
    ${card(12, 26, 76, 48)}
    <path d="M50 26v48"/>
    <path d="M26 50h12"/>
    <path d="M62 50h12"/>`),

  // Card with an arrow into it: write out to a file.
  [RECALL_FILE_ICON]: stroke(`
    ${card(10, 20, 62, 44, 8)}
    <path d="M26 38h30"/>
    <path d="M74 64v28"/>
    <path d="M62 80l12 12 12-12"/>`),

  // Marker drawn at an angle with the band it lays down underneath. The angle
  // and the separate stroke are what keep it from reading as an eraser.
  [RECALL_HIGHLIGHT_ICON]: stroke(`
    <path d="M58 14l28 28-34 34-28-28z"/>
    <path d="M24 48l-8 22 22-8"/>
    <path d="M16 92h72"/>`),

  // Overflow. Drawn rather than borrowed so its dot size matches our stroke.
  [RECALL_MORE_ICON]: stroke(
    `<path d="M22 50h.01"/><path d="M50 50h.01"/><path d="M78 50h.01"/>`,
    11,
  ),

  [RECALL_CHEVRON_DOWN_ICON]: stroke(`<path d="M24 40l26 26 26-26"/>`),
  [RECALL_CHEVRON_RIGHT_ICON]: stroke(`<path d="M40 24l26 26-26 26"/>`),
};

export function registerRecallIcon(): void {
  for (const [name, svg] of Object.entries(ICONS)) addIcon(name, svg);
}
