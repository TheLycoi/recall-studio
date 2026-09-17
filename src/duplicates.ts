/**
 * Two pages about one subject, found from evidence the pages already carry.
 *
 * Follows the design of gd4ai/obsidian-llm-wiki's tiered duplicate detection
 * (name match always, wider similarity into a budget), reimplemented here
 * against this plugin's own records and without the model call: a name two
 * pages share, and a PDF span two pages both cite, are facts about the vault
 * rather than guesses about wording, and both are free hash joins.
 *
 * Report-only. Nothing here merges anything: merging is a rewrite of the
 * reader's notes, and the standing invariant is that nothing is silently
 * destroyed.
 *
 * Pure: no `obsidian` import, same rule as src/vaultLint.ts, so
 * test/duplicates.test.mjs bundles it standalone.
 */
import { linkKey } from "./graph";

export interface DuplicatePage {
  path: string;
  /** The filename without extension — what a wikilink addresses. */
  title: string;
  aliases: string[];
  /** `<pdf basename>#<highlightKey>` for every PDF++ callout the page cites. */
  evidence: string[];
}

export type DuplicatePass = "name" | "evidence";

export interface DuplicateFinding {
  /** The lesser path of the pair, so a pair has one spelling. */
  a: string;
  b: string;
  pass: DuplicatePass;
  /** What the two pages share, in words the report can print. */
  detail: string;
}

/**
 * Pass 1, name: a title or alias two pages both answer to, folded the way
 * links resolve (`linkKey`), so "Chunk Size" and "chunk-size" are one name.
 * Pass 2, evidence: the same span of the same document cited by two pages —
 * a page's sources are its callouts, so two pages built from one span are
 * about one thing. A pair is reported once; the name pass runs first and so
 * wins the report when both fire. Output is sorted by path so two runs on an
 * unchanged vault are byte-identical.
 */
export function findDuplicates(pages: DuplicatePage[]): DuplicateFinding[] {
  const out: DuplicateFinding[] = [];
  const seen = new Set<string>();
  const emit = (x: DuplicatePage, y: DuplicatePage, pass: DuplicatePass, detail: string): void => {
    if (x.path === y.path) return;
    const [a, b] = x.path < y.path ? [x, y] : [y, x];
    const key = `${a.path}\n${b.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ a: a.path, b: b.path, pass, detail });
  };

  const byName = new Map<string, Array<{ page: DuplicatePage; name: string }>>();
  for (const page of pages) {
    for (const name of [page.title, ...page.aliases]) {
      const key = linkKey(name);
      if (!key) continue;
      const list = byName.get(key) ?? [];
      list.push({ page, name });
      byName.set(key, list);
    }
  }
  for (const list of byName.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        emit(list[i].page, list[j].page, "name", `both answer to “${list[i].name}”`);
      }
    }
  }

  const byEvidence = new Map<string, DuplicatePage[]>();
  for (const page of pages) {
    for (const ev of new Set(page.evidence)) {
      const list = byEvidence.get(ev) ?? [];
      list.push(page);
      byEvidence.set(ev, list);
    }
  }
  for (const [ev, list] of byEvidence) {
    const hash = ev.indexOf("#");
    const doc = hash >= 0 ? ev.slice(0, hash) : ev;
    const where = hash >= 0 ? ev.slice(hash + 1) : "";
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        emit(list[i], list[j], "evidence", `both cite ${doc} at ${where}`);
      }
    }
  }

  out.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return out;
}
