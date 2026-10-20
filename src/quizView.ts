import type { App } from "obsidian";
import { indexPage } from "./pageIndex";
import { buildItems, startRecall, nextItem, sectionIn, checkQuestion, acceptQuestion, questionPoints, skipRecall, recallMisses, afterFirstAttempt, renderRevealMarkdown, itemById, type RecallSession } from "./recall";
import type { QuizChoiceDraft, QuizChoiceAudit } from "./quizSchemas";
import { validatedQuizGrade, validateQuizAudit, validateQuizChoices, validateChoiceAudit } from "./quizValidation";
import { QuizSources, type QuizSource } from "./quizSources";
import { makeHighlight } from "./model";
import { parseQuizCommand, isDontKnow } from "./quiz";
import { resolveQuizTarget, type QuizNote } from "./quizTarget";
import type { ChatStore, ChatGenerator } from "./reviewChatView";
import type { QuizQuestionMessageArgs, QuizRecallGradeMessageArgs } from "./prompt";
import type { QuizQuestionDraft, QuizRecallGradeDraft } from "./schemas";

export interface QuizLlm {
  quizQuestionAudit(args: QuizQuestionMessageArgs & { draft: QuizQuestionDraft }): Promise<{ supported: boolean }>;
  quizQuestion(args: QuizQuestionMessageArgs): Promise<QuizQuestionDraft>;
  quizRecallGrade(args: QuizRecallGradeMessageArgs): Promise<QuizRecallGradeDraft>;
  quizMultipleChoice(args: QuizQuestionMessageArgs): Promise<QuizChoiceDraft>;
  quizChoiceAudit(args: QuizQuestionMessageArgs & { draft: QuizChoiceDraft }): Promise<QuizChoiceAudit>;
  quizGradeAudit(args: QuizRecallGradeMessageArgs & { grade: QuizRecallGradeDraft }): Promise<{ points: Array<{ n: number; agrees: boolean }> }>;
}
export interface QuizHost {
  app: App;
  settings?: { schemaFolder?: string; exportFolder?: string };
  llm: QuizLlm;
  store: ChatStore;
  generator: ChatGenerator;
  openInbox(): void | Promise<void>;
}
interface Turn { role: "assistant" | "user"; text: string }

/** Quiz uses the existing Recall session, with old conversation kept only for display. */
export class QuizView {
  private turns: Turn[] = [];
  private draftQuestion = "";
  private cancelled = false;
  private busy = false;
  private status = "";
  private session: RecallSession | null = null;
  private target: { paths: string[]; label: string } | null = null;
  private choices: QuizNote[] = [];
  private choosingMode = false;
  private mode: "free" | "mc" = "free";
  private mc: QuizChoiceDraft | null = null;
  private sent = new Map<string, string>();

  private epoch = 0;
  private sources: QuizSource[] = [];
  private reader: QuizSources;
  constructor(private contentEl: HTMLElement, private host: QuizHost) {
    this.reader = new QuizSources(host.app, () => host.settings ?? {});
  }
  private cleanup: Array<() => void> = [];
  async onOpen(): Promise<void> {
    this.cancelled = false; this.contentEl.addClass("review-chat");
    const refresh = () => this.refreshSources();
    for (const ref of [this.host.app.vault.on?.("modify", refresh), this.host.app.vault.on?.("rename", refresh), this.host.app.vault.on?.("delete", refresh)]) {
      if (ref) this.cleanup.push(() => this.host.app.vault.offref?.(ref));
    }
    const editor = this.host.app.workspace.on?.("editor-change", () => this.refreshSources());
    if (editor) this.cleanup.push(() => this.host.app.workspace.offref?.(editor));
    const metadata = this.host.app.metadataCache?.on?.("resolved", () => this.refreshSources());
    if (metadata) this.cleanup.push(() => this.host.app.metadataCache.offref?.(metadata));
    this.render();
  }
  async onClose(): Promise<void> { for (const dispose of this.cleanup.splice(0)) dispose(); this.cancel(); this.cancelled = true; }
  private cancel(): void {
    this.epoch++; this.busy = false; this.session = null; this.sources = [];
    this.target = null; this.choices = []; this.choosingMode = false; this.mc = null;
    this.status = "Quiz cancelled. No review schedule changed."; this.render();
  }
  refreshSources(): void {
    if (this.sources.length && !this.sources.every(s => this.reader.current(s))) {
      this.cancel(); this.status = "Quiz source changed or access was revoked. Start again."; this.render();
    }
  }
  private authorized(epoch: number): boolean {
    return !this.cancelled && this.epoch === epoch && this.sources.length > 0 && this.sources.every(s => this.reader.current(s));
  }
  private requireCurrent(epoch: number): void {
    if (!this.authorized(epoch)) { this.refreshSources(); throw Error("stale quiz"); }
  }

