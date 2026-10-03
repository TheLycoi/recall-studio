/**
 * The quiz as free-response questions: every rule about a quiz that is not a
 * rendering or a model call.
 *
 * A question asks about the main idea of one section of a note and is
 * answered from memory in a few sentences. The writer names the points of the
 * section a full answer must contain (`expects`), and the grade marks each of
 * those recalled, partial, missed or wrong. Points still missing get a hint
 * each and one more attempt, then the answer is shown.
 *
 * Why a question and not "write down everything you remember": the reader
 * asked for it on 2026-10-03. A bare instruction to recall a section tests
 * volume, and on a section that is one paragraph it tests nothing a person
 * can do. A question about the section's idea, answered in a few sentences,
 * is still free recall, since nothing on the page states the answer, and it
 * says what is being asked.
 *
 * Ideas taken from amosblomqvist/learn (read for its design; no code or
 * prose of it is used here): a question has a definite answer and is graded
 * at once with the reason; the ground is asked first, definitions and rules
 * that hold without exception; and the difficulty follows the reader, up
 * after a full answer and down after a miss, so the quiz finds the edge of
 * what they understand (`nextLevel`). Its questions are multiple choice;
 * these never are.
 *
 * Pure like src/quiz.ts: sessions are immutable and every check is counting,
 * so test/recall.test.mjs bundles it with no Obsidian runtime.
 */
import { normalizePlain } from "./util";
import { significantTokens, type EvidenceUnit } from "./retrieval";
import { splitSentences } from "./answerClaims";
import { feedbackGrounded, quizzable, resolvePool, wordCoverage, type QuizMiss, type QuizScope } from "./quiz";
import type { CueShape, QuizQuestionDraft, QuizRecallGradeDraft } from "./schemas";
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

/**
 * A passage longer than this that holds several sentences is several points.
 * A page's opening is often one paragraph of three ideas; as one point it
 * could only be marked whole, so an answer that gave exactly what the
 * question asked was partial for leaving out the rest.
 */
const LONG_POINT_CHARS = 240;

/** A long passage as its sentences, each a point of its own; anything else as it is. */
function pointsOf(u: EvidenceUnit): EvidenceUnit[] {
  if (u.text.length <= LONG_POINT_CHARS) return [u];
  const sentences = splitSentences(u.text)
    .map((t) => t.trim())
    .filter((t) => quizzable({ ...u, text: t }) && !QUOTED_LINE.test(t));
  if (sentences.length < 2) return [u];
  return sentences.map((text, i) => ({ ...u, id: `${u.id}#s${i + 1}`, text }));
}

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
    const points = pointsOf(u);
    if (last && last.notePath === u.notePath && last.section === section) last.points.push(...points);
    else groups.push({ notePath: u.notePath, noteTitle: u.noteTitle, section, points });
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

/** How much a question asks for: 1 state it, 2 explain why or how, 3 connect it to another idea. */
export type QuizLevel = 1 | 2 | 3;

