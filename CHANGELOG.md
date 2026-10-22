# Changelog

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
