// v1.23.2: vertical turn indicator (Variant 2 only).
// v1.25.11 PATCH follow-up v4: translated dot stack.
//
// Right-edge dots, one per turn. Clicking a dot scrolls the
// corresponding turn to the top of the history container. Tooltip on
// hover shows the question text. The whole dot stack is translated
// vertically via the `--llm-wiki-translate-y` CSS custom property so
// the dot representing the currently-visible turn sits at the
// indicator's vertical centre.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { installObsidianDomHelpers } from '../__support__/dom-helpers';

import {
  buildTurnIndicator,
  findTurnElements,
  pickActiveTurn,
  scrollTurnToStart,
  updateActiveDot,
  updateIndicatorTranslation,
} from '../../wiki/turn-indicator';

beforeEach(() => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  // eslint-disable-next-line obsidianmd/no-global-this
  globalThis.document = dom.window.document;
  // eslint-disable-next-line obsidianmd/no-global-this
  (globalThis as Record<string, unknown>).activeDocument = dom.window.document;
  installObsidianDomHelpers(
    { HTMLElement: dom.window.HTMLElement, Document: dom.window.Document },
    dom.window.document,
  );
});

afterEach(() => {
  // eslint-disable-next-line obsidianmd/no-global-this
  delete (globalThis as Record<string, unknown>).document;
  // eslint-disable-next-line obsidianmd/no-global-this
  delete (globalThis as Record<string, unknown>).activeDocument;
});

function makeHistoryContainer(turnCount: number): HTMLElement {
  // eslint-disable-next-line obsidianmd/no-global-this
  const doc = globalThis.document;
  const container = doc.createElement('div');
  container.className = 'llm-wiki-query-history';
  for (let i = 0; i < turnCount; i++) {
    const user = doc.createElement('div');
    user.className = 'llm-wiki-query-message-wrapper llm-wiki-query-message-user';
    user.dataset.turn = String(i);
    container.appendChild(user);

    const assistant = doc.createElement('div');
    assistant.className = 'llm-wiki-query-message-wrapper llm-wiki-query-message-assistant';
    assistant.dataset.turn = String(i);
    container.appendChild(assistant);
  }
  return container;
}

