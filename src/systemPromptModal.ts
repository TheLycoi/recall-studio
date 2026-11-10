import { App, Modal, Notice, Setting, TextAreaComponent } from "obsidian";
import type RecallPlugin from "./main";
import { DEFAULT_SYSTEM_PROMPTS, MAX_PROMPT_CHARS, systemPrompt, type PromptId } from "./systemPrompts";

export const PROMPT_LABELS: Record<PromptId, string> = {
  method: "Shared writing method", reader: "Reader prompt", writer: "Writer prompt", grader: "Grader prompt",
};

export class SystemPromptModal extends Modal {
  private initial: string | undefined;
  private draft: string;
  private saving = false;

  constructor(app: App, private plugin: Pick<RecallPlugin, "settings" | "saveSettings">, private id: PromptId) {
    super(app);
    this.initial = plugin.settings.systemPrompts?.[id];
    this.draft = systemPrompt(id, plugin.settings.systemPrompts);
  }

  onOpen(): void {
    const root = this.contentEl;
    root.createEl("h2", { text: PROMPT_LABELS[this.id] });
    root.createEl("p", { text: "Edit the instructions used by the existing card-writing pipeline. Source safeguards and response schemas remain fixed. Changes apply to new requests; pending results using older prompts are refused. No cards are rewritten by saving." });
    let editor: TextAreaComponent;
    new Setting(root).setName("System instructions").addTextArea(t => {
      t.setValue(this.draft).onChange(value => { this.draft = value; });
      editor = t;
      editor.inputEl.rows = 22;
      editor.inputEl.setAttribute?.("aria-label", PROMPT_LABELS[this.id]);
      editor.inputEl.classList?.add("ri-system-prompt-editor");
    });
    new Setting(root).addButton(b => b.setButtonText("Restore default").onClick(() => {
      if (this.saving) return;
      this.draft = DEFAULT_SYSTEM_PROMPTS[this.id];
      editor.setValue(this.draft);
    }));
    new Setting(root).addButton(b => b.setButtonText("Cancel").onClick(() => { if (!this.saving) this.close(); }));
    new Setting(root).addButton(b => b.setButtonText("Save").onClick(async () => {
      if (this.saving) return;
      if (!this.draft.trim() || this.draft.length > MAX_PROMPT_CHARS) {
        new Notice("Enter a nonempty prompt of at most 30,000 characters, or restore the default.");
        return;
      }
      if (this.plugin.settings.systemPrompts?.[this.id] !== this.initial) {
        new Notice("This prompt changed while the editor was open. Reopen it before saving.");
        return;
      }
      this.saving = true; b.setDisabled(true);
      const prior = this.plugin.settings.systemPrompts;
      const value = this.draft === DEFAULT_SYSTEM_PROMPTS[this.id] ? undefined : this.draft;
      const prompts = { ...prior };
      if (value === undefined) delete prompts[this.id]; else prompts[this.id] = value;
      this.plugin.settings.systemPrompts = prompts;
      try {
        await this.plugin.saveSettings();
        this.close();
      } catch {
        // Restore only our still-current value, never a concurrent edit to another prompt.
        if (this.plugin.settings.systemPrompts?.[this.id] === value) {
          const restored = { ...this.plugin.settings.systemPrompts };
          if (this.initial === undefined) delete restored[this.id]; else restored[this.id] = this.initial;
          this.plugin.settings.systemPrompts = !prior && !Object.keys(restored).length ? undefined : restored;
        }
        new Notice("Recall Studio could not save this prompt. Your draft is still in the editor; check storage and retry.");
      } finally { this.saving = false; b.setDisabled(false); }
    }));
  }

  onClose(): void { this.contentEl.empty(); }
}
