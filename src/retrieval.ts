// Pure retrieval for Ask: index notes into evidence units, rank them against a
// question, number them for the prompt, and check the model's citations. No
// `obsidian` import (see src/lint.ts:1-6): the scorer is injected, so the
// caller can hand in Obsidian's `prepareSimpleSearch(question)` wrapped to
// return `SearchResult.score` (obsidian.d.ts:5254-5260, :5593-5598) without
// this module — or its test bundle — ever resolving `obsidian`.
import { basenameNoExt } from "./util";
import { parsePdfSubpath, renderCallout, splitLinktext, type PdfTarget } from "./pdflink";
import { parseTopicNote } from "./topicNote";
import type { AskEvidenceIn } from "./prompt";

export interface EvidenceUnit {
  id: string;
  notePath: string;
  noteTitle: string;
  pdfBasename: string | null;
  target: PdfTarget | null;
  page: number | null;
  text: string;
  kind: "highlight" | "claim";
}

/**
 * The separator between a claim's text and its source link. The vault writes
 * an em dash and only an em dash: 106 ` — [[` bullets under `## Key claims`
 * across 12 notes in `projects/classes`, zero ` - [[`. A hyphen-minus is
 * accepted as well so a hand-typed bullet still indexes; it cannot collide
 * with a list marker because the pattern requires a following wikilink.
 */
const CLAIM_SEP_RE = /\s+[—-]\s+(?=\[\[[^\]]+\]\]\s*$)/;

/** The `## Key claims` section body: the lines after the heading, up to the next `## ` heading or EOF. */
function keyClaimsSection(body: string): string | null {
  const m = /^##\s+Key claims\s*$/m.exec(body);
  if (!m) return null;
  const headingEnd = m.index + m[0].length;
  const rest = body.slice(headingEnd);
  const next = /^##\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Drop `==mark==` wrappers, keeping the marked text. */
function stripMarks(s: string): string {
  return s.replace(/==([\s\S]*?)==/g, "$1");
}

/**
 * Every evidence unit in one note: the `## Highlights` callouts and embeds
 * (via `parseTopicNote`) plus the `## Key claims` bullets. A claim's link is a
 * PDF target only when its path ends in `.pdf` and its subpath parses; a link
 * to another note leaves `target`, `pdfBasename` and `page` null.
 */
export function indexNote(path: string, md: string): EvidenceUnit[] {
  const parsed = parseTopicNote(md);
  const noteTitle = parsed.title || basenameNoExt(path);
  const units: EvidenceUnit[] = [];

  parsed.highlights.forEach((h, i) => {
    units.push({
      id: `${path}#h${i}`,
      notePath: path,
      noteTitle,
      pdfBasename: h.pdfBasename,
      target: h.target,
      page: h.page,
      text: h.text,
      kind: "highlight",
    });
  });

  const section = keyClaimsSection(md);
  if (section !== null) {
    let claimIndex = 0;
    for (const raw of section.split("\n")) {
      const line = raw.trim();
      const bullet = /^[-*]\s+(.*)$/.exec(line);
      if (!bullet) continue;
      const rest = bullet[1].trim();
      const sep = CLAIM_SEP_RE.exec(rest);
      if (!sep) continue;

      const text = stripMarks(rest.slice(0, sep.index)).trim();
      const linkInner = rest.slice(sep.index + sep[0].length).replace(/^\[\[/, "").replace(/\]\]$/, "");
      const { path: linkPath, subpath } = splitLinktext(linkInner);

      let target: PdfTarget | null = null;
      let pdfBasename: string | null = null;
      if (/\.pdf$/i.test(linkPath) && subpath) {
        const t = parsePdfSubpath(subpath);
        if (t) {
          target = t;
          const base = linkPath.split("/").pop() ?? linkPath;
          pdfBasename = base.replace(/\.pdf$/i, "");
        }
      }

      units.push({
        id: `${path}#c${claimIndex}`,
        notePath: path,
        noteTitle,
        pdfBasename,
        target,
        page: target ? target.page : null,
        text,
        kind: "claim",
      });
      claimIndex += 1;
    }
  }

  return units;
}

/** Nulls sort last; otherwise ascending. */
function comparePage(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/**
 * Score every unit with the injected scorer, drop the ones whose text does not
 * match, and take the best `k` — at most `ceil(k/2)` from any one note, so one
 * long note cannot crowd the rest. A note title match is worth 0.15 of a text
 * match: it breaks ties toward the note the reader would have opened, without
 * letting a title alone carry a unit whose text says nothing.
 *
 * `scorer` is injected because Obsidian's `prepareSimpleSearch` lives in the
 * `obsidian` module, which this file must not import. `SearchResult.score`
 * (obsidian.d.ts:5593-5598) carries no ordering comment in the d.ts, so the
 * ranking here treats a higher score as a better match and the caller wraps
 * the search callback accordingly.
 */
export function rankEvidence(
  units: EvidenceUnit[],
  question: string,
  scorer: (text: string) => number | null,
  k: number,
): EvidenceUnit[] {
  const scored: Array<{ unit: EvidenceUnit; score: number; index: number }> = [];
  units.forEach((unit, index) => {
    const textScore = scorer(unit.text);
    if (textScore === null) return;
    const titleScore = scorer(unit.noteTitle) ?? 0;
    scored.push({ unit, score: textScore + 0.15 * titleScore, index });
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.unit.notePath !== b.unit.notePath) return a.unit.notePath < b.unit.notePath ? -1 : 1;
    const page = comparePage(a.unit.page, b.unit.page);
    if (page !== 0) return page;
    if (a.unit.text !== b.unit.text) return a.unit.text < b.unit.text ? -1 : 1;
    return a.index - b.index;
  });

  const perNoteCap = Math.ceil(k / 2);
  const perNote = new Map<string, number>();
  const out: EvidenceUnit[] = [];
  for (const s of scored) {
    if (out.length >= k) break;
    const used = perNote.get(s.unit.notePath) ?? 0;
    if (used >= perNoteCap) continue;
    perNote.set(s.unit.notePath, used + 1);
    out.push(s.unit);
  }
  return out;
}

/** Number the ranked units `[1]…[k]` for the prompt. */
export function numberEvidence(units: EvidenceUnit[]): AskEvidenceIn[] {
  return units.map((u, i) => ({ n: i + 1, noteTitle: u.noteTitle, page: u.page, text: u.text }));
}

/**
 * Grounding, mechanically: a `[n]` outside `1…count` cites evidence that does
 * not exist, so it is cut from the answer text and never reported as cited.
 * The reported `cited` list is the union of the valid numbers the model
 * declared and the valid ones it actually wrote.
 */
export function validateCitations(
  answer: string,
  cited: number[],
  count: number,
): { answer: string; cited: number[] } {
  const found = new Set<number>();
  let out = answer.replace(/\[(\d+)\]/g, (match, digits: string) => {
    const n = Number(digits);
    if (n >= 1 && n <= count) {
      found.add(n);
      return match;
    }
    return "";
  });

  // A removed token leaves the spaces that framed it behind.
  out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+([,.;:!?)\]])/g, "$1");

  for (const n of cited) {
    if (Number.isInteger(n) && n >= 1 && n <= count) found.add(n);
  }

  return { answer: out, cited: Array.from(found).sort((a, b) => a - b) };
}

