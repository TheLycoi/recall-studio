import { Setting } from 'obsidian';
import type { LLMWikiSettingTab } from '../settings';

/**
 * Shared number-input renderer for settings sections (v1.26.0 #382 item 2).
 *
 * Serves the Advanced section's three temperature/penalty fields AND the
 * Auto Maintenance section's three lint dedup thresholds. Extracted from
 * advanced-section.ts as a module-level function so both sections share one
 * implementation instead of duplicating the ~20-line input row.
 *
 * `max` parameterizes the HTML range: temperature/penalty fields use 0..2;
 * dedup thresholds use 0..1 (Jaccard similarity is bounded [0,1]).
 *
 * The onChange uses Number.isFinite (not isNaN) so ±Infinity / NaN never
 * land in settings — a value of 1.5 or −0.1 would otherwise silently
 * disable or flood a dedup signal (the consumption layer clamps to [0,1]
 * as a second gate, so data.json-sourced values are defended there).
 */
export type NumberInputFieldKey =
  | 'extractionTemperature'
  | 'chatTemperature'
  | 'repetitionPenalty'
  | 'lintJaccardLinkThreshold'
  | 'lintJaccardBodyGate'
  | 'lintBigramThreshold';

export function renderNumberInput(
  tab: LLMWikiSettingTab,
  containerEl: HTMLElement,
  nameKey: string,
  descKey: string,
  fieldKey: NumberInputFieldKey,
  max: string = '2',
): void {
  const { tempSettings } = tab;
  new Setting(containerEl)
    .setName(tab.getTextDynamic(nameKey))
    .setDesc(tab.getTextDynamic(descKey))
    .addText(text => {
      text
        .setPlaceholder(tab.getText('temperaturePlaceholder'))
        .setValue(tempSettings[fieldKey]?.toString() ?? '')
        .onChange((value) => {
          const trimmed = value.trim();
          if (trimmed === '') {
            tempSettings[fieldKey] = undefined;
          } else {
            const parsed = parseFloat(trimmed);
            if (Number.isFinite(parsed)) {
              tempSettings[fieldKey] = parsed;
            }
          }
        });
      text.inputEl.type = 'number';
      text.inputEl.min = '0';
      text.inputEl.max = max;
      text.inputEl.step = '0.05';
      text.inputEl.classList.add('llm-wiki-number-input');
    });
}
