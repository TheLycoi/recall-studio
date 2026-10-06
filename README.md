# Recall

Recall turns the passages you highlight into flashcards, with an inbox to review them before they reach Anki, and a free-response quiz on your wiki pages.
It runs beside a wiki plugin such as Karpathy LLM Wiki. It reads the wiki folder to build quiz questions, and it never writes to it.

## What it does

You capture a passage from a note or a PDF. Recall writes one or more cards from it and checks them before they land in your inbox.
You review the cards in the inbox. Flag or discard the ones that are wrong, then export sends the rest to Anki.
You can also run a quiz on your wiki pages. Each question covers one section, and you answer in a few sentences from memory.
A question you miss can become a card of its own, so the next thing you study is the thing you just got wrong.

## Requirements

- Obsidian 1.7.2 or later, on desktop.
- The Codex CLI, signed in with a ChatGPT account. The ChatGPT app bundles the CLI, so signing in to the app is enough.
- Anki with the AnkiConnect add-on, for export. Optional.
- A folder of wiki pages, for the quiz. Optional.

## Commands

Run these from the command palette. Each one also runs from the quiz panel's box by any of the words in backticks.

| Command | Aliases | What it does |
| --- | --- | --- |
| Send selection to inbox | `capture`, `send`, `pdf` | Queues the selected text for card writing. On a PDF it keeps the page number. |
| Send selection to inbox with instructions… | `capture-instruct`, `pdf-instruct` | The same, with a one-line instruction for the card writer first. |
| Open quiz | `quiz-panel` | Opens the quiz panel. |
| Open inbox | `inbox` | Opens the flashcard inbox. |
| Export all reviewed cards to Anki | `export` | Sends every card in the inbox to Anki, except flagged and discarded ones. |
| Open the card rules note | `rules`, `schema` | Opens your house rules for the card writer, and creates the note if needed. |
| Review card rule suggestions | `suggestions` | Rules Recall proposes from the edits you keep making. Accept, edit, or dismiss each one. |
| Send all ==highlights== in this note to inbox | `highlights`, `sweep` | Quiz panel only. Queues every `==highlight==` in the open note that is not in the inbox yet. |
| Retry failed highlights | `retry` | Quiz panel only. Tries the card writer again on highlights that failed. |

## The quiz

Say `quiz me` for a question on each section of the open note.
Say `quiz me on <page or subject>` to name a page, or `quiz me on everything` to cover the whole wiki folder.
While a quiz runs, say `hint`, `skip`, or `stop`.
After a quiz, say `send to inbox` (or `card it`) to turn what you missed into cards.
Say `help` to see the full list.

Recall reads markdown pages under the wiki folder. It skips the `schema` folder, pages named `index` or `log`, any page whose name starts with "Welcome to ", and lines that are only a link.

## Settings

- **Card writer**: how cards are written, and the model they are written with.
- **Recall folder**: where Recall keeps the card rules note, the inbox, and the rule suggestions. Default `Recall/`.
- **Card quality**: the rules the card writer and the critique pass follow.
- **Capture**: how a selection or a highlight is queued for a card.
- **Quiz**: how many questions a session asks and where it draws them from.
- **Anki**: the deck, note types, and tags used on export.

## Network and data

Recall starts the Codex CLI on your machine, and Codex sends the passage and the prompt to OpenAI under your ChatGPT account.
Recall talks to AnkiConnect on `http://127.0.0.1:8765`. It makes no other network request.
The inbox, the card rules note, and the rule suggestions file are stored in the Recall folder, default `Recall/`.
Text exports go to the Text export folder setting, default `Recall/exports`.

## Install

```
npm ci
npm run build
node scripts/install.mjs "<vault path>"
```

Then enable Recall under Settings → Community plugins.

## Where it came from

Recall was carved out of WikiLM 0.17.0. MIT licence.
