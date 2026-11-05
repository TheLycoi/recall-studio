# Changelog

## 0.1.28 beta: unified model dropdown

Settings now default to **Unified model**, with one Model and Effort selection
for every stage. Choose **Strong / Cheap** in Model mode to reveal the separate
role controls. Switching back ignores Cheap overrides but retains them for the
next switch. Existing model choices are not erased. Configurations without a
saved mode use Unified, including upgrades from 0.1.27.

Prompts, source context, audit and repair stages are unchanged. Mode changes
that alter effective routing invalidate incompatible checkpoints and hold
stale in-flight output.

## 0.1.27 beta: configurable agents and Learn pane

The Agents settings separate the Strong main model from an optional Cheap model
for the same provider. Strong plans and checks cards; Cheap reads the captured
source context and writes, rewrites and repairs. Each role can have its own
reasoning effort. Empty Cheap settings inherit Strong, so upgrading preserves
the existing model selection. Both roles may use the same model.

The shared writing prompts, original-source payloads, schemas and automatic
preparation/write/audit workflow are unchanged. Gathering context remains local
code; this adds no reader request or separate adjudicator. Changing effective
routing invalidates incompatible generation checkpoints and pending results.

The pending native Learn pane is included. It uses the main model and a pinned,
explicitly installed LearnHarness history-reading skill. It does not install
executable code on startup or run the full LearnHarness teaching application.

## Recall Studio 0.1.26 beta: repair requested card splits

- Let an explicit split request override the default preference for grouping related clozes into one note. Keep source, coverage and retrieval checks.
- Add one indexed repair round for rejected wording, followed by a complete-set audit. Keep accepted siblings unchanged; refuse malformed, unchanged, stale or still-failing repairs without partially replacing the original.
- Show the actual failure reason, successful split count or unchanged result. Retain original cards, annotations, source evidence and export receipts through the existing replacement path.
- Preserve writer v11, settings, data format and automatic generation behavior. Explicit rewrites use at most four requests; no background retry, migration or automatic export.

## Recall Studio 0.1.25 beta: constrain audits and isolate incomplete verdicts

- Constrain audit output to each request's card identities, rendered-review counts and ordinals, and supplied deterministic-check IDs. Keep tolerant source-preserving response parsing separate.
- Hold incomplete or invalid card assessments without discarding valid sibling verdicts. Keep exact coverage checks, ambiguous-identity rejection and scoped source holds.
- Preserve writer v11, saved drafts and cards, dependency pins, settings and explicit export. Add no automatic model requests or migrations.
- Two bounded live audit requests over private copies of the reported drafts passed the output contract. Two drafts still failed semantic retrieval checks; no live cards were changed.

## Recall Studio 0.1.24 beta: retain source findings after malformed audits

- Retain valid scoped source concerns when malformed quality fields would otherwise reject the whole provider response. Mark that assessment incomplete, never approved.
- Preserve the hold through saved-state reload and explicit retry. A generic positive audit cannot clear the original concern.
- Keep writer v11, provider request schemas, dependency pins, stored data and explicit export unchanged. No new model stage or background rewrite.

## Recall Studio 0.1.23 beta: source-grounded mixed-format writing

- Ship writer method v11, the better-performing baseline in the bounded Q&A/cloze comparison. Keep both formats, including closed-list notes that hide one member per review. Do not include the unsuccessful v12 prompt revision.
- Decompose supported facts before grouping, preserve source quotes and exact numbers/units, and teach the writer with a schema-matched example inside the existing request.
- Require audit coverage for every rendered review. Preserve active source holds through repair/retry and reject duplicate preparation targets before writing.
- Keep accepted length/framing findings tied to exact wording so repeated export checks do not revive resolved warnings. Preserve real source and syntax failures, explicit export consent and meaningful list/alternative-answer exceptions.
- Preserve plugin ID, settings, stored cards, history and receipts. No automatic Anki export, study-data migration or rewrite of existing cards.
- The live comparison used a small, unblinded sample. Mixed output performed better on the selected passage, but compound planning and answer giveaways still occurred. Human review and independent auditing remain necessary; this is not a broad reliability or learning-outcome claim.

