import { ItemView, WorkspaceLeaf, type ViewStateResult } from "obsidian";
import type RecallPlugin from "./main";
import type { LlmBackend } from "./backend";
import { CodexBackend } from "./codex";
import { DeepSeekBackend } from "./deepseek";
import { OpenCodeBackend } from "./opencode";
import { loadSkill, runLearnTurn, runReader, type LearnMessage } from "./learnHarness";
import { LEARNHARNESS_REVISION } from "./learnHarnessPin";

export const VIEW_TYPE_LEARN = "review-inbox-learn";

/** Only conversational state is saved; reader results and consent are never persisted. */
export function parseLearnState(value: unknown): { messages: LearnMessage[]; draft: string } {
  if (!value || typeof value !== "object") return { messages: [], draft: "" };
  const s = value as Record<string, unknown>;
  if (s.version !== 1 || !Array.isArray(s.messages) || s.messages.length > 80 || typeof s.draft !== "string" || s.draft.length > 12_000) return { messages: [], draft: "" };
  const messages: LearnMessage[] = [];
  for (const m of s.messages) {
    if (!m || !["user", "assistant"].includes(m.role) || typeof m.text !== "string" || m.text.length > 24_000) return { messages: [], draft: "" };
    messages.push({ role: m.role, text: m.text });
  }
  if (messages.reduce((n, m) => n + m.text.length, 0) > 120_000) return { messages: [], draft: "" };
  return { messages, draft: s.draft };
}

export class LearnView extends ItemView {
  private messages: LearnMessage[] = [];
  private draft = "";
  private allowed = false;
  private closed = true;
  private epoch = 0;
  private running?: { backend: LlmBackend; controller: AbortController };
  private list?: HTMLElement;
  private status?: HTMLElement;
  private input?: HTMLTextAreaElement;
  private sendButton?: HTMLButtonElement;
  private stopButton?: HTMLButtonElement;
  private clearButton?: HTMLButtonElement;

