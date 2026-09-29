/**
 * ChatGPT/Grok-style vertical turn indicator (v1.25.11 PATCH redesign v4).
 *
 * Variant 2 only (per v1.23.2 scope): right-edge dots, one per turn.
 * Clicking a dot scrolls the corresponding turn into view. Tooltip on
 * hover shows the question text (the v1.23.2 behaviour — preserved).
 *
 * === Translation model (v4) ===
 *
 * Pre-patch behaviour (v1.23.2): rendered one dot per turn. With a 200-
 * turn conversation the indicator grew to ~3k px tall and overflowed
 * the history container — losing its purpose as a "where am I" anchor.
 *
 * Failed attempts in this patch:
 *   - v1: dynamic dot gap (compressed to fit) — confused users about
 *     "which dot represents which turn"; frame still huge.
 *   - v2: 12-slot sliding window — broke the hover-tooltip UX,
 *     misaligned active highlighting, broke clickability.
 *
 * Current (v4): one dot per turn, but the entire dot stack is
 * vertically TRANSLATED inside a fixed-height window so that the dot
 * representing the currently-visible turn always sits at the vertical
 * centre of the indicator.
 *
 *   - historyContainer height = indicator height (both stretch to fill
 *     the panel).
 *   - dot positions: `translateY(-activeIdx * dotPitch + containerMid -
 *     activeIdxMid)` so the active dot is centred in the indicator.
 *   - mask-image top/bottom fade so dots that scroll out of the
 *     indicator's visible region blend into the chrome instead of
 *     popping out abruptly.
 *   - When the conversation is very short and there are fewer dots
 *     than vertical room, the dots are centred with no translation.
 *   - When the conversation is very long, the dot stack is shifted so
 *     only ~`indicatorHeight / dotPitch` dots are ever visible; the
 *     rest fade into the mask.
 *
 * Tooltips on hover show the question text (the v1.23.2 behaviour).
 * The active dot is whichever turn the IntersectionObserver reports
 * as most visible.
 */

const INDICATOR_CLASS = 'llm-wiki-turn-indicator';
const DOT_CLASS = 'llm-wiki-turn-dot';
const ACTIVE_CLASS = 'llm-wiki-turn-dot-active';
const TURN_ATTR = 'data-turn';

/** Vertical pitch between adjacent dots: dot height 6 + gap 8 = 14px. */
const DOT_PITCH = 14;

/**
 * Vertical offset that shifts the whole dot stack upward so the
 * "active" dot lands in the upper-third of the indicator rather than
 * the dead-centre. Without this, long conversations look bottom-heavy
 * because the visible chat content usually scrolls to the latest turn
 * near the bottom of the viewport — placing the active dot higher
 * keeps the user's eyes on the conversation flow rather than on the
 * active-dot marker.
 */
const ACTIVE_DOT_VERTICAL_BIAS = 30;

/**
 * v1.25.11 PATCH follow-up v6: windowed indicator. The indicator is
 * not a full-height strip but a window inside the history container,
 * with its top and bottom margins expressed as percentages of
 * `historyContainer.clientHeight`. The CSS uses these percentages
 * directly; on resize we resolve them to px so the visible window
 * stays proportional regardless of panel size.
 *
 * The bottom margin is **larger** than the top because the history
 * container's bottom half visually co-exists with the input
 * container below it — the user's eye is weighted toward the
 * bottom of the chat panel (latest turn). The empirical sweet spot
 * the user discovered (top:200px, bottom:400px on a ~600px viewport
 * ≈ top:33%, bottom:67%) places the indicator window in the upper
 * portion of the chat panel where it's most readable while leaving
 * the lower portion of the scroll content free for the latest turn.
 */
const INDICATOR_TOP_PCT = 0.25;
const INDICATOR_BOTTOM_PCT = 0.50;

/**
 * Resolve the indicator's top/bottom offsets to px and write them as
 * inline styles. CSS carries the percentage fallback; this JS path
 * is the precision version. We use px (not %) because the indicator
 * is `position: absolute` relative to `.llm-wiki-query-history` (a
 * non-positioned ancestor means `%` would resolve against the wrong
 * box). Reading `historyContainer.clientHeight` and writing `top`/
 * `bottom` in px gives us a percentage-derived layout without
 * relying on the right ancestor being `position: relative`.
 */
