import { addIcon } from "obsidian";

/**
 * WikiLM's icon set.
 *
 * Every glyph is drawn on the same 100x100 grid Obsidian gives addIcon, but
 * laid out to Lucide's proportions so ours sit beside the built-in icons
 * without looking heavier or larger: a 24-unit Lucide grid scaled by ~4.17,
 * which puts the 2px Lucide stroke at 8 and the usual 2-unit margin at 8.
 * Shapes stay inside x/y 12..88 for the same optical weight as a Lucide box.
 *
 * The card shape is reserved for glyphs that mean a card: the base card, the
 * stack, and the two card types (cloze, Q&A). Actions are drawn as the plain
 * mark alone — a plus, a nib, a check. Putting a card behind every action made
 * a row of near-identical rectangles that could only be told apart by a small
 * mark in one corner, which is the opposite of what a toolbar needs.
 */

const ICON_PREFIX = "wikilm";

/** The inbox: a mailbox. The plugin's ribbon, view tab and menu entry. */
export const WIKILM_ICON = `${ICON_PREFIX}`;
/** A stack of cards — decks, and the inbox's deck picker. */
export const WIKILM_STACK_ICON = `${ICON_PREFIX}-stack`;
/** An upward arrow out of a tray — export to Anki. */
export const WIKILM_SEND_ICON = `${ICON_PREFIX}-send`;
/** A four-point spark — ask the model to write or rewrite. */
export const WIKILM_SPARK_ICON = `${ICON_PREFIX}-spark`;
/** A plus — add one by hand. */
export const WIKILM_ADD_ICON = `${ICON_PREFIX}-add`;
/** A nib — edit. */
export const WIKILM_EDIT_ICON = `${ICON_PREFIX}-edit`;
/** A cross — delete or dismiss. */
export const WIKILM_DISCARD_ICON = `${ICON_PREFIX}-discard`;
/** A circular arrow — retry a failed highlight. */
export const WIKILM_RETRY_ICON = `${ICON_PREFIX}-retry`;
/** A check — apply the linter's fix. */
export const WIKILM_FIX_ICON = `${ICON_PREFIX}-fix`;
/** Card with brackets — convert to cloze. */
export const WIKILM_CLOZE_ICON = `${ICON_PREFIX}-cloze`;
/** Card with a question mark — convert to Q&A. */
export const WIKILM_QA_ICON = `${ICON_PREFIX}-qa`;
/** A downward arrow into a tray — write the deck out as a file. */
export const WIKILM_FILE_ICON = `${ICON_PREFIX}-file`;
/** Marker nib — highlighter mode. */
export const WIKILM_HIGHLIGHT_ICON = `${ICON_PREFIX}-highlight`;
/** Three dots — the overflow menu. */
export const WIKILM_MORE_ICON = `${ICON_PREFIX}-more`;
/** Disclosure chevrons, drawn to match the rest of the set. */
export const WIKILM_CHEVRON_DOWN_ICON = `${ICON_PREFIX}-chevron-down`;
export const WIKILM_CHEVRON_RIGHT_ICON = `${ICON_PREFIX}-chevron-right`;

/**
 * Shared stroke wrapper. currentColor everywhere so the set follows the theme
 * and Obsidian's own hover/accent states without any extra CSS.
 */