  constructor(leaf: WorkspaceLeaf, private plugin: RecallPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE_LEARN; }
  getDisplayText(): string { return "Recall Studio Learn"; }
  getIcon(): string { return "messages-square"; }
  getState(): Record<string, unknown> { return { version: 1, messages: this.messages.map(m => ({ ...m })), draft: this.draft }; }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    this.cancel();
    const parsed = parseLearnState(state);
    this.messages = parsed.messages;
    this.draft = parsed.draft;
    this.allowed = false;
    if (!this.closed) await this.onOpen();
    await super.setState(state, result);
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.plugin.learnViews.add(this);
    this.contentEl.empty();
    this.contentEl.addClass("recall-learn");
    this.contentEl.createEl("h3", { text: "Learn" });
    this.contentEl.createEl("p", { text: `Runs LearnHarness's read-only learning-data skill (${LEARNHARNESS_REVISION.slice(0, 7)}). This does not start its teaching app or change your notes, cards or learning records.`, cls: "setting-item-description" });
    const consent = this.contentEl.createEl("label", { cls: "recall-learn-consent" });
    const check = consent.createEl("input", { type: "checkbox" });
    check.checked = this.allowed;
    consent.createSpan({ text: "Allow this chat to send relevant LearnHarness records to my configured model provider." });
    check.addEventListener("change", () => { this.allowed = check.checked; if (!this.allowed) this.cancel(); this.updateButtons(); });
    this.contentEl.createEl("p", { text: "Chat replies and drafts are saved in Obsidian workspace state and may follow your sync settings. Raw reader output is not saved. Use New chat to clear this pane's saved conversation.", cls: "setting-item-description" });
    this.list = this.contentEl.createDiv({ cls: "recall-learn-messages", attr: { role: "log", "aria-label": "Learning conversation" } });
    this.status = this.contentEl.createDiv({ attr: { role: "status", "aria-live": "polite" } });
    this.input = this.contentEl.createEl("textarea", { cls: "recall-learn-input", attr: { "aria-label": "Message to Learn", placeholder: "Ask about your LearnHarness sessions or concepts…", maxlength: "12000" } });
    this.input.value = this.draft;
    this.input.addEventListener("input", () => { this.draft = this.input!.value; this.save(); this.updateButtons(); });
    this.input.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.submit(); } });
    const actions = this.contentEl.createDiv({ cls: "recall-learn-actions" });
    this.sendButton = actions.createEl("button", { text: "Send", cls: "mod-cta" });
    this.sendButton.addEventListener("click", () => void this.submit());
    this.stopButton = actions.createEl("button", { text: "Stop" });
    this.stopButton.addEventListener("click", () => this.cancel());
    this.clearButton = actions.createEl("button", { text: "New chat" });
    this.clearButton.addEventListener("click", () => {
      if (this.running) return;
      this.messages = []; this.draft = ""; this.input!.value = "";
      this.status!.textContent = ""; this.renderMessages(); this.save(); this.updateButtons();
    });
    this.renderMessages(); this.updateButtons();
  }

  private save(): void { this.app.workspace.requestSaveLayout(); }
  private renderMessages(): void {
    this.list?.empty();
    for (const m of this.messages) {
      const entry = this.list!.createDiv({ cls: `recall-learn-message recall-learn-${m.role}` });
      entry.createEl("strong", { text: m.role === "user" ? "You" : "Learn" });
      // Plain text avoids executing stored HTML, embedding media, or leaking through remote images.
      entry.createDiv({ text: m.text, cls: "recall-learn-text" });
    }
  }
  private updateButtons(): void {
    const busy = !!this.running;
    if (this.input) this.input.disabled = busy;
    if (this.sendButton) this.sendButton.disabled = busy || !this.allowed || !this.draft.trim();
    if (this.stopButton) this.stopButton.disabled = !busy;
    if (this.clearButton) this.clearButton.disabled = busy;
  }
  cancel(): void {
    this.epoch++;
    if (this.running && !this.closed && this.status) this.status.textContent = "Stopped. Your draft is retained. Requests already sent to a provider may still finish remotely.";
    this.running?.controller.abort();
    void this.running?.backend.abort().catch(() => {});
  }
  async onClose(): Promise<void> {
    this.closed = true; this.allowed = false; this.cancel();
    this.plugin.learnViews.delete(this);
  }

  async submit(): Promise<void> {
    const text = this.draft.trim();
    if (this.closed || this.running || !this.allowed || !text || text.length > 12_000) return;
    if (this.messages.length >= 78 || this.messages.reduce((n, m) => n + m.text.length, 0) + text.length > 90_000) {
      this.status!.textContent = "This chat is full. Start a new chat; existing messages have not been truncated."; return;
    }
    const epoch = ++this.epoch;
    const settingsKey = JSON.stringify(this.plugin.settings);
    const settings = { ...this.plugin.settings };
    const getSettings = () => settings;
    const backend = settings.provider === "deepseek" ? new DeepSeekBackend(getSettings) : settings.provider === "opencode" ? new OpenCodeBackend(getSettings) : new CodexBackend(getSettings);
    const running = { backend, controller: new AbortController() };
    this.running = running;
    const authorized = () => !this.closed && this.allowed && this.epoch === epoch && JSON.stringify(this.plugin.settings) === settingsKey;
    this.updateButtons(); this.status!.textContent = "Loading LearnHarness skill…";
    try {
      const skill = await loadSkill(settings.learnSkillPath || undefined);
      if (!authorized()) throw new Error("cancelled");
      const answer = await runLearnTurn({ skill, messages: [...this.messages, { role: "user", text }], authorized,
        complete: async request => {
          const signal = running.controller.signal;
          if (signal.aborted) throw new Error("cancelled");
          let stop: () => void = () => {};
          const cancelled = new Promise<never>((_, reject) => {
            stop = () => reject(new Error("cancelled"));
            signal.addEventListener("abort", stop, { once: true });
          });
          try { return await Promise.race([backend.complete(request), cancelled]); }
          finally { signal.removeEventListener("abort", stop); }
        },
        read: action => runReader(skill, { dataDir: settings.learnDataPath, pythonPath: settings.learnPythonPath }, action, running.controller.signal),
        onAction: action => { if (authorized()) this.status!.textContent = `Reading LearnHarness: ${action.action.replaceAll("_", " ")}…`; },
      });
      if (!authorized()) return;
      this.messages.push({ role: "user", text }, { role: "assistant", text: answer });
      this.draft = ""; this.input!.value = "";
      this.status!.textContent = ""; this.renderMessages(); this.save();
    } catch {
      // Provider stderr and malformed records may contain private source text or credentials.
      if (!this.closed && this.epoch === epoch) this.status!.textContent = authorized()
        ? "Learn could not finish. Check the pinned skill installation, Python 3.10+, data folder and provider. Records may be invalid or too large. Your draft is retained; nothing was changed."
        : "Stopped because this chat was cancelled or its settings/permission changed. Your draft is retained.";
    } finally {
      if (this.running === running) this.running = undefined;
      if (!this.closed) this.updateButtons();
    }
  }
}