/**
 * One evidence unit as markdown: the citation number and a link to the note it
 * came from, then the highlight as the same PDF++ callout the note shows (so
 * PDF++ renders it and the link opens the PDF at the highlight), or a plain
 * quote block for a claim that has no PDF target.
 */
export function renderEvidenceMarkdown(u: EvidenceUnit, n: number): string {
  const linkPath = u.notePath.replace(/\.md$/i, "");
  const head = `**[${n}]** [[${linkPath}|${u.noteTitle}]]`;
  const body =
    u.target && u.pdfBasename
      ? renderCallout(u.pdfBasename, u.target, `p.${u.page}`, u.text)
      : `> ${u.text}`;
  return `${head}\n${body}`;
}

// ---- question scoring --------------------------------------------------------

/** Words that carry no retrieval signal in a study question. */
const STOPWORDS = new Set(
  "the a an and or of to in on at for from by with as is are was were be been being do does did what which who whom whose when where why how this that these those it its into than then there their they them can could should would will not no yes about between each all any some such more most other over under out up down off again further once here also very just than too each both few own same so than".split(
    " ",
  ),
);

function stem(w: string): string {
  return w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w;
}

function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * The scorer the chat injects into `rankEvidence` for a question: the number
 * of distinct significant words of the question that appear in the text
 * (stopwords dropped, a trailing plural "s" ignored), or null when none do.
 *
 * Obsidian's `prepareSimpleSearch` was the first choice, but it matches only
 * when every space-separated word of the query occurs in the text, so a real
 * question ("what are the five stages of change and what does the coach do")
 * matched no unit at all. Counting shared words is what a lexical evidence
 * search over short highlights actually needs.
 */
export function questionScorer(question: string): (text: string) => number | null {
  const tokens = [...new Set(significantTokens(question))];
  return (text) => {
    if (tokens.length === 0) return null;
    const have = new Set(significantTokens(text));
    let n = 0;
    for (const w of tokens) if (have.has(w)) n++;
    return n > 0 ? n : null;
  };
}
