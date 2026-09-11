import { ItemView, MarkdownRenderer, TAbstractFile, TFile, prepareSimpleSearch } from "obsidian";
import type RecallPlugin from "./main";
import { describeError } from "./llm";
import { indexNote, numberEvidence, rankEvidence, renderEvidenceMarkdown, type EvidenceUnit } from "./retrieval";
import { applyVerdicts, checkAnswer, noEvidenceAnswer, renderGroundingLine, type GroundingReport } from "./askCheck";
import { matchCommand, renderHelp, tokenOverlapScorer } from "./chatCommands";
import { RECALL_COMMANDS, type RecallCommand } from "./commands";
import type { AskHistoryTurn } from "./prompt";

/**
 * One turn in the chat log.
 *
 * An assistant turn carries the evidence it was answered from, error or not,
 * and the `report` of what the grounding checks did to the draft
 * (src/askCheck.ts:21-29). A system turn is the panel talking about itself —
 * a command running, a command that cannot run, `/help` — and never reaches
 * the model. An `offer` turn is the one-click chip the matcher asks for when a
 * plain sentence merely resembles a command (src/chatCommands.ts:119): it
 * carries the question it was typed as, so "Ask instead" can still ask it.
 */
interface ChatTurn {
  role: "user" | "assistant" | "system";
  text: string;
  evidence?: EvidenceUnit[];
  error?: string;
  report?: GroundingReport;
  offer?: { id: string; name: string; question: string };
}

/**
 * The Ask panel: the chat half of the Recall sidebar, owned by `InboxView`.
 *
 * It never imports `./inboxView` — the view hands itself in as an `ItemView`,
 * which is all this needs (a `Component` for `MarkdownRenderer.render`'s
 * lifecycle, obsidian.d.ts:4147, and `registerEvent`, :1886, for the vault
 * listeners that invalidate the index).
 *
 * State lives in memory on the instance, not in the DOM, because the view
 * re-renders on every store change: `render` rebuilds the log from `turns` and
 * the textarea from `draft`, so a card written in the background cannot wipe a
 * half-typed question or the conversation so far.
 *
 * A line typed into the box is not assumed to be a question. `ask` routes it
 * through `matchCommand` (src/chatCommands.ts:73) first, so the chat is also
 * the command line: `/help`, `/extract`, an exact command name, or a chip
 * offering to run the command a sentence resembles. Only what is left over
 * reaches `askQuestion` and the model.
 */
export class ChatPanel {
  private turns: ChatTurn[] = [];
  private busy = false;
  private draft = "";
  private status = "";
  /** The topic-folder index, built on the first question and kept until the vault changes under that folder. */
  private index: EvidenceUnit[] | null = null;
  private eventsRegistered = false;
  /** The element the panel was last mounted into, so an answer can redraw itself. */
  private root: HTMLElement | null = null;

  constructor(
    private plugin: RecallPlugin,
    private view: ItemView,
  ) {}

  /** The folder every indexed note must sit under, always with a trailing slash. */
  private folderPrefix(): string {
    const folder = this.plugin.settings.topicFolder.replace(/\/+$/, "");
    return `${folder}/`;
  }

  /**
   * Vault events invalidate the index rather than patching it: rebuilding is a
   * `cachedRead` per topic note, which is cheaper than keeping a correct
   * incremental index across renames. Registered through the view
   * (obsidian.d.ts:1886) so they die with the leaf.
   */
  private registerVaultEvents(): void {
    if (this.eventsRegistered) return;
    this.eventsRegistered = true;
    const vault = this.plugin.app.vault;
    const touched = (path: string) => path.startsWith(this.folderPrefix());
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

  /** Every evidence unit under the topic folder. Built lazily, cached until a vault event clears it. */
  private async buildIndex(): Promise<EvidenceUnit[]> {
    if (this.index) return this.index;
    this.registerVaultEvents();
    const prefix = this.folderPrefix();
    const units: EvidenceUnit[] = [];
    // obsidian.d.ts:7543 (getMarkdownFiles), :7420 (cachedRead).
    const files = this.plugin.app.vault.getMarkdownFiles().filter((f: TFile) => f.path.startsWith(prefix));
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const file of files) {
      const md = await this.plugin.app.vault.cachedRead(file);
      units.push(...indexNote(file.path, md));
    }
    this.index = units;
    return units;
  }

