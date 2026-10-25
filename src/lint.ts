// Deterministic post-generation linter. No model call, no network call: every
// check here is a regular expression or a word count, run against text the
// writer already produced. Obsidian-free by design — test/lint.test.mjs
// bundles this module standalone with esbuild, so an `obsidian` import (or an
// import of anything that pulls one in, e.g. settings.ts) breaks `npm test`
// loudly at the esbuild resolve step.
import { inlineMarkdownToHtml, normalizePlain, ungroundedClozes } from "./util";
import type { Card, Highlight, LintFailureId, LintWarningId } from "./model";

export interface LintResult {
  failures: LintFailureId[];
  warnings: LintWarningId[];
}

/** Length policies need independent adjudication, not automatic loss of meaning. */
export function isHardLintFailure(id: LintFailureId): boolean {
  return id !== "cloze-framing" && id !== "qa-answer-long" && id !== "card-long";
}

/** Split on whitespace after trimming; empty tokens (blank input) are dropped. */
function words(s: string): string[] {
  return s
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function reviewText(text: string): string {
  // Strip only tags our exporter adds, before decoding escaped literal source text.
  return inlineMarkdownToHtml(text).replace(/<\/?(?:b|i|code)>/g, "").replace(/<br>/g, " ")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function containsAnswer(visible: string, answer: string): boolean {
  // Unlike grounding normalization, leak matching must distinguish C/C++ and 5/-5.
  const tokens = (text: string) => text.normalize("NFC").toLowerCase()
    .match(/[\p{L}\p{N}\p{M}\p{S}_*/#%&-]+(?:[.'’][\p{L}\p{N}\p{M}\p{S}_*/#%&-]+)*/gu) ?? [];
  const cue = tokens(visible);
  const target = tokens(answer);
  return target.length > 0 && target.length <= cue.length
    && cue.some((_, i) => target.every((word, k) => cue[i + k] === word));
}

/** Cloze markers stripped down to their body content, i.e. what the reader sees. */
function clozeVisibleText(text: string): string {
  return text.replace(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g, "$1");
}

/** A front that starts this way invites a bare yes/no answer instead of recall. */
const QA_YES_NO_START = /^(is|are|was|were|does|do|did|can|will|should|has|have)\b/i;

export function lintCard(card: Card, highlight: Highlight, siblings: Card[]): LintResult {
  const failures: LintFailureId[] = [];
  const warnings: LintWarningId[] = [];

  if (card.kind === "cloze") {
    // cloze-not-grounded: every {{cN::body}} must appear in the highlight
    // after normalization. Reuses the existing check as-is.
    if (ungroundedClozes(card.text, highlight.text).length > 0) {
      failures.push("cloze-not-grounded");
    }

    const rendered = reviewText(card.text);
    const deletions: { n: number; body: string; hint: string; start: number; end: number }[] = [];
    for (const m of rendered.matchAll(/\{\{c(\d+)::([\s\S]*?)(?:::([^}]*))?\}\}/g)) {
      deletions.push({ n: Number(m[1]), body: m[2], hint: m[3] ?? "", start: m.index, end: m.index + m[0].length });
    }
    const distinctNumbers = [...new Set(deletions.map((d) => d.n))].sort((a, b) => a - b);

    // A review hides all spans with its number; hidden slots separate visible phrases.
    const leaks = distinctNumbers.some(n => {
      const segments: string[] = [];
      let visible = "", cursor = 0;
      for (const d of deletions) {
        visible += rendered.slice(cursor, d.start);
        if (d.n === n) {
          segments.push(visible, d.hint);
          visible = "";
        } else visible += d.body;
        cursor = d.end;
      }
      segments.push(visible + rendered.slice(cursor));
      return deletions.filter(d => d.n === n).some(d => segments.some(segment => containsAnswer(segment, d.body)));
    });
    if (leaks) failures.push("answer-in-question");

    // A cloze needs an answer to hide; the source determines how many.
    // One deletion is valid. There is no count ceiling or forced Q&A conversion.
    if (distinctNumbers.length === 0) {
      failures.push("cloze-count");
    }

    // cloze-numbering: distinct numbers are exactly 1..k, no gaps.
    let numberingOk = distinctNumbers.length > 0;
    for (let i = 0; i < distinctNumbers.length; i++) {
      if (distinctNumbers[i] !== i + 1) {
        numberingOk = false;
        break;
      }
    }
    if (!numberingOk) failures.push("cloze-numbering");

    // cloze-framing: each deletion body <=6 words; keywords alone cannot judge retrieval quality.
    let framingOk = true;
    for (const d of deletions) {
      if (words(d.body).length > 6) {
        framingOk = false;
        break;
      }
    }
    if (!framingOk) failures.push("cloze-framing");

    // qa-empty (cloze variant): text must contain at least one {{cN:: marker,
    // and every deletion must actually hide something. `{{c1::}}` renders as a
    // blank with no answer behind it, which is an empty card wearing cloze
    // syntax, not a card the reader can be graded on.
    if (deletions.length === 0 || deletions.some((d) => !d.body.trim())) failures.push("qa-empty");
  } else {
    // qa-empty (qa variant): front and back both non-empty after trim.
    if (card.front.trim().length === 0 || card.back.trim().length === 0) {
      failures.push("qa-empty");
    }
    // qa-answer-long: back <=12 words.
    if (words(card.back).length > 12) failures.push("qa-answer-long");
    // qa-yes-no: front must not start with a yes/no auxiliary.
    if (QA_YES_NO_START.test(card.front.trim())) failures.push("qa-yes-no");
    // answer-in-question: the normalized answer must not appear in the
    // normalized question as a whole run of words. A raw substring test
    // false-positives on short answers that merely spell a letter sequence
    // inside a longer word ("on" inside "contemplation").
    if (containsAnswer(reviewText(card.front), reviewText(card.back))) failures.push("answer-in-question");
  }

  // card-long: front + back + text combined <=60 words. Cloze text is
  // counted with markers stripped to their body content, i.e. what the
  // reader sees, not the {{cN::...}} markup.
  const visibleText = card.kind === "cloze" ? clozeVisibleText(card.text) : card.text;
  const totalWords = words(card.front).length + words(card.back).length + words(visibleText).length;
  if (totalWords > 60) failures.push("card-long");

  // duplicate-card: this card's normalized front (qa) or normalized text
  // (cloze) equals that of any sibling of the same kind. Checked against
  // `siblings` only, per the three-parameter signature — the pipeline
  // wiring stage (out of scope here) is responsible for passing any other
  // cards that should count as duplicates.
  const ownKey = normalizePlain(card.kind === "cloze" ? card.text : card.front);
  const isDuplicate = siblings.some((s) => {
    if (s.kind !== card.kind) return false;
    const sKey = normalizePlain(s.kind === "cloze" ? s.text : s.front);
    return sKey.length > 0 && sKey === ownKey;
  });
  if (isDuplicate) warnings.push("duplicate-card");

  // shared-answer: qa only. Normalized back equals the normalized back of
  // any sibling qa card (interference risk).
  if (card.kind === "qa") {
    const nBack = normalizePlain(card.back);
    const isShared = siblings.some((s) => s.kind === "qa" && nBack.length > 0 && normalizePlain(s.back) === nBack);
    if (isShared) warnings.push("shared-answer");
  }

  return { failures, warnings };
}

/**
 * Cross-interference: two cards from DIFFERENT highlights whose comparison
 * key collides (e.g. two qa cards both answering "six months"). Takes
 * `{ card, highlightId }` rather than `Highlight` so the signature stays free
 * of anything that could pull Obsidian in transitively. Same-highlight pairs
 * are excluded on purpose — that overlap is already the per-batch
 * duplicate-card / shared-answer check's job in lintCard, and double-badging
 * it here would be redundant.
 */
export function findCrossInterference(
  items: Array<{ card: Card; highlightId: string }>,
): Map<string, string[]> {
  const groups = new Map<string, Array<{ card: Card; highlightId: string }>>();
  for (const item of items) {
    const { card } = item;
    const key = normalizePlain(card.kind === "qa" ? card.back : card.text);
    if (key.length === 0) continue;
    const groupKey = card.kind + key;
    const group = groups.get(groupKey);
    if (group) {
      group.push(item);
    } else {
      groups.set(groupKey, [item]);
    }
  }

  const result = new Map<string, string[]>();
  for (const group of groups.values()) {
    for (const item of group) {
      const partners = group
        .filter((other) => other.highlightId !== item.highlightId)
        .map((other) => other.card.id);
      if (partners.length > 0) result.set(item.card.id, partners);
    }
  }
  return result;
}

/** Short human label per id, for the inbox badge. */
export const LINT_LABELS: Record<LintFailureId | LintWarningId, string> = {
  "cloze-not-grounded": "not grounded",
  "cloze-count": "missing cloze",
  "cloze-numbering": "cloze numbering",
  "cloze-framing": "cloze framing",
  "qa-empty": "empty",
  "qa-answer-long": "answer too long",
  "qa-yes-no": "yes/no question",
  "card-long": "card too long",
  "answer-in-question": "answer in question",
  "duplicate-card": "duplicate",
  "shared-answer": "shared answer",
  "cross-interference": "answer used elsewhere",
};

/**
 * What the model has to actually do about each failure, for the one-click fix.
 *
 * LINT_LABELS is written for a badge the reader glances at, so its wording is
 * a fragment: "not grounded", "cloze framing". Handed to a rewrite as an
 * instruction those say almost nothing — the model has to guess both what is
 * wrong and what would count as fixed. These say it outright, in the terms the
 * writer prompt already uses, so the rewrite is aimed rather than exploratory.
 */
export const LINT_FIX_INSTRUCTIONS: Record<LintFailureId | LintWarningId, string> = {
  "cloze-not-grounded": "a deletion hides text that is not in the highlight; re-word the sentence so every deletion is a span the highlight states verbatim",
  "cloze-count": "the card has no valid deletion; mark the supported answer span without imposing a deletion quota or splitting the sentence to meet a count",
  "cloze-numbering": "the deletion numbers skip or repeat out of order; number them c1, c2, c3 with no gaps",
  "cloze-framing": "the span exceeds the six words product policy; adjudicate whether it is one meaningful retrieval target before shortening, preserving essential names, negations, and conditions, causal relationships and short procedures; remove only incidental scaffolding, never required meaning",
  "qa-empty": "the card is missing its question, its answer, or its cloze text; write the missing side from the highlight",
  "qa-answer-long": "the answer exceeds the twelve-word product policy; adjudicate focus and required meaning rather than blindly shortening; retain meaningful causal relationships and short procedures, and narrow only genuinely independent retrieval targets",
  "qa-yes-no": "the question can be answered yes or no, which is guessable; ask what, which, how, why, when, or how many instead",
  "card-long": "the card is too long to read at a glance; cut it to the words that carry the retrieval",
  "answer-in-question": "the visible review text already contains the answer; remove the answer leak from the question, cloze framing, visible sibling spans, or hints while preserving a supported cue; do not combine independent targets under one number merely to hide the leak",
  "duplicate-card": "another card on this highlight tests the same fact; either test a genuinely different fact or a different direction",
  "shared-answer": "another card on this highlight has the same answer; add the cue that tells the two apart, or test a different fact",
  "cross-interference": "a card on another highlight has this answer; add a cue naming this subject so the two cannot be confused",
};

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::[^}]*)?\}\}/g;

/**
 * The editor's Cloze button: wrap the selected span with the next unused
 * deletion number. Whitespace at the edges of the selection stays outside
 * the marker, so "{{c2:: exhaustion}}" cannot happen; an empty selection
 * wraps nothing. `cursor` is where the caret lands, just after the marker.
 */
export function wrapCloze(text: string, start: number, end: number): { text: string; cursor: number } | null {
  if (end <= start) return null;
  let a = start;
  let b = end;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  if (b <= a) return null;
  let next = 1;
  for (const m of text.matchAll(CLOZE_RE)) next = Math.max(next, Number(m[1]) + 1);
  const marker = `{{c${next}::${text.slice(a, b)}}}`;
  return { text: text.slice(0, a) + marker + text.slice(b), cursor: a + marker.length };
}
