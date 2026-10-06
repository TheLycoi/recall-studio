import { ItemView, MarkdownRenderer, Notice, parseFrontMatterAliases, TAbstractFile, TFile } from "obsidian";
import type RecallPlugin from "./main";
import { describeError } from "./llm";
import { indexPage, questionScorer, type EvidenceUnit } from "./pageIndex";
import { isQuizPage, noteSource } from "./quizPages";
import { matchIntent, renderHelp, type Intent, type IntentContext, type IntentPage, type Target } from "./chatCommands";
import { RECALL_COMMANDS, type RecallCommand } from "./commands";
import { captureQuizMisses } from "./capture";
import { isDontKnow, parseQuizCommand, type QuizMiss, type QuizScope, type Verdict } from "./quiz";
import {
  acceptQuestion,
  afterCuedAttempt,
  afterFirstAttempt,
  checkQuestion,
  checkRecallGrade,
  fallbackExpects,
  fallbackQuestion,
  itemById,
  nextItem,
  nextLevel,
  openPoints,
  questionPoints,
  recallMisses,
  renderQuestionMarkdown,
  renderCuedMarkdown,
  renderRecallSummaryMarkdown,
  renderRevealMarkdown,
  resolveRecallPool,
  resultVerdict,
  sectionIn,
  skipRecall,
  startRecall,
  type RecallItem,
  type RecallSession,
} from "./recall";
import type { CueShape } from "./schemas";

/** What the panel says to a line it does not act on. */
const NOT_A_QUIZ =
  "This panel runs quizzes. Say **quiz me** for the open note, **quiz me on** a page or a subject, or **quiz me on everything**. To ask the wiki a question, use the wiki plugin's own query.";

/** The most turns the log keeps. Older ones scroll away. */
const MAX_TURNS = 40;

/**
 * One turn in the quiz log.
 *
 * A user turn is a line the reader typed: a quiz phrase or command, or an
 * answer to a question. A system turn is the panel talking about itself: a
 * command running, a quiz starting, `help`. An assistant turn is a quiz turn
 * or an error.
 *
 * `quiz` marks the shapes a quiz puts in the log: the question, the grade, the
 * cued retry, the closing summary. `renderTurn` styles on it, and it carries
 * only what the DOM needs that the markdown does not already say: the index
 * for the badge, the verdict for the border colour, the missed units for the
 * summary's send button.
 */
interface QuizTurn {
  role: "user" | "assistant" | "system";
  text: string;
  error?: string;
  /** A system turn whose text is markdown rather than a plain line. */
  markdown?: boolean;
  /** Set once this quiz summary's misses are in the inbox (added now or already there), so they are not sent twice. */
  sentToInbox?: boolean;
  quiz?: {
    kind: "question" | "grade" | "retry" | "summary";
    index?: number;
    verdict?: Verdict;
    misses?: QuizMiss[];
    unverified?: boolean;
  };
}

/**
 * The quiz panel: the second half of the Recall sidebar, owned by `InboxView`.
 *
 * It reads the pages under the wiki folder and never writes one. A typed line
 * is a quiz phrase, a quiz control, an answer to the question on screen, or
 * one of Recall's commands. Anything else gets one line saying what the panel
 * does.
 *
 * State lives on the instance, not in the DOM, because the view redraws on
 * every store change.
 */
export class QuizPanel {
  private turns: QuizTurn[] = [];
  private busy = false;
  private draft = "";
  private status = "";
  /** The wiki-folder index, built on the first line typed and kept until the vault changes under that folder. */
  private index: EvidenceUnit[] | null = null;
  private eventsRegistered = false;
  /** The element the panel was last mounted into, so a turn can redraw it. */
  private root: HTMLElement | null = null;
  /**
   * The quiz being run, or null. Public because it is the whole of the quiz's
   * state: the live run reads it through `view.quizPanel().session` between
   * turns, and `null` is the one test for "is a quiz running" everywhere in
   * this file.
   */
  session: RecallSession | null = null;
  /** What the last finished quiz was, kept so “Quiz again” repeats it. Each summary turn carries its own misses for its send button. */
  private lastQuiz: { scope: QuizScope; query: string; notePath: string | null } | null = null;
  /** Set by the first quiz phrase typed during a quiz. The next one restarts, any other message clears it. */
  private restartArmed = false;
  /** The note the running quiz was scoped to, so "Quiz again" can repeat it. */
  private lastQuizNotePath: string | null = null;
  /**
   * The log's scroll position and whether the reader is at its foot, kept
   * across rebuilds: the view redraws on every store change, and only a turn
   * the panel pushes may move the reader (`render`).
   */
  private logScroll = 0;
  private atBottom = true;
  private lastRenderedTurn: QuizTurn | null = null;
  /** Set by the reader's own submit or Clear. The next idle render focuses the input and clears it. A background redraw never does. */
  private wantFocus = true;
  /** The pages the intent matcher may name, rebuilt with the index. */
  private pageMeta: IntentPage[] = [];