  /**
   * The last `askMaxTurns` turns, as the prompt wants them (src/prompt.ts:97-106).
   *
   * System turns are the panel narrating itself and offers have no text at all,
   * so neither is conversation: sending them would teach the model that
   * "Ran Extract PDF highlights to manifest." is something it said.
   */
  private history(): AskHistoryTurn[] {
    const keep = Math.max(0, this.plugin.settings.askMaxTurns);
    return this.turns
      .filter((t): t is ChatTurn & { role: "user" | "assistant" } => t.role === "user" || t.role === "assistant")
      .filter((t) => !t.error && !t.offer && t.text.trim().length > 0)
      .slice(-keep)
      .map((t) => ({ role: t.role, text: t.text }));
  }

  /** Keep the log bounded the way the settings ask: `askMaxTurns` exchanges, so twice that many entries. */
  private trim(): void {
    const cap = Math.max(2, this.plugin.settings.askMaxTurns * 2);
    if (this.turns.length > cap) this.turns = this.turns.slice(this.turns.length - cap);
  }

  // --------------------------------------------------------------- routing

  /**
   * What a typed line means, decided before anything is sent anywhere.
   *
   * The command matcher gets `tokenOverlapScorer` (src/chatCommands.ts): shared
   * words between the message and a command name or alias, the same scorer the
   * tests use, so `OFFER_THRESHOLD` means the same thing in the app as in the
   * tests. Obsidian's `prepareFuzzySearch` score scale is undocumented, which is
   * why it is not used for this decision.
   * has been seen in the app.
   */
  async ask(text: string): Promise<void> {
    const q = text.trim();
    if (!q || this.busy) return;

    const match = matchCommand(q, RECALL_COMMANDS, tokenOverlapScorer);

    switch (match.kind) {
      case "help":
        this.draft = "";
        this.pushSystem(this.helpText());
        return;
      case "run": {
        this.draft = "";
        await this.runCommand(match.id);
        return;
      }
      case "unknown":
        this.draft = "";
        this.pushSystem(`No command matches /${match.query}. Type /help.`);
        return;
      case "offer": {
        const command = RECALL_COMMANDS.find((c) => c.id === match.id);
        if (!command) {
          await this.askQuestion(q);
          return;
        }
        this.draft = "";
        this.turns.push({ role: "user", text: q });
        this.turns.push({
          role: "assistant",
          text: "",
          offer: { id: command.id, name: command.name, question: q },
        });
        this.trim();
        this.rerender();
        return;
      }
      default:
        await this.askQuestion(q);
    }
  }

  /** `/help`: every command, its first alias, its hint, and whether it can run right now. */
  private helpText(): string {
    return renderHelp(RECALL_COMMANDS.map((c) => ({ ...c, available: c.available(this.plugin) })));
  }

  /** Push a system turn and redraw. System turns are the panel's own voice. */
  private pushSystem(text: string): void {
    this.turns.push({ role: "system", text });
    this.trim();
    this.rerender();
  }

