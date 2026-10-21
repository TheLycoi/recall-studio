import { makeHighlight, type Highlight } from "./model";
import { normalizeWs } from "./util";
import type { App, TFile } from "obsidian";
import { ChatRetriever } from "./chatRetrieval";
import { QuizSources, type QuizSource } from "./quizSources";
import { DEFAULT_RULES_FOLDER, DEFAULT_EXPORT_FOLDER } from "./paths";
import { buildChatEvidence, type ChatSeed } from "./reviewChat";
import { STUDY_GUIDE_MAX_CHARS, studyGuideLines, validateStudyEvidence, type StudyEvidenceArgs, type StudyEvidenceDraft } from "./studySchemas";
import type { ChatStore, ChatGenerator } from "./reviewChatView";

export { STUDY_GUIDE_MAX_CHARS } from "./studySchemas";
export interface StudyRequest { mode: "quiz" | "flashcards"; topic: string; guide: string }
export interface StudyPassage { id: string; path: string; title: string; text: string; line: number; page: number | null }
export interface StudyPlan { request: StudyRequest; passages: StudyPassage[]; gaps: string[]; skipped: string[]; truncated: boolean }
export interface StudyHost {
  app: App;
  settings?: { schemaFolder?: string; exportFolder?: string };
  llm: {
    requestAuthorization(authorized?: () => boolean): () => boolean;
    selectStudyEvidence(args: StudyEvidenceArgs): Promise<StudyEvidenceDraft>;
  };
  store: ChatStore & { allHistory(): Highlight[]; touch(): void };
  generator: ChatGenerator;
}
interface Prepared { plan: StudyPlan; snapshot: StudyPlan; fingerprint: string; authorized: () => boolean; captured?: { highlightIds: string[] } }

function editorSnapshots(app: App, allowed: (path: string) => boolean): Map<string, string | false> {
  const texts = new Map<string, string | false>();
  for (const leaf of app.workspace.getLeavesOfType?.("markdown") ?? []) {
    const view = leaf.view as unknown as { file?: TFile; editor?: { getValue(): string } };
    if (!view.file || !view.editor || !allowed(view.file.path)) continue;
    const text = view.editor.getValue(), previous = texts.get(view.file.path);
    texts.set(view.file.path, previous === undefined || previous === text ? text : false);
  }
  return texts;
}

/** A run owns its snapshots; retrieval caches and old assistant answers are never sources. */
export class StudyCoordinator {
  private epoch = 0;
  private prepared: Prepared | null = null;
  constructor(private host: StudyHost) {}

  cancel(): void { this.epoch++; this.prepared = null; }

  current(plan: StudyPlan): boolean {
    try {
      if (this.prepared?.plan !== plan) return false;
      if (JSON.stringify(structuredClone(plan)) === this.prepared.fingerprint && this.prepared.authorized()) return true;
    } catch { /* An unreadable or mutated plan is revoked, never renewed. */ }
    this.prepared = null;
    return false;
  }

  capture(plan: StudyPlan): { added: number; duplicates: number; highlightIds: string[] } {
    if (!this.current(plan) || this.prepared!.snapshot.request.mode !== "flashcards") throw Error("Study plan is stale or not a flashcard plan.");
    const prepared = this.prepared!;
    const evidence = prepared.snapshot;
    if (prepared.captured) return { added: 0, duplicates: evidence.passages.length, highlightIds: [...new Set(prepared.captured.highlightIds)] };
    const pending: Highlight[] = [];
    const highlightIds: string[] = [];
    let duplicates = 0;
    for (const passage of evidence.passages) {
      const normalized = normalizeWs(passage.text);
      const existing = [...this.host.store.allHistory(), ...pending].find(h => h.sourcePath === passage.path && normalizeWs(h.text) === normalized);
      if (existing || this.host.store.hasDuplicate?.(passage.path, normalized)) {
        duplicates++; if (existing) highlightIds.push(existing.id); continue;
      }
      pending.push(makeHighlight({ sourcePath: passage.path, sourceTitle: passage.title, text: passage.text, line: passage.line - 1, page: passage.page,
        heading: passage.page === null ? null : `page ${passage.page}`, origin: passage.page === null ? "selection" : "pdf",
        instruction: `Study topic: ${evidence.request.topic}\nCoverage instructions only, not factual evidence:\n${evidence.request.guide}\nUse only facts stated in this captured passage.`,
      }));
    }
    if (!this.current(plan)) throw Error("Study source authorization expired before capture.");
    // Consume before callbacks so reentrant or failed writes cannot queue a second batch.
    prepared.captured = { highlightIds };
    for (const h of pending) {
      if (!this.current(plan)) throw Error("Study source authorization expired during capture.");
      this.host.store.add(h);
      highlightIds.push(h.id);
      if (!this.current(plan)) {
        h.status = "error";
        h.error = "Study source authorization expired during capture; generation was not queued.";
        this.host.store.touch();
        throw Error(h.error);
      }
      this.host.generator.enqueue(h);
    }
    return { added: pending.length, duplicates, highlightIds: [...new Set(highlightIds)] };
  }