## Recall Studio 0.1.22 beta: simpler writer and verification-label removal

- Shorten the shared writing method from 23,170 to 13,260 characters. Keep all twenty applicability rules, source boundaries, variant-field guidance and independent audit/repair stages.
- Group related retrieval targets before planning locks note boundaries. Prefer two or three distinct cloze numbers per coherent note without rejecting useful single-deletion or larger-list notes. Preserve all selected fact links.
- Allow focused term-definition retrieval in both directions with separate cloze numbers and a visible identifying cue for each review. Do not force ambiguous reversals.
- Remove verification-status badges and warnings based only on missing or stale checks. Keep actual findings, source conflicts, source quotes, explicit warning acceptance and stale-export safeguards.
- Preserve plugin ID `review-inbox`, existing cards, settings, history and receipts. No storage migration, automatic export or background rewrite of existing cards.
- Verification: 1,828 tests pass in the combined source suite. Seven bounded live-model requests covered two-/three-review generation and seven audit cases. This is a small sample, not a quality guarantee or an Anki export test.

## Recall Studio 0.1.21 release candidate: highlight writer

- Review all twenty formulation rules for applicability in the shared writing method. Do not invent learner understanding, personal associations or unavailable visual aids.
- Keep useful retrieval targets within the selected highlight and explicit target instruction. Nearby context may identify the subject, not supply extra answer facts.
- Clarify fixed-list missing-member clozes versus open examples. Retain stable display order, optional hints and coherent lists with more than three numbers; permit supported, explicitly example-seeking questions without inventing exhaustive membership.
- Add production-module regression fixtures for circuit routes, a four-tool list, same-number grouping, open-list slots, hints, grounding and application-schema identity. These examples cover existing validator behavior, not a new hard-gate fix or live-model quality claim.
- Pin runtime Zod to patched `4.6.6` for GHSA-mrhx-c7xc-m3w5; leave every other dependency pin unchanged.
- Preserve plugin ID `review-inbox`, Obsidian minimum version, existing data and explicit Anki export. Publication and live installation remain separate acceptance steps.

## Recall Studio 0.1.20 prerelease: atomic card-writer testing

This is a testing release, not a card-quality guarantee. The checks cover recognized structures and still rely on model and human judgment for broader ambiguity. Human Inbox review remains necessary.

- Include the unreleased cue fixes from `9a40801` and `476349e`: require a visible subject and requested relation, name the specific feedback system, and prevent vague hints or unrelated clauses from rescuing a topic-only cue. Narrow English cue checks to avoid treating ordinary attribute wording as a bare topic; broader ambiguity still needs model and human review.
- apply the partial-recall test in planning, writing, audit and repair. Split independently testable targets when a learner could recall one part but miss another, including multiple spans hidden under the same cloze number. Preserve essential qualifiers and meaningful relationships rather than splitting by word count or every occurrence of "and".
- replace whole-list recall as the default with source-confirmed fixed-list clozes that hide one member while the others remain visible in stable order. Do not invent a real-world sequence, claim an open list is exhaustive, or fabricate distinctions to separate members.
- add narrow hard checks for recognized compound-list answers, including the reported seven-member blank, so a positive model audit or disabled advisory lint cannot waive those defects. Keep unresolved drafts private with reasons after bounded repair; these checks cannot recognize every compound answer or certify atomicity.
- Preserve plugin ID `review-inbox`, display name Recall Studio, existing cards, settings and history. Existing cards are not automatically rewritten, and export remains an explicit user action. No automatic export is added.

## Recall Studio 0.1.19 beta: one built-in writing method

