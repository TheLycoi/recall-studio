import type { App } from "obsidian";
import { StudyCoordinator, STUDY_GUIDE_MAX_CHARS, STUDY_MESSAGE_MAX_CHARS, type StudyHost, type StudyPlan, type StudyPassage } from "./study";
import { indexPage } from "./pageIndex";
import { readStudyGuidePdf, StudyGuidePdfError, type StudyGuidePdf } from "./studyGuidePdf";
import { QUIZ_COVERAGE_PREFIX, QUIZ_COVERAGE_SUFFIX } from "./prompt";
import { buildItems, startRecall, nextItem, sectionIn, checkQuestion, acceptQuestion, questionPoints, skipRecall, recallMisses, afterFirstAttempt, renderRevealMarkdown, itemById, type RecallSession } from "./recall";
import type { QuizChoiceDraft, QuizChoiceAudit } from "./quizSchemas";
import { validatedQuizGrade, validateQuizAudit, validateQuizChoices, validateChoiceAudit } from "./quizValidation";
import { QuizSources } from "./quizSources";
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
  llm: QuizLlm & StudyHost["llm"];
  store: StudyHost["store"];
  generator: ChatGenerator;
  openInbox(): void | Promise<void>;
}
interface Turn { role: "assistant" | "user"; text: string; current?: () => boolean; source?: StudyPassage }

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
  private awaitingGuide = false;
  private awaitingTopic = false;
  private guide = "";
  private guidePdf: StudyGuidePdf | null = null;
  private pdfRead: { controller: AbortController; name: string } | null = null;
  private pdfError = "";
  private pdfEpoch = 0;
  private topic = "";
  private studyMode: "quiz" | "flashcards" = "quiz";
  private study: StudyCoordinator;
  private plan: StudyPlan | null = null;
  private mode: "free" | "mc" = "free";
  private mc: QuizChoiceDraft | null = null;
  private sent = new Map<string, string>();

  private epoch = 0;
  private unitSources = new Map<string, StudyPassage>();
  private reader: QuizSources;
  constructor(private contentEl: HTMLElement, private host: QuizHost) {
    this.reader = new QuizSources(host.app, () => host.settings ?? {});
    this.study = new StudyCoordinator(host);
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
    this.clearPdf();
    this.epoch++; this.study.cancel(); this.plan = null; this.busy = false; this.session = null; this.unitSources.clear();
    this.target = null; this.choices = []; this.choosingMode = false; this.awaitingTopic = false; this.awaitingGuide = false; this.guide = ""; this.mc = null;
    this.status = "Quiz cancelled. No review schedule changed."; this.render();
  }
  refreshSources(): void {
    if (this.plan && !this.study.current(this.plan)) {
      this.cancel(); this.status = "Study source changed or access was revoked. Start again.";
    }
    this.render();
  }
  private authorized(epoch: number): boolean {
    return !this.cancelled && this.epoch === epoch && !!this.plan && this.study.current(this.plan);
  }
  private requireCurrent(epoch: number): void {
    if (!this.authorized(epoch)) { this.refreshSources(); throw Error("stale quiz"); }
  }

  private notes(): QuizNote[] {
    return this.host.app.vault.getFiles().filter(f => /^(md|pdf)$/i.test(f.extension) && this.reader.allowed(f.path)).map(f => {
      const cache = this.host.app.metadataCache?.getFileCache(f);
      const values = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((s): s is string => typeof s === "string");
      return { path: f.path, name: f.basename, aliases: [...values(cache?.frontmatter?.aliases), ...values(cache?.frontmatter?.alias)], tags: [...values(cache?.frontmatter?.tags).flatMap(t => t.split(/[,\s]+/)).filter(Boolean).map(t => t.startsWith("#") ? t : `#${t}`), ...(cache?.tags ?? []).map(t => t.tag)] };
    });
  }

  async submit(message: string): Promise<boolean> {
    if (this.cancelled || this.busy || this.draftQuestion) return false;
    this.draftQuestion = message; await this.ask(); return true;
  }

  private async ask(): Promise<void> {
    const text = this.draftQuestion.trim();
    if (!text && !(this.awaitingGuide && this.guidePdf)) return;
    const limit = this.awaitingGuide ? STUDY_GUIDE_MAX_CHARS : STUDY_MESSAGE_MAX_CHARS;
    if (text.length > limit) { this.status = `Keep the message within ${limit} characters; it has not been truncated or sent.`; this.render(); return; }
    const flashcards = /^\/?(?:make[\s-]+flashcards|flashcards)(?:\s+(?:on|about)\s+([\s\S]+))?$/i.exec(text);
    const command = parseQuizCommand(text, !!this.session || this.choosingMode || this.awaitingGuide || this.awaitingTopic);
    if (command?.kind === "stop" || /^\/?cancel(?: (?:quiz|study))?$/i.test(text)) { this.draftQuestion = ""; this.cancel(); return; }
    if (command?.kind === "start" || flashcards) {
      this.clearPdf();
      this.epoch++;
      if (!this.plan) this.study.cancel();
      this.study = new StudyCoordinator(this.host); this.plan = null; this.busy = false; this.unitSources.clear();
      this.studyMode = flashcards ? "flashcards" : "quiz";
      this.session = null; this.mc = null; this.choices = []; this.target = null; this.choosingMode = false;
      const query = flashcards ? flashcards[1]?.trim() ?? "" : command?.kind === "start" && command.scope !== "this" ? command.query || "all" : "";
      this.topic = query || (/\b(?:this|active|current|open) (?:note|file)\b|\bon this$/i.test(text) ? this.host.app.workspace.getActiveFile?.()?.path ?? "" : "");
      this.turns.push({ role: "user", text }); this.draftQuestion = "";
      this.awaitingTopic = !this.topic; this.awaitingGuide = !!this.topic; this.guide = "";
      if (this.awaitingTopic) { this.status = "What topic should we study? You can name a subject, note, path or #tag."; this.turns.push({ role: "assistant", text: this.status }); }
      else this.promptGuide();
      this.render(); return;
    }
    if (this.busy || this.pdfRead) return;
    if (this.awaitingTopic) {
      this.topic = text; this.awaitingTopic = false; this.awaitingGuide = true;
      this.turns.push({ role: "user", text }); this.draftQuestion = ""; this.promptGuide(); this.render(); return;
    }
    if (this.awaitingGuide) {
      const pdf = this.guidePdf;
      const guide = pdf ? [text, pdf.text].filter(Boolean).join("\n\n") : text;
      if (guide.length > STUDY_GUIDE_MAX_CHARS) {
        this.status = `Keep the combined coverage within ${STUDY_GUIDE_MAX_CHARS} characters. Nothing was truncated or sent; shorten the instructions or choose a smaller PDF.`;
        this.render(); return;
      }
      this.guide = guide; this.awaitingGuide = false;
      this.turns.push({ role: "user", text: pdf ? [text, `Attached coverage PDF: ${pdf.name} (${pdf.pages} pages).`].filter(Boolean).join("\n\n") : text });
      this.draftQuestion = ""; this.clearPdf();
      const sourcePath = this.topic.trim().replace(/^\[\[([\s\S]*)\]\]$/, "$1");
      // Explicit PDF paths cannot fall back to aliases or suggestions for other files.
      const notes = this.notes().filter(note => !/\.pdf$/i.test(sourcePath) || note.path.toLocaleLowerCase() === sourcePath.toLocaleLowerCase());
      const resolved = /^(all|everything)$/i.test(this.topic)
        ? notes.length ? { kind: "resolved" as const, paths: notes.map(n => n.path), label: this.topic } : { kind: "missing" as const }
        : resolveQuizTarget(this.topic, notes, null);
      if (resolved.kind === "resolved") this.target = resolved;
      else if (resolved.kind === "choices") this.choices = resolved.choices;
      else if (!/^#|[/\\]|\.(?:md|pdf)$|^\[\[|^(?:all|everything)$/i.test(this.topic)) this.target = { paths: [], label: this.topic };
      this.choosingMode = this.studyMode === "quiz" && !!this.target;
      this.status = this.target ? "Choose a question format." : this.choices.length ? "Choose a note. No source has been sent." : "No eligible note or tag matched. Start again with an available source.";
      if (this.studyMode === "flashcards" && this.target) await this.makeFlashcards();
      this.render(); return;
    }
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
      this.recordResult(); this.status = "";
    } catch { if (epoch === this.epoch) this.status = "Could not validate the grade. No attempt counted; retry your answer."; }
    finally { if (epoch === this.epoch) { this.busy = false; this.render(); } }
  }

  private clearPdf(): void {
    this.pdfEpoch++; this.pdfRead?.controller.abort(); this.pdfRead = null;
    this.guidePdf = null; this.pdfError = "";
  }

  private async attachGuidePdf(file: File): Promise<void> {
    if (this.cancelled || this.busy || !this.awaitingGuide || this.studyMode !== "quiz") return;
    this.clearPdf();
    const pending = { controller: new AbortController(), name: file.name };
    this.pdfRead = pending; this.render();
    try {
      const pdf = await readStudyGuidePdf(file, STUDY_GUIDE_MAX_CHARS, pending.controller.signal);
      if (this.pdfRead === pending) this.guidePdf = pdf;
    } catch (error) {
      if (this.pdfRead === pending) this.pdfError = error instanceof StudyGuidePdfError ? error.message : "Could not read the PDF. Try another PDF with selectable text.";
    } finally {
      if (this.pdfRead === pending) { this.pdfRead = null; this.render(); }
    }
  }

  private promptGuide(): void {
    this.status = "Paste a study guide or describe what to focus on." + (this.studyMode === "quiz" ? " You can also attach a PDF." : "") + " It defines coverage only; all facts must come from your notes.";
    this.turns.push({ role: "assistant", text: this.status });
  }

  private async makeFlashcards(): Promise<void> {
    this.busy = true; const epoch = this.epoch; this.status = "Finding references in your notes…"; this.render();
    try {
      const plan = await this.study.prepare({ mode: "flashcards", topic: this.topic, guide: this.guide }, this.target?.paths.length ? this.target.paths : undefined);
      if (this.cancelled || epoch !== this.epoch) return;
      this.plan = plan;
      if (!plan.passages.length) { this.status = "No matching note evidence was selected. Nothing was queued; the guide is not a source."; return; }
      const captured = this.study.capture(plan);
      this.status = `${captured.added} reference passages queued for the Inbox card writer; ${captured.duplicates} already captured. No cards were exported.`;
    } catch { if (epoch === this.epoch) this.status = "Could not prepare or queue references. Check source access and start again; any captures already added remain in the Inbox."; }
    finally { if (epoch === this.epoch) { this.busy = false; this.render(); } }
  }

  private async begin(mode: "free" | "mc" = "free"): Promise<void> {
    if (!this.target || this.busy) return;
    this.mode = mode; this.mc = null; this.sent.clear();
    this.busy = true; this.choosingMode = false; const epoch = this.epoch; this.render();
    try {
      const plan = await this.study.prepare({ mode: "quiz", topic: this.topic, guide: this.guide }, this.target.paths.length ? this.target.paths : undefined);
      if (this.cancelled || epoch !== this.epoch) return;
      this.plan = plan; this.requireCurrent(epoch);
      if (!plan.passages.length) { this.status = "No matching note evidence was selected. The guide is not a source; start again with a narrower topic."; return; }
      const units = plan.passages.flatMap(passage => indexPage(passage.path, passage.text).map(unit => {
        const id = `${unit.id}:study:${passage.id}`;
        this.unitSources.set(id, passage);
        return { ...unit, id, noteTitle: passage.title, page: passage.page,
          section: [unit.section, passage.page ? `page ${passage.page}` : `line ${passage.line}`].filter(Boolean).join(" › ") };
      }));
      const items = buildItems(units);
      for (const point of items.flatMap(item => item.points)) {
        // Sentence points inherit the selected passage of their original evidence unit.
        const source = this.unitSources.get(point.id) ?? this.unitSources.get(point.id.replace(/#s\d+$/, ""));
        if (source) this.unitSources.set(point.id, source);
      }
      if (!items.length) { this.status = "The selected notes contain no usable quiz statements. Start again with another topic."; return; }
      this.session = startRecall({ kind: "query", label: this.topic }, this.guide, items, 20);
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
    const args: QuizQuestionMessageArgs = { ...sectionIn(item), level: 1, asked: [], standingInstructions: QUIZ_COVERAGE_PREFIX + this.guide + QUIZ_COVERAGE_SUFFIX, failure: "", authorized: () => this.authorized(epoch) };
    if (this.mode === "mc") {
      const draft = validateQuizChoices(await this.host.llm.quizMultipleChoice(args), item);
      this.requireCurrent(epoch);
      const audit = await this.host.llm.quizChoiceAudit({ ...args, draft });
      this.requireCurrent(epoch); validateChoiceAudit(audit, draft);
      this.mc = draft;
      this.session = acceptQuestion(session, item, draft.question, "concept", false, [item.points[draft.point - 1].id]);
      this.recordSourceTurn(draft.question, this.unitSources.get(item.points[0].id));
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
    this.recordSourceTurn(checked.cue, this.unitSources.get(item.points[0].id));
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
    try { this.requireCurrent(this.epoch); this.turns.push({ role: "user", text: "Skip" }); this.session = skipRecall(this.session, ""); this.mc = null; this.recordResult(); this.status = ""; }
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
      const source = this.unitSources.get(id);
      if (!source) return;
      const normalized = source.text.replace(/\s+/g, " ").trim();
      const duplicate = this.host.store.allHistory().some(h => h.sourcePath === source.path && h.text.replace(/\s+/g, " ").trim() === normalized) || this.host.store.hasDuplicate?.(source.path, normalized);
      if (duplicate) { this.sent.set(id, "Already captured"); this.render(); return; }
      const h = makeHighlight({ sourcePath: source.path, sourceTitle: source.title, text: source.text, line: source.line - 1, page: source.page,
        title: unit.text.slice(0, 80), instruction: `The reader missed this source point during Quiz: ${unit.text}\nTest only this point using the captured note excerpt.`, origin: "quiz" });
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
      this.turns.push({ role: "user", text: `${id}. ${this.mc.choices.find(c => c.id === id)!.text}` });
      this.draftQuestion = ""; this.mc = null; this.recordResult(); this.status = "";
    } catch { this.status = "Quiz source changed. Start again."; }
    this.render();
  }

  private recordSourceTurn(text: string, source?: StudyPassage): void {
    const study = this.study, plan = this.plan!;
    this.turns.push({ role: "assistant", text, source, current: () => study.current(plan) });
  }
  private recordResult(): void {
    const result = this.session?.results.at(-1);
    const item = result && itemById(this.session!, result.itemId);
    if (result && item) this.recordSourceTurn(`${renderRevealMarkdown(result, item)}\n${this.mode === "free" ? "AI-checked grading; compare with the source excerpts." : "Choice graded locally against the checked answer key."}`, this.unitSources.get(item.points[0].id));
  }
  private sourceLink(root: HTMLElement, source: StudyPassage): void {
    const href = source.path + (source.page ? `#page=${source.page}` : "");
    const link = root.createEl("a", { text: source.title + (source.page ? ` · page ${source.page}` : ` · line ${source.line}`), href });
    link.addEventListener("click", e => { e.preventDefault(); if (this.reader.allowed(source.path)) void this.host.app.workspace.openLinkText(href, "", false); });
  }

  private render(): void {
    const root = this.contentEl; root.empty();
    root.createEl("h3", { text: "Chat" });
    root.createEl("p", { cls: "review-chat-muted", text: "Quiz & Make Flashcards · Experimental" });
    const log = root.createDiv({ cls: "review-chat-log" });
    for (const turn of this.turns) {
      const valid = !turn.current || turn.current();
      const row = log.createDiv({ cls: `review-chat-turn is-${turn.role}`, text: valid ? turn.text : "Source changed or access was revoked; this earlier study turn is no longer current." });
      if (valid && turn.source) this.sourceLink(row, turn.source);
    }
    const action = (label: string, fn: () => void | Promise<void>, parent = root) => {
      const b = parent.createEl("button", { text: label, attr: { type: "button" } });
      b.disabled = this.busy; b.addEventListener("click", fn); return b;
    };
    for (const choice of this.choices) action(choice.path, async () => {
      this.target = { paths: [choice.path], label: choice.name }; this.choices = [];
      this.turns.push({ role: "user", text: choice.path });
      this.choosingMode = this.studyMode === "quiz"; this.status = this.choosingMode ? "Choose a question format." : "";
      if (this.studyMode === "flashcards") await this.makeFlashcards();
      this.render();
    });
    if (this.choosingMode) {
      action("Free response", () => this.begin("free"));
      action("Multiple choice", () => this.begin("mc"));
    }
    const sourceLink = (path: string, title: string) => {
      const a = root.createEl("a", { text: title, href: path });
      a.addEventListener("click", e => { e.preventDefault(); if (this.reader.allowed(path)) void this.host.app.workspace.openLinkText(path, "", false); });
    };
    if (this.plan && this.study.current(this.plan)) {
      if (this.plan.truncated) root.createDiv({ cls: "review-chat-muted", text: "Limited search: some note content was outside the retrieval budget. Narrow the topic if needed; coverage is not exhaustive." });
      if (this.plan.gaps.length) root.createDiv({ cls: "review-chat-a", text: `Not supported by the selected note excerpts (from your guide):\n${this.plan.gaps.join("\n")}` });
    }
    if (this.studyMode === "flashcards" && this.plan && this.study.current(this.plan)) {
      for (const passage of this.plan.passages) sourceLink(passage.path, passage.title);
    }
    const session = this.session;
    if (session?.current) {
      const item = itemById(session, session.current.itemId)!;
      sourceLink(item.notePath, item.noteTitle);

      if (this.mc) for (const choice of this.mc.choices) action(`${choice.id}. ${choice.text}`, () => this.submitChoice(choice.id));
      action("Hint", () => this.hint()); action("Skip", () => this.skip());
    }
    for (const miss of session ? recallMisses(session) : []) {
      const b = action(this.sent.get(miss.unit.id) ?? "Send to Inbox", () => this.sendMiss(miss.unit.id));
      b.setAttribute("aria-label", `Send missed source point to Inbox: ${miss.unit.text}`);
      b.disabled = this.busy || this.sent.has(miss.unit.id);
    }
    if (session && !session.current && !session.finished) action("Next question", () => this.advance());
    const form = root.createDiv({ cls: "review-chat-input" });
    const box = form.createEl("textarea", { cls: "review-chat-question", attr: { rows: "2", "aria-label": session?.current ? "Your answer" : "Chat message", placeholder: "quiz me on a topic or #tag · make flashcards on a topic" } });
    box.value = this.draftQuestion; box.disabled = this.busy;
    box.addEventListener("input", () => { this.draftQuestion = box.value; });
    const actions = form.createDiv({ cls: "review-chat-input-actions" });
    const send = action(session?.current ? "Submit answer" : "Send", () => this.ask(), actions);
    send.disabled = this.busy || !!this.pdfRead;
    if (this.awaitingGuide && this.studyMode === "quiz") {
      const pickerEpoch = this.pdfEpoch;
      const input = form.createEl("input", { attr: { type: "file", accept: ".pdf,application/pdf", "aria-label": "Attach coverage PDF", hidden: "" } });
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (file && pickerEpoch === this.pdfEpoch) await this.attachGuidePdf(file);
      });
      action("Attach PDF", () => input.click(), actions);
      if (this.pdfRead || this.guidePdf) {
        const label = this.pdfRead ? `Reading ${this.pdfRead.name}…` : `${this.guidePdf!.name} · ${this.guidePdf!.pages} pages · coverage only`;
        form.createDiv({ cls: "review-chat-source", text: label, attr: { role: "status", "aria-live": "polite" } });
        action("Remove PDF", () => { this.clearPdf(); this.render(); }, actions);
      }
      if (this.guidePdf?.emptyPages.length) form.createDiv({ cls: "review-chat-muted", text: `Pages without selectable text were not read: ${this.guidePdf.emptyPages.join(", ")}. OCR is not supported.` });
      form.createDiv({ cls: "review-chat-muted", text: "PDF coverage only; answers come from vault notes. Text goes to your configured model when Quiz starts. Temporary attachment, not copied into the vault. Up to 20 MiB, 200 pages and 64,000 combined coverage characters." });
      if (this.pdfError) form.createDiv({ cls: "review-chat-error", text: this.pdfError, attr: { role: "alert" } });
    }
    action("Cancel", () => this.cancel(), actions).disabled = false;
    if (this.status) root.createDiv({ cls: "review-chat-status", text: this.status, attr: { role: "status", "aria-live": "polite" } });
  }
}