  /**
   * Run one registry command from the chat.
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
      this.pushSystem(`No command matches /${id}. Type /help.`);
      return;
    }
    if (!command.available(this.plugin)) {
      this.pushSystem(`${command.name}: not available now (${command.hint}).`);
      return;
    }

    const turn: ChatTurn = { role: "system", text: `Running ${command.name}…` };
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

  /**
   * One question: index, rank, number, ask, check the answer against its evidence.
   *
   * Retrieval finding nothing is answered here, not by the model: a model handed
   * no evidence is exactly the situation that invents one, so `noEvidenceAnswer`
   * (src/askCheck.ts:147) says so and the provider is never called — which is
   * also why a vault with no matching notes answers instantly and without a
   * provider error.
   *
   * The evidence is pushed with the assistant turn whether the model answered
   * or failed, because the sources are the part the reader can still use when
   * there is no provider configured.
   */
  private async askQuestion(question: string): Promise<void> {
    const q = question.trim();
    if (!q || this.busy) return;

    this.busy = true;
    this.status = "searching…";
    this.draft = "";
    this.turns.push({ role: "user", text: q });
    this.trim();
    this.rerender();

    let evidence: EvidenceUnit[] = [];
    try {
      const units = await this.buildIndex();
      // `prepareSimpleSearch` (obsidian.d.ts:5260) returns null for no match and
      // a `SearchResult` whose `score` (:5593) `rankEvidence` reads as
      // higher-is-better (src/retrieval.ts:128-134).
      const search = prepareSimpleSearch(q);
      const scorer = (t: string) => search(t)?.score ?? null;
      evidence = rankEvidence(units, q, scorer, this.plugin.settings.askEvidenceCount);

      if (evidence.length === 0) {
        const { answer, report } = noEvidenceAnswer(q);
        this.turns.push({ role: "assistant", text: answer, evidence: [], report });
        return;
      }

      this.status = "asking the model…";
      this.rerender();

      const numbered = numberEvidence(evidence);
      let draft = await this.plugin.llm.ask({
        question: q,
        evidence: numbered,
        history: this.history(),
        standingInstructions: this.plugin.settings.askInstructions,
      });

      // The verify pass is a second opinion, not a gate: when it fails the
      // draft is still the best thing we have, so the answer is rendered and
      // the failure is stated on the turn rather than replacing it.
      let verifyError: string | undefined;
      if (this.plugin.settings.askVerifyPass) {
        this.status = "verifying…";
        this.rerender();
        try {
          const verdicts = await this.plugin.llm.verifyAnswer({
            evidence: numbered,
            sentences: draft.sentences.map((s, i) => ({ i, text: s.text, cited: s.cited })),
          });
          draft = applyVerdicts(draft, verdicts);
        } catch (e) {
          verifyError = `verify pass failed: ${describeError(e)}`;
        }
      }

      const { answer, report } = checkAnswer(draft, numbered);
      this.turns.push({ role: "assistant", text: answer, evidence, report, error: verifyError });
    } catch (e) {
      this.turns.push({ role: "assistant", text: "", evidence, error: describeError(e) });
    } finally {
      this.busy = false;
      this.status = "";
      this.trim();
      this.rerender();
    }
  }

  /** Empty the log. The index survives: nothing about the vault changed. */
  clear(): void {
    this.turns = [];
    this.draft = "";
    this.status = "";
    this.rerender();
  }

  /** Drop the cached index; the vault listeners belong to the view and go with it. */
  dispose(): void {
    this.index = null;
    this.root = null;
  }

  /** Redraw where the panel is mounted; a no-op when the view is in inbox mode. */
  private rerender(): void {
    const root = this.root;
    if (root?.isConnected) this.render(root);
  }

  // ---------------------------------------------------------------- render

  render(root: HTMLElement): void {
    this.root = root;
    root.querySelector(".recall-chat")?.remove();
    const wrap = root.createDiv({ cls: "recall-chat" });

    const log = wrap.createDiv({ cls: "recall-chat-log" });

    const prefix = this.folderPrefix();
    if (this.turns.length === 0) {
      const hasNotes = this.plugin.app.vault.getMarkdownFiles().some((f: TFile) => f.path.startsWith(prefix));
      log.createDiv({
        cls: "recall-muted",
        text: hasNotes
          ? "Ask a question about your topic notes. Answers cite the highlights they came from. Type /help for commands."
          : `No topic notes under ${prefix} yet. Digest a PDF first, or type /help for commands.`,
      });
    }

    for (const turn of this.turns) this.renderTurn(log, turn);

    this.renderInput(wrap);
    log.scrollTop = log.scrollHeight;
  }