- Use one built-in writing method for preparation, writing, audit and repair. Card language and explicit capture or rewrite instructions remain available.
- Retire rule-learning and standing-rule controls, along with native chat, quiz, study and manual checking controls. Saved legacy rules, settings and history remain on disk but cannot restore competing writing instructions.
- Preserve automatic audit, bounded repair, independent recheck and private holds for unresolved drafts. Capture, editing, explicit rewriting and source history remain available.
- Add narrow English checks for certain arbitrary unordered-list slots and underspecified power/cable procedure cues. Recognized defects enter repair even after a positive model audit; repeated defects stay held. Other wording, procedures and languages can evade these checks.
- Keep cloze hints optional. Parsing, persistence and export support remain, but useful hint selection by the live model is unmeasured.
- Keep plugin ID `review-inbox`, stored data and explicit Anki export unchanged. No automatic export or background rewrite of existing cards is added.
- Synthetic tests and the production build do not establish broader real-model quality, live Obsidian behavior or actual Anki export acceptance. Human Inbox review remains necessary.

## Recall Studio 0.1.18 beta: optional writer guidance

- Prefer one to three distinct cloze numbers per note, with coherent list and sequence exceptions. Keep all supported targets; this is not a hard count gate.
- Use short hints only when they clarify the requested answer without revealing it. Hints remain optional.
- Reconcile planning and writing guidance, retain useful foundational facts, and make missing-subject context explicit on the front.
- Preserve the notes, highlight, Inbox review and Anki-export workflow. No storage migration or existing-card rewrite.
- Known limits: live samples still produced unordered slots and an underspecified procedural cue, also present in the baseline. Hint-selection benefit is not yet demonstrated. Human Inbox review remains necessary.

## Recall Studio 0.1.16 beta: repair before Inbox

- Audit new drafts, repair flagged candidates within a bounded round, independently recheck them, and show only passing cards. Keep unresolved drafts private with reasons and explicit Retry, including partial batches.
- Preserve meaningful context and procedures. Fail closed when writing rules are unavailable; check retries against current sibling wording.
- Support explicit one-to-many rewrites with whole-set validation, independent audit and original/history preservation. Protect newer edits and learn saved user corrections even if an optional rewrite fails.
- Repair spaced suggestion IDs, occurrence history, concurrent learning, reversed-edit evidence, stale proposals and partial-Accept retries. Preserve sibling modal drafts and restore controls after errors.
- Validate content before reusing Anki receipts, retain failed-migration recovery, drain pending writes across reload and suppress provider-controlled diagnostics that can expose credentials.
- Keep plugin identity and existing data. Automatic repair applies to new drafts, not existing/exported cards; export still requires a user action. No scheduler or automatic export is added.

## Recall Studio 0.1.15 beta: card-quality checks and repair guidance

- Detect answers left visible by other cloze numbers, hints and supported inline formatting, without treating hidden slots as adjacent words.
- Distinguish meaningful signs and identifier punctuation, so `C++` is not flagged merely because the cue says `C`, and `-5` is not confused with `5`.
- Stop flagging proper names such as `WHO` and meaningful short conditions solely because they contain question words or verbs.
- Give Verify actionable repair instructions and share the retrieval-quality rubric across preparation, writing, audit and repair.
- Preserve the instruction-driven star, guarded Verify behavior, plugin identity and stored data. Existing length caps remain product policy, not research thresholds.

## Recall Studio 0.1.14 beta: instruction-driven card rewrite

- Make the card star open a prompt asking what to change, then rewrite that card with AI.
- Keep check-and-repair on Verify and retain cancellation, authorization, editor and revision safeguards.
- Preserve the 0.1.13 Inbox-only workspace and all stored data. Multi-card splits are not included.

## Recall Studio 0.1.13 beta: Inbox-only workspace

- Remove the Chat tab and native Quiz/Make Flashcards commands and aliases.
- Open Inbox directly. Keep source capture, card writing, editing, Verify, Export and source history.
- Preserve plugin identity and stored cards, transcripts, revisions and export receipts. No data migration or external-quiz bridge is included.


## Recall Studio 0.1.12 beta

- Stop adding capture badges to your notes. The "N cards created · N awaiting · N Anki confirmed" pill and the "Dismissed · no cards" pill no longer appear next to your prose, so a dismissed or exported passage leaves the note exactly as you wrote it.
- Mark only cards written in the note itself. Inline `#flashcards` cards keep their **Flashcard** badge; capture receipts and export counts move to the source-history command, where they were already listed in full.
- Remove the now-unused passage badge widget so a note cannot be marked by capture state at all.