  constructor(
    private plugin: RecallPlugin,
    private view: ItemView,
  ) {}

  /** The wiki folder, always with a trailing slash. */
  private folderPrefix(): string {
    const folder = this.plugin.settings.topicFolder.replace(/\/+$/, "");
    return `${folder}/`;
  }

  /** Is this file a page the quiz may read? (src/quizPages.ts) */
  private isWikiPage(path: string): boolean {
    return isQuizPage(path, this.plugin.settings.topicFolder);
  }

  /**
   * Vault events invalidate the index rather than patching it: rebuilding is a
   * `cachedRead` per wiki page, which is cheaper than keeping a correct
   * incremental index across renames. Registered through the view
   * (obsidian.d.ts:1886) so they die with the leaf.
   */
  private registerVaultEvents(): void {
    if (this.eventsRegistered) return;
    this.eventsRegistered = true;
    const vault = this.plugin.app.vault;
    const touched = (path: string) => this.isWikiPage(path);
    const invalidate = (file: TAbstractFile) => {
      if (touched(file.path)) this.index = null;
    };
    // obsidian.d.ts:7558 (create), :7564 (modify), :7570 (delete), :7576 (rename).
    this.view.registerEvent(vault.on("create", invalidate));
    this.view.registerEvent(vault.on("modify", invalidate));
    this.view.registerEvent(vault.on("delete", invalidate));
    this.view.registerEvent(
      vault.on("rename", (file, oldPath) => {
        if (touched(file.path) || touched(oldPath)) this.index = null;
      }),
    );
  }

  /** Every quiz unit under the wiki folder. Built lazily, cached until a vault event clears it. */
  private async buildIndex(): Promise<EvidenceUnit[]> {
    if (this.index) return this.index;
    this.registerVaultEvents();
    const units: EvidenceUnit[] = [];
    const files = this.plugin.app.vault.getMarkdownFiles().filter((f: TFile) => this.isWikiPage(f.path));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const meta: IntentPage[] = [];
    for (const file of files) {
      const md = await this.plugin.app.vault.cachedRead(file);
      const pageUnits = indexPage(file.path, md);
      units.push(...pageUnits);
      // The page's names for "quiz me on X": its heading, and the aliases in
      // its frontmatter as Obsidian has already parsed them.
      const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
      meta.push({
        path: file.path,
        title: pageUnits[0]?.noteTitle ?? file.basename,
        aliases: parseFrontMatterAliases(frontmatter) ?? [],
      });
    }
    this.index = units;
    this.pageMeta = meta;
    return units;
  }

  private intentContext(): IntentContext {
    return { pages: this.pageMeta, commands: RECALL_COMMANDS };
  }

  /** Keep the log bounded: the newest `MAX_TURNS` turns. */
  private trim(): void {
    if (this.turns.length > MAX_TURNS) this.turns = this.turns.slice(-MAX_TURNS);
  }

  // --------------------------------------------------------------- routing