export interface RecallQuestion {
  n: number;
  itemId: string;
  /** The question as the reader sees it. */
  cue: string;
  shape: CueShape;
  /** Ids of the section's points a full answer must contain: the answer key the grade marks against. */
  expects: string[];
  level: QuizLevel;
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

export type QuestionCheck = { ok: true; cue: string; shape: CueShape; expects: string[] } | { ok: false; reason: string };

/** A full answer is a few sentences, so it carries a few points, not a section's worth. */
const EXPECTS_MAX = 4;

/** "Write down everything you remember": a dump, which is what this quiz replaced. */
const DUMP = /\beverything\s+(?:you\s+)?(?:can\s+)?(?:remember|recall|know)\b|\ball\s+you\s+(?:remember|know)\b/i;

/**
 * Whether a question gives an expected point away. A question has to name
 * its subject, and on a long point it shares many of the subject's words
 * without stating the point, so only the point itself, or half of its
 * meaning-carrying words, counts. (`statesPoint`, with its four-word rule,
 * stays the test for a hint, which points at one short thing.)
 */
function givesAway(question: string, point: string): boolean {
  if (!question.trim()) return false;
  if (normalizePlain(question).includes(normalizePlain(point))) return true;
  const cov = wordCoverage(point, question);
  return cov.total >= 2 && cov.fraction >= 0.5;
}

/**
 * The code tier of a question: not empty, not yes/no, not a prompt to write
 * everything down, expecting between one and four points the section has,
 * and stating none of them. What the question asks must be in those points,
 * and that is the model's rule, not a count this function can make.
 */
export function checkQuestion(draft: QuizQuestionDraft, item: RecallItem): QuestionCheck {
  const cue = (draft.question ?? "").trim();
  if (!cue) return { ok: false, reason: "empty question" };
  if (BINARY_CUE.test(cue)) return { ok: false, reason: "a yes/no question; ask one the reader answers in a few sentences" };
  if (DUMP.test(cue)) return { ok: false, reason: "it asks for everything the reader remembers; ask one question about the section's main idea" };
  const expects: string[] = [];
  const numbers: number[] = [];
  for (const n of draft.expects ?? []) {
    const point = Number.isInteger(n) ? item.points[n - 1] : undefined;
    if (!point || expects.includes(point.id) || expects.length >= EXPECTS_MAX) continue;
    expects.push(point.id);
    numbers.push(n);
  }
  if (expects.length === 0) return { ok: false, reason: "expects names no point of the section; list the numbers of the points a full answer contains" };
  const leaked = numbers.find((n) => givesAway(cue, item.points[n - 1].text));
  if (leaked !== undefined) return { ok: false, reason: `the question states point ${leaked}; ask for it, do not say it` };
  return { ok: true, cue, shape: draft.shape, expects };
}

/** Headings that name a page's part, not its subject: the question names the note instead. */
const GENERIC_SECTION = /^(?:definition|description|summary|overview|introduction|key claims?)$/i;

/** The question when the model's two drafts failed: the section's name and a plain request to explain it. */
export function fallbackQuestion(item: RecallItem): string {
  const parts = item.section.split(" › ").filter(Boolean);
  const last = parts[parts.length - 1];
  const generic = !!last && GENERIC_SECTION.test(last);
  const name = !last || generic ? item.noteTitle : last;
  const parent = !generic && parts.length > 1 ? ` (${parts[parts.length - 2]})` : "";
  const part = item.parts > 1 ? `, part ${item.part} of ${item.parts}` : "";
  return `${name}${parent}${part}: explain it in a few sentences.`;
}

/** What the fallback question is marked against: the section's first points, as many as one answer holds. */
export function fallbackExpects(item: RecallItem): string[] {
  return item.points.slice(0, EXPECTS_MAX).map((p) => p.id);
}

/**
 * The level of the next question, from how the last one went: up after a full
 * answer, down after one that held nothing or was declined, the same after a
 * partial one. The first question states the ground.
 */
export function nextLevel(session: RecallSession): QuizLevel {
  const last = session.results[session.results.length - 1];
  if (!last) return 1;
  const level = last.question.level ?? 1;
  const verdict = resultVerdict(last);
  if (verdict === "correct") return Math.min(3, level + 1) as QuizLevel;
  if (verdict === "incorrect" || verdict === "skipped") return Math.max(1, level - 1) as QuizLevel;
  return level;
}

/**
 * Put a question to the reader. `expects` defaults to every point of the
 * section, which is how a question with no answer key of its own is marked.
 */
export function acceptQuestion(
  session: RecallSession,
  item: RecallItem,
  cue: string,
  shape: CueShape,
  fallback: boolean,
  expects: string[] = item.points.map((p) => p.id),
  level: QuizLevel = 1,
): RecallSession {
  return {
    ...session,
    current: { n: session.results.length + 1, itemId: item.id, cue, shape, fallback, expects, level },
    attempt: 1,
    first: null,
  };
}

/** The points the current question is marked against, in the section's order. */
export function questionPoints(session: RecallSession): EvidenceUnit[] {
  const current = session.current;
  const item = current ? itemById(session, current.itemId) : undefined;
  if (!current || !item) return [];
  const want = new Set(current.expects);
  const points = item.points.filter((p) => want.has(p.id));
  return points.length ? points : item.points;
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
  return close(session, answer.trim() ? [answer] : [], questionPoints(session).map((p) => missed(p.id)), "", true, true);
}

// ---- rendering ---------------------------------------------------------------

/** The question as the reader sees it: which section, what shape of answer, then the question. */
export function renderQuestionMarkdown(q: RecallQuestion, item: RecallItem): string {
  return `**Question ${q.n} · ${itemName(item)}** *(${q.shape} · answer in a few sentences)*\n\n${q.cue}`;
}

/** Between the attempts: the count so far and a cue per open point, the points themselves still hidden. */
export function renderCuedMarkdown(session: RecallSession): string {
  const first = session.first;
  if (!first) return "";
  const recalled = first.marks.filter((m) => m.status === "recalled").length;
  const cues = first.marks.filter(open).map((m) => `- ${m.cue || "one more point"}`);
  return [
    `Your answer has ${recalled} of ${first.marks.length} parts. Hints for the other ${cues.length}:`,
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