Plugin identity, stored data and published 0.1.11 assets stay unchanged. Capture records are still retained and still visible through source history, so nothing is lost — only the on-note marker is gone. There is no scheduler or study-data migration.

## Recall Studio 0.1.11 beta

- Attach a local PDF as study-guide coverage in Chat without importing it into the vault. Coverage instructions still define only what to cover; every fact and citation comes from your notes.
- Raise the study-guide limit to 64,000 characters while ordinary Chat messages keep their 8,000-character limit, and reject over-limit input instead of truncating it.
- Recognize inline flashcards in your own notes. Add `#flashcards`, then write cards where you study: `Question::Answer`, `Question:::Answer`, multiline `?` and `??`, and cloze paragraphs using `==highlight==` or `{{curly braces}}`.
- Scan bullet and numbered list items, including nested ones, so cards written in outline notes are found. Fenced code inside a list and blockquoted prose stay excluded.
- Treat `#flashcards/Sub deck` as a suggested export deck shown in source history. The Inbox deck picker stays authoritative.
- Rename recognized-card badges from "Existing SR card" to "Flashcard", since these are your own cards rather than another plugin's.
- Keep bold `**text**` as ordinary emphasis by default, with a separate opt-in setting for readers who want bold treated as a cloze.

Inline cards coexist with capture. Recall Studio still does not schedule reviews: review happens in Anki, or in the Spaced Repetition plugin if you install it. Plugin identity, stored data and published 0.1.10 assets stay unchanged, and there is no study-data migration.

## Recall Studio 0.1.10 beta

- Fix card writing failing with "Malformed card fields." The staged writer's output schema again describes which fields belong to which card kind, and a draft that also fills the unused fields is normalized instead of rejected. Empty questions, answers and cloze text are still refused, and the malformed-cloze and grounding checks are unchanged.

Plugin identity, stored data, prompt contracts and published 0.1.9 assets stay unchanged. This release adds no scheduler or study-data migration.

## Recall Studio 0.1.6 beta

- Rename the shared study tab and heading to Chat. Quiz and Make Flashcards remain experimental activities within it.
- Add an Inbox command box and conversational `quiz me on …` and `make flashcards on …` entrypoints. Both ask for a fresh study guide or coverage instructions.
- Find exact note excerpts for the requested topic. Guides define coverage, never facts; earlier answers and general knowledge are not evidence.
- Queue selected references through the existing Inbox card writer. Quiz misses still require an explicit Send to Inbox action.
- Add scoped Verify controls beside Export in the Inbox, expanded sources and passages. Verify checks, repairs and rechecks without exporting.

Plugin identity, stored data and published 0.1.5 assets stay unchanged. This release adds no scheduler or study-data migration. Source tests and synthetic host checks do not establish real-provider writing quality or live Anki export acceptance.

## Recall Studio 0.1.5 beta

This replaces the rejected 0.1.4 beta. Keep its published tag and assets unchanged; do not install 0.1.4.

- Validate usable stored records before choosing a recovery snapshot; preserve damaged bytes and fail read-only when recovery is uncertain.
- Drain generation rollback and final persistence on unload. A separately loaded successor waits for the old store before reading or saving.
- Recheck permission before every check/repair or explicit Rewrite request and retry. Preserve current cards, revisions and newer editor drafts when work is cancelled or stale.
- Defer optional rule-learning redraws while a card editor is open.
- Exclude code examples inside list and blockquote containers from optional Spaced Repetition recognition. Genuine cards in unsupported containers remain unrecognized.

The plugin ID, data paths, provider bindings and BRAT repository stay unchanged. Failed persistence blocks a same-path reload until restart; this is not crash-durability protection. Provider quality and live Anki exports are not covered by synthetic acceptance.

## Recall Studio 0.1.4 beta

