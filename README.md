# Recall Studio

Recall Studio turns captured note and PDF passages into source-linked flashcard
drafts. Capture a passage, let it generate cards, edit or rewrite them, then
explicitly export the cards you choose to Anki. Recall does not schedule reviews
or export automatically.

The repository and BRAT target are `TheLycoi/recall-studio`, formerly
`TheLycoi/review-inbox`. Plugin ID `review-inbox` and the default data folder
`Review Inbox/` stay unchanged.

## 0.1.29 beta: rewrite compliance and editable card agents

Explicit rewrites now check whether the result follows the latest instruction,
not only whether it preserves facts. An unchanged original triggers one repair
attempt even if the model approves it. A requested split can produce separate
notes during that repair; a failed repair keeps the original and reports why.
Source holds, unrelated cards and the four-request maximum remain intact.

The existing preparation, writing and audit stages now use reader, writer and
grader instructions. In **Strong / Cheap** mode, Cheap reads and plans, Strong
writes and repairs, and the Grader has its own optional model and effort.
Unset secondary choices inherit Strong. **Unified model** still uses one model
for every stage. This does not add another model call or increase repair limits.

Under **System prompts**, open the shared writing method or an individual role
to edit its instructions. **Save** persists changes; **Cancel** discards them.
**Restore default** changes the editor draft until saved. Output schemas,
source-evidence boundaries and plan/fact identifiers remain application-owned.
Changing prompts or effective routing rejects stale pending results and
invalidates incompatible checkpoints; it does not rewrite existing cards.

The default method requires at most one sentence per cloze note, or one question
sentence and one answer sentence for Q&A. Useful bidirectional clozes and closed
lists remain supported within that limit. The shared accuracy instructions
require checking doubtful interpretations against the supplied evidence,
stating unresolved uncertainty explicitly and revisiting it in the final audit
or an explicit retry. These are prompt and audit requirements, not a guarantee
that a model will detect every error. There is no web-research stage.

New Markdown captures store up to 24,000 characters of the source body, excluding
frontmatter. Longer notes use a window around the selection, marked truncated;
PDF captures use available page text. This snapshot goes to the configured reader
and grader. The writer receives quoted context terms and the existing short
neighboring context. Only the selected highlight supplies answer facts. Older
captures retain their existing context without an automatic reread.

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

Historical note: 0.1.27 included an unfinished Learn pane. The current beta
removes that integration and its installer. Existing saved settings and external
LearnHarness files are preserved, but this plugin no longer reads or runs them.

## 0.1.26 beta: repair requested card splits

Rewrite can create separate editable cards when you ask it to split a note.
If its first check finds repairable wording issues, it repairs only those
replacements once, then checks the complete set again. Clean replacements are
not regenerated. A failed check keeps the original and shows a concise reason.
Successful splits retain the original in history, with its source and export
receipts. Nothing is exported automatically.

Explicit rewrites use two model requests when clean and at most four when a
repair is needed. This does not increase the automatic generation budget or
retry existing captures. The shared writer method and stored-data format stay
unchanged. A copied-data live replay produced five separate cloze notes and
passed its audit; this small check is not a general card-quality guarantee.

## 0.1.25 beta: constrain audits and isolate incomplete verdicts

Audit output contracts now specify the requested card identities, review ordinals
and deterministic-check IDs. When one assessment is incomplete, that card stays
held without discarding valid sibling verdicts. Unknown or duplicate card
identities still reject the response. Genuine source holds survive reload and
generic positive retry; only scoped evidence can resolve them.

Writer v11, saved data and the automatic request budget are unchanged. Two live
audits of private copies of the reported drafts returned complete contracts;
two drafts still failed retrieval-quality checks. This fixes audit-format
handling, not every card-writing defect, and does not retry existing captures.

### Mixed-format writing

Writer method v11 supports Q&A and cloze cards. Closed lists can hide one member
per review while the others remain visible; selected meanings and relationships
can use direct questions. Grouped notes and reversed term-definition retrieval
still need a meaningful cue for every rendered review.

Preparation decomposes supported facts before grouping. A compact worked example
shows the writer how to preserve source quotes, exact values, selected fact links
and the output schema. Audit coverage is required for every rendered review.
Source holds survive retries, duplicate plan targets are rejected, and accepted
soft findings remain tied to the wording and source that were checked.

The earlier removal of verification-status decoration remains. Actual findings,
source conflicts and saved evidence stay available. Export still requires an
explicit user action; existing cards are not rewritten in the background.

This release retains the better-performing baseline from a small, unblinded Luna
comparison, not the unsuccessful v12 revision. Compound planning and answer
leakage remain possible. The results do not establish broad model reliability,
medical accuracy or learning outcomes. Plugin identity and saved settings,
content, history, export receipts and dependency versions stay unchanged.

## Workflow

1. Select text in a note or PDF and run **Send selection to inbox**. Use
   **Send selection to inbox with instructions…** for an instruction specific to
   that capture. Highlighter mode also captures drag selections when enabled.
2. Return to the Inbox after generation. Recall uses one editable shared writing method
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
and plan references. Saved audits remain tied to the wording and source they
checked; editing does not certify a card. Existing cards are not repaired in the
background.

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

Edit prompts under **Settings → Recall Studio → System prompts → Open prompt**.
The editors are **Shared writing method**, **Reader prompt**, **Writer prompt**
and **Grader prompt**. Save persists changes; Restore default changes only the
draft until you save it. Card language and explicit capture/rewrite instructions
remain available. Recall does not use global standing instructions from legacy
rule files or infer preferences from edit history. Legacy rule and suggestions files are ignored
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
The MIT licence is in `LICENSE`. The older native quiz and rule-learning
workflows remain retired; saved legacy data is untouched. The unfinished Learn
integration and direct-copy installers are removed. Use BRAT for beta updates.
