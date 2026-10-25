/**
 * The reader's own schema note: `Recall/recall-rules.md`, and the suggestions
 * file beside it.
 *
 * Recall's prompts are the plugin's; this file is the reader's. Its sections
 * are read before each card it writes and injected as house rules, so a rule
 * the reader writes here ("answers in German", "never cloze a date") reaches
 * the model without anyone editing `src/llm.ts`. Deleting a rule from the
 * note is how it stops applying — there is no second copy of it anywhere.
 *
 * Pure on purpose, like `src/examples.ts`: no `obsidian` import, so
 * `test/schemaNote.test.mjs` can bundle it standalone with esbuild. Another
 * module does the reading and writing of the file.
 *
 * Modelled on gd4ai/obsidian-llm-wiki's wiki/schema/config.md (Apache-2.0):
 * the idea of a reader-owned config note. The text here is our own.
 */

export interface SchemaSection {
  /** The heading without its `## `. */
  heading: string;
  /** Everything to the next `## ` or EOF, trimmed. May be "". */
  body: string;
}

export interface ParsedSchema {
  version: number;
  updated: string;
  learnedCount: number;
  sections: SchemaSection[];
}

/** The one italic line `## Learned` carries before any rule has been promoted into it. */
const LEARNED_PLACEHOLDER =
  "_Rules promoted from your own edits appear here, each with its date and the evidence that earned it. Delete one to unlearn it._";

export interface DefaultSchemaOptions {
  today: string;
}

/** The note a reader is given on the first run. */
export function renderDefaultSchema(opts: DefaultSchemaOptions): string {
  const { today } = opts;

  return `---
version: 1
updated: ${today}
learned_count: 0
---

# Recall Studio Card Rules

These are your rules for the cards Recall Studio writes. Every section below is read before each card it writes and handed to the model as your house rules, so a rule you write here applies from the next run onward — no setting to find, no code to edit. Delete a rule and it stops applying; delete a whole section and nothing from it is sent. The sections are yours to rewrite in your own words.

## Card Templates

- Q&A: \`What does decisional balance weigh?\` → \`the costs and benefits of changing\`
- Cloze: one sentence from the highlight with \`{{c1::...}}\` around the span to hide.

## Card Rules

- One fact per retrieval. Independent cloze deletions can share a source sentence. There is no fixed deletion count or cloze-card quota; a single deletion is valid. Do not split or duplicate a stem solely to meet a number.
- The question must not contain its answer, and must not be answerable by grammar, length, or the only candidate the sentence admits.
- Use the highlight's own words. A card is verifiable against the text at a glance, or it is not verifiable at all.
- Answers are short: a term, a number, a name, or a phrase.
- Name the subject in the question. The card will be met months from now, shuffled among cards from other notes.
- If the highlight holds nothing worth testing, write no card. A card you would delete costs more than a card that was never written.

## Content Rules

- Quotes are verbatim, character for character, and each one keeps the PDF++ link to the page and selection it came from.
- Nothing from outside the source reaches a page or a card. Outside knowledge is indistinguishable from yours once it is on the page, and you will study from it.
- No links, callouts or highlight ids in model-written prose; the plugin renders those from its own records.

## Learned

${LEARNED_PLACEHOLDER}
`;
}

/** Normalise line endings so every regex below can assume `\n`. */
function lf(md: string): string {
  return md.replace(/\r\n/g, "\n");
}

/** The frontmatter block's inner text, or "" when the note has none. */
function frontmatterOf(md: string): string {
  return /^---\n([\s\S]*?)\n---\n?/.exec(md)?.[1] ?? "";
}

/**
 * Tolerant by contract: this note is hand-edited, so half-typed frontmatter and
 * a heading with nothing under it are normal states, not errors. Anything
 * unreadable falls back to the default rather than throwing — a reader mid-edit
 * should never see the plugin refuse to run.
 */
