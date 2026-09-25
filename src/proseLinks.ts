/**
 * Links inside model-written prose, resolved by code.
 *
 * The model nominates, code disposes, and no link reaches disk unverified
 * (the Wikipedia-shape design, 2026-09-23). The model writes two kinds of
 * marker and never a bracket:
 *
 *   {{Receptors}}   a mention of another page, by the name the model would
 *                   say. Resolved against the pages the digest was shown; a
 *                   name no page answers to is stripped to its words and
 *                   reported as an orphan. No stub is ever created.
 *   [H03] [H03, H04] a citation by a highlight's id. Rendered as the PDF++
 *                   link that opens the source at the span, with the file's
 *                   title and page as its text; an id the manifest lacks is
 *                   dropped and counted.
 *
 * Pure: no `obsidian` import; test/proseLinks.test.mjs bundles it standalone.
 */
import { renderPdfLink, type PdfTarget } from "./pdflink";

/** A page a marker may resolve to: what it is called, what else it answers to, where it lives. */
export interface LinkablePage {
  path: string;
  title: string;
  aliases: string[];
}

/** A highlight a citation may resolve to. */
export interface CitableHighlight {
  id: string;
  page: number;
  target: PdfTarget;
}

export interface ResolvedProse {
  prose: string;
  /** Page names the model mentioned that no page answers to, in order of first appearance. */
  orphans: string[];
  /** Ids the model cited that the manifest does not hold, in order of first appearance. */
  droppedIds: string[];
  /** Ids cited at least once, in order of first appearance. */
  citedIds: string[];
}

const MARKER_RE = /\{\{([^{}\n]+)\}\}/g;
const CITATION_RE = /\[((?:[A-Z]+\d+)(?:\s*,\s*[A-Z]+\d+)*)\]/g;

/** Title case folded the way a page name is looked up: case, whitespace and smart quotes ignored. */
function fold(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** A wikilink target from a vault path: the `.md` off, folders kept. */
function linkTarget(path: string): string {
  return path.replace(/\.md$/i, "");
}

/**
 * Resolve `{{Name}}` markers to `[[path|Name]]` and `[Hnn]` citations to
 * PDF++ links. `pdfBasename` names the file every citation opens; `display`
 * renders a citation's text, by default the file's title and page.
 */
export function resolveProseLinks(
  prose: string,
  pages: LinkablePage[],
  highlights: CitableHighlight[],
  pdfBasename: string,
  display: (page: number) => string = (page) => `${pdfBasename}, p.${page}`,
): ResolvedProse {
  const byName = new Map<string, LinkablePage>();
  for (const p of pages) {
    for (const name of [p.title, ...p.aliases]) {
      const k = fold(name);
      if (k && !byName.has(k)) byName.set(k, p);
    }
  }
  const byId = new Map(highlights.map((h) => [h.id, h]));

  const orphans: string[] = [];
  const droppedIds: string[] = [];
  const citedIds: string[] = [];
  const note = (list: string[], v: string) => {
    if (!list.includes(v)) list.push(v);
  };

  let out = prose.replace(MARKER_RE, (_m, inner: string) => {
    const name = inner.replace(/\s+/g, " ").trim();
    if (!name) return "";
    const hit = byName.get(fold(name));
    if (!hit) {
      note(orphans, name);
      return name;
    }
    return `[[${linkTarget(hit.path)}|${name}]]`;
  });

  out = out.replace(CITATION_RE, (_m, inner: string) => {
    const links: string[] = [];
    for (const raw of inner.split(",")) {
      const id = raw.trim();
      const h = byId.get(id);
      if (!h) {
        note(droppedIds, id);
        continue;
      }
      note(citedIds, id);
      links.push(renderPdfLink(pdfBasename, h.target, display(h.page)));
    }
    return links.join(" ");
  });

  // A dropped citation leaves a double space or a space before punctuation.
  out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1");

  return { prose: out.trim(), orphans, droppedIds, citedIds };
}
