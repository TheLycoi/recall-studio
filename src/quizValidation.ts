import type { RecallItem } from "./recall";
import { checkQuestion } from "./recall";
import { QuizChoiceOut, type QuizChoiceDraft, type QuizChoiceAudit } from "./quizSchemas";
import { QuizRecallGradeOut, type QuizRecallGradeDraft } from "./schemas";
import { checkRecallGrade } from "./recall";
import type { EvidenceUnit } from "./pageIndex";

/** Complete unique judgments are required before a learner attempt can count. */
export function validatedQuizGrade(value: QuizRecallGradeDraft, points: EvidenceUnit[], answer: string) {
  const parsed = QuizRecallGradeOut.safeParse(value);
  if (!parsed.success || parsed.data.points.length !== points.length || !points.length) throw Error("invalid grade");
  const seen = new Set<number>();
  for (const p of parsed.data.points) {
    if (!Number.isInteger(p.n) || p.n < 1 || p.n > points.length || seen.has(p.n)) throw Error("invalid point judgment");
    seen.add(p.n);
    if (p.status !== "missed" && (!p.said.trim() || !answer.includes(p.said))) throw Error("invalid learner quote");
  }
  const checked = checkRecallGrade(parsed.data, points, answer);
  if (checked.marks.some(m => !m.verified)) throw Error("invalid learner quote");
  return checked.marks.map(m => ({ ...m, note: "", cue: "" }));
}
const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase();
export function validateQuizChoices(value: QuizChoiceDraft, item: RecallItem): QuizChoiceDraft {
  const d = QuizChoiceOut.parse(value);
  const point = item.points[d.point - 1];
  if (!point || new Set(d.choices.map(c => c.id)).size !== d.choices.length ||
      new Set(d.choices.map(c => fold(c.text))).size !== d.choices.length) throw Error("invalid choices");
  const correct = d.choices.find(c => c.id === d.correctId);
  // Whole-point equality preserves negations and qualifiers; token overlap cannot establish support.
  if (!correct || fold(correct.text) !== fold(point.text)) throw Error("unsupported answer key");
  const check = checkQuestion({ question: d.question, shape: "concept", expects: [d.point] }, item);
  if (!check.ok) throw Error("invalid question");
  return d;
}
export function validateChoiceAudit(audit: QuizChoiceAudit, draft: QuizChoiceDraft): void {
  if (!audit || !Array.isArray(audit.choices) || audit.choices.length !== draft.choices.length) throw Error("incomplete choice audit");
  const seen = new Set<string>();
  for (const c of audit.choices) {
    if (seen.has(c.id) || !draft.choices.some(d => d.id === c.id) || c.supported !== (c.id === draft.correctId)) throw Error("ambiguous choices");
    seen.add(c.id);
  }
}

export function validateQuizAudit(audit: { points: Array<{ n: number; agrees: boolean }> }, count: number): void {
  if (!audit || !Array.isArray(audit.points) || audit.points.length !== count) throw Error("incomplete audit");
  const seen = new Set<number>();
  for (const p of audit.points) {
    if (!Number.isInteger(p.n) || p.n < 1 || p.n > count || seen.has(p.n) || p.agrees !== true) throw Error("unsupported grade");
    seen.add(p.n);
  }
}