export function parseSchema(md: string): ParsedSchema {
  const text = lf(md ?? "");
  const fm = frontmatterOf(text);
  const num = (key: string, fallback: number): number => {
    const raw = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim();
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const sections: SchemaSection[] = [];
  // Split on `## ` at the start of a line. Everything before the first one is
  // the intro, which is prose for the reader and not a rule for the model.
  const re = /^##\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  const starts: Array<{ heading: string; from: number }> = [];
  while ((m = re.exec(body)) !== null) {
    starts.push({ heading: m[1].trim(), from: m.index + m[0].length });
  }
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? body.lastIndexOf("\n##", starts[i + 1].from) : body.length;
    const slice = body.slice(starts[i].from, end < starts[i].from ? body.length : end);
    if (starts[i].heading) sections.push({ heading: starts[i].heading, body: slice.trim() });
  }

  return {
    version: num("version", 1),
    updated: /^updated:\s*(.+)$/m.exec(fm)?.[1]?.trim() ?? "",
    learnedCount: num("learned_count", 0),
    sections,
  };
}

/** The body as the model should see it: nothing, when all it holds is the placeholder. */
function liveBody(section: SchemaSection): string {
  const kept = section.body
    .replace(/ ?<!-- recall-accept: \S+ -->/g, "")
    .split("\n")
    .filter((l) => l.trim() !== LEARNED_PLACEHOLDER)
    .join("\n")
    .trim();
  return kept;
}

const HOUSE_RULES_INTRO =
  "The reader's own rules, from their schema note. Follow them; they refine the instructions above and never override the source.";

function wrap(parts: string[]): string {
  if (parts.length === 0) return "";
  return `<house_rules>\n${HOUSE_RULES_INTRO}\n\n${parts.join("\n\n")}\n</house_rules>`;
}

/** The block the card writer is shown, "" when no section applies. */
export function schemaBlocks(parsed: ParsedSchema): { cards: string } {
  const cards: string[] = [];
  for (const section of parsed.sections ?? []) {
    const body = liveBody(section);
    if (!body) continue;
    cards.push(`## ${section.heading}\n${body}`);
  }
  return { cards: wrap(cards) };
}

/**
 * Promote one rule into `## Learned`, and touch only what that requires.
 *
 * The reader owns every other byte of this note — their prose, their spacing,
 * their sections in their order — so the edit is a splice at two places
 * (the frontmatter's two keys and the end of the Learned body), never a
 * re-render. `test/schemaNote.test.mjs` asserts this by diffing the note line
 * by line with those lines removed.
 */
export function appendLearnedRule(md: string, rule: string, opts: { date: string; count: number; occurrenceId?: string }): string {
  if (opts.occurrenceId && hasLearnedReceipt(md, opts.occurrenceId)) return md;
  const receipt = opts.occurrenceId ? ` <!-- recall-accept: ${encodeURIComponent(opts.occurrenceId)} -->` : "";
  const line = `- ${rule.trim()} _(learned ${opts.date} from ${opts.count} edits)_${receipt}`;
  let text = lf(md ?? "");

  const heading = /^##\s+Learned\s*$/m.exec(text);
  if (heading) {
    const from = heading.index + heading[0].length;
    const rest = text.slice(from);
    const next = /^##\s/m.exec(rest);
    const end = next ? from + next.index : text.length;
    const section = text.slice(from, end);
    // Keep the blank lines that separated this section from the next, so the
    // rule lands under the last existing line rather than after the gap.
    const trailing = /\n*$/.exec(section)?.[0] ?? "";
    const core = trailing ? section.slice(0, section.length - trailing.length) : section;
    const appended = core.trim() === "" ? `\n\n${line}` : `${core}\n${line}`;
    text = text.slice(0, from) + appended + trailing + text.slice(end);
  } else {
    text = `${text.replace(/\n*$/, "")}\n\n## Learned\n\n${line}\n`;
  }

  return touchFrontmatter(text, opts.date);
}

/** Acceptance is deduplicated by occurrence, never by arbitrary equal rule text. */
export function hasLearnedReceipt(md: string, occurrenceId: string): boolean {
  return md.includes(`<!-- recall-accept: ${encodeURIComponent(occurrenceId)} -->`);
}