- Add same-panel Quiz with source-grounded free-response and multiple-choice practice. Sending missed material to the Inbox remains an explicit choice.
- Prepare source facts, write cards and audit them in separate stages with retained checkpoints.
- Retain passage history after exported cards leave the Inbox, with source indicators and history lookup.
- Make card and passage stars check, repair and recheck findings. Failed or stale repairs leave the original intact.
- Remove fixed cloze-deletion and card-count quotas. One deletion remains a valid cloze, and grouping follows the source.
- Add opt-in, read-only recognition of supported Spaced Repetition card syntax without changing schedules.
- Change the display name to Recall Studio while retaining the plugin ID, storage paths, keychain names and BRAT repository.

The release has no scheduler, study-data migration or automatic rewrite of existing cards. Provider request and token budgets remain. Source tests and synthetic Obsidian checks do not establish real-provider writing quality or actual Anki export acceptance.

## Review Inbox 0.1.3

- Chat retrieves text from uncaptured PDFs as well as Markdown notes and captured passages, with page or line citations.
- Add bounded search-phrase expansion without letting it displace original-question matches.
- Allow supported paraphrases after a separate evidence-only model check; keep exact quote and citation checks and refuse unsupported answers.
- Add “Search whole wiki” to clear an old source restriction without losing the conversation or question.
- Recheck exclusions after asynchronous reads and before provider calls. Bound the candidate pool and extracted source text, invalidate stale cache entries and clean up PDF documents.
- Preserve the existing Inbox/Chat toggle, Export behavior and card data. No OCR, vector service or new dependency.

## Review Inbox 0.1.2

- Restore the Inbox/Chat toggle within one workspace panel. Inbox opens first.
- Switching preserves conversation, unfinished questions, card edits and each panel's scroll position.
- Keep toggle buttons mounted so keyboard focus survives switches and background updates.
- Hide inactive controls and prevent button activation or Chat keystrokes from exporting hidden cards.

## Review Inbox 0.1.1

- Chat searches eligible vault notes by default. Source selection is optional;
  only bounded relevant passages reach the provider. Ignored files and plugin
  data remain excluded, and answers still require verified citations.
- Chat is embedded inside Inbox. Open chat focuses its question box instead of
  opening another workspace tab.
- Export accepts drafts directly; separate approval controls are removed. Inbox
  buttons export visible cards in their stated scope, with failed sends retryable.
- Passage stars and per-card check controls run explicit best-practices checks
  without rewriting cards. Only these checks set the checked badge; edits invalidate it.
- Captured PDF evidence can produce new drafts through Chat without changing
  existing approved or exported cards.
- Anki content duplicate checks cover all decks. Text export separates Q&A and
  cloze note types, including cloze models without an extra field.
- Notices use Review Inbox branding, and the keyboard-focused Inbox has a
  visible focus ring.

## Review Inbox 0.1.0

The first stage of the Review product, carved out of Obsidian Recall (MIT). It
turns a highlighted passage into draft flashcards in a source-linked inbox, lets
a grounded chat over explicitly selected sources send its answers back to the
inbox as drafts, and exports approved cards to Anki. No quiz, dashboard,
statistics or scheduler.

- Distinct plugin identity `review-inbox` (display name `Review Inbox`), so its
  settings and data never collide with an installed Recall plugin.
- Capture and generation keep the existing Markdown/PDF selection path, the
  Codex, DeepSeek and OpenCode providers, and the quality checks. The card rules
  note, the inbox and the rule suggestions live under the `Review Inbox/` folder.
- Inbox groups passages by source with inline editing, regeneration, individual
  and bulk approval/dismissal. Generated cards stay drafts until approved, and
  only approved cards export.
- Chat answers only from the sources you explicitly select, verifies every quote
  literally, refuses an answer the evidence does not support, keeps excluded
  sources out of the prompt, and can send a grounded answer's cited passages to
  the inbox as drafts.
- Anki export uses the existing AnkiConnect path: stable per-vault identities for
  repeat-send and retry idempotency, content duplicate detection across the whole
  collection, and source backlinks. Nothing is scheduled.

The history below — 0.1.0 through 0.3.1 — is Obsidian Recall's, the project
Review Inbox was carved out of. Those entries describe Recall at those versions,
not Review Inbox; the two share a version history but are distinct plugins.

## 0.3.1

Fixes the Spaced Repetition export, which wrote its note but never marked the
cards it had written.