  private notes(): QuizNote[] {
    return this.host.app.vault.getFiles().filter(f => f.extension.toLowerCase() === "md" && this.reader.allowed(f.path)).map(f => {
      const cache = this.host.app.metadataCache?.getFileCache(f);
      const values = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((s): s is string => typeof s === "string");
      return { path: f.path, name: f.basename, aliases: [...values(cache?.frontmatter?.aliases), ...values(cache?.frontmatter?.alias)], tags: [...values(cache?.frontmatter?.tags).flatMap(t => t.split(/[,\s]+/)).filter(Boolean).map(t => t.startsWith("#") ? t : `#${t}`), ...(cache?.tags ?? []).map(t => t.tag)] };
    });
  }

  private async ask(): Promise<void> {
    const text = this.draftQuestion.trim();
    if (!text) return;
    const command = parseQuizCommand(text, !!this.session || this.choosingMode);
    if (command?.kind === "stop") { this.cancel(); return; }
    if (command?.kind === "start") {
      this.epoch++; this.busy = false; this.sources = [];
      this.session = null; this.mc = null; this.choices = []; this.target = null; this.choosingMode = false;
      const query = command.scope === "this" ? "" : command.query || "all";
      const resolved = resolveQuizTarget(query, this.notes(), this.host.app.workspace.getActiveFile?.()?.path ?? null);
      this.turns.push({ role: "user", text }); this.draftQuestion = "";
      if (resolved.kind === "resolved") { this.target = resolved; this.choosingMode = true; this.status = "Choose a question format."; }
      else if (resolved.kind === "choices") { this.choices = resolved.choices; this.status = "Choose a note. No source has been sent."; }
      else this.status = "No eligible note or tag matched. Name a note, path, alias or #tag.";
      this.render(); return;
    }
    if (this.busy) return;
    if (command?.kind === "hint") { this.hint(); this.draftQuestion = ""; return; }
    if (command?.kind === "skip" || (this.session?.current && isDontKnow(text))) {
      this.draftQuestion = "";
      if (this.session?.current) this.skip(); else await this.advance();
      return;
    }
    if (this.mc && this.session?.current) {
      this.submitChoice(text); return;
    }
    if (!this.session?.current) { this.status = "Start with ‘quiz me’ or ‘quiz me on Note name’."; this.render(); return; }
    this.busy = true; const epoch = this.epoch; this.render();
    try {
      this.requireCurrent(epoch);
      const session = this.session;
      const item = itemById(session, session.current!.itemId)!;
      const args = { ...sectionIn(item), points: questionPoints(session).map(p => p.text), question: session.current!.cue, answer: text, cued: false, authorized: () => this.authorized(epoch) };
      const draft = await this.host.llm.quizRecallGrade(args);
      this.requireCurrent(epoch);
      const marks = validatedQuizGrade(draft, questionPoints(session), text);
      const audit = await this.host.llm.quizGradeAudit({ ...args, grade: draft });
      this.requireCurrent(epoch);
      validateQuizAudit(audit, marks.length);
      // Source excerpts are the feedback. Generated elaboration and hints are not evidence.
      this.session = afterFirstAttempt(session, text, marks, "", true);
      this.turns.push({ role: "user", text }); this.draftQuestion = "";
      this.status = "";
    } catch { if (epoch === this.epoch) this.status = "Could not validate the grade. No attempt counted; retry your answer."; }
    finally { if (epoch === this.epoch) { this.busy = false; this.render(); } }
  }

