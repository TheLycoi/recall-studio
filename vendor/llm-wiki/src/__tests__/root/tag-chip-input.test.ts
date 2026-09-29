// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TagChipInputComponent } from '../../ui/tag-chip-input';

describe('TagChipInputComponent (Issue #85 v2)', () => {
  let container: HTMLElement;
  let onChange: (csv: string) => void;
  let onChangeMock: ReturnType<typeof vi.fn>;
  let component: TagChipInputComponent;

  const getChips = (): HTMLElement[] =>
    Array.from(container.querySelectorAll('.llm-wiki-tag-chip'));
  const getChipLabels = () =>
    getChips().map(c => c.querySelector('.llm-wiki-tag-chip-label')?.textContent ?? '');
  const getInput = () => container.querySelector('.llm-wiki-tag-input') as HTMLInputElement;
  const fireKey = (el: HTMLElement, key: string, init: Partial<KeyboardEventInit> = {}) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return ev;
  };

  beforeEach(() => {
    container = activeDocument.createElement('div');
    activeDocument.body.appendChild(container);
    onChangeMock = vi.fn();
    onChange = onChangeMock as unknown as (csv: string) => void;
    component = new TagChipInputComponent({
      controlEl: container,
      initialTags: '',
      placeholder: 'Add tag...',
      ariaLabel: 'Custom tags',
      duplicateHint: 'Duplicate tag skipped',
      // No defaultTags here — the v2 describe block tests the "no
      // defaults" code path; v4 has a separate describe block for the
      // default-fallback behavior.
      onChange,
    });
  });

  it('renders multiple chips from CSV setValue', () => {
    component.setValue('person, organization, project');
    expect(getChipLabels()).toEqual(['person', 'organization', 'project']);
  });

  it('trims whitespace and filters empty entries on setValue', () => {
    component.setValue(' person , , organization ');
    expect(getChipLabels()).toEqual(['person', 'organization']);
  });

  it('dedupes case-insensitively, keeping first casing', () => {
    component.setValue('Person, person, PERSON');
    expect(getChipLabels()).toEqual(['Person']);
  });

  it('preserves nested tag syntax with /', () => {
    component.setValue('Arzneimittel/Neurologie');
    expect(getChipLabels()).toEqual(['Arzneimittel/Neurologie']);
  });

  it('handles empty CSV (no chips, no error)', () => {
    component.setValue('');
    expect(getChips()).toHaveLength(0);
    expect(getInput().value).toBe('');
  });

  it('handles CSV with only commas (no chips, no flash)', () => {
    component.setValue(',,,');
    expect(getChips()).toHaveLength(0);
    expect(container.classList.contains('llm-wiki-tag-container--duplicate')).toBe(false);
  });

  it('Enter key adds a chip and clears the input', () => {
    const input = getInput();
    input.value = 'medical';
    fireKey(input, 'Enter');
    expect(getChipLabels()).toEqual(['medical']);
    expect(input.value).toBe('');
  });

  it('Comma key acts as terminator (suppresses literal comma)', () => {
    const input = getInput();
    input.value = 'medical';
    const ev = fireKey(input, ',');
    expect(getChipLabels()).toEqual(['medical']);
    expect(input.value).toBe('');
    expect(ev.defaultPrevented).toBe(true);
  });

  it('Backspace on empty input removes the last chip', () => {
    component.setValue('a, b, c');
    const input = getInput();
    input.value = '';
    fireKey(input, 'Backspace');
    expect(getChipLabels()).toEqual(['a', 'b']);
  });

  it('Click on × removes the matching chip', () => {
    component.setValue('a, b, c');
    const removeBtn = getChips()[1].querySelector('.llm-wiki-tag-chip-remove') as HTMLButtonElement;
    removeBtn.click();
    expect(getChipLabels()).toEqual(['a', 'c']);
  });

  it('Duplicate tag (case-insensitive) flashes container, does not add chip', () => {
    component.setValue('medical');
    const input = getInput();
    input.value = 'Medical';
    const added = component.addTag('Medical');
    expect(added).toBe(false);
    expect(getChipLabels()).toEqual(['medical']);
    expect(container.classList.contains('llm-wiki-tag-container--duplicate')).toBe(true);
  });

  it('Empty/whitespace Enter is silently skipped (no chip, no flash)', () => {
    const input = getInput();
    input.value = '   ';
    fireKey(input, 'Enter');
    expect(getChips()).toHaveLength(0);
    expect(container.classList.contains('llm-wiki-tag-container--duplicate')).toBe(false);
  });

  it('onChange fires with CSV after each add/remove', () => {
    // setValue() is the initial-load path and intentionally does not
    // fire onChange (it's a settings hydration, not a user edit).
    component.setValue('a');
    expect(onChangeMock).not.toHaveBeenCalled();
    const input = getInput();
    input.value = 'b';
    fireKey(input, 'Enter');
    expect(onChangeMock).toHaveBeenLastCalledWith('a, b');
    const removeBtn = getChips()[0].querySelector('.llm-wiki-tag-chip-remove') as HTMLButtonElement;
    removeBtn.click();
    expect(onChangeMock).toHaveBeenLastCalledWith('b');
  });

  it('getValue returns canonical CSV (joined by ", ")', () => {
    component.setValue('alpha, beta, gamma');
    expect(component.getValue()).toBe('alpha, beta, gamma');
  });

  it('container exposes role="group" and aria-label for a11y', () => {
    expect(container.getAttribute('role')).toBe('group');
    expect(container.getAttribute('aria-label')).toBe('Custom tags');
  });

  it('IME composition (isComposing) prevents Enter from adding chip', () => {
    const input = getInput();
    input.value = '医疗';
    fireKey(input, 'Enter', { isComposing: true });
    expect(getChips()).toHaveLength(0);
  });
});

