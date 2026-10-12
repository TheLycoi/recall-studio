# Review Inbox

Review Inbox turns the passages you highlight into flashcards. Cards land in a
source-linked inbox as drafts, you approve the ones you want, and export sends
the approved cards to Anki. A grounded chat over selected sources lets you ask
questions and turn an answer into draft cards.

This is the first stage of the Review product. There is no quiz, no dashboard,
no statistics and no review scheduler.

## What it does

You capture a passage from a note or a PDF. Review Inbox writes one or more
cards from it and checks them before they land in your inbox as drafts.
You review the cards in the inbox, beside the highlighted passage they came
from: edit one, rewrite it, or bin it. Approve the cards you want.
Export sends every approved card to Anki, with a backlink to its source.

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
| Open chat | `chat` | Opens grounded chat over the sources you select. |
| Export approved cards to Anki | `export` | Sends every approved card to Anki. Drafts and flagged cards are never exported. |
| Open the card rules note | `rules`, `schema` | Opens your house rules for the card writer, and creates the note if needed. |
| Review card rule suggestions | `suggestions` | Rules Review Inbox proposes from the edits you keep making. Accept, edit, or dismiss each one. |
| Send all ==highlights== in this note to inbox | `highlights`, `sweep` | Queues every `==highlight==` in the open note that is not in the inbox yet. |
| Retry failed highlights | `retry` | Tries the card writer again on highlights that failed. |

Highlighter mode has no palette entry: it is the ribbon pen. While it is on,
drag across a passage in a note or PDF and it is sent to the inbox.

## Drafts, approval and export

A card is a **Draft** until you approve it. Approving (**Approve**, or `a` on
the focused card) makes it exportable; unapproving sends it back to Draft.
Editing or rewriting an approved card returns it to Draft, because the wording
you approved is no longer the stored one. Nothing is approved for you: a card
the critique or the linter flagged stays flagged and is never exported.

Only **approved** cards are exported. **Approve all drafts** in the inbox header,
or **Approve all** on a passage or a source, approves in bulk.

Export goes through AnkiConnect. Each card carries a stable identity scoped to
this plugin and this vault, so a repeated send, a retry after a lost reply, or a
send to a different deck looks the note up instead of adding a duplicate. Notes
are only ever added, never overwritten, so existing review history is safe. A
card whose content already exists in Anki as an unrelated note is reported, not
merged. If Anki is closed, the cards stay approved and nothing is lost.

## The chat

Chat answers questions from the sources you explicitly select (markdown files or
captured passages). It shows clickable citations back to the evidence, refuses an
answer the evidence does not support, and keeps excluded sources out of the
prompt. A grounded answer can be sent to the inbox as draft cards.

Answers are extractive: each displayed claim must occur verbatim in a verified
quote from a selected source. This deliberately rejects paraphrases rather than
treating shared keywords as proof. Each question is independent; earlier answers
are not sent back to the provider, so removing a source also excludes its old
answers from subsequent prompts. Cancel discards the answer but may not stop the
provider request; it does not interrupt background card generation.

## Settings

- **Card writer**: which provider writes the cards, its key or CLI path, and the model. Test sends one small request and loads that provider's model list.
- **Review Inbox folder** (under Card writer): where Review Inbox keeps the card rules note, the inbox, and the rule suggestions. Default `Review Inbox/`.
- **Card quality**: the rules the card writer and the critique pass follow.
- **Capture**: how a selection or a highlight is queued for a card.
- **Sources**: the wiki or sources folder. Chat reads only the pages you select from it out of this folder; nothing under it is ever marked or changed. The chat's own source picker (notes and captured PDF passages) is in the Chat view, not here.
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

The integrated build has not yet passed real Obsidian/Anki acceptance: it has not
been installed or driven in Obsidian, and no card has been exported to a
disposable Anki deck. A private `0.1.0` prerelease was published to
`TheLycoi/review-inbox` — the original Recall repository, kept under that name
with the maintainer's approval — and its release assets were read back and
verified against the tested build. BRAT installation, a real-provider
capture/Chat run, and a repeat export against unchanged study records are still
outstanding.

## Where it came from

Review Inbox is derived from the Obsidian Recall project (MIT), which was carved
out of WikiLM 0.17.0. It keeps the Codex, DeepSeek and OpenCode provider work and
the Markdown/PDF capture path. MIT licence; see `LICENSE`.
