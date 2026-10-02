/**
 * The quiz as free recall: every rule about a quiz that is not a rendering or
 * a model call.
 *
 * A question is a free-recall trial on one section of a note. The reader is
 * given a cue that names the section's subject and none of its points, writes
 * everything they remember in any order, and the grade marks each point of
 * the section recalled, partial, missed or wrong. Points still missing get a
 * cue each and one more attempt, then the whole section is shown. Design:
 * free-recall quiz design note.
 *
 * Why a section and not a passage. The free-recall literature:
 * study a set of items, then produce them with no cue beyond the instruction
 * to recall, the most demanding form of retrieval practice. Its pages on the
 * danger of flashcards and on understanding before memorising say the other
 * half: facts held one by one stay thin and disconnected. A section is the
 * unit a reader understands as one idea, so recalling it whole tests the
 * connections as well as the facts. The flashcard rules (one detail, no sets)
 * belong to the cards written from the misses, not to this test.
 *
 * Principles taken from amosblomqvist/learn (read for its design; no code or
 * prose of it is used here): sections are asked in
 * note order so the definitions and lead lines, the unconditional truths the
 * rest builds on, come first; and what the reader could not produce is the
 * edge of what they know, found here by the points missed within a section.
 *
 * Pure like src/quiz.ts: sessions are immutable and every check is counting,
 * so test/recall.test.mjs bundles it with no Obsidian runtime.
 */
import { normalizePlain } from "./util";
import { significantTokens, type EvidenceUnit } from "./retrieval";
import { feedbackGrounded, quizzable, resolvePool, wordCoverage, type QuizMiss, type QuizScope } from "./quiz";
import type { CueShape, QuizCueDraft, QuizRecallGradeDraft } from "./schemas";
import type { QuizSectionIn } from "./prompt";

// ---- items -------------------------------------------------------------------

/** One section of one note, or one run of a long section: what one question asks the reader to recall. */
export interface RecallItem {
  id: string;
  notePath: string;
  noteTitle: string;
  /** The heading path, "" for the note's lead. */
  section: string;
  /** 1-based run number, and how many runs the section was split into. */
  part: number;
  parts: number;
  points: EvidenceUnit[];
}

/**
 * A line that is nothing but a quotation: the example utterance under a step
 * ("What does 'eating better' look like to you?"). It illustrates the point
 * above it and is not a point of its own; asking the reader to produce it
 * from memory would test the wording of an example, not the section.
 */
const QUOTED_LINE = /^(?:"[^"]*"|“[^”]*”|'[^']*'|‘[^’]*’)[.!?]?$/;

/** Above this many points a section is split: nobody recalls twenty things in one go. */
const SPLIT_ABOVE = 9;
/** The longest run a split produces, the span of one recall (the wiki's chunking page). */
const RUN_MAX = 7;

/**
 * Group a pool into items: consecutive passages of one note under one heading
 * path, in the pool's order. A section longer than nine points is split into
 * balanced runs of at most seven. Passages that are labels rather than
 * statements (`quizzable`) never become points.
 */
export function buildItems(pool: EvidenceUnit[]): RecallItem[] {
  const groups: Array<{ notePath: string; noteTitle: string; section: string; points: EvidenceUnit[] }> = [];
  for (const u of pool) {
    if (!quizzable(u) || QUOTED_LINE.test(u.text.trim())) continue;
    const section = u.section ?? "";
    const last = groups[groups.length - 1];
    if (last && last.notePath === u.notePath && last.section === section) last.points.push(u);
    else groups.push({ notePath: u.notePath, noteTitle: u.noteTitle, section, points: [u] });
  }
  const items: RecallItem[] = [];
  for (const g of groups) {
    const parts = g.points.length > SPLIT_ABOVE ? Math.ceil(g.points.length / RUN_MAX) : 1;
    const size = Math.ceil(g.points.length / parts);
    for (let k = 0; k < parts; k++) {
      items.push({
        id: `${g.notePath}#${g.section}#${k + 1}`,
        notePath: g.notePath,
        noteTitle: g.noteTitle,
        section: g.section,
        part: k + 1,
        parts,
        points: g.points.slice(k * size, (k + 1) * size),
      });
    }
  }
  return items;
}

/**
 * The items a quiz will ask, and the phrase that names them.
 *
 * The passages come from `resolvePool` uncapped, so a query still ranks whole
 * notes, and the cap is applied to sections: a note scope is always the whole
 * note, a query takes the first `maxSections` in rank order, and the whole
 * vault is sampled evenly so every note is represented.
 */
