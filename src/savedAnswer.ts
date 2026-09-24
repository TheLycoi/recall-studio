/**
 * A saved answer as a page: the question, the answer, and the sources the
 * answer rested on, rendered as PDF++ rows by code.
 *
 * Answers used to evaporate with the chat. Upstream keeps a conversation by
 * ingesting it (gd4ai/obsidian-llm-wiki, conversation-ingest.ts), which
 * makes the model's words a source; here the answer is kept as what it is —
 * a reading of the reader's own evidence — and every source under it is the
 * same PDF++ link the evidence carried, so the page is anchored exactly as a
 * digested page is. The answer text carries no links of its own: the model
 * is told not to write any, and any it wrote are reduced to their words here,
 * so nothing on disk links to a place code did not verify.
 *
 * Pure: no `obsidian` import; test/savedAnswer.test.mjs bundles it standalone.
 */
import { calloutHeader, renderPdfLink, type PdfTarget } from "./pdflink";
import { safeTitle, wikiDisplay } from "./topicNote";

/** The part of an evidence unit a saved page needs. */
export interface SavedSourceUnit {
  notePath: string;
  noteTitle: string;
  pdfBasename: string | null;
  target: PdfTarget | null;
  page: number | null;
  text: string;
}

export interface SavedSource {
  unit: SavedSourceUnit;
  /** The model's few words on what this source contributed; may be empty. */
  why: string;
}

export interface SavedAnswerArgs {
  question: string;
  answer: string;
  /** The class the question was scoped to, or the active note's; empty when none. */
  classCode: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  created: string;
  /** Which retrieval route found the evidence, for the frontmatter; optional. */
  route?: string;
  sources: SavedSource[];
}

/** The most a filename takes from the question. */
const SLUG_MAX = 60;

/** `<topicFolder>/answers/<question as a filename>.md`. */
export function savedAnswerPath(topicFolder: string, question: string): string {
  const folder = topicFolder.replace(/\/+$/, "");
  const slug = safeTitle(question).slice(0, SLUG_MAX).trim() || "Answer";
  return `${folder}/answers/${slug}.md`;
}

/** Wikilinks and markdown links reduced to their words. */
function stripLinks(text: string): string {
  return text
    .replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
      const s = String(inner);
      const pipe = s.lastIndexOf("|");
      if (pipe >= 0) return s.slice(pipe + 1);
      const path = s.replace(/#.*$/, "");
      return (path.split("/").pop() ?? path).replace(/\.(md|pdf)$/i, "");
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/** A note path as a wikilink target: the `.md` off, the display its title. */
function noteLink(unit: SavedSourceUnit): string {
  return `[[${unit.notePath.replace(/\.md$/i, "")}|${unit.noteTitle}]]`;
}

/**
 * One source row. A source with a PDF target is a direct quote and renders
 * as PDF++ writes one — the callout, the Title-and-page link, the quote —
 * with the note it was read from and the model's reason on a third line. A
 * source with no PDF target is a claim from a note and renders as the quoted
 * claim with the note it came from.
 */
function renderSource(s: SavedSource): string {
  const { unit, why } = s;
  const reason = why.trim() ? `: ${why.trim()}` : "";
  const text = unit.text.replace(/\s+/g, " ").trim();
  if (unit.pdfBasename && unit.target) {
    const page = unit.page ?? unit.target.page;
    const link = renderPdfLink(unit.pdfBasename, unit.target, wikiDisplay(unit.pdfBasename, page));
    return [`> ${calloutHeader(unit.target.color ?? null)} ${link}`, `> > ${text}`, `> — ${noteLink(unit)}${reason}`].join("\n");
  }
  return `- "${text}" — ${noteLink(unit)}${reason}`;
}

export function renderSavedAnswer(a: SavedAnswerArgs): string {
  const lines: string[] = ["---", "type: answer"];
  if (a.classCode.trim()) lines.push(`class: ${a.classCode.trim()}`);
  lines.push(`created: ${a.created}`);
  lines.push(`question: ${JSON.stringify(a.question.trim())}`);
  if (a.route?.trim()) lines.push(`route: ${a.route.trim()}`);
  lines.push("---", "", `# ${a.question.trim()}`, "", stripLinks(a.answer).trim(), "");
  if (a.sources.length > 0) {
    lines.push("## Sources", "");
    for (const s of a.sources) lines.push(renderSource(s), "");
  }
  return lines.join("\n");
}
