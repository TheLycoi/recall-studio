/**
 * A wiki page as quiz material: each prose line under a heading is one unit,
 * tagged with the heading path it sits under.
 *
 * Recall does not write the wiki. It reads whatever the wiki plugin wrote, so
 * nothing here expects a particular section name.
 *
 * Pure: no `obsidian` import (test/pageIndex.test.mjs bundles it standalone).
 */
import { basenameNoExt } from "./util";
import { parsePdfSubpath, splitLinktext, type PdfTarget } from "./pdflink";

export interface EvidenceUnit {
  id: string;
  notePath: string;
  noteTitle: string;
  pdfBasename: string | null;
  target: PdfTarget | null;
  page: number | null;
  text: string;
  kind: "highlight" | "claim";
  /** The note's `class:` codes, so a quiz can be scoped to one class. */
  classCodes: string[];
  /**
   * The heading path the passage sits under, below the note's title:
   * "Motivational interviewing › Elicit-provide-elicit". "" for the lead
   * before the first heading. Set only for prose-indexed notes; the quiz
   * groups a note's passages by it, and Ask ignores it.
   */
  section?: string;
}

/** Drop `==mark==` wrappers, keeping the marked text. */
function stripMarks(s: string): string {
  return s.replace(/==([\s\S]*?)==/g, "$1");
}

/** The note body with frontmatter removed. */
function raw(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * A line that is nothing but one link, with or without a list marker.
 *
 * It is navigation, not a statement. A "Related Concepts" list is a column of
 * these, and a question written from it would ask the reader to recite which
 * pages link to which.
 */
const LINK_ONLY = /^(?:\s*>)*\s*(?:[-*+]|\d+[.)])?\s*(?:!?\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]*\))\s*$/;

/**
 * Evidence from an unstructured note: each prose line becomes a unit, so a
 * hand-written note is searchable by the same ranking as a digested one.
 *
 * Headings, image embeds and fenced code are skipped — a heading is a label
 * rather than a statement, and an embed carries no text to quote. List markers
 * and leading numbers are stripped so the text reads as a sentence, and a
 * line's PDF link (when it has one) is kept as the unit's target, which is
 * what lets an answer cite back to the page it came from.
 */
function proseUnits(path: string, noteTitle: string, body: string, classCodes: string[]): EvidenceUnit[] {
  const out: EvidenceUnit[] = [];
  let fenced = false;
  let i = 0;
  // The PDF link from the callout header above, carried down to the quoted
  // lines inside it: the quote is the evidence, but the page it cites is
  // written on the header, and an answer is only useful if it can point there.
  let calloutTarget: { target: PdfTarget; pdfBasename: string } | null = null;

  // The heading path above the current line, from `##` down; the note's `#`
  // title is the note itself and not part of any section's name.
  const headings: string[] = [];
  const lines = body.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!line) {
      calloutTarget = null;
      continue;
    }
    // A callout header (`> [!PDF|yellow] [[…]]`) names the source of the lines
    // beneath it; as evidence it would quote the file name back at the reader.
    if (/^>\s*\[!/.test(line)) {
      calloutTarget = firstPdfTarget(line);
      continue;
    }
    const heading = /^(#{2,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const depth = heading[1].length - 2;
      headings.length = depth;
      headings[depth] = cleanProse(heading[2]);
    }
    // `![[...]]` is an embedded image or PDF rect: no quotable text.
    if (line.startsWith("#") || /^!\[\[/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (!line.startsWith(">")) calloutTarget = null;
      continue;
    }

    if (LINK_ONLY.test(line)) {
      if (!line.startsWith(">")) calloutTarget = null;
      continue;
    }

    // A table's header row and its separator are labels; a body row is one
    // statement, its first cell the thing and the rest what is said of it.
    let text: string;
    if (line.startsWith("|")) {
      if (TABLE_SEPARATOR.test(line) || TABLE_SEPARATOR.test((lines[li + 1] ?? "").trim())) continue;
      text = tableRowText(line);
    } else {
      text = cleanProse(line);
    }
    const target = firstPdfTarget(line) ?? (line.startsWith(">") ? calloutTarget : null);
    if (!line.startsWith(">")) calloutTarget = null;
    // Below the length of a real statement, a fragment only adds noise.
    if (text.length < 12) continue;
    // A line naming where the note came from is metadata about the note, not a
    // claim inside it — the same reason a heading is skipped. Left in, it is
    // indistinguishable from evidence, and the quiz asked which organisation
    // published the source table: bibliography the reader never set out to
    // learn, in place of the subject sitting directly under it.
    if (CITATION_LINE.test(text)) continue;

    out.push({
      id: `${path}#p${i}`,
      notePath: path,
      noteTitle,
      pdfBasename: target ? target.pdfBasename : null,
      target: target ? target.target : null,
      page: target ? target.target.page : null,
      text,
      kind: "claim",
      classCodes,
      section: headings.filter(Boolean).join(" › "),
    });
    i += 1;
  }

  return out;
}

/** Every quiz unit of one page. The title is the page's `# ` heading, or its file name. */
export function indexPage(path: string, md: string): EvidenceUnit[] {
  const body = raw(md);
  const h1 = /^#\s+(.+?)\s*$/m.exec(body);
  return proseUnits(path, h1 ? h1[1].trim() : basenameNoExt(path), body, []);
}

/**
 * A line that says where the note's material came from.
 *
 * Anchored at the start so it catches the citation and not a sentence that
 * happens to discuss sources: "Source: …", "Adapted from …", "Reference: …"
 * open a line whose job is attribution. A passing mention inside a real
 * statement never matches, because the words are not at the front.
 */
const CITATION_LINE = /^\s*(?:source|sources|adapted from|adapted|reference|references|ref|citation|cited from|from|credit|credits|via|see also|further reading)\b\s*[::—–-]?/i;

/** A markdown table's separator row: `| --- | :---: |`. */
const TABLE_SEPARATOR = /^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/;

/** One table body row as a sentence: "Simple: Repeats or rephrases — \"You're busy.\"". */
function tableRowText(line: string): string {
  const cells = line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => cleanProse(c))
    .filter(Boolean);
  if (cells.length <= 1) return cells[0] ?? "";
  return `${cells[0]}: ${cells.slice(1).join(" — ")}`;
}