export function resolveRecallPool(
  scope: "all" | "this" | "query",
  query: string,
  units: EvidenceUnit[],
  activePath: string | null,
  scorer: (text: string) => number | null,
  maxSections: number,
): { items: RecallItem[]; label: string } {
  const { pool, label } = resolvePool(scope, query, units, activePath, scorer, Number.MAX_SAFE_INTEGER);
  const items = buildItems(pool);
  if (scope === "this" || maxSections <= 0 || items.length <= maxSections) return { items, label };
  if (scope === "query") return { items: items.slice(0, maxSections), label };
  const step = items.length / maxSections;
  const sampled: RecallItem[] = [];
  for (let i = 0; i < maxSections; i++) sampled.push(items[Math.floor(i * step)]);
  return { items: sampled, label };
}

/** The section as the cue and grade messages carry it (src/prompt.ts). */
export function sectionIn(item: RecallItem): QuizSectionIn {
  return { noteTitle: item.noteTitle, section: item.section, part: item.part, parts: item.parts, points: item.points.map((p) => p.text) };
}

/** The section's own name: its last heading, or the note's title for the lead. */
export function itemName(item: RecallItem): string {
  const parts = item.section.split(" › ").filter(Boolean);
  const name = parts[parts.length - 1] ?? item.noteTitle;
  return item.parts > 1 ? `${name} (part ${item.part} of ${item.parts})` : name;
}

// ---- session -----------------------------------------------------------------

export interface RecallQuestion {
  n: number;
  itemId: string;
  cue: string;
  shape: CueShape;
  /** The cue was written by code from the heading path because the model's failed the checks. */
  fallback: boolean;
}

export type PointStatus = "recalled" | "cued" | "partial" | "missed" | "wrong";

export interface PointMark {
  unitId: string;
  status: PointStatus;
  /** The reader's words for the point, as the grader copied them. */
  said: string;
  /** `said` was found in the reader's answer. A point with no words to find is verified trivially; an unverified point is always missed. */
  verified: boolean;
  /** The missing part or the wrong belief. */
  note: string;
  /** Where the point sits, without stating it; "" when there is none to give. */
  cue: string;
  /** Marked missed although the answer carries most of the point's words: worth a second look. */
  dispute: boolean;
}

export interface RecallResult {
  question: RecallQuestion;
  itemId: string;
  answers: string[];
  marks: PointMark[];
  feedback: string;
  feedbackGrounded: boolean;
  /** Declined outright: no attempt was graded. */
  skipped: boolean;
}

export interface RecallSession {
  scope: QuizScope;
  /** The words after "quiz me on", kept so "Quiz again" repeats the same quiz. */
  query: string;
  items: RecallItem[];
  /** A ceiling on sections per sitting; the quiz is meant to end by covering them. */
  cap: number;
  results: RecallResult[];
  current: RecallQuestion | null;
  /** 1 for the free attempt, 2 for the cued one. */
  attempt: 1 | 2;
  /** The first attempt's answer and marks, held while the cued attempt runs. */
  first: { answer: string; marks: PointMark[]; feedback: string } | null;
  finished: boolean;
}

export function startRecall(scope: QuizScope, query: string, items: RecallItem[], cap: number): RecallSession {
  return { scope, query, items, cap, results: [], current: null, attempt: 1, first: null, finished: items.length === 0 };
}

/** The next section to ask, in note order; null when every one has been asked. */
export function nextItem(session: RecallSession): RecallItem | null {
  const asked = new Set(session.results.map((r) => r.itemId));
  return session.items.find((i) => !asked.has(i.id)) ?? null;
}

export function itemById(session: RecallSession, id: string): RecallItem | undefined {
  return session.items.find((i) => i.id === id);
}

// ---- cue ---------------------------------------------------------------------

/** "Is it…", "Does it…": a cue a coin toss answers (the wiki's binary-prompts page). */
const BINARY_CUE = /^(?:is|are|does|do|did|can|could|should|was|were|will|would|has|have|had)\b/i;

/**
 * Whether `text` gives `point` away: the point itself, or at least half of its
 * meaning-carrying words when it has two or more, or four of them outright.
 * The subject's own name is shared by cue and points alike, which is why one
 * or two shared words are not a leak.
 */
function statesPoint(text: string, point: string): boolean {
  if (!text.trim()) return false;
  if (normalizePlain(text).includes(normalizePlain(point))) return true;
  const cov = wordCoverage(point, text);
  return (cov.total >= 2 && cov.fraction >= 0.5) || cov.count >= 4;
}

