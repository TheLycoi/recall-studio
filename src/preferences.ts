import type { CardRevision, CardSnapshot } from "./model";

/**
 * What the reader keeps correcting, read back out of their own edits.
 *
 * Every `CardRevision` the store keeps (src/model.ts) is one card before and
 * after a rewrite or a hand edit. Seen one at a time an edit says nothing —
 * this answer happened to be long, that card happened to read better as a
 * cloze. Seen four times in a row the same correction is a house rule the
 * reader has been applying by hand, and the generator could have applied for
 * them. This module finds those repetitions and phrases each as a rule line
 * for the schema note's `## Learned` section.
 *
 * It writes nothing. `observe` returns observations; the UI proposes them and
 * the reader accepts or dismisses, which is why every `id` is stable across
 * runs: a proposal dismissed once must be recognisable the next time the same
 * evidence comes round, or the reader is asked the same question forever.
 *
 * Precision over recall, everywhere. A rule the reader did not mean costs
 * them a dismissal now and a wrong card later, while a rule we failed to
 * notice costs only the edit they were already making. So each pattern has a
 * threshold below which it says nothing, and — the part that matters more —
 * each pattern is silenced outright by evidence pointing the other way. A
 * reader who shortened four answers and lengthened two is not asking for
 * shorter answers; they are editing. Consistency, not volume, is the signal.
 *
 * Obsidian-free like `examples.ts` and for the same reason: `test/*.test.mjs`
 * bundles it standalone with esbuild (see the harness in
 * `test/prompt.test.mjs:10-16`). Its only import is a type from `./model`,
 * whose closures do not resolve `obsidian`.
 */

export type PatternId = "shorter-answers" | "prefer-kind" | "drop-opening" | "extra-field" | "instruction";

export interface Observation {
  /**
   * Stable across runs for the same pattern + parameter, e.g. "shorter-answers",
   * "prefer-kind:cloze", "drop-opening:what is the", "extra-field:empty",
   * "instruction:make the answer shorter". Used to dedupe against proposals
   * already made or dismissed.
   */
  id: string;
  pattern: PatternId;
  /** The exact rule line to add under `## Learned`: imperative, one sentence, ending in a period. */
  rule: string;
  /** One sentence for the chip and the proposal header, in the second person. */
  summary: string;
  /** Rendered edits that support it, newest first, at most 4: "qa | Q | A  →  qa | Q | A'" */
  evidence: string[];
  count: number;
}

export const THRESHOLDS: Record<PatternId, number> = {
  "shorter-answers": 4,
  "prefer-kind": 4,
  "drop-opening": 3,
  "extra-field": 4,
  instruction: 3,
};

/** At most this many rendered edits per observation: enough to recognise the pattern, few enough to read. */
const MAX_EVIDENCE = 4;

/** The reader must have typed at least this much for a rewrite instruction to be worth a standing rule. */
const MIN_INSTRUCTION_CHARS = 8;

/** Openings are compared on their first three words, so "what is the" and "what is the best" are one habit. */
const OPENING_WORDS = 3;

/** `qa | front | back` and `cloze | text`, the shape `examples.ts:29` renders cards in for the prompts. */
function renderSnapshot(s: CardSnapshot): string {
  return s.kind === "qa" ? `qa | ${s.front} | ${s.back}` : `cloze | ${s.text}`;
}

/** One edit as the proposal shows it: what the card said, then what the reader made it say. */
function renderEdit(r: CardRevision): string {
  return `${renderSnapshot(r.before)}  →  ${renderSnapshot(r.after)}`;
}

/**
 * Word count as the rule means it: visible words, split on whitespace.
 *
 * The rule this feeds — `Keep answers to at most N words.` — is read by a
 * person and applied by a model exactly as written, and both of them count
 * "words" the way anyone counts words: split on whitespace, nothing dropped.
 * A count that stemmed and dropped stopwords and short words, as
 * `significantTokens` (src/pageIndex.ts) does for scoring evidence,
 * would silently disagree with that reading. "in the cell membrane" is four
 * words to a reader and to a model; counted as significant tokens it is two
 * ("cell", "membrane"), so the rule would say "at most 2 words" and push the
 * writer to cut "in the" from an answer the reader was already keeping whole.
 */
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function changed(r: CardRevision): boolean {
  const a = r.before;
  const b = r.after;
  return a.kind !== b.kind || a.front !== b.front || a.back !== b.back || a.text !== b.text || a.extra !== b.extra;
}

const isQaToQa = (r: CardRevision): boolean => r.before.kind === "qa" && r.after.kind === "qa";

/** The first `OPENING_WORDS` words of a question, lowercased, or "" when it is shorter than that. */
function opening(front: string): string {
  const words = front.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < OPENING_WORDS) return "";
  return words.slice(0, OPENING_WORDS).join(" ");
}