  /**
   * What a typed line means, decided before anything else runs.
   *
   * While a quiz runs, a quiz control acts on it and any other line is the
   * answer. Otherwise `matchIntent` (src/chatCommands.ts) reads the line. The
   * index is built first because the matcher needs the page titles and
   * aliases in it to resolve "quiz me on X".
   */
  async submit(text: string): Promise<void> {
    if (this.busy) return;
    const q = text.trim();
    // The reader submitted: once the panel is idle again, the cursor goes back
    // in the box. Not for an empty Enter outside a quiz, which returns below
    // without drawing, so the flag would fire on some later, unrelated redraw.
    if (q || this.session) this.wantFocus = true;

    // The quiz controls are panel-local and not in the registry
    // (`parseQuizCommand`, src/quiz.ts), and while a session runs they
    // outrank everything else: "skip" during a quiz is a skipped question. A
    // quiz phrase that starts one flows through `matchIntent` below.
    const quizCommand = parseQuizCommand(q, !!this.session);
    if (quizCommand && quizCommand.kind !== "start") {
      this.draft = "";
      this.restartArmed = false;
      if (!this.session) {
        this.pushSystem("No quiz is running. Say “quiz me”.");
        return;
      }
      switch (quizCommand.kind) {
        case "stop":
          await this.finishQuiz();
          return;
        case "hint":
          this.showHint();
          return;
        default:
          // `q` is the command itself, so the log shows which one was typed.
          await this.skipQuiz(q);
          return;
      }
    }

    // Anything that is not a quiz control, while a quiz is running, is an
    // answer, including an empty one, which `isDontKnow` (src/quiz.ts) reads
    // as "I don't know" so the grader's promise that a blank never reaches it
    // is kept here rather than in the prompt. A quiz phrase is the exception:
    // it means restart, and `quizTarget` handles the confirmation.
    if (this.session && !(quizCommand && quizCommand.kind === "start")) {
      this.draft = "";
      this.restartArmed = false;
      if (isDontKnow(q)) {
        await this.skipQuiz(q);
        return;
      }
      await this.answerQuiz(q);
      return;
    }

    if (!q) return;

    // A cold index is a read of every wiki page, the longest silent wait in
    // the panel: say so and hold the input before it starts, or a second
    // Enter starts a second rebuild.
    if (!this.index) {
      this.busy = true;
      this.status = "reading the wiki…";
      this.rerender();
      let failed: unknown = null;
      try {
        await this.buildIndex();
      } catch (e) {
        failed = e;
      } finally {
        this.busy = false;
        this.status = "";
      }
      if (failed) {
        this.turns.push({ role: "assistant", text: "", error: describeError(failed) });
        this.trim();
        this.rerender();
        return;
      }
    }
    const intent = matchIntent(q, this.intentContext());
    this.draft = "";
    this.turns.push({ role: "user", text: q });
    await this.runIntent(intent);
  }

  /** Carry out what a phrase asked for. Every branch either acts or says why it cannot. */
  private async runIntent(intent: Intent): Promise<void> {
    switch (intent.kind) {
      case "help":
        this.pushSystem(renderHelp(), true);
        return;
      case "export":
        await this.runCommand("export-reviewed");
        return;
      case "inbox":
        await this.runCommand("open-inbox");
        return;
      case "command":
        await this.runCommand(intent.id);
        return;
      case "quiz":
        await this.quizTarget(intent.target);
        return;
      case "send-misses":
        await this.sendLastMissesToInbox();
        return;
      case "unknown":
        this.restartArmed = false;
        this.pushSystem(NOT_A_QUIZ, true);
        return;
    }
  }

  /** The typed form of the button under a quiz summary: card the newest summary's misses. */
  private async sendLastMissesToInbox(): Promise<void> {
    const turn = this.newestReply();
    if (turn?.quiz?.kind === "summary") {
      await this.sendMissesToInbox(turn);
      return;
    }
    this.pushSystem("There is no finished quiz above to send. Finish a quiz first, then say send to inbox.");
  }

