# Recall Studio

Recall Studio turns captured note and PDF passages into source-linked flashcard
drafts. Capture a passage, let it generate cards, edit or rewrite them, then
explicitly export the cards you choose to Anki. Recall does not schedule reviews
or export automatically.

The repository and BRAT target are `TheLycoi/recall-studio`, formerly
`TheLycoi/review-inbox`. Plugin ID `review-inbox` and the default data folder
`Review Inbox/` stay unchanged.

## 0.1.21 release candidate

The shared method reviews all twenty formulation rules for applicability. It does
not require every technique on every card or claim to know the learner's
understanding. Personal associations and visual aids need supplied input.

The selected highlight and explicit target instruction bound relevance; nearby
context cannot add answer facts. Fixed lists can use stable-order clozes with
one member hidden per review, including coherent notes with more than three
numbers. Open examples do not establish a complete set, but an explicitly
example-seeking question can accept supported alternatives. Hints are optional.

This candidate pins runtime Zod to patched `4.6.6` for GHSA-mrhx-c7xc-m3w5 and
leaves other dependency pins unchanged. It preserves existing cards, settings,
history and explicit export.
Release preparation and synthetic fixtures do not establish live model quality,
medical correctness or an installed update.

## Workflow

1. Select text in a note or PDF and run **Send selection to inbox**. Use
   **Send selection to inbox with instructions…** for an instruction specific to
   that capture. Highlighter mode also captures drag selections when enabled.
2. Return to the Inbox after generation. Recall uses one built-in writing method
   for source-grounded Q&A and cloze cards. It prepares source facts and a card
   plan, writes drafts, checks their structure and source support, and attempts
   one bounded repair followed by an independent recheck when needed.
3. Review cards beside the captured passage. Edit the wording, remove a card, or
   select its star to request an AI rewrite. Explicit rewrite instructions can
   split a card into a bounded replacement set. Every replacement must pass
   validation and an independent audit before the original is retired. Failed,
   cancelled or stale rewrites preserve the original. Convert switches between
   Q&A and cloze; saved edits and rewrites retain revision history.
4. Choose **Export** when ready. The card button exports one card; passage and
   source buttons export visible drafts in their scope; the header exports all
   visible drafts. Collapsed sources and hidden flagged groups are excluded.
   The command palette exports all eligible drafts. Deleted, dismissed and
   already exported records are excluded.

Automatic checks are not proof of truth or learner understanding. Findings and
saved Evidence remain visible for review, including their source quotes, batch
and plan references. Changing a card or its captured source makes its displayed
audit stale. Existing cards are not repaired in the background.

Unresolved generated drafts remain held rather than becoming ordinary editable
or exportable cards. Held counts, reasons and **Retry** remain available even
when a batch has passing cards. Retry authorizes another bounded attempt.
Interrupted or unknown requests also require explicit Retry. Valid checkpoints
are reused; changed inputs start a new batch. **Write more cards** deliberately
starts a new batch and retains earlier evidence.

Export summaries count selected Anki notes, expected retrieval tasks and notes
with warnings. Repeated uses of one cloze number count as one task; custom Anki
templates can change actual review-card counts. Warnings remain advisory, but
malformed cards block export. When confirmation is required, closing or cancelling
the warning sends nothing. Exporting despite warnings records your acceptance,
not a model certification.

AnkiConnect export looks up each card's stable plugin/vault identity before
adding it, including after a lost reply or a deck change. Recall adds notes; it
does not overwrite existing Anki notes or review history. Duplicate content is
reported, not merged. Failed sends preserve unsent draft states. If Anki is
closed, use **Export as Anki text file** from the Inbox menu, then import the
files in Anki. A file export is not confirmation of an Anki import.

## Commands

| Command | Aliases | What it does |
| --- | --- | --- |
| Send selection to inbox | `capture`, `send`, `pdf` | Captures selected text; PDF captures retain the page locator. |
| Send selection to inbox with instructions… | `capture-instruct`, `pdf-instruct` | Captures with an explicit instruction for that passage. |
| Open inbox | `inbox` | Opens the card workspace. |
| Open source history | `source-history` | Opens retained captures and cards for the current source, or a source picker. |
| Export to Anki | `export` | Accepts and exports all eligible drafts. Inbox buttons use visible cards in their scope. |
| Send all ==highlights== in this note to inbox | `highlights`, `sweep` | Captures unrecorded highlights in the current note; available by alias. |
| Retry failed highlights | `retry` | Retries failed captures and held drafts, including partial batches; available by alias. |