  private async begin(mode: "free" | "mc" = "free"): Promise<void> {
    if (!this.target || this.busy) return;
    this.mode = mode; this.mc = null; this.sent.clear();
    this.busy = true; this.choosingMode = false; const epoch = this.epoch; this.render();
    try {
      if (this.target.paths.length > 20) throw Error("too many sources");
      const units = [];
      this.sources = [];
      let chars = 0;
      for (const path of this.target.paths) {
        const source = await this.reader.read(path);
        if (this.cancelled || epoch !== this.epoch) return;
        this.sources.push(source); this.requireCurrent(epoch);
        chars += source.text.length;
        if (chars > 250_000) throw Error("source budget exceeded");
        units.push(...indexPage(path, source.text));
      }
      const items = buildItems(units);
      if (items.some(i => i.points.reduce((n, p) => n + p.text.length, 0) > 12_000)) throw Error("section too large");
      this.session = startRecall({ kind: "note", label: this.target.label }, "", items, 20);
      await this.nextQuestion();
    } catch { if (epoch === this.epoch) this.status = "Could not read or validate the quiz source (20 notes, 100,000 characters each, 250,000 total, 12,000 per section). Start again."; }
    finally { if (epoch === this.epoch) { this.busy = false; this.render(); } }
  }
  private async nextQuestion(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const item = nextItem(session);
    if (!item || session.finished) { this.status = "Quiz complete."; return; }
    const epoch = this.epoch;
    this.requireCurrent(epoch);
    const args: QuizQuestionMessageArgs = { ...sectionIn(item), level: 1, asked: [], standingInstructions: "", failure: "", authorized: () => this.authorized(epoch) };
    if (this.mode === "mc") {
      const draft = validateQuizChoices(await this.host.llm.quizMultipleChoice(args), item);
      this.requireCurrent(epoch);
      const audit = await this.host.llm.quizChoiceAudit({ ...args, draft });
      this.requireCurrent(epoch); validateChoiceAudit(audit, draft);
      this.mc = draft;
      this.session = acceptQuestion(session, item, draft.question, "concept", false, [item.points[draft.point - 1].id]);
      this.status = ""; return;
    }
    const draft = await this.host.llm.quizQuestion(args);
    const checked = checkQuestion(draft, item);
    if (!checked.ok) throw Error("invalid question");
    this.requireCurrent(epoch);
    const audit = await this.host.llm.quizQuestionAudit({ ...args, draft });
    this.requireCurrent(epoch);
    if (audit.supported !== true) throw Error("unsupported question");
    this.session = acceptQuestion(session, item, checked.cue, checked.shape, false, checked.expects);
    this.status = "";
  }

  private async advance(): Promise<void> {
    if (this.busy) return;
    const epoch = this.epoch;
    this.busy = true; this.render();
    try { await this.nextQuestion(); }
    catch { if (epoch === this.epoch) this.status = "Could not validate a question. Retry."; }
    finally { if (epoch === this.epoch) { this.busy = false; this.render(); } }
  }

  private hint(): void {
    if (!this.session?.current || this.busy) return;
    try {
      this.requireCurrent(this.epoch);
      const item = itemById(this.session, this.session.current.itemId)!;
      // shortcut: hints name the source section only; add semantically verified hints before elaborating.
      this.status = `Think of the main idea in ${item.noteTitle}${item.section ? ` › ${item.section}` : ""}.`;
    } catch { this.status = "Quiz source changed. Start again."; }
    this.render();
  }
  private skip(): void {
    if (!this.session?.current || this.busy) return;
    try { this.requireCurrent(this.epoch); this.session = skipRecall(this.session, ""); this.mc = null; this.status = ""; }
    catch { this.status = "Quiz source changed. Start again."; }
    this.render();
  }
  private sendMiss(id: string): void {
    if (!this.session || this.sent.has(id) || this.busy) return;
    try {
      this.requireCurrent(this.epoch);
      const miss = recallMisses(this.session).find(m => m.unit.id === id);
      if (!miss) return;
      const unit = miss.unit;
      const normalized = unit.text.replace(/\s+/g, " ").trim();
      const duplicate = this.host.store.all().some(h => h.sourcePath === unit.notePath && h.text.replace(/\s+/g, " ").trim() === normalized) || this.host.store.hasDuplicate?.(unit.notePath, normalized);
      if (duplicate) { this.sent.set(id, "Already captured"); this.render(); return; }
      const source = this.sources.find(s => s.path === unit.notePath)!;
      const line = Math.max(0, source.text.split("\n").findIndex(t => t.includes(unit.text)));
      const h = makeHighlight({ sourcePath: unit.notePath, sourceTitle: unit.noteTitle, text: unit.text, line, page: null,
        title: unit.text.slice(0, 80), instruction: "The reader missed this source point during Quiz. Test only what the quoted passage states.", origin: "quiz" });
      const stored = this.host.store.add(h);
      this.sent.set(id, stored.id === h.id ? "Sent to Inbox" : "Already captured");
      if (stored.id === h.id) this.host.generator.enqueue(stored);
    } catch { this.status = "Could not send this source. Check access and retry."; }
    this.render();
  }