function syncIndicatorWindowPx(indicator: HTMLElement, historyContainer: HTMLElement): void {
  const viewport = historyContainer.clientHeight;
  if (viewport <= 0) return;
  indicator.style.top = `${Math.round(viewport * INDICATOR_TOP_PCT)}px`;
  indicator.style.bottom = `${Math.round(viewport * INDICATOR_BOTTOM_PCT)}px`;
}

/** Find one representative element per turn, in document order. */
export function findTurnElements(historyContainer: HTMLElement): HTMLElement[] {
  const seen = new Set<string>();
  const reps: HTMLElement[] = [];
  const wrappers = historyContainer.querySelectorAll('.llm-wiki-query-message-wrapper');
  wrappers.forEach((el) => {
    const turn = el.getAttribute(TURN_ATTR);
    if (!turn || seen.has(turn)) return;
    seen.add(turn);
    reps.push(el as HTMLElement);
  });
  return reps;
}

/**
 * Build the indicator: one dot per turn. The dots are absolutely
 * positioned so they can be translated as a single stack on every
 * scroll update.
 *
 * Returns the indicator element. The indicator has `height: 100%` so
 * it stretches to match the history container; the per-dot translateY
 * is applied lazily by `updateIndicatorTranslation()`.
 */
export function buildTurnIndicator(
  historyContainer: HTMLElement,
  activeTurn: number,
  turnLabels: string[],
  onDotClick: (turn: number) => void,
): HTMLElement {
  const existing = historyContainer.querySelector(`.${INDICATOR_CLASS}`);
  if (existing) existing.remove();

  const indicator = historyContainer.createDiv();
  indicator.className = INDICATOR_CLASS;
  // Resolve top/bottom percentages to px so the window stays
  // proportional to the history container's visible region
  // regardless of panel size. CSS keeps the % fallback for the
  // very first paint before this runs.
  syncIndicatorWindowPx(indicator, historyContainer);

  const turns = findTurnElements(historyContainer);

  turns.forEach((_, idx) => {
    const wrapper = historyContainer.createDiv();
    wrapper.className = 'llm-wiki-turn-dot-wrapper';
    wrapper.dataset.turnIdx = String(idx);

    const dot = historyContainer.createDiv();
    dot.className = DOT_CLASS;
    if (idx === activeTurn) dot.classList.add(ACTIVE_CLASS);
    dot.addEventListener('click', () => onDotClick(idx));
    wrapper.appendChild(dot);

    const label = turnLabels[idx]?.trim();
    const tip = historyContainer.createDiv();
    tip.className = 'llm-wiki-turn-dot-tooltip';
    tip.textContent = label || `Turn ${idx + 1}`;
    wrapper.appendChild(tip);

    indicator.appendChild(wrapper);
  });

  historyContainer.appendChild(indicator);
  // Initial translation so the active dot lands at the indicator centre.
  updateIndicatorTranslation(indicator, activeTurn);
  return indicator;
}

/**
 * Recompute the vertical translation of the dot stack so that the dot
 * at `activeTurn` sits at the indicator's vertical centre. Also fades
 * each dot's opacity based on its distance from the indicator centre —
 * dots near the visible edges fade out so the dot stack blends into
 * the chrome instead of popping in/out abruptly.
 *
 *   offsetY = indicatorHeight/2 - activeTurn * DOT_PITCH - dotHalf
 *
 * Subtract that from the dot positions to push active to centre.
 */