/** lowercase, trimmed, whitespace collapsed, trailing punctuation stripped — so "Make it shorter!" and "make  it shorter" are one instruction. */
function normalizeInstruction(instruction: string): string {
  return instruction
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/, "")
    .trim();
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** Newest first. `CardRevision.at` is an ISO timestamp, a fixed-width UTC format, so a descending string compare is chronological; a revision missing the field sorts last rather than throwing. */
function byNewestFirst(a: CardRevision, b: CardRevision): number {
  const x = a.at ?? "";
  const y = b.at ?? "";
  return x < y ? 1 : x > y ? -1 : 0;
}

function evidenceFrom(revisions: CardRevision[]): string[] {
  return [...revisions].sort(byNewestFirst).slice(0, MAX_EVIDENCE).map(renderEdit);
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function observe(
  revisions: CardRevision[],
  opts?: { thresholds?: Partial<Record<PatternId, number>> },
): Observation[] {
  const thresholds: Record<PatternId, number> = { ...THRESHOLDS, ...(opts?.thresholds ?? {}) };
  // An edit that changed no field is a save, not a correction: it is evidence
  // for nothing, and counting it would let a reader reach a threshold by
  // pressing the button.
  const edits = (revisions ?? []).filter(changed);
  const out: Observation[] = [];

  out.push(...shorterAnswers(edits, thresholds["shorter-answers"]));
  out.push(...preferKind(edits, thresholds["prefer-kind"]));
  out.push(...dropOpening(edits, thresholds["drop-opening"]));
  out.push(...extraField(edits, thresholds["extra-field"]));
  out.push(...instructions(edits, thresholds["instruction"]));

  // Strongest evidence first; id breaks the tie so the order is the same on
  // every run over the same input, which the dedupe against dismissed
  // proposals depends on.
  return out.sort((a, b) => (b.count - a.count) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The reader trims answers.
 *
 * Only Q&A→Q&A revisions can say anything here: a conversion to cloze changes
 * what "the answer" even means. An answer emptied entirely is a deletion of
 * the field rather than a trim, so it is not counted — proposing a word cap
 * from a blank would set the cap at zero.
 *
 * The cap is the *largest* answer the reader kept, not the average or the
 * smallest. A rule tighter than that would contradict an edit they made with
 * their own hands, and the generator would start producing cards the reader
 * has to lengthen.
 */
function shorterAnswers(edits: CardRevision[], threshold: number): Observation[] {
  const shortened: CardRevision[] = [];
  let lengthened = 0;
  for (const r of edits) {
    if (!isQaToQa(r)) continue;
    const before = wordCount(r.before.back);
    const after = wordCount(r.after.back);
    if (r.after.back.trim() !== "" && after < before) shortened.push(r);
    else if (after > before) lengthened++;
  }
  if (shortened.length < threshold) return [];
  // Evidence both ways is not a preference. Half as many lengthenings as
  // shortenings is already a reader who is editing for sense, not for length,
  // and a word cap would fight them on every card.
  if (lengthened >= shortened.length / 2) return [];

  const cap = Math.max(...shortened.map((r) => wordCount(r.after.back)));
  return [
    {
      id: "shorter-answers",
      pattern: "shorter-answers",
      rule: `Keep answers to at most ${cap} words.`,
      summary: `You shortened ${shortened.length} ${plural(shortened.length, "answer", "answers")} to ${cap} words or fewer.`,
      evidence: evidenceFrom(shortened),
      count: shortened.length,
    },
  ];
}

/**
 * The reader converts cards from one kind to the other.
 *
 * A conversion in each direction is a reader choosing per card, which is what
 * a good card writer does anyway — so one conversion back cancels the whole
 * pattern rather than merely denting it. Only a clean run in one direction
 * says "always write these as cloze".
 */
function preferKind(edits: CardRevision[], threshold: number): Observation[] {
  const toCloze: CardRevision[] = [];
  const toQa: CardRevision[] = [];
  for (const r of edits) {
    if (r.before.kind === r.after.kind) continue;
    if (r.after.kind === "cloze") toCloze.push(r);
    else toQa.push(r);
  }

  const propose = (
    winners: CardRevision[],
    losers: CardRevision[],
    id: string,
    rule: string,
    what: string,
  ): Observation[] => {
    if (winners.length < threshold || losers.length > 0) return [];
    return [
      {
        id,
        pattern: "prefer-kind",
        rule,
        summary: `You turned ${winners.length} ${plural(winners.length, "card", "cards")} into ${what}.`,
        evidence: evidenceFrom(winners),
        count: winners.length,
      },
    ];
  };

  return [
    ...propose(toCloze, toQa, "prefer-kind:cloze", "Prefer cloze deletions to question-and-answer cards.", "cloze deletions"),
    ...propose(toQa, toCloze, "prefer-kind:qa", "Prefer question-and-answer cards to cloze deletions.", "question-and-answer cards"),
  ];
}

/**
 * The reader keeps striking the same question opening.
 *
 * Grouped by the first three lowercased words, so "What is the treaty…" and
 * "WHAT IS THE city…" are one habit. An opening counts as dropped when the
 * question no longer starts with those three words.
 *
 * One kept opening anywhere in the record vetoes the rule, even against many
 * drops. "Do not open a question with X" is an absolute instruction to the
 * generator; a reader who left X standing once does not want it banned, they
 * want it used well, and that is not a rule this module can write.
 */
function dropOpening(edits: CardRevision[], threshold: number): Observation[] {
  const dropped = new Map<string, CardRevision[]>();
  const kept = new Set<string>();

  for (const r of edits) {
    if (!isQaToQa(r)) continue;
    const before = opening(r.before.front);
    const after = opening(r.after.front);
    if (before === "") continue;
    if (before === after) kept.add(before);
    else {
      const list = dropped.get(before);
      if (list) list.push(r);
      else dropped.set(before, [r]);
    }
  }
  // An opening the reader introduced or preserved in any edit's result is one
  // they are willing to write, whatever they did elsewhere.
  for (const r of edits) {
    if (r.after.kind !== "qa") continue;
    const after = opening(r.after.front);
    if (after !== "") kept.add(after);
  }

  const out: Observation[] = [];
  for (const [open, list] of dropped) {
    if (list.length < threshold || kept.has(open)) continue;
    out.push({
      id: `drop-opening:${open}`,
      pattern: "drop-opening",
      rule: `Do not open a question with "${open}".`,
      summary: `You rewrote ${list.length} ${plural(list.length, "question", "questions")} that opened with "${open}".`,
      evidence: evidenceFrom(list),
      count: list.length,
    });
  }
  return out;
}

/**
 * The reader always clears the extra field, or always fills it.
 *
 * As with the card kind, mixed evidence means the reader is deciding per
 * card, so a single edit the other way silences both directions.
 */
function extraField(edits: CardRevision[], threshold: number): Observation[] {
  const cleared: CardRevision[] = [];
  const filled: CardRevision[] = [];
  for (const r of edits) {
    const before = r.before.extra.trim();
    const after = r.after.extra.trim();
    if (before !== "" && after === "") cleared.push(r);
    else if (before === "" && after !== "") filled.push(r);
  }

  const propose = (
    winners: CardRevision[],
    losers: CardRevision[],
    id: string,
    rule: string,
    summary: (n: number) => string,
  ): Observation[] => {
    if (winners.length < threshold || losers.length > 0) return [];
    return [
      {
        id,
        pattern: "extra-field",
        rule,
        summary: summary(winners.length),
        evidence: evidenceFrom(winners),
        count: winners.length,
      },
    ];
  };

  return [
    ...propose(cleared, filled, "extra-field:empty", "Leave the extra field empty.", (n) => `You cleared the extra field on ${n} ${plural(n, "card", "cards")}.`),
    ...propose(
      filled,
      cleared,
      "extra-field:filled",
      "Put a supporting sentence from the highlight in the extra field.",
      (n) => `You filled in the extra field on ${n} ${plural(n, "card", "cards")}.`,
    ),
  ];
}

/**
 * The reader asks for the same rewrite over and over.
 *
 * This is the one pattern where the reader has already said in words what
 * they want, so the rule is their own sentence rather than one inferred from
 * a diff — and the threshold is lower for that reason. Only `via: "rewrite"`
 * counts: a hand edit's `instruction` field is not a request the reader typed
 * about this card.
 *
 * Instructions under `MIN_INSTRUCTION_CHARS` are dropped, not because they
 * are careless but because a fragment ("fix", "no") makes a rule that the
 * generator cannot act on and that reads as noise in the schema note.
 */
function instructions(edits: CardRevision[], threshold: number): Observation[] {
  const groups = new Map<string, CardRevision[]>();
  for (const r of edits) {
    if (r.via !== "rewrite") continue;
    const normalized = normalizeInstruction(r.instruction ?? "");
    if (normalized.length < MIN_INSTRUCTION_CHARS) continue;
    const list = groups.get(normalized);
    if (list) list.push(r);
    else groups.set(normalized, [r]);
  }

  const out: Observation[] = [];
  for (const [normalized, list] of groups) {
    if (list.length < threshold) continue;
    out.push({
      id: `instruction:${normalized}`,
      pattern: "instruction",
      rule: `${capitalize(normalized)}.`,
      summary: `You asked ${list.length} ${plural(list.length, "time", "times")} to ${normalized}.`,
      evidence: evidenceFrom(list),
      count: list.length,
    });
  }
  return out;
}
