// Schema analyze cancel wiring — extracted as a pure function for testability.
//
// Background: ROADMAP v1.17.0 P1 #1.
// Both call sites of `suggestSchemaUpdate` (command palette + Lint Report
// Modal button) bypass the lint cancel infrastructure, so the status bar's
// "click to cancel" does nothing during schema analysis.
//
// v1.22.0 #97: when the LLM returns new_schema_body, the orchestrator
// hands it to a UI callback (openSchemaDiffModal) that shows the
// SchemaDiffModal with the IDE-style diff preview. The user can
// Apply (backs up + writes), Regenerate (re-call LLM with optional
// hint), or Cancel.

import { Notice } from 'obsidian';
import { TEXTS } from '../texts';
import { NOTICE_NORMAL, NOTICE_ERROR } from '../constants';
import type { SchemaSuggestion } from '../types';

export interface SchemaAnalyzeCtx {
  settings: { language: string };
  llmClient: unknown;
  wikiEngine: {
    startLintOperation(): { aborted: boolean };
    endLintOperation(): void;
  };
  schemaManager: {
    suggestSchemaUpdate(context: string): Promise<unknown>;
  };
  requireLLMReady(): boolean;
  /** v1.22.0 #97: when the LLM returns new_schema_body, the orchestrator
   *  hands it to this callback. The UI shows the diff Modal and applies
   *  the change. The callback is async because Apply triggers
   *  applySchemaSuggestion which is also async. */
  openSchemaDiffModal?: (suggestion: SchemaSuggestion) => Promise<void> | void;
  /** v1.22.0 #97: when no new_schema_body is available (legacy v1.21.x
   *  prompt, or changes_needed is false), the orchestrator falls back to
   *  the historical Notice-based flow. */
  /** v1.22.0 #97: lint analysis context — a string summarising the
   *  lint results (orphan counts, dead links, contradictions, tag
   *  violations, etc.) so the LLM has real data to decide whether
   *  schema changes are needed. Falls back to 'Wiki lint analysis'
   *  when not provided (backward compat with callers that don't pass
   *  it, e.g. command-palette direct invocation). */
  lintAnalysisContext?: string;
}

export async function runSchemaAnalyze(ctx: SchemaAnalyzeCtx): Promise<void> {
  if (!ctx.requireLLMReady()) return;
  if (!ctx.llmClient) {
    new Notice(TEXTS[ctx.settings.language as keyof typeof TEXTS].errorNoApiKey);
    return;
  }

  const signal = ctx.wikiEngine.startLintOperation();
  // v1.22.0 #97: persistent notice while the LLM thinks — the call
  // can take 5-30s on a thinking-capable model and the user has no
  // other progress signal. We update the same notice with a "thinking"
  // suffix so the user knows it's not hung.
  const thinkingNotice = new Notice(TEXTS[ctx.settings.language as keyof typeof TEXTS].analyzingSchema, 0);
  try {
    const result = (await ctx.schemaManager.suggestSchemaUpdate(ctx.lintAnalysisContext ?? 'Wiki lint analysis')) as SchemaSuggestion | null;
    thinkingNotice.hide();
    if (signal.aborted) return; // user cancelled — suppress stale result Notice
    // v1.22.0 #97: the Modal opens for ANY result (changes_needed true OR
    // false) so the user can read the LLM's reasoning and decide whether
    // to Regenerate (re-prompt) or Cancel. Without the Modal, the user
    // is left wondering "what did the LLM think?" after a flash of
    // Notice. We pass the new body even when changes_needed=false —
    // the Modal handles the no-op case (left == right, Apply disabled).
    if (result && ctx.openSchemaDiffModal) {
      await ctx.openSchemaDiffModal(result);
      return;
    }
    // Backward-compat fallback: if the caller does not provide the
    // Modal callback (e.g. a future test, a CLI script, etc.) we fall
    // back to the v1.21.x Notice-based flow.
    if (result?.changes_needed) {
      new Notice(TEXTS[ctx.settings.language as keyof typeof TEXTS].schemaSuggestionGenerated, NOTICE_ERROR);
    } else if (result) {
      new Notice(TEXTS[ctx.settings.language as keyof typeof TEXTS].noSchemaUpdateNeeded, NOTICE_NORMAL);
    }
  } catch (error) {
    thinkingNotice.hide();
    console.error('Schema suggestion failed:', error);
    if (signal.aborted) return; // suppress error Notice on user-initiated cancel
    const errMsg = error instanceof Error ? error.message : String(error);
    new Notice(
      TEXTS[ctx.settings.language as keyof typeof TEXTS].schemaSuggestionFailed + ': ' + errMsg,
      NOTICE_ERROR
    );
  } finally {
    ctx.wikiEngine.endLintOperation();
  }
}