  private submitChoice(id: string): void {
    if (this.busy || !this.session?.current || !this.mc) return;
    try {
      this.requireCurrent(this.epoch);
      if (!this.mc.choices.some(c => c.id === id)) return;
      const correct = id === this.mc.correctId;
      const marks = questionPoints(this.session).map(p => ({ unitId: p.id, status: correct ? "recalled" as const : "wrong" as const, said: "", verified: true, note: "", cue: "", dispute: false }));
      this.session = afterFirstAttempt(this.session, id, marks, "", true);
      this.mc = null; this.status = "";
    } catch { this.status = "Quiz source changed. Start again."; }
    this.render();
  }

  private render(): void {
    const root = this.contentEl; root.empty();
    root.createEl("h3", { text: "Quiz" });
    const log = root.createDiv({ cls: "review-chat-log" });
    for (const turn of this.turns) log.createDiv({ cls: `review-chat-turn is-${turn.role}`, text: turn.text });
    const action = (label: string, fn: () => void | Promise<void>) => {
      const b = root.createEl("button", { text: label, attr: { type: "button" } });
      b.disabled = this.busy; b.addEventListener("click", fn); return b;
    };
    for (const choice of this.choices) action(choice.path, () => { this.target = { paths: [choice.path], label: choice.name }; this.choices = []; this.choosingMode = true; this.render(); });
    if (this.choosingMode) {
      action("Free response", () => this.begin("free"));
      action("Multiple choice", () => this.begin("mc"));
    }
    const sourceLink = (path: string, title: string) => {
      const a = root.createEl("a", { text: title, href: path });
      a.addEventListener("click", e => { e.preventDefault(); if (this.reader.allowed(path)) void this.host.app.workspace.openLinkText(path, "", false); });
    };
    const session = this.session;
    if (session?.current) {
      const item = itemById(session, session.current.itemId)!;
      sourceLink(item.notePath, item.noteTitle);
      root.createDiv({ cls: "review-chat-a", text: session.current.cue });
      if (this.mc) for (const choice of this.mc.choices) action(`${choice.id}. ${choice.text}`, () => this.submitChoice(choice.id));
      action("Hint", () => this.hint()); action("Skip", () => this.skip());
    }
    for (const result of session?.results ?? []) {
      const item = itemById(session!, result.itemId);
      if (item) {
        root.createDiv({ cls: "review-chat-a", text: renderRevealMarkdown(result, item) });
        sourceLink(item.notePath, item.noteTitle);
        root.createDiv({ cls: "review-chat-grounding", text: this.mode === "free" ? "AI-checked grading; compare with the source excerpts." : "Choice graded locally against the checked answer key." });
      }
    }
    for (const miss of session ? recallMisses(session) : []) {
      const b = action(this.sent.get(miss.unit.id) ?? "Send to Inbox", () => this.sendMiss(miss.unit.id));
      b.setAttribute("aria-label", `Send missed source point to Inbox: ${miss.unit.text}`);
      b.disabled = this.busy || this.sent.has(miss.unit.id);
    }
    if (session && !session.current && !session.finished) action("Next question", () => this.advance());
    const form = root.createDiv({ cls: "review-chat-input" });
    const box = form.createEl("textarea", { attr: { rows: "2", "aria-label": session?.current ? "Your answer" : "Quiz request", placeholder: "quiz me on Note name or #tag" } });
    box.value = this.draftQuestion; box.maxLength = 4000; box.disabled = this.busy;
    box.addEventListener("input", () => { this.draftQuestion = box.value; });
    if (!this.mc) action(session?.current ? "Submit answer" : "Start quiz", () => this.ask());
    action("Cancel quiz", () => this.cancel()).disabled = false;
    if (this.status) root.createDiv({ cls: "review-chat-status", text: this.status, attr: { role: "status", "aria-live": "polite" } });
  }
}
