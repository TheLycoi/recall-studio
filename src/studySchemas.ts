import { z } from "zod";
import { locateQuote } from "./util";
import type { StudyPassage } from "./study";

export const STUDY_MESSAGE_MAX_CHARS = 8000;
export const STUDY_GUIDE_MAX_CHARS = 64000;
const StudyPassageIn = z.object({
  id: z.string().regex(/^[1-9]\d*$/), path: z.string().min(1), title: z.string(), text: z.string().min(1).max(1200),
  line: z.number().int().positive(), page: z.number().int().positive().nullable(),
}).strict();
export function validateStudyInput(args: StudyEvidenceArgs): void {
  if (!args.topic.trim() || !args.guide.trim() || args.guide.length > STUDY_GUIDE_MAX_CHARS || typeof args.authorized !== "function") throw Error("Invalid study topic, guide or authorization.");
  const passages = z.array(StudyPassageIn).max(40).safeParse(args.passages);
  if (!passages.success || new Set(args.passages.map(p => p.id)).size !== args.passages.length || args.passages.reduce((n, p) => n + p.text.length, 0) > 12000) throw Error("Invalid or unbounded study evidence.");
}

export const StudyEvidenceOut = z.object({
  selections: z.array(z.object({ id: z.string(), quote: z.string() }).strict()).max(40),
  // n nonempty lines need at least 2n - 1 raw guide characters.
  gaps: z.array(z.number().int().positive()).max(Math.floor((STUDY_GUIDE_MAX_CHARS + 1) / 2)),
}).strict();
export type StudyEvidenceDraft = z.infer<typeof StudyEvidenceOut>;
export interface StudyEvidenceArgs {
  topic: string;
  guide: string;
  passages: readonly StudyPassage[];
  authorized: () => boolean;
}
export function studyGuideLines(guide: string): string[] {
  return guide.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** No generated prose crosses the evidence boundary. */
export function validateStudyEvidence(value: unknown, passages: readonly StudyPassage[], guide: string, spanStarts?: ReadonlyMap<string, number>): { passages: StudyPassage[]; gaps: string[] } {
  const parsed = StudyEvidenceOut.safeParse(value);
  if (!parsed.success) throw Error("Invalid study evidence selection.");
  const seen = new Set<string>();
  const spans = new Set<string>();
  const accepted: StudyPassage[] = [];
  for (const selection of parsed.data.selections) {
    const source = passages.find(p => p.id === selection.id);
    if (!source || seen.has(selection.id)) throw Error("Invalid or duplicate study selection ID.");
    seen.add(selection.id);
    const loc = locateQuote(source.text, selection.quote);
    if (!selection.quote.trim() || !loc?.exact || source.text.slice(loc.start, loc.end) !== selection.quote || source.text.indexOf(selection.quote, loc.start + 1) !== -1) throw Error("Study evidence quote is not exact or is ambiguous.");
    // Selection marks relevance; only the original passage preserves qualifiers and context.
    const key = JSON.stringify([source.path, source.page, spanStarts?.get(source.id) ?? source.id, source.text]);
    if (spans.has(key)) continue;
    spans.add(key);
    accepted.push({ ...source });
  }
  const lines = studyGuideLines(guide);
  if (new Set(parsed.data.gaps).size !== parsed.data.gaps.length || parsed.data.gaps.some(n => n > lines.length)) throw Error("Invalid study coverage gap reference.");
  return { passages: accepted, gaps: parsed.data.gaps.map(n => lines[n - 1]) };
}