  async prepare(input: StudyRequest, paths?: readonly string[]): Promise<StudyPlan> {
    this.cancel();
    if (input.mode !== "quiz" && input.mode !== "flashcards") throw Error("Invalid study mode.");
    if (!input.topic.trim()) throw Error("A study topic is required.");
    if (!input.guide.trim()) throw Error("A fresh study guide is required.");
    if (input.guide.length > STUDY_GUIDE_MAX_CHARS) throw Error(`Study guide exceeds ${STUDY_GUIDE_MAX_CHARS} characters.`);
    const request = { ...input };
    const epoch = this.epoch;
    const { app, llm, store, generator } = this.host;
    const settings = JSON.stringify(this.host.settings);
    const reader = new QuizSources(app, () => ({ schemaFolder: this.host.settings?.schemaFolder ?? DEFAULT_RULES_FOLDER, exportFolder: this.host.settings?.exportFolder ?? DEFAULT_EXPORT_FOLDER }));
    const snapshots: QuizSource[] = [];
    let revoked = false;
    const lifecycle = llm.requestAuthorization(() => epoch === this.epoch);
    const authorized = () => {
      try {
        if (revoked || !lifecycle() || this.host.app !== app || this.host.llm !== llm || this.host.store !== store || this.host.generator !== generator || JSON.stringify(this.host.settings) !== settings) { revoked = true; return false; }
        const files = new Map(app.vault.getFiles().map(file => [file.path, file]));
        const tracked = new Set(snapshots.map(source => source.path));
        const editors = editorSnapshots(app, path => tracked.has(path) && reader.allowed(path));
        if (!snapshots.every(source => {
          const file = files.get(source.path);
          return reader.allowed(source.path) && file === source.file && file.path === source.path && file.stat.mtime === source.mtime && file.stat.size === source.size && (editors.get(source.path) ?? null) === source.editorText;
        })) revoked = true;
      } catch { revoked = true; }
      return !revoked;
    };
    const requireCurrent = () => { if (!authorized()) throw Error("Study source authorization expired; sources changed or study cancelled."); };
    requireCurrent();
    const all = app.vault.getFiles();
    const scope = paths === undefined ? all.map(f => f.path) : [...new Set(paths)];
    const skipped: string[] = [];
    const scoped = new Set(scope);
    const editors = editorSnapshots(app, path => scoped.has(path) && reader.allowed(path));
    for (const path of scope) {
      const file = all.find(f => f.path === path);
      if (!reader.allowed(path)) { skipped.push(`${path}: excluded by source access controls`); continue; }
      if (!file) { skipped.push(`${path}: source not found`); continue; }
      if (!/^(md|pdf)$/i.test(file.extension)) { skipped.push(`${path}: unsupported source type`); continue; }
      const editorText = editors.get(path) ?? null;
      if (editorText === false) { skipped.push(`${path}: conflicting editors; source not searched`); continue; }
      snapshots.push({ file, path, mtime: file.stat.mtime, size: file.stat.size, editorText, text: "" });
    }
    const vault = Object.create(app.vault) as App["vault"];
    vault.getFiles = () => app.vault.getFiles();
    vault.cachedRead = async file => {
      requireCurrent();
      const source = await reader.read(file.path);
      requireCurrent();
      return source.text;
    };
    vault.readBinary = async file => {
      requireCurrent();
      const bytes = await app.vault.readBinary(file);
      requireCurrent();
      return bytes;
    };
    const retrievalApp = Object.assign(Object.create(app), { vault }) as App;
    const roots = new Map<string, ChatSeed>();
    const result = await new ChatRetriever(retrievalApp, path => reader.allowed(path)).search(request.topic, {
      paths: snapshots.map(s => s.path), cancelled: () => !authorized(),
      includeUnmatched: paths !== undefined,
      onSource: (seeds, ranked) => {
        const retained = new Set(ranked.map(s => JSON.stringify([s.path, s.page])));
        for (const key of roots.keys()) if (!retained.has(key)) roots.delete(key);
        for (const seed of seeds) {
          const key = JSON.stringify([seed.path, seed.page]);
          if (retained.has(key)) roots.set(key, seed);
        }
      },
    });
    requireCurrent();
    const bounded = buildChatEvidence(result.seeds);
    const passages: StudyPassage[] = [];
    const spanStarts = new Map<string, number>();
    for (const candidate of bounded.evidence) {
      const root = roots.get(JSON.stringify([candidate.path, candidate.page]))!;
      const starts: number[] = [];
      for (let at = root.text.indexOf(candidate.text); at !== -1; at = root.text.indexOf(candidate.text, at + 1)) {
        if (root.line + (root.text.slice(0, at).match(/\n/g)?.length ?? 0) === candidate.line) starts.push(at);
      }
      if (starts.length !== 1) { skipped.push(`${candidate.path}: ambiguous passage location; not sent`); continue; }
      const id = String(passages.length + 1);
      spanStarts.set(id, starts[0]);
      passages.push({ id, path: candidate.path, title: candidate.title, text: candidate.text, line: candidate.line, page: candidate.page });
    }
    const selected = passages.length
      ? validateStudyEvidence(await llm.selectStudyEvidence({ topic: request.topic, guide: request.guide, passages, authorized }), passages, request.guide, spanStarts)
      : { passages: [], gaps: studyGuideLines(request.guide) };
    requireCurrent();
    if (!selected.passages.length) selected.gaps = studyGuideLines(request.guide);
    // Candidates are bounded to top-40 / 12,000 characters, not exhaustive guide coverage.
    const plan = { request, ...selected, skipped: [...skipped, ...result.skipped], truncated: true };
    this.prepared = { plan, snapshot: structuredClone(plan), fingerprint: JSON.stringify(plan), authorized };
    return plan;
  }
}