describe('turn-indicator helpers', () => {
  describe('findTurnElements', () => {
    it('finds all unique turns in document order', () => {
      const container = makeHistoryContainer(3);
      const turns = findTurnElements(container);
      expect(turns.length).toBe(3);
      expect(turns[0].dataset.turn).toBe('0');
      expect(turns[2].dataset.turn).toBe('2');
    });
  });

  describe('buildTurnIndicator', () => {
    it('renders one dot per turn (no fixed slot count)', () => {
      const container = makeHistoryContainer(50);
      const indicator = buildTurnIndicator(container, 0, Array(50).fill('q'), () => {});
      const dots = indicator.querySelectorAll('.llm-wiki-turn-dot');
      expect(dots.length).toBe(50);
    });

    it('preserves question text in tooltips (v1.23.2 behaviour)', () => {
      const container = makeHistoryContainer(3);
      const indicator = buildTurnIndicator(
        container, 0, ['first question', 'second question', 'third'], () => {},
      );
      const tooltips = indicator.querySelectorAll('.llm-wiki-turn-dot-tooltip');
      expect(tooltips.length).toBe(3);
      expect(tooltips[0].textContent).toBe('first question');
      expect(tooltips[1].textContent).toBe('second question');
      expect(tooltips[2].textContent).toBe('third');
    });

    it('falls back to "Turn N" for empty labels', () => {
      const container = makeHistoryContainer(3);
      const indicator = buildTurnIndicator(container, 0, ['first', '', 'third'], () => {});
      const tooltips = indicator.querySelectorAll('.llm-wiki-turn-dot-tooltip');
      expect(tooltips[1].textContent).toMatch(/Turn \d+/);
    });

    it('marks the initial active dot and routes its click callback', () => {
      const container = makeHistoryContainer(3);
      const clicked: number[] = [];
      const indicator = buildTurnIndicator(
        container, 1, ['q1', 'q2', 'q3'],
        (idx) => clicked.push(idx),
      );
      const dots = indicator.querySelectorAll('.llm-wiki-turn-dot');
      expect(dots[1].classList.contains('llm-wiki-turn-dot-active')).toBe(true);
      expect(dots[0].classList.contains('llm-wiki-turn-dot-active')).toBe(false);
      (dots[1] as HTMLElement).click();
      expect(clicked).toEqual([1]);
    });

    it('every dot is clickable (no empty slots, no pointer-events disabled)', () => {
      const container = makeHistoryContainer(20);
      const indicator = buildTurnIndicator(container, 0, Array(20).fill('q'), () => {});
      const dots = indicator.querySelectorAll('.llm-wiki-turn-dot');
      dots.forEach((dot) => {
        // No empty class — every dot is interactive.
        expect(dot.classList.contains('llm-wiki-turn-dot-empty')).toBe(false);
      });
      expect(dots.length).toBe(20);
      // Each dot has a real click listener (no .onclick = null trick).
      const clicked: number[] = [];
      // Re-build with a click recorder to verify all dots fire.
      const indicator2 = buildTurnIndicator(
        container, 0, Array(20).fill('q'), (idx) => clicked.push(idx),
      );
      indicator2.querySelectorAll('.llm-wiki-turn-dot').forEach((d) => (d as HTMLElement).click());
      expect(clicked.length).toBe(20);
    });
  });

  describe('updateActiveDot', () => {
    it('moves the active class and re-translates the stack', () => {
      const container = makeHistoryContainer(20);
      const indicator = buildTurnIndicator(container, 0, Array(20).fill('q'), () => {});
      Object.defineProperty(indicator, 'clientHeight', { configurable: true, get: () => 400 });
      updateActiveDot(indicator, 10);
      const dots = indicator.querySelectorAll('.llm-wiki-turn-dot');
      expect(dots[10].classList.contains('llm-wiki-turn-dot-active')).toBe(true);
      // translate-y must be set to a non-default value
      const ty = indicator.style.getPropertyValue('--llm-wiki-translate-y');
      expect(ty).not.toBe('');
      expect(ty).not.toBe('0px');
    });
  });

  describe('updateIndicatorTranslation', () => {
    it('sets --llm-wiki-translate-y so the active dot lands above indicator centre', () => {
      const container = makeHistoryContainer(20);
      const indicator = buildTurnIndicator(container, 0, Array(20).fill('q'), () => {});
      Object.defineProperty(indicator, 'clientHeight', { configurable: true, get: () => 200 });
      updateIndicatorTranslation(indicator, 5);
      // dotPitch = 14, activeIdx = 5, dotHalf = 3, indicatorHeight = 200,
      // ACTIVE_DOT_VERTICAL_BIAS = 30.
      // translateY = 200/2 - 5*14 - 3 - 30 = 100 - 70 - 3 - 30 = -3
      expect(indicator.style.getPropertyValue('--llm-wiki-translate-y')).toBe('-3px');
    });

    it('no-op when indicator has zero dots', () => {
      const container = makeHistoryContainer(0);
      const indicator = buildTurnIndicator(container, 0, [], () => {});
      updateIndicatorTranslation(indicator, 0);
      expect(indicator.style.getPropertyValue('--llm-wiki-translate-y')).toBe('');
    });
  });

  describe('pickActiveTurn', () => {
    function makeTurnEl(turn: string): HTMLElement {
      const el = document.createElement('div');
      el.setAttribute('data-turn', turn);
      return el;
    }

    it('returns the index of the most-visible entry', () => {
      const turns = [makeTurnEl('3'), makeTurnEl('5')];
      const entries = [
        { target: turns[0], intersectionRatio: 0.4 },
        { target: turns[1], intersectionRatio: 0.9 },
      ] as unknown as IntersectionObserverEntry[];
      expect(pickActiveTurn(entries, turns)).toBe(1);
    });

    it('returns null when entries is empty', () => {
      expect(pickActiveTurn([], [])).toBe(null);
    });
  });

  it('scrolls the selected turn to start via scrollIntoView mock', () => {
    const container = makeHistoryContainer(3);
    const turns = findTurnElements(container);
    const called: { turn: string; options: ScrollIntoViewOptions }[] = [];

    scrollTurnToStart(turns[1], (opts: ScrollIntoViewOptions) => {
      called.push({ turn: turns[1].dataset.turn ?? '', options: opts });
    });

    expect(called.length).toBe(1);
    expect(called[0].turn).toBe('1');
    expect(called[0].options.block).toBe('start');
    expect(called[0].options.behavior).toBe('smooth');
  });
});