export function updateIndicatorTranslation(
  indicator: HTMLElement,
  activeTurn: number,
): void {
  const wrappers = Array.from(
    indicator.querySelectorAll<HTMLElement>('.llm-wiki-turn-dot-wrapper'),
  );
  if (wrappers.length === 0) return;

  const indicatorHeight = indicator.clientHeight;
  // Indicator hasn't been laid out yet (clientHeight === 0). Skip the
  // update — the caller will re-invoke us once the layout pass runs.
  if (indicatorHeight === 0) return;

  const dotHalf = 3; // dot height / 2
  // Translate the dot stack so the active dot lands slightly above the
  // indicator centre (ACTIVE_DOT_VERTICAL_BIAS pulls it up).
  const translateY = indicatorHeight / 2
    - activeTurn * DOT_PITCH
    - dotHalf
    - ACTIVE_DOT_VERTICAL_BIAS;

  // Apply via CSS custom property so we only touch one style (cheap).
  indicator.style.setProperty('--llm-wiki-translate-y', `${translateY}px`);

  // Fade dots near the top/bottom of the indicator. The "fade zone"
  // is the top/bottom 14px — same as the original mask-image fade.
  const FADE_ZONE = 14;
  const centreY = indicatorHeight / 2;
  const dotCentre = activeTurn * DOT_PITCH + dotHalf;
  wrappers.forEach((w, idx) => {
    const dot = w.querySelector<HTMLElement>(`.${DOT_CLASS}`);
    if (!dot) return;
    // Distance of THIS dot's centre from the indicator centre, after
    // the stack translation. idx * DOT_PITCH + dotHalf gives the
    // natural position of dot idx; adding the translateY moves the
    // whole stack so the active dot lands at `centreY`.
    const naturalCentre = idx * DOT_PITCH + dotHalf;
    const finalCentre = naturalCentre + translateY;
    const distanceFromEdge = Math.min(finalCentre, indicatorHeight - finalCentre);
    // Toggle a CSS class based on which fade zone the dot is in. CSS
    // rules in styles.css own the visual fade so we don't have to set
    // inline opacity (which the Obsidian review bot flags).
    dot.classList.remove(
      'llm-wiki-turn-dot-faded',
      'llm-wiki-turn-dot-mid-fade',
      'llm-wiki-turn-dot-full',
    );
    if (distanceFromEdge <= 0) {
      dot.classList.add('llm-wiki-turn-dot-faded');
    } else if (distanceFromEdge >= FADE_ZONE) {
      dot.classList.add('llm-wiki-turn-dot-full');
    } else {
      dot.classList.add('llm-wiki-turn-dot-mid-fade');
    }
    void centreY; void dotCentre; // referenced for clarity
  });
}

/** Move the active class to the dot for `activeTurn`. Recompute the
 *  dot stack translation so the active dot lands at the indicator's
 *  vertical centre. */
export function updateActiveDot(indicator: HTMLElement, activeTurn: number): void {
  const wrappers = Array.from(
    indicator.querySelectorAll<HTMLElement>('.llm-wiki-turn-dot-wrapper'),
  );
  if (wrappers.length === 0) return;
  wrappers.forEach((w, idx) => {
    const dot = w.querySelector(`.${DOT_CLASS}`);
    if (!dot) return;
    if (idx === activeTurn) {
      dot.classList.add(ACTIVE_CLASS);
    } else {
      dot.classList.remove(ACTIVE_CLASS);
    }
  });
  updateIndicatorTranslation(indicator, activeTurn);
}

/** Scroll a turn element to the top of its scroll container. */
export function scrollTurnToStart(
  turnElement: HTMLElement,
  scrollFn?: (options: ScrollIntoViewOptions) => void,
): void {
  const options: ScrollIntoViewOptions = { block: 'start', behavior: 'smooth' };
  if (scrollFn) {
    scrollFn(options);
    return;
  }
  turnElement.scrollIntoView(options);
}

/** Compute the active turn from IntersectionObserver entries. */
export function pickActiveTurn(
  entries: IntersectionObserverEntry[],
  turns: HTMLElement[],
): number | null {
  let best: IntersectionObserverEntry | null = null;
  for (const entry of entries) {
    if (!best || entry.intersectionRatio > best.intersectionRatio) {
      best = entry;
    }
  }
  if (!best) return null;
  const turn = best.target.getAttribute(TURN_ATTR);
  if (!turn) return null;
  const idx = turns.findIndex((t) => t.getAttribute(TURN_ATTR) === turn);
  return idx >= 0 ? idx : null;
}

/** Create an IntersectionObserver that updates the active dot. */
export function observeVisibleTurn(
  historyContainer: HTMLElement,
  indicator: HTMLElement,
  onActiveTurnChange: (turnIdx: number | null) => void,
): IntersectionObserver {
  const turns = findTurnElements(historyContainer);

  const observer = new IntersectionObserver(
    (entries) => {
      const idx = pickActiveTurn(entries, turns);
      onActiveTurnChange(idx);
    },
    {
      root: historyContainer,
      threshold: [0, 0.25, 0.5, 0.75, 1],
    },
  );

  turns.forEach((t) => observer.observe(t));
  return observer;
}