export type CueCheck = { ok: true; cue: string; shape: CueShape } | { ok: false; reason: string };

/**
 * The code tier of the cue: not empty, not yes/no, and stating none of the
 * points. A free-recall cue may ask for a set; that is what recall of a
 * section is. What the cue asks must be in the section, and that is the
 * model's rule, not a count this function can make.
 */
export function checkCue(draft: QuizCueDraft, item: RecallItem): CueCheck {
  const cue = draft.cue.trim();
  if (!cue) return { ok: false, reason: "empty cue" };
  if (BINARY_CUE.test(cue)) return { ok: false, reason: "a yes/no cue; ask the reader to produce the section" };
  const leaked = item.points.findIndex((p) => statesPoint(cue, p.text));
  if (leaked >= 0) return { ok: false, reason: `the cue states point ${leaked + 1}; name the subject, not what it holds` };
  return { ok: true, cue, shape: draft.shape };
}

/** The cue when the model's two drafts failed: the heading path and the instruction to recall, which is free recall in its plainest form. */
export function fallbackCue(item: RecallItem): string {
  const parts = item.section.split(" › ").filter(Boolean);
  const name = parts[parts.length - 1] ?? item.noteTitle;
  const parent = parts.length > 1 ? ` (${parts[parts.length - 2]})` : "";
  const part = item.parts > 1 ? `, part ${item.part} of ${item.parts}` : "";
  return `${name}${parent}${part}: write down everything you remember.`;
}

export function acceptCue(session: RecallSession, item: RecallItem, cue: string, shape: CueShape, fallback: boolean): RecallSession {
  return {
    ...session,
    current: { n: session.results.length + 1, itemId: item.id, cue, shape, fallback },
    attempt: 1,
    first: null,
  };
}

// ---- grade -------------------------------------------------------------------

/**
 * The code tier of a grade: one mark per point, whatever the model returned.
 *
 * A point the grader left out is missed. A point marked as produced must come
 * with the reader's own words for it, and those words must be in the answer;
 * when they are not, the point counts as missed (keeping its cue) and says
 * unverified, so only marks code could check are counted. An unverified
 * "wrong" is missed too, so it never becomes a misconception card. A cue that
 * states its point is dropped, and a point marked missed while the answer
 * holds most of its words is flagged.
 */
export function checkRecallGrade(
  draft: QuizRecallGradeDraft,
  points: EvidenceUnit[],
  answer: string,
): { marks: PointMark[]; feedback: string; feedbackGrounded: boolean } {
  const plainAnswer = normalizePlain(answer);
  const marks = points.map((p, i): PointMark => {
    const d = draft.points.find((e) => e.n === i + 1);
    const claimed: PointStatus = d ? d.status : "missed";
    const said = d && claimed !== "missed" ? d.said.trim() : "";
    const verified =
      claimed === "missed" || (!!said && significantTokens(said).length > 0 && plainAnswer.includes(normalizePlain(said)));
    const status: PointStatus = verified ? claimed : "missed";
    const cue = d && (status === "missed" || status === "partial") && !statesPoint(d.cue, p.text) ? d.cue.trim() : "";
    const cov = wordCoverage(p.text, answer);
    return {
      unitId: p.id,
      status,
      said,
      verified,
      note: d && (status === "partial" || status === "wrong") ? d.note.trim() : "",
      cue,
      dispute: status === "missed" && cov.total >= 2 && cov.fraction >= 0.8,
    };
  });
  const feedback = draft.feedback.trim();
  return { marks, feedback, feedbackGrounded: feedbackGrounded(feedback, points.map((p) => p.text).join(" "), answer) };
}

/** A point the cued attempt can still win: absent, or only half there. */
function open(m: PointMark): boolean {
  return m.status === "missed" || m.status === "partial";
}

/** The current section's points still open after the free attempt, in order. */
export function openPoints(session: RecallSession): EvidenceUnit[] {
  const item = session.current ? itemById(session, session.current.itemId) : undefined;
  const first = session.first;
  if (!item || !first) return [];
  const byId = new Map(item.points.map((p) => [p.id, p]));
  return first.marks.filter(open).map((m) => byId.get(m.unitId)).filter((p): p is EvidenceUnit => !!p);
}

function close(session: RecallSession, answers: string[], marks: PointMark[], feedback: string, grounded: boolean, skipped: boolean): RecallSession {
  const current = session.current;
  if (!current) return session;
  const results = [...session.results, { question: current, itemId: current.itemId, answers, marks, feedback, feedbackGrounded: grounded, skipped }];
  const asked = new Set(results.map((r) => r.itemId));
  return {
    ...session,
    results,
    current: null,
    attempt: 1,
    first: null,
    finished: results.length >= session.cap || session.items.every((i) => asked.has(i.id)),
  };
}