describe('TagChipInputComponent (Issue #85 v4) — default fallback tags', () => {
  let container: HTMLElement;
  let onChangeMock: ReturnType<typeof vi.fn>;
  let onChange: (csv: string) => void;
  let component: TagChipInputComponent;

  const getChips = (): HTMLElement[] =>
    Array.from(container.querySelectorAll('.llm-wiki-tag-chip'));
  const getChipLabels = () =>
    getChips().map(c => c.querySelector('.llm-wiki-tag-chip-label')?.textContent ?? '');
  const getInput = () => container.querySelector('.llm-wiki-tag-input') as HTMLInputElement;
  const fireKey = (el: HTMLElement, key: string) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  };

  beforeEach(() => {
    container = activeDocument.createElement('div');
    activeDocument.body.appendChild(container);
    onChangeMock = vi.fn();
    onChange = onChangeMock as unknown as (csv: string) => void;
    component = new TagChipInputComponent({
      controlEl: container,
      initialTags: '',
      placeholder: 'Add tag...',
      ariaLabel: 'Custom tags',
      duplicateHint: 'Duplicate tag skipped',
      defaultTags: ['person', 'organization', 'project'],
      onChange,
    });
  });

  it('when initialTags is empty, defaultTags materialize as real chips (editable baseline)', () => {
    expect(getChips()).toHaveLength(3);
    expect(getChipLabels()).toEqual(['person', 'organization', 'project']);
  });

  it('defaulted chips use the same .llm-wiki-tag-chip class (no visual distinction from user-added)', () => {
    expect(getChips()[0].className).toBe('llm-wiki-tag-chip');
    // No data-preview attribute — defaults are real, editable chips.
    expect(getChips()[0].getAttribute('data-preview')).toBeNull();
  });

  it('defaulted chips have a `×` remove button (same as user-added chips)', () => {
    const remove = getChips()[0].querySelector('.llm-wiki-tag-chip-remove');
    expect(remove?.textContent).toBe('×');
    // No "+" add button — v3 preview design is gone.
    expect(getChips()[0].querySelector('.llm-wiki-tag-chip-add')).toBeNull();
  });

  it('clicking × on a defaulted chip removes it and fires onChange', () => {
    expect(getChips()).toHaveLength(3);
    const remove = getChips()[0].querySelector('.llm-wiki-tag-chip-remove') as HTMLButtonElement;
    remove.click();
    expect(getChips()).toHaveLength(2);
    expect(getChipLabels()).toEqual(['organization', 'project']);
    expect(onChangeMock).toHaveBeenLastCalledWith('organization, project');
  });

  it('initial load with defaultTags does NOT fire onChange (settings hydration, not user edit)', () => {
    expect(onChangeMock).not.toHaveBeenCalled();
  });

  it('user can type a new tag and the defaulted chips remain visible', () => {
    const input = getInput();
    input.value = 'medical';
    fireKey(input, 'Enter');
    expect(getChips()).toHaveLength(4);
    expect(getChipLabels()).toContain('medical');
    expect(getChipLabels()).toContain('person');
    expect(onChangeMock).toHaveBeenLastCalledWith('person, organization, project, medical');
  });

  it('when initialTags is non-empty, defaultTags are ignored (user already customized)', () => {
    container = activeDocument.createElement('div');
    activeDocument.body.appendChild(container);
    const c = new TagChipInputComponent({
      controlEl: container,
      initialTags: 'medical',
      placeholder: 'Add tag...',
      ariaLabel: 'Custom tags',
      duplicateHint: 'Duplicate tag skipped',
      defaultTags: ['person', 'organization'],
      onChange,
    });
    expect(c.getTags()).toEqual(['medical']);
    expect(c.getValue()).toBe('medical');
  });

  it('removing all defaulted chips leaves the field empty (getValue returns "")', () => {
    for (let i = 0; i < 3; i++) {
      const remove = getChips()[0].querySelector('.llm-wiki-tag-chip-remove') as HTMLButtonElement;
      remove.click();
    }
    expect(getChips()).toHaveLength(0);
    // Once the user has removed all chips the persisted value is empty.
    // The defaults no longer auto-restore (otherwise the user could never
    // opt out of them). At write time `enforceFrontmatterConstraints`
    // falls back to the hardcoded defaults when the CSV is empty.
    expect(component.getValue()).toBe('');
  });

  it('getValue returns the canonical ", "-joined CSV of currently-rendered chips', () => {
    expect(component.getValue()).toBe('person, organization, project');
    const remove = getChips()[1].querySelector('.llm-wiki-tag-chip-remove') as HTMLButtonElement;
    remove.click();
    expect(component.getValue()).toBe('person, project');
  });
});