/** The first PDF wikilink on a line, when it resolves to a real target. */
function firstPdfTarget(line: string): { target: PdfTarget; pdfBasename: string } | null {
  for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const { path: linkPath, subpath } = splitLinktext(m[1].split("|")[0]);
    if (!/\.pdf$/i.test(linkPath) || !subpath) continue;
    const target = parsePdfSubpath(subpath);
    if (!target) continue;
    const base = linkPath.split("/").pop() ?? linkPath;
    return { target, pdfBasename: base.replace(/\.pdf$/i, "") };
  }
  return null;
}

/**
 * A prose line as a readable statement: list and quote markers off the front,
 * wikilinks reduced to their display text, and bold/italic/mark syntax
 * dropped. The words are left otherwise intact, because quote verification in
 * src/askCheck.ts matches the model's quotes against this text.
 */
function cleanProse(line: string): string {
  return stripMarks(line)
    .replace(/^(?:\s*>)+\s?/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/!?\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
      const s = String(inner);
      const pipe = s.lastIndexOf("|");
      return pipe >= 0 ? s.slice(pipe + 1) : s.replace(/#.*$/, "");
    })
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([\s\S]*?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- question scoring --------------------------------------------------------

/**
 * Words that carry no retrieval signal in a study question.
 *
 * The second line is filler verbs and question scaffolding. They survived the
 * length filter and then scored like real terms: "how do drugs get absorbed"
 * matched "get" in three psychopathology passages and put them above every
 * pharmacology one, because a hit on "get" counted exactly as much as a hit on
 * "drug". A word the reader did not really ask about must not win a slot.
 */
const STOPWORDS = new Set(
  ("the a an and or of to in on at for from by with as is are was were be been being do does did what which who whom whose when where why how this that these those it its into than then there their they them can could should would will not no yes about between each all any some such more most other over under out up down off again further once here also very just than too each both few own same so than " +
    "get gets getting got give gives given make makes made making use uses used using take takes taken taking put puts come comes came go goes going know knows known say says said see sees seen look looks looking find finds found want wants need needs like likes thing things way ways lot much many really actually basically mean means happen happens work works help helps let lets tell tells call calls try tries able based upon via etc").split(
    " ",
  ),
);

function stem(w: string): string {
  return w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w;
}

export function significantTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * The scorer `rankEvidence` ranks a question's evidence with.
 *
 * Given the corpus, a question's words are weighted by how rare they are in
 * it. Counting shared words treated every word alike, so a term the notes use
 * constantly ("analysis" in a biomechanics vault, "drug" in a pharmacology
 * one) won as many slots as the one term that actually named the topic — and
 * "how do drugs get absorbed" answered itself out of three psychopathology
 * passages that happened to contain "get". The weight is the usual
 * inverse-document-frequency shape: a word in one unit out of 580 is worth far
 * more than a word in 200 of them.
 *
 * Without a corpus it is plain overlap. Obsidian's `prepareSimpleSearch`
 * (obsidian.d.ts:5254-5260) was the first choice but matches only when every
 * word of the query occurs in the text, so a real question matched nothing.
 */
export function questionScorer(question: string, units: EvidenceUnit[] = []): (text: string) => number | null {
  const tokens = [...new Set(significantTokens(question))];

  // With no corpus to measure rarity against, every word weighs the same and
  // the score is plain overlap — which is what the quiz wants when it ranks a
  // pool it has already narrowed by hand.
  if (units.length === 0) {
    return (text) => {
      if (tokens.length === 0) return null;
      const have = new Set(significantTokens(text));
      let n = 0;
      for (const w of tokens) if (have.has(w)) n++;
      return n > 0 ? n : null;
    };
  }

  const docFreq = new Map<string, number>();
  for (const u of units) {
    for (const w of new Set(significantTokens(u.text))) {
      if (!tokens.includes(w)) continue;
      docFreq.set(w, (docFreq.get(w) ?? 0) + 1);
    }
  }

  const n = units.length;
  const weight = new Map<string, number>();
  for (const w of tokens) {
    // A word absent from the corpus keeps full weight: it costs nothing (it
    // can never match) and keeps the map total.
    const df = docFreq.get(w) ?? 0;
    weight.set(w, Math.log((n + 1) / (df + 1)) + 1);
  }

  return (text) => {
    if (tokens.length === 0) return null;
    const have = new Set(significantTokens(text));
    let score = 0;
    let hits = 0;
    for (const w of tokens) {
      if (!have.has(w)) continue;
      score += weight.get(w) ?? 1;
      hits++;
    }
    return hits > 0 ? score : null;
  };
}