/**
 * After the free attempt: when points are open and at least one has a cue, the
 * reader gets the cued attempt before anything is shown; otherwise the
 * section is closed and revealed. Free recall first, cued recall second, then
 * the answer: the order that keeps the effort before the reveal.
 */
export function afterFirstAttempt(session: RecallSession, answer: string, marks: PointMark[], feedback: string, grounded = true): RecallSession {
  if (!session.current) return session;
  if (marks.some((m) => open(m) && m.cue)) {
    return { ...session, attempt: 2, first: { answer, marks, feedback } };
  }
  return close(session, [answer], marks, feedback, grounded, false);
}

/**
 * After the cued attempt: `marks` cover `openPoints` in order. A point
 * produced now counts as cued, not recalled; one still missing or half there
 * keeps its first mark unless the second attempt says it is wrong.
 */
export function afterCuedAttempt(session: RecallSession, answer: string, marks: PointMark[], feedback: string, grounded = true): RecallSession {
  const first = session.first;
  if (!session.current || !first) return session;
  const second = new Map(marks.map((m) => [m.unitId, m]));
  const merged = first.marks.map((m): PointMark => {
    const s = second.get(m.unitId);
    if (!open(m) || !s) return m;
    if (s.status === "recalled") return { ...s, status: "cued", cue: m.cue };
    if (s.status === "wrong") return { ...s, cue: m.cue };
    if (s.status === "partial") return { ...s, status: "partial", note: s.note || m.note, cue: m.cue };
    return m;
  });
  return close(session, [first.answer, answer], merged, [first.feedback, feedback].filter(Boolean).join(" "), grounded, false);
}

/** `/skip`, `/idk` or a blank: every point still open is missed, and the section is shown. */
export function skipRecall(session: RecallSession, answer: string): RecallSession {
  const current = session.current;
  const item = current ? itemById(session, current.itemId) : undefined;
  if (!current || !item) return session;
  const missed = (id: string): PointMark => ({ unitId: id, status: "missed", said: "", verified: true, note: "", cue: "", dispute: false });
  const first = session.first;
  if (first) {
    const marks = first.marks.map((m) => (open(m) ? { ...m, status: "missed" as const, cue: m.cue } : m));
    return close(session, [first.answer, answer].filter((a) => a.trim()), marks, first.feedback, true, false);
  }
  return close(session, answer.trim() ? [answer] : [], item.points.map((p) => missed(p.id)), "", true, true);
}

// ---- rendering ---------------------------------------------------------------

/** The question as the reader sees it: which section, what shape, how many points, then the cue. */
export function renderCueMarkdown(q: RecallQuestion, item: RecallItem): string {
  const count = `${item.points.length} point${item.points.length === 1 ? "" : "s"}`;
  return `**Question ${q.n} · ${itemName(item)}** *(${q.shape} · ${count})*\n\n${q.cue}`;
}

/** Between the attempts: the count so far and a cue per open point, the points themselves still hidden. */
export function renderCuedMarkdown(session: RecallSession): string {
  const first = session.first;
  if (!first) return "";
  const recalled = first.marks.filter((m) => m.status === "recalled").length;
  const cues = first.marks.filter(open).map((m) => `- ${m.cue || "one more point"}`);
  return [
    `You recalled ${recalled} of ${first.marks.length}. Cues for the other ${cues.length}:`,
    cues.join("\n"),
    "Write what these bring back, or say skip.",
  ].join("\n\n");
}

const MARK: Record<PointStatus, string> = { recalled: "✓", cued: "◐", partial: "△", missed: "✗", wrong: "⚠" };

/** A result's counts, for the reveal's first line, the summary and the panel's colour. */
export function resultCounts(result: RecallResult): { recalled: number; cued: number; wrong: number; total: number } {
  const count = (s: PointStatus) => result.marks.filter((m) => m.status === s).length;
  return { recalled: count("recalled"), cued: count("cued"), wrong: count("wrong"), total: result.marks.length };
}

/** The verdict the panel colours a reveal by: all recalled, some, none, or declined. */
export function resultVerdict(result: RecallResult): "correct" | "partial" | "incorrect" | "skipped" {
  if (result.skipped) return "skipped";
  const c = resultCounts(result);
  if (c.recalled === c.total) return "correct";
  return c.recalled + c.cued > 0 ? "partial" : "incorrect";
}