  private renderTurn(log: HTMLElement, turn: ChatTurn): void {
    const cls =
      turn.role === "user" ? "is-user" : turn.role === "system" ? "is-system" : "is-assistant";
    const el = log.createDiv({ cls: `recall-chat-turn ${cls}` });
    if (turn.role === "user") {
      el.setText(turn.text);
      return;
    }
    if (turn.role === "system") {
      // `/help` is a markdown list; everything else is one plain line, and
      // plain text is set as text so a command name containing `*` or `_`
      // cannot be read as markup.
      if (turn.text.startsWith("- ")) void MarkdownRenderer.render(this.plugin.app, turn.text, el.createDiv(), "", this.view);
      else el.setText(turn.text);
      return;
    }

    if (turn.offer) {
      this.renderOffer(el, turn);
      return;
    }

    if (turn.text.trim()) {
      // sourcePath "" — the evidence links `renderEvidenceMarkdown` writes are
      // vault-absolute (`[[classes/HBIO250/Receptors|Receptors]]`), so there is
      // no relative link for a source path to resolve (obsidian.d.ts:4143).
      void MarkdownRenderer.render(this.plugin.app, turn.text, el.createDiv(), "", this.view);
    }
    if (turn.error) el.createDiv({ cls: "recall-error", text: turn.error });

    const report = turn.report;
    if (report && this.plugin.settings.askShowGrounding) this.renderGrounding(el, report);

    const evidence = turn.evidence ?? [];
    if (evidence.length === 0) return;
    el.createDiv({ cls: "recall-chat-evidence-head", text: "Evidence" });
    const cited = new Set(report?.cited ?? []);
    evidence.forEach((unit, i) => {
      const n = i + 1;
      const box = el.createDiv({ cls: `recall-chat-evidence${cited.has(n) ? " is-cited" : ""}` });
      void MarkdownRenderer.render(this.plugin.app, renderEvidenceMarkdown(unit, n), box, "", this.view);
    });
  }

  /**
   * What the checks did, under the answer.
   *
   * The verified quotes are shown because they are the words the answer rests
   * on: the reader can compare them against the evidence below without trusting
   * the prose. Rejected quotes are a count on the grounding line, not a list —
   * printing a quote the check could not find in the evidence would put an
   * unsupported sentence back on the screen.
   */
  private renderGrounding(el: HTMLElement, report: GroundingReport): void {
    const line = el.createDiv({ cls: `recall-chat-grounding${report.verified ? "" : " is-unverified"}` });
    line.createSpan({ text: renderGroundingLine(report) });
    if (!report.verified) line.createSpan({ cls: "recall-badge recall-badge-warn", text: "unverified" });

    if (report.quotesVerified.length === 0) return;
    const md = report.quotesVerified.map((q) => `> “${q.quote}” — [${q.n}]`).join("\n>\n");
    void MarkdownRenderer.render(this.plugin.app, md, el.createDiv({ cls: "recall-chat-quotes" }), "", this.view);
  }

  /**
   * The chip for a line that resembles a command without being one.
   *
   * Nothing has been sent anywhere yet at this point: the matcher only guessed,
   * and the two buttons are the two readings of what was typed. Either way the
   * offer turn goes, so the log does not keep a chip whose choice was already
   * made.
   */
  private renderOffer(el: HTMLElement, turn: ChatTurn): void {
    const offer = turn.offer;
    if (!offer) return;
    const row = el.createDiv({ cls: "recall-chat-offer" });
    row.createSpan({ cls: "recall-muted", text: "Did you mean to run a command?" });

    const run = row.createEl("button", { cls: "mod-cta", text: `Run “${offer.name}”` });
    run.disabled = this.busy;
    run.addEventListener("click", () => {
      this.dropTurn(turn);
      void this.runCommand(offer.id);
    });

    const askInstead = row.createEl("button", { text: "Ask instead" });
    askInstead.disabled = this.busy;
    askInstead.addEventListener("click", () => {
      this.dropTurn(turn);
      void this.askQuestion(offer.question);
    });
  }

  /** Remove one turn by identity; the user turn that preceded an offer stays, because it was typed. */
  private dropTurn(turn: ChatTurn): void {
    const i = this.turns.indexOf(turn);
    if (i >= 0) this.turns.splice(i, 1);
  }

  private renderInput(wrap: HTMLElement): void {
    const box = wrap.createDiv({ cls: "recall-chat-input" });
    const ta = box.createEl("textarea", { cls: "recall-chat-textarea" });
    ta.rows = 3;
    ta.placeholder = "Ask your notes, or type /help…";
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
      void this.ask(ta.value);
    });

    const row = box.createDiv({ cls: "recall-chat-buttons" });
    const send = row.createEl("button", { cls: "mod-cta", text: "Send" });
    send.disabled = this.busy;
    send.addEventListener("click", () => {
      this.draft = ta.value;
      void this.ask(ta.value);
    });
    const clear = row.createEl("button", { text: "Clear" });
    clear.addEventListener("click", () => this.clear());

    row.createSpan({ cls: "recall-muted", text: this.status });

    if (!this.busy) window.setTimeout(() => ta.focus(), 0);
  }
}