- **Cards now leave the inbox when they are sent to Spaced Repetition.** The
  export wrote the note, recorded its path on each card, and stopped there, so
  every card stayed `pending`. Two consequences, both visible in a vault: the
  highlight stayed "ready" and never finished, and pressing the command again
  wrote a second note holding the same cards. The Anki path had always flipped
  `status` to `exported`; the Spaced Repetition path was missing it. This is the
  one-destination-per-card rule the Anki export already followed.
- The export is now covered by tests that run the real function, which is what
  the earlier work lacked. Its serialization had been verified against the
  target plugin's own parser, but the export itself was never executed, so the
  missing status transition had no test at all. `test/spacedExport.test.mjs`
  drives `exportToSpacedRepetition` against a stubbed vault and asserts the note
  is written, the cards are marked, the highlight is finished, and a second send
  writes no second note.
- Nothing else changed. The serialization, the note format, the folder, the
  deck tag, and the refusals are as they were.

## 0.3.0

OpenCode joins Codex and DeepSeek as a provider. Pick one under Settings → Card writer.

- Provider setting: **Codex** (the CLI, on your ChatGPT sign-in, no key), **DeepSeek** (the API, with a key), or **OpenCode** (the opencode CLI, which owns its own credentials, so Recall holds no key for it). Switching takes effect on the next call, with no reload.
- OpenCode runs `opencode run`, so any model that CLI can reach is available, in the `provider/model` form `opencode models` prints. The model list is loaded by Test, and a keyed provider's models only appear in it once that provider has a key.
- The run is locked down. OpenCode's default agent allows every action, so every call runs under an agent Recall defines as deny-everything, in a scratch directory outside the vault. A prompt asking to read a file is refused at the tool layer rather than merely discouraged in the prompt.
- Sessions are cleaned up, failures included. `opencode run` writes a session row, and each run's id comes back in its own event stream, so it is deleted as the run ends rather than after the answer is read. The order matters: cleanup runs before the failure paths throw, because a failed run is exactly the case that would otherwise leave a row behind on every error. Card writing fires per highlight, so leaving them would fill the reader's session list.
- Structured output reuses the DeepSeek path: the zod schema is described in the prompt and the answer is validated locally, so a malformed answer is a reported failure and never a bad card.
- Failures name the fix: a binary that is not where the setting says, an opencode too old to have `--format json`, a model the machine does not serve, and a provider that is not signed in each say what to do about them.

## 0.2.0

DeepSeek joins Codex as a provider. Pick one under Settings → Card writer.

- Provider setting: **Codex** (the CLI, on your ChatGPT sign-in, no key) or **DeepSeek** (the API, with a key). Switching takes effect on the next call, with no reload.
- DeepSeek: JSON-mode structured output validated against the same schema Codex uses, so a malformed answer is a reported failure and never a bad card. Thinking is always on; `low`, `high` and `max` map straight through, and `medium` and `xhigh` land on `high`, which is the level DeepSeek maps them to.
- DeepSeek key resolution: the settings field, then `DEEPSEEK_API_KEY` in the environment, then the macOS keychain under `DEEPSEEK_API_KEY` or `Recall DeepSeek API key`. The keychain keeps the key out of `data.json`, which a synced vault replicates in plaintext.
- Failures name the fix: a rejected key, an empty balance, a rate limit, an overloaded API, and a model id the API does not serve each say what to do about them. An empty answer under JSON mode is retried once, and a truncated one is reported as its own error rather than as broken JSON.
- Settings text and the README now describe both providers.

## 0.1.0

First version. Recall is the card, inbox, Anki and quiz half of WikiLM 0.17.0 as a plugin of its own.

- Cards: capture a selection from a note or a PDF, with or without instructions. Highlighter mode. Sweep every highlight in a note.
- Inbox: review, edit, flag, retry.
- Anki: export through AnkiConnect, or to a text file when Anki is closed.
- Quiz: one free-response question per section of a wiki page, marked against an answer key. Misses can become cards.
- Model: the Codex CLI with a ChatGPT sign-in. No API key.
- Recall reads the wiki folder and never writes to it.
