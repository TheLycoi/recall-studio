# Critique + deterministic lint chain for Recall

Branch: `critique-linter`. Base: `dd24602` (0.3.1, main). Target version 0.4.0.

## Goal

Raise card quality by restoring the full chain Loopback had — draft, LLM critique,
deterministic lint — without slowing the capture gesture Janus's design depends on.

## Invariants (contract; a ticket that weakens one is wrong)

1. **Capture stays instant.** `src/capture.ts` and `src/highlighter.ts` make no
   network call and gain no new work. All new work happens inside
   `Generator.run` in `src/generator.ts`, which is already the background queue.
2. **The quality chain is on by default, and never blocks a card.** As shipped
   in 0.4.0 the settings are `critiquePass: true`, `lintMode: "badge"`,
   `historyExamples: true` (see `DEFAULT_SETTINGS` in `src/settings.ts`). A user
   who upgrades and changes nothing gets the critique and history examples, but
   `lintMode: "badge"` means lint results only annotate cards — the set of cards
   that reach Anki is unchanged from 0.3.1, and every part of the chain can be
   switched off individually.
3. **Nothing is silently destroyed.** The critique never deletes a card. A card
   it rejects is stored with `status: "flagged"` and a reason; the reviewer
   decides. `lintMode: "drop"` is opt-in and even then writes the card as
   `flagged`, never omits it.
4. **`inbox.json` changes are additive only.** New optional fields, one new
   status string. An older build reading a newer file must not crash.
5. **Grounding is checked mechanically, not trusted to a model.** The linter
   runs after the critique regardless of what the critique concluded.
6. **The linter is Obsidian-free.** No `import ... from "obsidian"` in
   `src/lint.ts`, because `test/*.test.mjs` bundles the module standalone with
   esbuild (see `test/prompt.test.mjs:10-16`). Verified transitively: `lint.ts`
   imports `model.ts` (whose only import is `newId` from `util.ts`) and
   `util.ts` (which imports nothing), so the whole closure bundles clean. Adding
   an import of `settings.ts` or `obsidian` to `lint.ts` breaks `npm test` loudly
   at the esbuild resolve step — that is the guard.
7. **Shared types live in `src/model.ts`.** `LintFailureId` and `BloomLevel` are
   declared there, next to `Card`, and imported by `lint.ts` and `llm.ts`.
   `model.ts` imports only `./util`, so there is no cycle. This is deliberate:
   `Card.lintFailures?: LintFailureId[]` must be the *same* union the linter
   produces and the inbox view switches on, or a renamed id silently stops
   rendering a badge with no type error anywhere.
8. **Export safety is load-bearing at one line.** `pendingItems`
   (`src/main.ts:280-286`) is the only funnel into both `exportHighlights` and
   `exportAsTextFile`, and it allowlists `c.status === "pending"` by strict
   equality. That is *why* a flagged card cannot reach Anki. Any ticket that
   turns this into a denylist breaks invariant 3.

## Design decisions

**Bloom level lives in the critique, not the linter.** Bloom's taxonomy
(remember → understand → apply → analyze → evaluate → create) is a judgment
about whether a card's cognitive demand matches its source material. A script
cannot measure it. The critique prompt asks for a `bloom` label per card and
flags the one failure mode that matters here: a highlight stating a mechanism
or a reason turned into a vocabulary-recall card. AnkiThis's "quality bars"
idea is adapted as one rule, not a six-dimension score, because Recall's
highlights are short and single-claim by design.

**One critique call per highlight, not per card.** Loopback critiqued each
candidate separately (`drafting.ts:113`), which multiplies latency by the card
count. Recall sends the whole card set for one highlight in a single call, which
also lets the critic see interference between siblings — the exact defect found
in the 2026-09-09 batch (two cards both answering "six months").

**Speed budget.** Capture: unchanged, still returns in a second. Time to cards
ready: one extra model call per highlight when `critiquePass` is on. Mitigations:
the critique is skipped entirely when the draft returns 0 or 1 card and that card
passes lint clean, and `Generator` keeps its existing `concurrency` so highlights
still overlap.

---