/** Bump `learned_count` and move `updated`, creating the frontmatter when the note has none. */
function touchFrontmatter(text: string, date: string): string {
  const m = /^(---\n)([\s\S]*?)(\n---)/.exec(text);
  if (!m) {
    return `---\nversion: 1\nupdated: ${date}\nlearned_count: 1\n---\n\n${text.replace(/^\n+/, "")}`;
  }
  let fm = m[2];
  const count = Number(/^learned_count:\s*(.+)$/m.exec(fm)?.[1]?.trim());
  const next = (Number.isFinite(count) ? count : 0) + 1;
  fm = /^learned_count:/m.test(fm) ? fm.replace(/^learned_count:.*$/m, `learned_count: ${next}`) : `${fm}\nlearned_count: ${next}`;
  fm = /^updated:/m.test(fm) ? fm.replace(/^updated:.*$/m, `updated: ${date}`) : `${fm}\nupdated: ${date}`;
  return text.slice(0, m.index) + m[1] + fm + m[3] + text.slice(m.index + m[0].length);
}

// ---- suggestions

/**
 * A rule Recall noticed in the reader's own card edits and would like to adopt.
 *
 * It is a proposal and nothing more: until the reader accepts it, no model call
 * sees it. `applied` and `dismissed` are both terminal, and both are recorded
 * rather than deleted, so the same observation is not proposed twice.
 */
export interface Proposal {
  id: string;
  /** Identifies this decision, not the recurring pattern in `id`. */
  occurrenceId?: string;
  date: string;
  status: "open" | "applied" | "dismissed" | "superseded" | "withdrawn";
  /** The day its status changed; absent while open. */
  statusDate?: string;
  summary: string;
  rule: string;
  /** Original generated wording, so hand-edited wording is never mistaken for it. */
  suggestedRule?: string;
  evidence: string[];
  count: number;
}

/**
 * The path is a parameter because the reader can move the schema folder in the
 * settings: the sentence below tells them where to accept a rule by hand, and a
 * hardcoded path would send them to a file their vault does not have. The
 * default is the default setting's path, for a caller with nothing better.
 */
export function renderEmptySuggestions(schemaPath = "Review Inbox/recall-rules.md"): string {
  return `# Recall Studio Card Rule Suggestions

> These are rules Recall Studio noticed in your own edits to its cards. None of them is in force. Accept one by copying its rule into a section of \`${schemaPath}\`, or dismiss it; either way the entry stays here so the same observation is not proposed to you twice.

---
`;
}

/** One proposal as an appendable block, ending in its own `---` so blocks concatenate. */
export function renderProposal(p: Omit<Proposal, "status" | "statusDate">): string {
  const evidence = p.evidence.map((e) => `- ${e}`).join("\n");
  return `## Suggestion — ${p.date}
<!-- id: ${p.id} status: open -->
${p.occurrenceId ? `<!-- occurrence: ${p.occurrenceId} -->\n` : ""}
<!-- suggested-rule: ${encodeURIComponent(p.suggestedRule ?? p.rule)} -->
**Noticed:** ${p.summary}
**Rule:** ${p.rule}
**Evidence (${p.count} edits):**
${evidence}

---
`;
}

const ID_LINE = /^<!--\s*id:\s*(.+?)\s+status:\s*(open|applied|dismissed|superseded|withdrawn)(?:\s+(\S+))?\s*-->\s*$/;

/** Every proposal in the file, in order. A block missing its comment line is skipped rather than guessed at. */
export function parseProposals(md: string): Proposal[] {
  return proposalEntries(md).map(e => e.proposal);
}