  /** The newest assistant turn, or null. */
  private newestReply(): QuizTurn | null {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.role === "assistant") return t;
    }
    return null;
  }

  /**
   * Start a quiz on whatever the phrase named.
   *
   * A quiz already running is confirmed rather than replaced: the first phrase
   * says so, the second restarts. Losing four graded questions to a misread
   * line is worse than one extra message.
   */
  private async quizTarget(target: Target): Promise<void> {
    if (this.session && !this.restartArmed) {
      this.restartArmed = true;
      this.pushSystem(
        `A quiz on ${this.session.scope.label} is running, and your next message is read as the answer to its question. Send the same “quiz me…” line once more to drop it and start the new one, or say stop.`,
      );
      return;
    }
    this.restartArmed = false;
    switch (target.kind) {
      case "active": {
        const active = this.plugin.app.workspace.getActiveFile();
        if (active && active.extension === "md") await this.startQuiz("this", "", active.path);
        else {
          this.pushSystem("No note is open, so this quiz covers every page in the wiki folder.");
          await this.startQuiz("all", "");
        }
        return;
      }
      case "page":
        await this.startQuiz("this", "", target.path);
        return;
      case "query":
        await this.startQuiz(target.words ? "query" : "all", target.words);
        return;
    }
  }

  /** Push a system turn and redraw. System turns are the panel's own voice. */
  private pushSystem(text: string, markdown = false): void {
    this.turns.push({ role: "system", text, markdown });
    this.trim();
    this.rerender();
  }

  /**
   * Run one registry command from the panel.
   *
   * The log says what happened and nothing more: the command behaves exactly as
   * it does from the palette, modals and Notices included, so the panel would
   * be lying if it claimed to know the outcome. The "Running…" turn is rewritten
   * in place rather than followed by a second turn, so a burst of commands does
   * not fill the log with pairs.
   */
  private async runCommand(id: string): Promise<void> {
    const command: RecallCommand | undefined = RECALL_COMMANDS.find((c) => c.id === id);
    if (!command) {
      this.pushSystem(`No command matches “${id}”. Say help.`);
      return;
    }
    if (!command.available(this.plugin)) {
      this.pushSystem(`${command.name}: not available now (${command.hint}).`);
      return;
    }

    const turn: QuizTurn = { role: "system", text: `Running ${command.name}…` };
    this.turns.push(turn);
    this.trim();
    this.rerender();

    try {
      await command.run(this.plugin);
      turn.text = `Ran ${command.name}.`;
    } catch (e) {
      turn.text = `${command.name} failed: ${describeError(e)}`;
    } finally {
      this.rerender();
    }
  }

  // ------------------------------------------------------------------ quiz

  /**
   * Start a quiz: resolve the pool, then ask the first question.
   *
   * An empty pool is answered here and the provider is never called, so a
   * quiz on a wiki with no matching pages costs nothing and answers
   * instantly. The line names the scope, because "nothing to quiz on" is
   * ambiguous between "this note has none" and "the whole folder has none".
   */
  private async startQuiz(scope: "all" | "this" | "query", query: string, notePath: string | null = null): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.status = "gathering evidence…";
    this.draft = "";
    this.rerender();

    let items: RecallItem[] = [];
    let label = "";
    try {
      const all = await this.buildIndex();
      // A phrase can name the note to quiz ("quiz me on Receptors"), so the
      // pool is not always the file in front of the reader. obsidian.d.ts
      // (`Workspace.getActiveFile`): null when nothing is open, which
      // `resolveRecallPool` reads as "this note has nothing to quiz on".
      const activePath = notePath ?? this.plugin.app.workspace.getActiveFile()?.path ?? null;
      let units = all;
      // The index holds only wiki pages. A note outside the wiki folder can
      // still be quizzed with "quiz me": that one file is read, never
      // written. A wiki file `isQuizPage` rejects (index, log, schema/…) has
      // no units at all: it is the wiki plugin's own file, not knowledge.
      if (scope === "this" && notePath) {
        const source = noteSource(notePath, this.plugin.settings.topicFolder);
        if (source === "single-file") {
          const file = this.plugin.app.vault.getFileByPath(notePath);
          units = file ? indexPage(file.path, await this.plugin.app.vault.cachedRead(file)) : [];
        } else if (source === "none") {
          units = [];
        }
      }
      const resolved = resolveRecallPool(
        scope,
        query,
        units,
        activePath,
        questionScorer(query || "", units),
        this.plugin.settings.quizPoolSize,
      );
      items = resolved.items;
      label = resolved.label;
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", error: describeError(e) });
      this.busy = false;
      this.status = "";
      this.trim();
      this.rerender();
      return;
    }

    this.busy = false;
    this.status = "";

    if (items.length === 0) {
      this.session = null;
      this.pushSystem(this.noEvidenceLine(scope, query));
      return;
    }

    // Kept so "Quiz again" repeats the same scope rather than falling back to
    // whatever file happens to be open when the button is pressed.
    this.lastQuizNotePath = notePath;
    const kind: QuizScope["kind"] = scope === "all" ? "all" : scope === "this" ? "note" : "query";
    this.session = startRecall({ kind, label }, query, items, Math.max(1, this.plugin.settings.quizCap));
    this.pushSystem(
      `Quiz on ${label}: ${items.length} question${items.length === 1 ? "" : "s"}, one per section. Answer each from memory in a few sentences, in your own words. You get a hint for what you miss, then the answer. Say skip or stop.`,
    );
    await this.nextQuestion();
  }

  /** Why a scope has nothing to quiz on, in the scope's own words. */
  private noEvidenceLine(scope: "all" | "this" | "query", query: string): string {
    if (scope === "query") return `Nothing in the wiki folder matches “${query.trim()}”.`;
    if (scope === "this") return "This note has nothing to quiz on yet.";
    return `No pages under ${this.folderPrefix()} yet. Add a source with the wiki plugin first, then say quiz me.`;
  }

  /**
   * Write the cue for the next section, checking it before the reader sees it.
   *
   * The two-strike rule of the passage quiz, with a different last resort: a
   * cue that fails `checkQuestion` (src/recall.ts) is asked for once more with the
   * failure named, and a second failure falls back to a cue written by code
   * from the heading path. A section is never set aside because the model
   * could not phrase it, so the quiz cannot loop or stall on one. A cue call
   * that throws falls back the same way. Anything else that throws finishes
   * the quiz, so the sections already graded keep their summary and misses.
   */
  private async nextQuestion(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const item = nextItem(session);
    if (!item) {
      await this.finishQuiz();
      return;
    }

    this.busy = true;
    this.status = "writing a question…";
    this.rerender();

    try {
      // The level follows the reader: up after a full answer, down after a
      // miss, so the questions find where their understanding stops.
      const level = nextLevel(session);
      const asked = session.results.map((r) => r.question.cue);
      let failure = "";
      let accepted: { cue: string; shape: CueShape; expects: string[]; fallback: boolean } | null = null;
      for (let attempt = 0; attempt < 2 && !accepted; attempt++) {
        let draft;
        try {
          draft = await this.plugin.llm.quizQuestion({
            ...sectionIn(item),
            level,
            asked,
            standingInstructions: this.plugin.settings.quizInstructions,
            failure,
          });
        } catch (e) {
          console.debug("[recall] quiz question failed, using the heading question:", e);
          break;
        }
        const check = checkQuestion(draft, item);
        if (check.ok) accepted = { cue: check.cue, shape: check.shape, expects: check.expects, fallback: false };
        else failure = check.reason;
      }
      const live = this.session;
      if (!live) return;
      const q = accepted ?? { cue: fallbackQuestion(item), shape: "concept" as const, expects: fallbackExpects(item), fallback: true };
      const next = acceptQuestion(live, item, q.cue, q.shape, q.fallback, q.expects, level);
      this.session = next;
      if (!next.current) return;
      this.turns.push({ role: "assistant", text: renderQuestionMarkdown(next.current, item), quiz: { kind: "question", index: next.current.n } });
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", error: describeError(e) });
      await this.finishQuiz();
    } finally {
      this.busy = false;
      this.status = "";
      this.trim();
      this.rerender();
    }
  }

  /**
   * One typed answer, marked point by point against the section.
   *
   * On the free attempt, points still open with a cue to give arm the cued
   * attempt, and the reader sees the cues, not the points. On the cued
   * attempt only the open points are sent. A failed model call keeps the
   * session, because the answer is still on the screen and typing it again is
   * the whole recovery.
   */
  private async answerQuiz(text: string): Promise<void> {
    const session = this.session;
    const current = session?.current;
    const item = session && current ? itemById(session, current.itemId) : undefined;
    if (!session || !current || !item || this.busy) return;

    this.busy = true;
    this.status = "marking…";
    this.draft = "";
    this.turns.push({ role: "user", text, quiz: { kind: "grade" } });
    this.trim();
    this.rerender();

    const cued = session.attempt === 2;
    // Marked against the points the question expects, not the whole section.
    const points = cued ? openPoints(session) : questionPoints(session);
    try {
      const draft = await this.plugin.llm.quizRecallGrade({
        ...sectionIn(item),
        points: points.map((p) => p.text),
        question: current.cue,
        answer: text,
        cued,
      });
      const { marks, feedback, feedbackGrounded } = checkRecallGrade(draft, points, text);
      const next = cued
        ? afterCuedAttempt(session, text, marks, feedback, feedbackGrounded)
        : afterFirstAttempt(session, text, marks, feedback, feedbackGrounded);
      if (next.attempt === 2 && next.current) {
        this.session = next;
        this.turns.push({ role: "assistant", text: renderCuedMarkdown(next), quiz: { kind: "retry", verdict: "partial" } });
        this.busy = false;
        this.status = "";
        this.trim();
        this.rerender();
        return;
      }
      this.pushReveal(next);
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", error: describeError(e) });
      this.busy = false;
      this.status = "";
      this.trim();
      this.rerender();
      return;
    }

    this.busy = false;
    this.status = "";
    await this.afterGrade();
  }

  /**
   * A declined answer: `/skip`, `/idk` or a blank line. No model call. Every
   * point still open is missed and the section is shown, because the point
   * of declining is to be told.
   */
  private async skipQuiz(userAnswer: string): Promise<void> {
    const session = this.session;
    if (!session?.current || this.busy) return;
    if (userAnswer.trim()) this.turns.push({ role: "user", text: userAnswer, quiz: { kind: "grade" } });
    this.pushReveal(skipRecall(session, userAnswer));
    await this.afterGrade();
  }

  /** Put the reveal of the section just closed on the log and keep the new session. */
  private pushReveal(next: RecallSession): void {
    this.session = next;
    const result = next.results[next.results.length - 1];
    const item = result ? itemById(next, result.itemId) : undefined;
    if (!result || !item) return;
    this.turns.push({
      role: "assistant",
      text: renderRevealMarkdown(result, item),
      quiz: {
        kind: "grade",
        verdict: resultVerdict(result),
        unverified: !result.feedbackGrounded || result.marks.some((m) => !m.verified),
      },
    });
    this.trim();
    this.rerender();
  }

  /** After a reveal: the summary when the quiz is done, otherwise the next section. */
  private async afterGrade(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (session.finished) await this.finishQuiz();
    else await this.nextQuestion();
  }

  /**
   * `/hint`. There is no hint before the attempt, because any word about the
   * content would answer part of the question. The hints come after the
   * first answer, one per point missed. So the hint says that.
   */
  private showHint(): void {
    const session = this.session;
    if (!session?.current) return;
    this.pushSystem(
      session.attempt === 2
        ? "The hints are above. Write what they bring back, or say skip."
        : "Answer in a few sentences with whatever you have. After your answer you get a hint for each part you missed, before the answer is shown.",
    );
  }

  /**
   * End the quiz and offer the misses.
   *
   * The session goes to null, but the scope and the missed points stay on the
   * panel: the two buttons outlive the session they came from, so "Quiz again"
   * still knows what was being quizzed after the summary has scrolled up.
   */
  private async finishQuiz(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const misses = recallMisses(session);
    this.lastQuiz = { scope: session.scope, query: session.query, notePath: this.lastQuizNotePath };
    this.turns.push({
      role: "assistant",
      text: renderRecallSummaryMarkdown(session),
      quiz: { kind: "summary", misses },
    });
    this.session = null;
    this.restartArmed = false;
    this.trim();
    this.rerender();
  }

  /**
   * The summary's first button. Public because the live run drives it through
   * `eval` on the view, and because the button is the only thing in the plugin
   * that writes to the inbox from a quiz. Nothing is written without it.
   *
   * Sends the misses of the summary it is given (the one the button sits
   * under) or, called bare, of the newest summary in the log. It turns to
   * "Sent" once the rows are in the inbox, new or already there, so an old
   * summary cannot send a newer quiz's misses and a second click cannot
   * report "0 sent".
   */
  async sendMissesToInbox(summary?: QuizTurn): Promise<void> {
    const turn = summary ?? [...this.turns].reverse().find((t) => t.quiz?.kind === "summary");
    const misses = turn?.quiz?.misses ?? [];
    if (!turn || misses.length === 0) {
      this.pushSystem("Nothing was missed.");
      return;
    }
    if (turn.sentToInbox) {
      this.pushSystem("Those misses are already in the inbox.");
      return;
    }
    // `duplicates` are the misses whose row was already in the inbox.
    // `skipped` also counts passages too short to card. Only an added or a
    // duplicate row means the misses are in the inbox: a send that skipped
    // them all as too short sent nothing and keeps its button.
    const { added, duplicates, reason } = captureQuizMisses(this.plugin, misses);
    if (added > 0 || duplicates > 0) turn.sentToInbox = true;
    if (added > 0) {
      new Notice(`Sent ${added} passage${added === 1 ? "" : "s"} to the inbox${duplicates ? `, ${duplicates} already there` : ""}.`);
      this.rerender();
      return;
    }
    this.pushSystem(`Not sent: ${reason ?? "nothing to card."}`);
  }

  /** The summary's second button: the same scope and the same words, a fresh pool. */
  async quizAgain(): Promise<void> {
    const last = this.lastQuiz;
    if (!last) {
      this.pushSystem("No quiz to repeat. Say “quiz me”.");
      return;
    }
    // The button is disabled while a quiz runs. This covers any other caller.
    if (this.session) {
      this.pushSystem("A quiz is running. Finish it, or say “quiz me” twice to restart it.");
      return;
    }
    const scope = last.scope.kind === "all" ? "all" : last.scope.kind === "note" ? "this" : "query";
    await this.startQuiz(scope, last.query, last.notePath);
  }

  /**
   * Empty the log. The index survives: nothing about the vault changed.
   *
   * Not while busy: a grade in flight would land under no question, and a
   * quiz question being written would bring the cleared quiz back. The button
   * is disabled too. This covers any other caller.
   */
  clear(): void {
    if (this.busy) return;
    this.wantFocus = true;
    this.turns = [];
    this.draft = "";
    this.status = "";
    this.session = null;
    this.restartArmed = false;
    this.rerender();
  }

  /** Drop the cached index. The vault listeners belong to the view and go with it. */
  dispose(): void {
    this.index = null;
    this.root = null;
  }

  /** Redraw where the panel is mounted. A no-op when the view is in inbox mode. */
  private rerender(): void {
    const root = this.root;
    if (root?.isConnected) this.render(root);
  }

  // ---------------------------------------------------------------- render

  render(root: HTMLElement): void {
    this.root = root;
    root.querySelector(".wikilm-chat")?.remove();
    const wrap = root.createDiv({ cls: "wikilm-chat" });

    const log = wrap.createDiv({ cls: "wikilm-chat-log" });
    this.wireInternalLinks(log);

    const prefix = this.folderPrefix();
    if (this.turns.length === 0) {
      const hasPages = this.plugin.app.vault.getMarkdownFiles().some((f: TFile) => this.isWikiPage(f.path));
      log.createDiv({
        cls: "wikilm-muted",
        text: hasPages
          ? "Say “quiz me” for a quiz on the open note, or “quiz me on” a page or a subject. Say “help” for the rest."
          : `No pages under ${prefix} yet. Add a source with the wiki plugin first, then say quiz me.`,
      });
    }

    for (const turn of this.turns) this.renderTurn(log, turn);

    this.renderInput(wrap);

    // Only a turn the panel pushed moves the log to its foot. Every other
    // redraw (a status step, or a store change: inboxView's `onChange`
    // subscription redraws the whole view when a card is written in the
    // background) puts the reader back where they were: at the foot if they
    // were there, else at the same offset, so scrolling back is not undone.
    const newest = this.turns[this.turns.length - 1] ?? null;
    if (newest !== this.lastRenderedTurn) this.atBottom = true;
    this.lastRenderedTurn = newest;
    // Where to put the log is decided once, here. The scrolls `place` itself
    // causes are not the reader's and are not recorded: markdown that grows
    // between the assignment and its scroll event would read as "scrolled up"
    // and pin the second `place` part-way down the turn. A scroll event
    // fires before the frame's rAF callbacks, so `placing` clears one frame
    // after the last `place`.
    const stick = this.atBottom;
    const offset = this.logScroll;
    let placing = false;
    let placed = 0;
    const place = (): void => {
      placing = true;
      const mine = ++placed;
      log.scrollTop = stick ? log.scrollHeight : offset;
      window.requestAnimationFrame(() => {
        if (mine === placed) placing = false;
      });
    };
    place();
    // Markdown renders asynchronously, so the height is not final yet.
    window.requestAnimationFrame(() => {
      if (log.isConnected) place();
    });
    log.addEventListener("scroll", () => {
      if (placing) return;
      this.logScroll = log.scrollTop;
      this.atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
    });
  }

  /**
   * Make the wikilinks inside rendered markdown open their notes.
   *
   * `MarkdownRenderer.render` writes a real `a.internal-link` carrying its
   * target in `data-href`, but it attaches no click handler: Obsidian wires
   * those inside its own `MarkdownView`, and this is a plain `ItemView`, so in
   * the panel they rendered as links that did nothing. A reveal links the
   * page its section came from (`renderRevealMarkdown`, src/recall.ts), and
   * that page is the thing a reader wants after getting one wrong.
   *
   * One delegated listener on the log covers every turn that goes through the
   * markdown renderer (reveals, the closing summary, `help`) rather than each
   * render site wiring its own. `render` rebuilds the log on every state
   * change, so the handler is recreated with it and cannot stack up.
   *
   * Links open in the root split (`"tab"`, obsidian.d.ts:7883), not in the
   * active leaf: the panel usually *is* the active leaf, and a note opened
   * over it would replace the quiz it was opened from. `inboxView.ts` opens
   * its links the same way. The source path is empty because the links are
   * vault-absolute, so there is nothing relative to resolve against
   * (obsidian.d.ts:7914).
   */
  private wireInternalLinks(log: HTMLElement): void {
    const open = (e: MouseEvent): void => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const link = target.closest<HTMLElement>("a.internal-link");
      if (!link || !log.contains(link)) return;
      const href = link.getAttribute("data-href") ?? link.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      void this.plugin.app.workspace.openLinkText(href, "", "tab");
    };

    log.addEventListener("click", open);
    // Middle-click, which everywhere else in Obsidian also opens a tab.
    log.addEventListener("auxclick", (e) => {
      if (e.button === 1) open(e);
    });
  }

  private renderTurn(log: HTMLElement, turn: QuizTurn): void {
    const cls =
      turn.role === "user" ? "is-user" : turn.role === "system" ? "is-system" : "is-assistant";
    // The quiz classes are additive: a grade turn is still an assistant turn,
    // it just carries a verdict-coloured border and its own spacing.
    const quizCls =
      turn.quiz && turn.role === "assistant"
        ? turn.quiz.kind === "question"
          ? " wikilm-quiz-question"
          : turn.quiz.kind === "grade"
            ? ` wikilm-quiz-grade is-${turn.quiz.verdict ?? "skipped"}${turn.quiz.unverified ? " is-unverified" : ""}`
            : turn.quiz.kind === "retry"
              ? ` wikilm-quiz-grade is-${turn.quiz.verdict ?? "skipped"}`
              : " wikilm-quiz-summary"
        : "";
    const el = log.createDiv({ cls: `wikilm-chat-turn ${cls}${quizCls}` });
    if (turn.role === "user") {
      el.setText(turn.text);
      return;
    }
    if (turn.role === "system") {
      // `help` and the line for an unknown phrase are markdown. Everything
      // else is one plain line, set as text so a command name containing `*`
      // or `_` cannot be read as markup.
      if (turn.text.startsWith("- ") || turn.markdown) void MarkdownRenderer.render(this.plugin.app, turn.text, el.createDiv(), "", this.view);
      else el.setText(turn.text);
      return;
    }

    if (turn.text.trim()) {
      // sourcePath "": the links in a quiz turn are vault-absolute, so there
      // is no relative link for a source path to resolve (obsidian.d.ts:4143).
      void MarkdownRenderer.render(this.plugin.app, turn.text, el.createDiv(), "", this.view);
    }
    if (turn.quiz?.kind === "grade" && turn.quiz.unverified) {
      el.createDiv({ cls: "wikilm-chat-grounding is-unverified" }).createSpan({ cls: "wikilm-badge wikilm-badge-warn", text: "unverified" });
    }
    if (turn.error) el.createDiv({ cls: "wikilm-error", text: turn.error });

    if (turn.quiz?.kind === "summary") this.renderSummaryChips(el, turn);
  }

  /**
   * The two buttons under a summary.
   *
   * The misses are on the turn, and the send button sends that turn's misses
   * and remembers it did, so an old summary sends its own quiz and reads
   * "Sent to inbox" afterwards. "Quiz again" reads `lastQuiz` and so always
   * repeats the most recent quiz. It is disabled while a quiz runs, because
   * starting one would drop it. Sending nothing is not offered: the button is
   * disabled at zero rather than writing an empty batch to the inbox.
   */
  private renderSummaryChips(el: HTMLElement, turn: QuizTurn): void {
    const misses = turn.quiz?.misses ?? [];
    const row = el.createDiv({ cls: "wikilm-chat-offer" });
    const send = row.createEl("button", {
      cls: turn.sentToInbox ? "" : "mod-cta",
      text: turn.sentToInbox ? "Sent to inbox" : `Send ${misses.length} missed to inbox`,
    });
    send.disabled = this.busy || misses.length === 0 || !!turn.sentToInbox;
    send.addEventListener("click", () => void this.sendMissesToInbox(turn));

    const again = row.createEl("button", { text: "Quiz again" });
    again.disabled = this.busy || !!this.session;
    again.addEventListener("click", () => void this.quizAgain());
  }

  private renderInput(wrap: HTMLElement): void {
    const box = wrap.createDiv({ cls: "wikilm-chat-input" });
    const studio = box.createDiv({ cls: "wikilm-chat-studio" });
    const quizMe = studio.createEl("button", { text: "Quiz me" });
    quizMe.disabled = this.busy;
    quizMe.title = "Quiz me";
    quizMe.addEventListener("click", () => void this.runIntent({ kind: "quiz", target: { kind: "active" } }));
    const ta = box.createEl("textarea", { cls: "wikilm-chat-textarea" });
    ta.rows = 3;
    ta.placeholder = "quiz me, or answer the question above";
    ta.value = this.draft;
    ta.disabled = this.busy;
    // The draft lives on the panel, so a store-driven re-render restores it.
    ta.addEventListener("input", () => {
      this.draft = ta.value;
    });
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        ta.blur();
        return;
      }
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      this.draft = ta.value;
      void this.submit(ta.value);
    });

    const row = box.createDiv({ cls: "wikilm-chat-buttons" });
    const send = row.createEl("button", { cls: "mod-cta", text: "Send" });
    send.disabled = this.busy;
    send.addEventListener("click", () => {
      this.draft = ta.value;
      void this.submit(ta.value);
    });
    const clear = row.createEl("button", { text: "Clear" });
    clear.disabled = this.busy;
    clear.addEventListener("click", () => this.clear());

    row.createSpan({ cls: "wikilm-muted", text: this.status });

    // Focus follows the reader's own submit or Clear, once the panel is idle
    // again, and nothing else: a redraw driven by a store change must not
    // pull the cursor out of the note they are editing.
    if (!this.busy && this.wantFocus) {
      this.wantFocus = false;
      window.setTimeout(() => ta.focus(), 0);
    }
  }
}