### T1: Deterministic linter
- **depends_on**: []
- **model**: sonnet
- **location**: `src/lint.ts` (new), `test/lint.test.mjs` (new)
- **description**: Pure module exporting
  `lintCard(card, highlight, siblings): LintResult` where
  `LintResult = { failures: LintFailure[]; warnings: LintWarning[] }`.
  Reuse `normalizePlain` and `ungroundedClozes` from `src/util.ts` (lines
  179-202) — import them, move nothing.

  **Provenance, stated honestly so you do not go looking for what is not
  there.** Loopback's `linter.ts` is cloze-only and has no Q&A concept, so it
  is a source for three rules and a structural model for the rest:
  - Ported with the threshold *changed*: `cloze-count` (Loopback is 2-4 at
    `linter.ts:63-64`; Recall is 1-3, because Recall's writer prompt says "at
    most three" at `src/llm.ts:61` and Recall writes single-deletion cards).
  - Ported as-is: `cloze-numbering`, `cloze-framing` (≤6 words plus the framing
    regex, `linter.ts:67-70`), `cloze-not-grounded` (`checkAtomGrounding`).
  - New for Recall, no Loopback equivalent: every `qa-*` rule, `card-long`
    (Loopback's 80-word ceiling covered cloze+backExtra; 60 fits Recall's
    shorter cards), `answer-in-question`.
  - Deliberately dropped: Loopback's `back-extra-substring` and
    `back-extra-near-restatement`. Recall has no Back Extra field; the nearest
    equivalent is `answer-in-question`, kept as a plain substring test. The
    0.6-ratio near-restatement check is not ported — near-tautology is a
    judgment call and belongs to the critique (T2), which has a rule for it.
  - The `warnings` bucket is new. Loopback returns `{passed, failures}`
    (`linter.ts:51-54`) with no warning concept.

  Rules (failure ids):
  | id | rule |
  |---|---|
  | `cloze-not-grounded` | every `{{cN::body}}` body must appear in the highlight after `normalizePlain` (existing `ungroundedClozes`) |
  | `cloze-count` | 1 to 3 deletions per card (writer prompt says "at most three") |
  | `cloze-numbering` | distinct numbers are exactly 1..k, no gaps |
  | `cloze-framing` | each deletion body ≤ 6 words and free of `/\b(is|are|was|were|which|that|because|since|due to|such as|who)\b/i` |
  | `qa-empty` | qa needs non-empty front and back; cloze needs ≥1 marker |
  | `qa-answer-long` | qa back ≤ 12 words |
  | `qa-yes-no` | front must not start with `/^(is|are|was|were|does|do|did|can|will|should|has|have)\b/i` |
  | `card-long` | front + back + text ≤ 60 words total |
  | `answer-in-question` | qa back, normalized, is not a substring of the normalized front |

  Warnings (non-blocking, ids): `duplicate-card` (normalized front or cloze text
  equals a sibling's or an existing non-deleted card's), `shared-answer`
  (two cards in the same batch have equal normalized answers — interference).
- **evidence_in**: `~/dev/obsidian-loopback/linter.ts` (thresholds and check
  structure), `src/util.ts:179-202`, `src/model.ts` (Card shape),
  `test/prompt.test.mjs:1-20` (test harness pattern to copy exactly).
- **validation**: `npm test` — new file must cover every id above with one
  passing and one failing case, including a card that passes all rules.

### T2: Critique prompt and client method
- **depends_on**: []
- **model**: opus
- **location**: `src/llm.ts`
- **description**: Add `CRITIC_SYSTEM` and
  `LlmClient.critiqueCards(h, cards, existing): Promise<CritiqueVerdict[]>`.
  Schema, in the same flat strict style as `CardOut` (`src/llm.ts:10-28`) because
  Codex `--output-schema` runs strict and rejects unions:
  ```ts
  const VerdictOut = z.object({
    index: z.number().int(),
    verdict: z.enum(["keep", "revise", "drop"]),
    reason: z.string(),      // one sentence, shown to the user
    bloom: z.enum(["remember","understand","apply","analyze","evaluate","create"]),
    kind: z.enum(["qa","cloze"]),  // revise only; echo original otherwise
    front: z.string(), back: z.string(), text: z.string(), // revise only, else ""
  });
  ```
  The prompt is adapted from `~/dev/obsidian-loopback/prompts/critique-v1.md`,
  which must be read in full first. Carry over verbatim in spirit: the
  "one rule that overrides everything else" (a revision may only use facts the
  highlight states), and "dropping is the right call more often than reaching
  for a fix". Add, new for Recall: the Bloom fit rule as described in Design
  decisions above; the interference rule (sibling cards that would be confused);
  and the near-tautology rule (an answer that merely restates a word in the
  question). Reuse `writeCards`'s existing user-message assembly conventions
  (`src/llm.ts:161-176`) — same `<source>` wrapper, same standing-instructions
  block.
- **evidence_in**: `~/dev/obsidian-loopback/prompts/critique-v1.md` (read whole),
  `src/llm.ts:10-28` (schema style), `src/llm.ts:135-200` (client structure,
  `writeCards` and `rewriteCard`), `src/backend.ts:6-13` (`CompletionRequest`).
- **validation**: `npm run build` (tsc must pass). Report the full prompt text
  in your report so the architect can review the wording.

### T3: Model and settings
- **depends_on**: []
- **model**: sonnet
- **location**: `src/model.ts`, `src/settings.ts`
- **description**: Add `"flagged"` to `CardStatus`. Add optional fields to
  `Card`: `lintFailures?: string[]`, `critiqueReason?: string`, `bloom?: string`.
  All optional so old files parse (invariant 4) and `makeCard` is unchanged.
  Add to `RecallSettings` + `DEFAULT_SETTINGS`: `critiquePass: boolean` (false),
  `lintMode: "badge" | "hide" | "drop"` ("badge"), `historyExamples: boolean`
  (false). Add three controls to the settings tab in the existing style, in a
  new "Card quality" section placed after the writer instructions textarea.
  Each description states what it costs: the critique one adds a second model
  call per highlight.
- **evidence_in**: `src/model.ts` (whole), `src/settings.ts:23-24` and `:64-65`
  and `:240-259` (existing textarea pattern to copy).
- **validation**: `npm run build`.

### T4: History examples from inbox decisions
- **depends_on**: [T2, T3]   <- T2 as well: T4 edits the body of `critiqueCards`,
  which does not exist until T2 lands. Never start T4 before T2 is verified.
- **model**: opus
- **location**: `src/examples.ts` (new), `src/llm.ts`
- **description**: `buildExamplesBlock(store, limit): string` — walk every
  highlight's cards, take up to 6 with `status === "exported"` or
  `edited === true` as positive examples and up to 4 with `status === "deleted"`
  as negatives, most recent first by `createdAt`, cap the block at ~1,200 chars.
  Returns `""` when there is no history, which is the state today. Inject into
  the writer user message after standing instructions (`src/llm.ts:169`) and
  into the critic, both gated on `settings.historyExamples`. Scope is the whole
  inbox, unlike the existing per-highlight "do not repeat these facts" block at
  `src/llm.ts:171-176`, which stays as it is. Header wording must make the role
  clear: these show how the reader words and trims cards, they are not facts and
  not a source of content.
- **evidence_in**: `src/store.ts` (accessors), `src/model.ts` (Card.status,
  Card.edited), `src/llm.ts:161-176` (where blocks are assembled).
- **validation**: `npm run build`; add a case to `test/lint.test.mjs`-style
  harness only if `examples.ts` is Obsidian-free; if it needs the store type,
  test via a plain object literal fixture.

### T5: Pipeline wiring
- **depends_on**: [T1, T2, T3]
- **model**: opus
- **location**: `src/generator.ts`
- **description**: In `run()`, between `writeCards` and the `makeCard` loop:
  1. If `settings.critiquePass` and drafts.length > 0, call `critiqueCards`.
     Apply verdicts: `keep` unchanged; `revise` replaces the card fields and
     records `critiqueReason`; `drop` still creates the card but with
     `status: "flagged"` and the reason. Record `bloom` on every card.
     A critique failure (network, quota) is caught and logged — the drafts are
     kept as-is rather than losing the whole highlight. This is important: the
     critique is an enhancement, never a new failure mode.
  2. Run `lintCard` on every surviving card. `lintMode: "badge"` → store
     `lintFailures`, leave status pending. `"hide"` or `"drop"` → set
     `status: "flagged"` when failures is non-empty.
  Control flow, in the order it must actually execute (the skip check is a
  precondition, not a third step):
  ```
  lint each draft (siblings = the other drafts in this batch)
  if critiquePass and NOT (drafts.length <= 1 and that draft lints clean):
      critique all drafts in one call
      apply verdicts; re-lint any card the critique revised
  apply lintMode to the final set
  ```
  `siblings` at every call site means the other drafts in this generation
  batch. The `existing` cards from `generator.ts:57` are *not* siblings; they
  feed the duplicate warning only, passed as a separate argument.

  Distinguish "critique did not run" from "critique ran and was content": set
  `critiqueRan: true` on each card when a verdict came back. A card with
  `critiqueRan` unset was skipped or the call failed; the inbox view must not
  imply it was checked and approved.
  The Notice wording should reflect what happened, e.g.
  `Recall: 3 cards ready (1 flagged) for "…"`.

  **Counts must stay truthful.** `store.ts:112` computes `toReview` as
  `c.status === "pending"`, so flagged cards would vanish from the status bar
  and inbox header while still sitting in the inbox awaiting a decision — the
  exact "never show a status that is not true" failure the Loopback digest
  names. Add a `flagged` field to `counts()` and surface it in the status bar
  (`main.ts:227-238`) and inbox header (`inboxView.ts:112-124`) as its own
  figure. Also check `anki.ts:162` (`h.cards.some((c) => c.status === "pending")`),
  which decides whether a highlight offers an export action.
- **evidence_in**: `src/generator.ts:52-88` (the whole `run` method, quoted in
  the brief), T1's `lintCard` signature, T2's `critiqueCards` signature,
  `src/main.ts:280-286` (`pendingItems`, the export allowlist that makes
  invariant 3 true), `src/store.ts:103-115` (`counts`), `src/anki.ts:162`.
- **validation**: `npm run build && npm test`.

### T6: Inbox view surfaces the results
- **depends_on**: [T5]
- **model**: opus
- **location**: `src/inboxView.ts`
- **description**: Replace the `ungroundedClozes` call at
  `src/inboxView.ts:343-349` with rendering of the stored `lintFailures` /
  `critiqueReason` (recomputing is now wrong, since the stored result is the
  one the pipeline acted on).

  **The status gate must widen.** Today that block is gated
  `c.kind === "cloze" && c.status === "pending"` (line 343), so it never fires
  for a non-pending card. Flagged cards are not pending, so the replacement
  gate is `c.status === "pending" || c.status === "flagged"`, and it applies to
  qa cards too, since most new failure ids are qa rules. Leave the neighbouring
  `exported` / `duplicate` / `edited` badges (lines 340-342) alone. Show a warn badge per failure id with a readable
  label and the reason in the tooltip. Flagged cards render dimmed with the
  reason visible, and are excluded from export the way non-pending cards
  already are. Add one action to the existing hover row: "Fix with linter notes",
  which calls the existing `rewrite(h, c, preset)` path (`inboxView.ts:481-498`)
  with the failure reasons as the instruction string. Keep `lintMode: "hide"`
  meaning the flagged card is collapsed behind a "N flagged" toggle, not removed
  from the DOM entirely.
- **evidence_in**: `src/inboxView.ts:340-370` and `:481-498` (quoted in brief),
  T1's `LintFailure` ids and labels.
- **validation**: `npm run build`. Manual check deferred to the architect.

### T7: Docs and version
- **depends_on**: [T6]
- **model**: sonnet
- **location**: `README.md`, `manifest.json`, `versions.json`, `package.json`
- **description**: README section "Card quality" explaining the chain, the three
  settings and their defaults, and what Bloom fit means. Bump to 0.4.0 in all
  three metadata files, matching how 0.3.1 was done (check `git show dd24602`).
- **evidence_in**: `git show dd24602 --stat`, `README.md` current structure.
- **validation**: `npm run build`; `grep -n 0.4.0 manifest.json versions.json package.json`.

## Waves

- Wave 1: T1, T2, T3 (independent)
- Wave 2: T4, T5 (T5 needs all of wave 1; T4 needs T3)
- Wave 3: T6
- Wave 4: T7

## Rollback

`git checkout main` restores 0.3.1. The installed copy in
`projects/.obsidian/plugins/recall/` is snapshotted before any install. Settings
default to off, so even an installed 0.4.0 behaves as 0.3.1 until toggled.

## Out of scope

- AnkiConnect sampling for examples (user chose inbox decisions only).
- Any change to capture, the highlighter, or the export path.
- The `claude -p` backend for the quota problem — separate task.
