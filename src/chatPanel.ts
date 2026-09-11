import { ItemView, MarkdownRenderer, TAbstractFile, TFile, prepareSimpleSearch } from "obsidian";
import type RecallPlugin from "./main";
import { describeError } from "./llm";
import { indexNote, numberEvidence, rankEvidence, renderEvidenceMarkdown, type EvidenceUnit } from "./retrieval";
import type { AskHistoryTurn } from "./prompt";

/** One turn in the chat log. An assistant turn carries the evidence it was answered from, error or not. */
interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  evidence?: EvidenceUnit[];
  error?: string;
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

  /** The last `askMaxTurns` turns, as the prompt wants them (src/prompt.ts:97-106). */
  private history(): AskHistoryTurn[] {
    const keep = Math.max(0, this.plugin.settings.askMaxTurns);
    return this.turns
      .filter((t) => !t.error)
      .slice(-keep)
      .map((t) => ({ role: t.role, text: t.text }));
  }

  /** Keep the log bounded the way the settings ask: `askMaxTurns` exchanges, so twice that many entries. */
  private trim(): void {
    const cap = Math.max(2, this.plugin.settings.askMaxTurns * 2);
    if (this.turns.length > cap) this.turns = this.turns.slice(this.turns.length - cap);
  }

  /**
   * One question: index, rank, number, ask, check the citations.
   *
   * The evidence is pushed with the assistant turn whether the model answered
   * or failed, because the sources are the part the reader can still use when
   * there is no provider configured.
   */
  async ask(question: string): Promise<void> {
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

      this.status = "asking the model…";
      this.rerender();

      const draft = await this.plugin.llm.ask({
        question: q,
        evidence: numberEvidence(evidence),
        history: this.history(),
        standingInstructions: this.plugin.settings.askInstructions,
      });
      // Temporary: the draft is now structured, and `checkAnswer` (src/askCheck.ts)
      // is what assembles and grounds it. Until that lands, join the sentences
      // and append their citations so the panel keeps compiling and answering.
      const text = draft.sentences
        .map((s) => s.text + (s.cited.length ? " " + s.cited.map((n) => `[${n}]`).join("") : ""))
        .join(" ");
      this.turns.push({ role: "assistant", text, evidence });
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
          ? "Ask a question about your topic notes. Answers cite the highlights they came from."
          : `No topic notes under ${prefix} yet. Digest a PDF first.`,
      });
    }

    for (const turn of this.turns) this.renderTurn(log, turn);

    this.renderInput(wrap);
    log.scrollTop = log.scrollHeight;
  }

  private renderTurn(log: HTMLElement, turn: ChatTurn): void {
    const el = log.createDiv({ cls: `recall-chat-turn ${turn.role === "user" ? "is-user" : "is-assistant"}` });
    if (turn.role === "user") {
      el.setText(turn.text);
      return;
    }

    if (turn.text.trim()) {
      // sourcePath "" — the evidence links `renderEvidenceMarkdown` writes are
      // vault-absolute (`[[classes/HBIO250/Receptors|Receptors]]`), so there is
      // no relative link for a source path to resolve (obsidian.d.ts:4143).
      void MarkdownRenderer.render(this.plugin.app, turn.text, el.createDiv(), "", this.view);
    }
    if (turn.error) el.createDiv({ cls: "recall-error", text: turn.error });

    const evidence = turn.evidence ?? [];
    if (evidence.length === 0) return;
    el.createDiv({ cls: "recall-chat-evidence-head", text: "Evidence" });
    evidence.forEach((unit, i) => {
      const box = el.createDiv({ cls: "recall-chat-evidence" });
      void MarkdownRenderer.render(this.plugin.app, renderEvidenceMarkdown(unit, i + 1), box, "", this.view);
    });
  }

  private renderInput(wrap: HTMLElement): void {
    const box = wrap.createDiv({ cls: "recall-chat-input" });
    const ta = box.createEl("textarea", { cls: "recall-chat-textarea" });
    ta.rows = 3;
    ta.placeholder = "Ask your notes…";
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
