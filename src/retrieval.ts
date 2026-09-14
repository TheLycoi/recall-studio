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
import { isGraphUsable, pprFromSeeds, type Graph, type PPROptions } from "./graph";

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
 *
 * When neither section is present the note's prose is indexed instead, so a
 * hand-written note answers questions rather than reading as empty.
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

  // A note that follows neither convention still has to be answerable. Notes
  // written by hand — no `## Highlights`, no `## Key claims` — indexed to
  // nothing here, so Ask reported "no coverage" for a topic the vault plainly
  // covered. When the structured passes find nothing, fall back to the note's
  // own prose so its content is reachable; a note that already yielded units
  // keeps exactly the units it had.
  if (units.length === 0) {
    proseUnits(path, noteTitle, raw(md)).forEach((u) => units.push(u));
  }

  return units;
}

/** The note body with frontmatter removed. */
function raw(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

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
function proseUnits(path: string, noteTitle: string, body: string): EvidenceUnit[] {
  const out: EvidenceUnit[] = [];
  let fenced = false;
  let i = 0;
  // The PDF link from the callout header above, carried down to the quoted
  // lines inside it: the quote is the evidence, but the page it cites is
  // written on the header, and an answer is only useful if it can point there.
  let calloutTarget: { target: PdfTarget; pdfBasename: string } | null = null;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
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
    // `![[...]]` is an embedded image or PDF rect: no quotable text.
    if (line.startsWith("#") || /^!\[\[/.test(line) || /^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (!line.startsWith(">")) calloutTarget = null;
      continue;
    }

    const target = firstPdfTarget(line) ?? (line.startsWith(">") ? calloutTarget : null);
    if (!line.startsWith(">")) calloutTarget = null;
    const text = cleanProse(line);
    // Below the length of a real statement, a fragment only adds noise.
    if (text.length < 12) continue;

    out.push({
      id: `${path}#p${i}`,
      notePath: path,
      noteTitle,
      pdfBasename: target ? target.pdfBasename : null,
      target: target ? target.target : null,
      page: target ? target.target.page : null,
      text,
      kind: "claim",
    });
    i += 1;
  }

  return out;
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

// ---- graph expansion ---------------------------------------------------------

/**
 * Add units from notes the matched notes link to.
 *
 * Lexical search can only return a note that uses the question's words. The
 * note next to it — linked from it, part of the same idea — is invisible no
 * matter how relevant, and in a wiki that is exactly where the rest of the
 * answer lives. PPR over the wikilinks scores those neighbours by how
 * reachable they are from the notes that did match, and the best of them are
 * appended after the lexical hits.
 *
 * Seeds are the notes lexical search already found, never an arbitrary note:
 * upstream learned that walking from a random seed returns that seed's
 * neighbourhood dressed up as an answer (gd4ai/obsidian-llm-wiki,
 * select-seeds.ts). No lexical hits means no seeds and no expansion.
 *
 * Lexical hits keep their order and their places; expansion only fills the
 * slots lexical search left empty, so this can add evidence but never
 * displace a better-matched passage.
 */
export function expandWithGraph(
  lexical: EvidenceUnit[],
  units: EvidenceUnit[],
  graph: Graph,
  k: number,
  options: PPROptions = {},
): EvidenceUnit[] {
  if (lexical.length >= k || lexical.length === 0) return lexical;
  if (!isGraphUsable(graph)) return lexical;

  const seeds = [...new Set(lexical.map((u) => u.notePath))];
  const scores = pprFromSeeds(graph, seeds, options);
  if (scores.size === 0) return lexical;

  const seedSet = new Set(seeds);
  const taken = new Set(lexical.map((u) => u.id));

  // Only notes the walk actually reached, and not the ones we started from:
  // their own passages were already ranked on the words they contain.
  const reached = [...scores.entries()]
    .filter(([path, score]) => score > 0 && !seedSet.has(path))
    .sort((a, b) => b[1] - a[1]);

  const out = [...lexical];
  for (const [path] of reached) {
    if (out.length >= k) break;
    // One passage per neighbour note, so expansion broadens the answer
    // instead of pasting in one note's whole contents.
    const pick = units.find((u) => u.notePath === path && !taken.has(u.id));
    if (!pick) continue;
    taken.add(pick.id);
    out.push(pick);
  }
  return out;
}

/**
 * Rank the units a set of search terms hits, weighting a note-title match
 * above a body match.
 *
 * The weighting is upstream's: a term in the title says the note is about the
 * thing, a term in the body may be a passing mention
 * (gd4ai/obsidian-llm-wiki, `scorePagesByNeedles`). Used for the terms the
 * model supplies, which are concept names and so land on titles far more
 * often than a reader's phrasing does.
 */
export function rankByKeywords(units: EvidenceUnit[], keywords: string[], k: number): EvidenceUnit[] {
  const needles = keywords.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2);
  if (needles.length === 0) return [];

  const scored: Array<{ unit: EvidenceUnit; score: number; index: number }> = [];
  units.forEach((unit, index) => {
    const text = unit.text.toLowerCase();
    const title = unit.noteTitle.toLowerCase();
    let score = 0;
    for (const needle of needles) {
      if (title.includes(needle)) score += 3;
      else if (text.includes(needle)) score += 2;
    }
    if (score > 0) scored.push({ unit, score, index });
  });

  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));

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

/** Lexical hits plus keyword hits, in that order, without repeats. */
export function mergeEvidence(primary: EvidenceUnit[], extra: EvidenceUnit[], k: number): EvidenceUnit[] {
  const seen = new Set(primary.map((u) => u.id));
  const out = [...primary];
  for (const u of extra) {
    if (out.length >= k) break;
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    out.push(u);
  }
  return out;
}
