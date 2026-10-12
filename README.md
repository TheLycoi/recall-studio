# Review Inbox

Review Inbox turns the passages you highlight into flashcards. Cards land in a
source-linked inbox as drafts. Export accepts the cards you choose and sends
them to Anki. A grounded chat inside Inbox searches your vault so you can ask
questions and turn an answer into draft cards.

This is the first stage of the Review product. There is no quiz, no dashboard,
no statistics and no review scheduler.

## What it does

You capture a passage from a note or a PDF. Review Inbox writes one or more
cards from it and checks them before they land in your inbox as drafts.
You review the cards in the inbox, beside the highlighted passage they came
from: edit one, check it against best practices, or bin it.
Export accepts the visible drafts in its scope and sends them to Anki with source backlinks.

## Requirements

- Obsidian 1.7.2 or later, on desktop.
- One model provider:
  - **Codex**: the Codex CLI, signed in with a ChatGPT account. The ChatGPT app bundles the CLI, so signing in to the app is enough. No API key.
  - **DeepSeek**: a DeepSeek API key from platform.deepseek.com.
  - **OpenCode**: the [opencode](https://opencode.ai) CLI, signed in to whichever provider you want to run (`opencode auth login`). Review Inbox holds no key for this one: opencode owns its credentials.
- Anki with the AnkiConnect add-on, for export. Optional.

## Commands

| Command | Aliases | What it does |
| --- | --- | --- |
| Send selection to inbox | `capture`, `send`, `pdf` | Queues the selected text for card writing. On a PDF it keeps the page number. |
| Send selection to inbox with instructions… | `capture-instruct`, `pdf-instruct` | The same, with a one-line instruction for the card writer first. |
| Open inbox | `inbox` | Opens the flashcard inbox. |
| Open chat | `chat` | Focuses Chat inside Inbox, with vault search and verified citations. |
| Export to Anki | `export` | Accepts and exports all eligible drafts. Inbox Export buttons limit this to visible cards in their scope. |
| Open the card rules note | `rules`, `schema` | Opens your house rules for the card writer, and creates the note if needed. |
| Review card rule suggestions | `suggestions` | Rules Review Inbox proposes from the edits you keep making. Accept, edit, or dismiss each one. |
| Send all ==highlights== in this note to inbox | `highlights`, `sweep` | Queues every `==highlight==` in the open note that is not in the inbox yet. |
| Retry failed highlights | `retry` | Tries the card writer again on highlights that failed. |

Highlighter mode has no palette entry: it is the ribbon pen. While it is on,
drag across a passage in a note or PDF and it is sent to the inbox.

## Drafts, checks and export

Export is the acceptance action. There is no separate Approve button. Export
on a card sends that card; passage and source buttons send their visible drafts;
the header sends the visible drafts across the Inbox. Hidden flagged groups and
collapsed sources are excluded. The command palette exports all eligible drafts.
Dismissed passages, deleted cards and already exported cards are excluded.

The passage star checks its cards against best practices. The per-card check
does the same for one card. Findings do not rewrite the card. A `checked` badge
appears only after an explicit check completes for its current wording and source
context; editing invalidates it. Automatic generation critique does not set this badge.

Export goes through AnkiConnect. Each card carries a stable identity scoped to
this plugin and this vault, so a repeated send, a retry after a lost reply, or a
send to a different deck looks the note up instead of adding a duplicate. Notes
are only ever added, never overwritten, so existing review history is safe. A
card whose content already exists in Anki as an unrelated note is reported, not
merged. If Anki is closed or an export fails, unsent cards keep their previous state.

## The chat

Chat is embedded inside Inbox, not a separate tab. Ask a question without selecting notes. Chat searches Markdown notes and captured
PDF passages locally and sends only the highest-ranked passages to your provider.
The optional, collapsed Search scope control narrows the search to chosen sources.
Hidden paths, Obsidian excluded files, and the configured plugin-data and export
folders are never searched. Notes larger than 1 MB are skipped with a notice.

Retrieval uses keyword matching, not embeddings. It retains at most 40 candidate
passages, each up to 1,200 characters; source text sent to the model is capped at
12,000 characters. It can miss synonyms or facts split across long passages.
When no relevant evidence is found, Chat refuses instead of sending unrelated
notes. Clickable citations open the source passage. A grounded answer can become
draft cards in the Inbox, including when its PDF passage was captured earlier.

Answers are extractive: each displayed claim must occur verbatim in a verified
quote from a retrieved source. This deliberately rejects paraphrases rather than
treating shared keywords as proof. Each question is independent; earlier answers
are not sent back to the provider, so removing a source also excludes its old
answers from subsequent prompts. Cancel discards the answer but may not stop the
provider request; it does not interrupt background card generation.

## Settings

- **Card writer**: which provider writes the cards, its key or CLI path, and the model. Test sends one small request and loads that provider's model list.
- **Review Inbox folder** (under Card writer): where Review Inbox keeps the card rules note, the inbox, and the rule suggestions. Default `Review Inbox/`.
- **Card quality**: the rules the card writer and the critique pass follow.
- **Capture**: how a selection or a highlight is queued for a card.
- **Sources**: the wiki or sources folder protected from capture marking. Chat searches eligible notes throughout the vault; optional narrowing is in the Chat view.
- **Anki**: the deck, note types, and tags used on export.

### The DeepSeek key

Leave the key field empty and Review Inbox looks for `DEEPSEEK_API_KEY` in the
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
[opencode](https://opencode.ai) CLI. Review Inbox runs `opencode run` and reads
its JSON event stream, so the model is whatever that CLI is signed in to.

- **No key.** opencode resolves its own credentials, so Review Inbox stores none for this provider and nothing sensitive reaches `data.json`.
- **Any model it serves.** The model id is the `provider/model` string `opencode models` prints, for example `deepseek/deepseek-flash`.
- **The run has no tools.** Review Inbox runs under an agent it defines as deny-everything, in a scratch directory outside the vault, so a card prompt cannot touch your notes.

## Network and data

Review Inbox sends the passage and the prompt to whichever provider you picked,
and nothing else leaves the machine.

- **Codex** (default): Review Inbox starts the Codex CLI, and Codex sends the request to OpenAI under your ChatGPT account.
- **DeepSeek**: Review Inbox posts to `https://api.deepseek.com` with your API key.
- **OpenCode**: Review Inbox starts the opencode CLI, and opencode sends the request to whichever provider you signed it in to.

Review Inbox also talks to AnkiConnect on `http://127.0.0.1:8765`. It makes no
other network request.

The inbox, the card rules note, and the rule suggestions file are stored in the
Review Inbox folder, default `Review Inbox/`. Text exports go to the Text export
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

Review Inbox is derived from the Obsidian Recall project (MIT), which was carved
out of WikiLM 0.17.0. It keeps the Codex, DeepSeek and OpenCode provider work and
the Markdown/PDF capture path. MIT licence; see `LICENSE`.