function proposalEntries(md: string): Array<{ proposal: Proposal; from: number; to: number }> {
  const text = lf(md ?? "");
  const out: Array<{ proposal: Proposal; from: number; to: number }> = [];
  const occurrences = new Map<string, number>();
  const reserved = new Set([...text.matchAll(/^<!-- occurrence: (\S+) -->$/gm)].map(m => m[1]));
  const heads = [...text.matchAll(/^##\s+Suggestion\s+—\s*(.*)$/gm)];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index ?? 0;
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length;
    const block = text.slice(start, end);
    const lines = block.split("\n");
    const idMatch = lines.map((l) => ID_LINE.exec(l)).find((x): x is RegExpExecArray => x !== null);
    if (!idMatch) continue;
    const explicit = /^<!-- occurrence: (\S+) -->$/m.exec(block)?.[1];
    let ordinal = (occurrences.get(idMatch[1]) ?? 0) + 1;
    while (reserved.has(`legacy:${encodeURIComponent(idMatch[1])}:${ordinal}`)) ordinal++;
    if (!explicit) occurrences.set(idMatch[1], ordinal);
    const occurrenceId = explicit ?? `legacy:${encodeURIComponent(idMatch[1])}:${ordinal}`;
    const status = idMatch[2] as Proposal["status"];
    const evidence: string[] = [];
    let inEvidence = false;
    for (const line of lines) {
      if (/^\*\*Evidence\b/.test(line)) {
        inEvidence = true;
        continue;
      }
      if (!inEvidence) continue;
      if (/^-\s+/.test(line)) evidence.push(line.replace(/^-\s+/, "").trim());
      else if (line.trim() !== "") break;
    }
    const count = Number(/^\*\*Evidence\s*\((\d+)\s+edits\)/m.exec(block)?.[1]);
    out.push({ from: start, to: end, proposal: {
      id: idMatch[1],
      occurrenceId,
      date: (heads[i][1] ?? "").trim(),
      status,
      ...(status !== "open" && idMatch[3] ? { statusDate: idMatch[3] } : {}),
      summary: /^\*\*Noticed:\*\*\s*(.*)$/m.exec(block)?.[1]?.trim() ?? "",
      rule: /^\*\*Rule:\*\*\s*(.*)$/m.exec(block)?.[1]?.trim() ?? "",
      suggestedRule: decodeRule(/^<!-- suggested-rule: (\S+) -->$/m.exec(block)?.[1]),
      evidence,
      count: Number.isFinite(count) ? count : evidence.length,
    } });
  }
  return out;
}

function decodeRule(encoded?: string): string | undefined {
  try { return encoded === undefined ? undefined : decodeURIComponent(encoded); }
  catch { return undefined; }
}

/** Freeze a legacy address before a cross-file decision can be partially saved. */
export function persistProposalIdentity(md: string, occurrenceId: string): string {
  const text = lf(md);
  const target = proposalEntries(text).find(e => e.proposal.occurrenceId === occurrenceId);
  if (!target) throw new Error("The selected suggestion is missing. Refresh suggestions.");
  const block = text.slice(target.from, target.to);
  if (/^<!-- occurrence:/m.test(block)) return md;
  const next = block.split("\n").map(line => ID_LINE.test(line)
    ? `${line}\n<!-- occurrence: ${occurrenceId} -->` : line).join("\n");
  return text.slice(0, target.from) + next + text.slice(target.to);
}

/**
 * Accept or dismiss one proposal, by rewriting its comment line and nothing
 * else. The reader may have annotated a block; those notes are theirs to keep,
 * and an unknown id is a no-op rather than an append.
 */
export function setProposalStatus(md: string, id: string, status: Exclude<Proposal["status"], "open">, date: string): string {
  const text = lf(md ?? "");
  const entries = proposalEntries(text);
  const target = entries.find(e => e.proposal.occurrenceId === id)
    ?? entries.find(e => e.proposal.id === id && e.proposal.status === "open");
  if (!target || target.proposal.status !== "open") return md;
  const block = text.slice(target.from, target.to).split("\n").map(line =>
    ID_LINE.test(line) ? `<!-- id: ${target.proposal.id} status: ${status} ${date} -->` : line,
  ).join("\n");
  return text.slice(0, target.from) + block + text.slice(target.to);
}