The ribbon pen toggles highlighter mode. Inbox keyboard shortcuts keep text
inputs and native buttons independent. In the card editor, ⌘/Ctrl+Enter saves,
Escape cancels, and ⌘/Ctrl+Shift+C makes a cloze from the selected sentence text.

## Source history and existing cards

Archiving exported or dismissed captures removes them from the active Inbox,
not from source history. Retained records include captures, revisions,
generation history and export receipts. Source-note labels require an exact,
unambiguous passage match; changed or ambiguous text remains available through
**Open source history**. Renames update retained paths. Deleting a source does
not delete its history. PDFs retain page locators without PDF overlays.

Optional Spaced Repetition syntax recognition is read-only and off by default.
Set eligible body tags or exact note paths explicitly. It recognizes supported
single-line and multiline Q&A, reversed forms and plain cloze paragraphs, with
bold clozes as a separate opt-in. Labels describe recognized syntax, not
scheduling, mastery or source coverage. Recognition does not write notes or
create Inbox records. Anki or a separately installed Spaced Repetition plugin
handles review scheduling.

## Requirements and settings

Desktop Obsidian 1.7.2 or later and one provider:

- **Codex**: the Codex CLI signed in with a ChatGPT account, including the copy
  bundled with the ChatGPT app.
- **DeepSeek**: a DeepSeek API key.
- **OpenCode**: the opencode CLI signed in to its provider. OpenCode owns its
  credentials; Recall stores no key for it.

Anki with AnkiConnect is optional when using text-file export. Provider **Test**
sends a small request and tries to load that provider's model list.

Writing customization is limited to card language and explicit instructions for
a capture or rewrite. Recall does not use global standing instructions or infer
preferences from edit history. Legacy rule and suggestions files are ignored
and preserved. Saved legacy settings and existing history are not deleted or
migrated; they cannot re-enable rule learning or hidden global prompts.

**Recall data folder** stores the Inbox, captured passages and revision history.
Keep it outside the protected wiki folder. Changing its path does not move old
files; reload Recall after a change. Capture marking is off by default, and
protected wiki/source paths are never marked. Other settings cover provider and
model, surrounding context, background concurrency, notifications, capture,
read-only SR recognition, and Anki deck, note types, fields and tags.

## Network and data

Card requests send the captured passage, surrounding context, source title and
heading, language, explicit capture/rewrite instructions and relevant existing
cards to the selected provider. Later stages also send saved preparation,
candidate cards and check findings. Rewrite requests include the current card
and relevant siblings. Legacy global instructions, rule files and automatically
selected edit-history examples are not prompt inputs.

- **Codex** runs the CLI, which sends requests to OpenAI under your sign-in.
- **DeepSeek** sends requests to `https://api.deepseek.com` with your API key.
- **OpenCode** runs the CLI, which sends requests to its configured provider.

A DeepSeek key typed in settings is stored in plaintext in the plugin's
`data.json` and can sync to other devices and backups. Leave it empty to use
`DEEPSEEK_API_KEY` from the environment or the macOS keychain (the current and
legacy keychain labels remain supported). CLI providers manage their own login.

Recall also connects to AnkiConnect, normally `http://127.0.0.1:8765`.
Source history and SR recognition run locally. Inbox data stays in the Recall
data folder, default `Review Inbox/`; text exports default to
`Review Inbox/exports`. Media export uploads only files already in the vault;
it does not fetch remote media. External assistants have their own disclosure
policies; Recall does not configure them.

## Build and beta installation

```
npm ci
npm test
npm run build
```

Install beta releases through BRAT using `TheLycoi/recall-studio` and the intended
release tag. Private releases require authorized repository access. Do not copy
builds over an existing installation. A passing synthetic test suite and build
do not establish live provider, Obsidian or Anki acceptance.

Recall Studio derives from Obsidian Recall, carved out of WikiLM 0.17.0.
The MIT licence is in `LICENSE`. Retired native chat, quiz and rule-learning
workflows are not current features; saved legacy data remains untouched.