const stroke = (body: string, width = 8): string =>
  `<g fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;

/**
 * The card body, for the glyphs that mean a card: the stack and the two card
 * types. Landscape, optically centred, with a radius that reads as a card
 * rather than a bubble.
 */
const card = (x: number, y: number, w: number, h: number, rx = 9): string =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;

const ICONS: Record<string, string> = {
  // A mailbox: domed body on a post, flag raised on the right. The flag is what
  // makes it a mailbox rather than a tunnel at 16px, so it stays even though it
  // carries no state — the inbox's own count badge says what is waiting. It
  // joins the body wall directly; drawn detached it read as a stray tick.
  [WIKILM_ICON]: stroke(`
    <path d="M10 64V48a18 18 0 0 1 18-18h24a18 18 0 0 1 18 18v16z"/>
    <path d="M28 64V36"/>
    <path d="M38 88V64"/>
    <path d="M82 64V26"/>
    <path d="M82 28h10v9H82"/>`),

  // Two offset cards. The back card is clipped to a corner rather than drawn
  // whole, which keeps the stack legible when it is 14px wide.
  [WIKILM_STACK_ICON]: stroke(`
    <path d="M28 30v-4a9 9 0 0 1 9-9h39a9 9 0 0 1 9 9v30a9 9 0 0 1-9 9h-4"/>
    ${card(12, 34, 60, 42, 9)}
    <path d="M28 55h28"/>`),

  // Arrow rising out of an open tray: export. The tray is three sides only, so
  // it never reads as a closed box the arrow is trapped in.
  [WIKILM_SEND_ICON]: stroke(`
    <path d="M50 66V14"/>
    <path d="M30 34L50 14l20 20"/>
    <path d="M18 62v18a8 8 0 0 0 8 8h48a8 8 0 0 0 8-8V62"/>`),

  // Four-point spark: anything the model writes. Unchanged in shape from the
  // card version, recentred and grown to fill the grid on its own.
  [WIKILM_SPARK_ICON]: stroke(`
    <path d="M50 12l9 22 22 9-22 9-9 22-9-22-22-9 22-9z"/>`),

  // Plus: add by hand.
  [WIKILM_ADD_ICON]: stroke(`
    <path d="M50 18v64"/>
    <path d="M18 50h64"/>`),

  // Nib on its diagonal, with the stroke it lays down: edit.
  [WIKILM_EDIT_ICON]: stroke(`
    <path d="M74 14l14 14L40 76l-20 6 6-20z"/>
    <path d="M64 24l14 14"/>`),

  // Cross: dismiss and delete. Reads as "set aside" rather than a bin, which
  // matches what the action does — the highlight is kept, just moved out of
  // the way.
  [WIKILM_DISCARD_ICON]: stroke(`
    <path d="M24 24l52 52"/>
    <path d="M76 24L24 76"/>`),

  // Circular arrow: retry. The arc closes most of the way round and the
  // arrowhead sits over the remaining gap — a wider gap read as a letter G.
  [WIKILM_RETRY_ICON]: stroke(`
    <path d="M82 38A34 34 0 1 1 68 21"/>
    <path d="M84 14v26H58"/>`),

  // Check: the linter's fix, accepted. A wrench turned to mush at 16px; a
  // check reads instantly and still means "resolve this".
  [WIKILM_FIX_ICON]: stroke(`
    <path d="M20 54l20 20 40-46"/>`),

  // Cloze: a card whose middle word is blanked out. The gap in the text line is
  // the whole idea, so the card stays whole and the line breaks instead —
  // brackets around the card read as a battery at small sizes. Two lines only,
  // widely spaced: three crowded into a dark bar at 16px.
  [WIKILM_CLOZE_ICON]: stroke(`
    ${card(10, 22, 80, 56, 10)}
    <path d="M26 42h12"/>
    <path d="M62 42h12"/>
    <path d="M26 60h22"/>`),

  // Q&A: a card split into a question side and an answer side. The divider is
  // what distinguishes it from the base card, and it survives 16px where a
  // drawn question mark did not.
  [WIKILM_QA_ICON]: stroke(`
    ${card(10, 22, 80, 56, 10)}
    <path d="M50 22v56"/>
    <path d="M26 50h10"/>
    <path d="M64 50h10"/>`),

  // Arrow descending into the same open tray: write out to a file. Deliberately
  // the send glyph mirrored, since the two actions are each other's opposite.
  [WIKILM_FILE_ICON]: stroke(`
    <path d="M50 14v52"/>
    <path d="M30 46l20 20 20-20"/>
    <path d="M18 62v18a8 8 0 0 0 8 8h48a8 8 0 0 0 8-8V62"/>`),

  // Marker drawn at an angle with the band it lays down underneath. The angle
  // and the separate stroke are what keep it from reading as an eraser.
  [WIKILM_HIGHLIGHT_ICON]: stroke(`
    <path d="M58 14l28 28-34 34-28-28z"/>
    <path d="M24 48l-8 22 22-8"/>
    <path d="M16 92h72"/>`),

  // Overflow. Drawn rather than borrowed so its dot size matches our stroke.
  [WIKILM_MORE_ICON]: stroke(
    `<path d="M22 50h.01"/><path d="M50 50h.01"/><path d="M78 50h.01"/>`,
    11,
  ),

  [WIKILM_CHEVRON_DOWN_ICON]: stroke(`<path d="M24 40l26 26 26-26"/>`),
  [WIKILM_CHEVRON_RIGHT_ICON]: stroke(`<path d="M40 24l26 26-26 26"/>`),
};

export function registerWikiLmIcon(): void {
  for (const [name, svg] of Object.entries(ICONS)) addIcon(name, svg);
}
