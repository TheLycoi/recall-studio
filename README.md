# Recall Studio

Recall Studio turns the passages you highlight into flashcards. Cards land in a
source-linked inbox as drafts. Export accepts the cards you choose and sends
them to Anki. Inbox is the only workspace. Use an external assistant for
conversation and quizzing; capture supporting note passages here for card writing.

The repository and BRAT target are `TheLycoi/recall-studio`, formerly
`TheLycoi/review-inbox`. Plugin ID `review-inbox`, default storage
`Review Inbox/` and retained command IDs stay unchanged. Version 0.1.18 is a beta
release. The card star asks what to change and rewrites that card with AI.
It adds no scheduler.

## What it does

You capture a passage from a note or a PDF. Recall Studio writes one or more
cards from it and checks them before they land in your inbox as drafts.
You review the cards in the inbox, beside the highlighted passage they came
from: edit one, check it against best practices, or bin it.
Export accepts the visible drafts in its scope and sends them to Anki with source backlinks.

## Requirements

- Obsidian 1.7.2 or later, on desktop.
- One model provider:
  - **Codex**: the Codex CLI, signed in with a ChatGPT account. The ChatGPT app bundles the CLI, so signing in to the app is enough. No API key.
  - **DeepSeek**: a DeepSeek API key from platform.deepseek.com.
  - **OpenCode**: the [opencode](https://opencode.ai) CLI, signed in to whichever provider you want to run (`opencode auth login`). Recall Studio holds no key for this one: opencode owns its credentials.
- Anki with the AnkiConnect add-on, for export. Optional.

## Commands

| Command | Aliases | What it does |
| --- | --- | --- |
| Send selection to inbox | `capture`, `send`, `pdf` | Queues the selected text for card writing. On a PDF it keeps the page number. |
| Send selection to inbox with instructions… | `capture-instruct`, `pdf-instruct` | The same, with a one-line instruction for the card writer first. |
| Open inbox | `inbox` | Opens the flashcard inbox. |
| Open source history | `source-history` | Shows retained captures and cards for the current note or PDF, with a picker for other captured sources. |
| Export to Anki | `export` | Accepts and exports all eligible drafts. Inbox Export buttons limit this to visible cards in their scope. |
| Open the card rules note | `rules`, `schema` | Opens your house rules for the card writer, and creates the note if needed. |
| Review card rule suggestions | `suggestions` | Rules Recall Studio proposes from the edits you keep making. Accept, edit, or dismiss each one. |
| Send all ==highlights== in this note to inbox | `highlights`, `sweep` | Queues every `==highlight==` in the open note that is not in the inbox yet. |
| Retry failed highlights | `retry` | Explicitly retries failed highlights and held private drafts, including partial batches with ready cards. Busy, archived and dismissed captures are skipped. |

Highlighter mode has no palette entry: it is the ribbon pen. While it is on,
drag across a passage in a note or PDF and it is sent to the inbox.

## Drafts, checks and export

Export is the acceptance action. There is no separate Approve button. Export
on a card sends that card; passage and source buttons send their visible drafts;
the header sends the visible drafts across the Inbox. Hidden flagged groups and
collapsed sources are excluded. The command palette exports all eligible drafts.
Dismissed passages, deleted cards and already exported cards are excluded.

The export summary beside the header, source and passage controls shows selected
Anki note records, expected retrieval tasks and notes with warnings. Repeated
occurrences of the same cloze number count as one task. Counts assume standard
Q&A/cloze templates; custom Anki templates may create different card counts.
Expand Warnings for details. The summary uses the existing export validation and
visible selection. It adds no confirmation or approval step and does not export
anything by itself. Warnings are advisory; malformed cards still block export.

Verify sits beside Export in the Inbox header, expanded sources and passages.
It checks the visible eligible cards in that scope, sequentially, without exporting.
Verify checks and repairs cards against the source and current writing rules.
Findings trigger one rewrite and a replacement check.
Clean cards stay unchanged; failed or stale replacements preserve the original.
Save or cancel an open card editor first. Successful repairs are recorded as
revisions, not learned as new writing preferences, and never export automatically.
The editor's separate draft Check remains diagnostic until you save.

The star on a card opens **Rewrite card**. Enter the change you want, then Send.
Cancelling sends no model request and leaves the card unchanged. Rewrites use
the existing source, writing rules and guarded replacement path, with revision
history. Explicit instructions can split a card into a bounded replacement set.
Every replacement must pass validation and independent audit before the original
is retired. New cards retain source provenance but do not inherit export receipts.
Verify remains the separate check-and-repair action.

A `checked` badge applies only to the current wording and source context.
New-generation audits do not set this badge. They gate publication and can trigger
a bounded repair before a draft becomes a normal Inbox card.

Export goes through AnkiConnect. Each card carries a stable identity scoped to
this plugin and this vault, so a repeated send, a retry after a lost reply, or a
send to a different deck looks the note up instead of adding a duplicate. Notes
are only ever added, never overwritten, so existing review history is safe. A
card whose content already exists in Anki as an unrelated note is reported, not
merged. If Anki is closed or an export fails, unsent cards keep their previous state.

## Staged generation

A generation batch uses one preparation request to inventory exact quotes and
plan cards, then one writer request. Deterministic checks validate quote and
fact references, card fields and cloze grounding. An independent audit always
checks the drafted claims against the captured passage, even for a single card.
Drafts stay private until they pass; the legacy audit toggle cannot bypass this.

Completed stages are checkpointed in the existing inbox file. Retrying after a
writer failure reuses valid preparation; changed inputs start a new batch.
Retries preserve card IDs and do not duplicate completed cards. Interrupted or
unknown requests require an explicit Retry rather than a silent paid repeat.
**Write more cards** deliberately starts another batch and retains prior evidence.

Rejected new candidates receive at most one repair attempt per authorized round,
followed by an independent recheck. Unresolved drafts remain held with their
reasons and cannot be edited or exported as ordinary cards. Retry includes partial
batches whose passing cards are already ready. Existing and exported cards are
not repaired automatically; Verify remains optional for older or hand-written
cards. Missing verdicts, unavailable writing rules and source conflicts cannot
become a verified pass. Partial retries audit the current published siblings.
Length findings require independent quality judgment, not automatic removal of
essential conditions or meaningful procedures.
Editing a card or its captured source invalidates the displayed audit. A model
audit is probabilistic, not proof of truth or approval to export. You still review
the cards and choose Export.

Each card's collapsed Evidence section shows its saved batch, plan and fact IDs,
exact source quotes, plan reason and stored audit result. Historical cards resolve
against their own batch, not the newest inventory. Missing or ambiguous references
are marked unavailable. The current audit label still becomes unverified when
wording or capture changes; the stored result remains visible as history.
Opening Evidence makes no model request and changes no stored data. Open source
uses the existing capture locator. Identical audit, check and critique paragraphs
appear once in the card body; distinct findings stay visible.

Card and cloze counts are source-driven, with no fixed deletion count or card
quota. A single cloze stays a cloze; supported deletions can share a stem instead
of repeating a sentence to meet a numeric ceiling. Existing user rules notes are
not rewritten. Token/time/request budgets still apply; incomplete output fails
validation instead of silently truncating cards or starting more requests.

## Source history

Clearing exported or dismissed captures archives them instead of deleting their
cards. Archived records leave the active Inbox but remain available through
**Open source history**, including after a restart.

In Markdown editing, Live Preview and reading view, a passage label shows how
many retained cards were created, await export, or have confirmed Anki IDs.
Select the label to inspect the saved quote and cards. File-export records
without Anki IDs are marked unconfirmed, not as successful Anki imports.

Labels require an exact, unambiguous match. Changed text and ambiguous repeats
remain available in source history without an inline label. Complex rendered
Markdown may also require the command. Renames update retained source paths;
deleting a source does not delete its history. PDFs retain page locators in
history, without PDF overlays or a claim that the text was reverified.

These overlays do not edit the source note. Card counts describe captured
passages, not whether you learned them or completed the whole note.

## External quizzes and source capture

Native Chat and its experimental Quiz/Make Flashcards commands are removed.
Inbox opens directly without a tab switch or message box. Existing captured
passages, cards, revisions, export receipts and stored legacy transcripts are
not deleted or migrated.

Use your external assistant to quiz you. For a missed concept, open the original
supporting note, select the relevant passage, and run **Send selection to inbox
with instructions…**. Describe the missed concept in the instruction; let the
existing card writer prepare the draft. Capture the original evidence, not the
assistant's explanation or your incorrect answer. Review and Verify the result
before deciding whether to Export. Automatic delivery from an external assistant
requires a separate supported bridge; this change does not add one.

The unmounted legacy study modules and their independent safety tests remain
for compatibility and possible reuse. Neither chat view is included in the
production entrypoint. There is no data deletion or scheduler change.

## Inline flashcards in your notes

Add `#flashcards` to a note, then write cards directly where you study. Cards
coexist with capture: the Inbox still generates cards from selected passages,
and inline cards let you see what you already wrote by hand.

Supported syntax: single-line basic (`Question::Answer`) and reversed
(`Question:::Answer`), multiline basic `?` and reversed `??` with an optional
end marker, and cloze paragraphs using `==highlight==` or `{{curly braces}}`.
Cards work inside plain paragraphs and inside bullet or numbered list items,
including nested ones, which is how outline notes are usually written. Bold
`**text**` is ordinary emphasis in most notes, so treating it as a cloze is a
separate opt-in setting.

`#flashcards/Sub deck` names a suggested export deck for that note. The Inbox
deck picker stays authoritative: the tag is a hint shown in source history, not
a silent override. Frontmatter tags, code and comments never supply card syntax
or deck scope. Notes over 1,048,576 characters are not scanned.

**Flashcard** badges and source-history entries describe only recognized card
syntax, never adjacent-prose coverage, exported-card counts or mastery.
Editor/history checks use current editor snapshots. Reading view marks only a
plain, unambiguous whole-card section; use source history for other rendering.
Recognition never writes notes, imports scheduling state or creates Inbox
records.

Recall Studio does not schedule reviews. Review happens in Anki, or in the
Spaced Repetition plugin if you install it; that plugin reads the same note text
and `#flashcards` tags independently.

## Settings

- **Card writer**: which provider writes the cards, its key or CLI path, and the model. Test sends one small request and loads that provider's model list.
- **Recall Studio folder** (under Card writer): where Recall Studio keeps the card rules note, the inbox, and the rule suggestions. Default `Review Inbox/`.
- **Card quality**: the rules the card writer and the critique pass follow.
- **Capture**: how a selection or a highlight is queued for a card.
- **Sources**: the wiki or sources folder protected from capture marking.
- **Existing Spaced Repetition cards**: read-only, opt-in scope and syntax settings.
- **Anki**: the deck, note types, and tags used on export.

### The DeepSeek key

Leave the key field empty and Recall Studio looks for `DEEPSEEK_API_KEY` in the
environment, then in the macOS keychain under `DEEPSEEK_API_KEY` or
`Review Inbox DeepSeek API key` (a keychain item named `Recall DeepSeek API key`,
from before the rename, is still read). A key typed into the settings field is
stored in the plugin's `data.json`, which in a synced vault is replicated in
plaintext to every device and backup, so the keychain is the better place for it:

```
security add-generic-password -s "DEEPSEEK_API_KEY" -a deepseek -w '<your key>'
```

### Running on opencode

Pick **OpenCode** under Settings → Card writer to route card writing through the
[opencode](https://opencode.ai) CLI. Recall Studio runs `opencode run` and reads
its JSON event stream, so the model is whatever that CLI is signed in to.

- **No key.** opencode resolves its own credentials, so Recall Studio stores none for this provider and nothing sensitive reaches `data.json`.
- **Any model it serves.** The model id is the `provider/model` string `opencode models` prints, for example `deepseek/deepseek-flash`.
- **The run has no tools.** Recall Studio runs under an agent it defines as deny-everything, in a scratch directory outside the vault, so a card prompt cannot touch your notes.

## Network and data

Card generation sends the captured passage, surrounding context, source title
and heading, your instructions, house rules and existing cards to the selected
provider. If history examples are enabled, selected examples also enter those
requests. Later stages include the saved preparation and drafted cards.
Source-history and SR recognition run locally. External assistants have their own
data-disclosure settings; Recall does not configure or control them.

- **Codex** (default): Recall Studio starts the Codex CLI, and Codex sends the request to OpenAI under your ChatGPT account.
- **DeepSeek**: Recall Studio posts to `https://api.deepseek.com` with your API key.
- **OpenCode**: Recall Studio starts the opencode CLI, and opencode sends the request to whichever provider you signed it in to.

Recall Studio also talks to AnkiConnect on `http://127.0.0.1:8765`. It makes no
other network request.

The inbox, the card rules note, and the rule suggestions file are stored in the
Recall Studio folder, default `Review Inbox/`. Text exports go to the Text export
folder setting, default `Review Inbox/exports`. No Anki media is fetched
remotely: only files already in the vault are uploaded.

## Build and beta installation

```
npm ci
npm run build
npm test
```

Install beta releases through BRAT, using the confirmed private repository and
its release tag. BRAT needs authorized access to the repository. Do not copy the
build over an existing Recall installation. This source uses the distinct plugin
ID `review-inbox`; its folder and settings are separate.

Private beta `0.1.0` was published to `TheLycoi/review-inbox`, the original
repository retained under its new name with the maintainer's approval. It loaded
through BRAT in Obsidian with the existing settings and inbox preserved.

The `0.1.1` changes add automatic retrieval and the concise Export label, plus
acceptance-review fixes. Full provider and Anki acceptance remain separate from
unit tests and build checks; see the project's host verification record.

## Where it came from

Recall Studio is derived from the Obsidian Recall project (MIT), which was carved
out of WikiLM 0.17.0. It keeps the Codex, DeepSeek and OpenCode provider work and
the Markdown/PDF capture path. MIT licence; see `LICENSE`.