function sectionLink(item: RecallItem): string {
  const linkPath = item.notePath.replace(/\.md$/i, "");
  const parts = item.section.split(" › ").filter(Boolean);
  const heading = parts[parts.length - 1];
  return heading ? `[[${linkPath}#${heading}|${item.noteTitle} › ${heading}]]` : `[[${linkPath}|${item.noteTitle}]]`;
}

/**
 * The reveal: the count, the grader's sentence, then every point of the
 * section with its mark, and a link to the section. Every point is shown,
 * right or wrong, so the reader sees the whole section they were asked to
 * produce and can overrule a mark.
 */
export function renderRevealMarkdown(result: RecallResult, item: RecallItem): string {
  const c = resultCounts(result);
  const head = [`Recalled ${c.recalled} of ${c.total}`];
  if (c.cued) head.push(`${c.cued} under cue`);
  if (c.wrong) head.push(`${c.wrong} wrong`);
  const parts = [head.join(" · ")];
  if (result.feedback) parts.push(result.feedback);
  const byId = new Map(item.points.map((p) => [p.id, p]));
  const lines = result.marks.map((m) => {
    const text = byId.get(m.unitId)?.text ?? "";
    const note = m.note ? ` — ${m.note}` : "";
    const flag = !m.verified ? " *(unverified)*" : m.dispute ? " *(your answer may have this)*" : "";
    return `- ${MARK[m.status]} ${text}${note}${flag}`;
  });
  parts.push(lines.join("\n"));
  parts.push(sectionLink(item));
  return parts.join("\n\n");
}

// ---- summary and misses ------------------------------------------------------

export function recallSummary(session: RecallSession): {
  line: string;
  weak: Array<{ item: RecallItem; recalled: number; total: number }>;
} {
  let recalled = 0;
  let cued = 0;
  let wrong = 0;
  let total = 0;
  const weak: Array<{ item: RecallItem; recalled: number; total: number }> = [];
  for (const r of session.results) {
    const c = resultCounts(r);
    recalled += c.recalled;
    cued += c.cued;
    wrong += c.wrong;
    total += c.total;
    const item = itemById(session, r.itemId);
    if (item && c.recalled < c.total) weak.push({ item, recalled: c.recalled, total: c.total });
  }
  weak.sort((a, b) => a.recalled / a.total - b.recalled / b.total);
  const sections = session.results.length;
  const left = session.items.length - sections;
  const parts = [`Recalled ${recalled} of ${total} points across ${sections} section${sections === 1 ? "" : "s"}`];
  if (cued) parts.push(`${cued} under cue`);
  if (wrong) parts.push(`${wrong} wrong`);
  const ending =
    left === 0
      ? " — every section asked"
      : sections >= session.cap
        ? ` — stopped at the section cap with ${left} section${left === 1 ? "" : "s"} not asked`
        : "";
  return { line: parts.join(" · ") + ending, weak };
}

export function renderRecallSummaryMarkdown(session: RecallSession): string {
  const { line, weak } = recallSummary(session);
  if (weak.length === 0) return `${line}\n\nNothing missed.`;
  const items = weak.map((w) => `- ${itemName(w.item)} — ${w.recalled} of ${w.total} — ${sectionLink(w.item)}`);
  return `${line}\n\n**Weakest sections:**\n${items.join("\n")}`;
}

/**
 * Every point the reader did not produce freely, as the inbox receives it: a
 * point missed, half there, produced only under its cue, or contradicted. The
 * cue travels as the question so the card writer knows what was being asked,
 * and the point itself is the card's title.
 */
export function recallMisses(session: RecallSession): QuizMiss[] {
  const out: QuizMiss[] = [];
  for (const r of session.results) {
    const item = itemById(session, r.itemId);
    if (!item) continue;
    const byId = new Map(item.points.map((p) => [p.id, p]));
    for (const m of r.marks) {
      const unit = byId.get(m.unitId);
      if (!unit || m.status === "recalled") continue;
      out.push({
        unit,
        question: r.question.cue,
        answer: unit.text,
        title: unit.text,
        verdict: m.status === "missed" ? "skipped" : m.status === "wrong" ? "incorrect" : "partial",
        gap: m.status === "wrong" ? "misconception" : "detail",
        gapNote: m.note || (m.status === "cued" ? "recalled it only when cued" : m.status === "missed" ? "could not recall it at all" : ""),
        shape: r.question.shape,
      });
    }
  }
  return out;
}
