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
- One model provider:
  - **Codex**: the Codex CLI, signed in with a ChatGPT account. The ChatGPT app bundles the CLI, so signing in to the app is enough. No API key.
  - **DeepSeek**: a DeepSeek API key from platform.deepseek.com.
  - **OpenCode**: the [opencode](https://opencode.ai) CLI, signed in to whichever provider you want to run (`opencode auth login`). Recall holds no key for this one: opencode owns its credentials. Any model that CLI can reach is available, so a local Ollama model works here too.
- Anki with the AnkiConnect add-on, for export. Optional.
- A folder of wiki pages, for the quiz. Optional.

## Commands

Run these from the command palette. Each one also runs from the quiz panel's box by any of the words in backticks.

| Command | Aliases | What it does |
| --- | --- | --- |
| Send selection to inbox | `capture`, `send`, `pdf` | Queues the selected text for card writing. On a PDF it keeps the page number. |
| Send selection to inbox with instructions… | `capture-instruct`, `pdf-instruct` | The same, with a one-line instruction for the card writer first. |
| Toggle highlighter mode |  | Turns highlighter mode on or off. While it is on, drag across a passage in a note or PDF to send it to the inbox. |
| Open quiz | `quiz-panel` | Opens the quiz panel. |
| Open inbox | `inbox` | Opens the flashcard inbox. |
| Export all reviewed cards to Anki | `export` | Sends every card in the inbox to Anki, except flagged and discarded ones. |
| Send reviewed cards to Spaced Repetition | `spaced` | Writes every card in the inbox to the vault as markdown the Spaced Repetition plugin indexes, except flagged and discarded ones. |
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

- **Card writer**: which provider writes the cards, its key or CLI path, and the model. Test sends one small request and loads that provider's model list.
- **Recall folder** (under Card writer): where Recall keeps the card rules note, the inbox, and the rule suggestions. Default `Recall/`.
- **Card quality**: the rules the card writer and the critique pass follow.
- **Capture**: how a selection or a highlight is queued for a card.
- **Quiz**: how many questions a session asks and where it draws them from.
- **Anki**: the deck, note types, and tags used on export.
- **Spaced Repetition**: the folder, deck tag, and separators used when cards are written into the vault for the [Spaced Repetition plugin](https://github.com/st3v3nmw/obsidian-spaced-repetition).

### The DeepSeek key

Leave the key field empty and Recall looks for `DEEPSEEK_API_KEY` in the environment, then in the macOS keychain under `DEEPSEEK_API_KEY` or `Recall DeepSeek API key`. A key typed into the settings field is stored in the plugin's `data.json`, which in a synced vault is replicated in plaintext to every device and backup, so the keychain is the better place for it:

```
security add-generic-password -s "DEEPSEEK_API_KEY" -a deepseek -w '<your key>'
```

### Running on opencode

Pick **OpenCode** under Settings → Card writer to route card writing through the [opencode](https://opencode.ai) CLI. Recall runs `opencode run` and reads its JSON event stream, so the model is whatever that CLI is signed in to.

- **No key.** opencode resolves its own credentials (`opencode auth login`, and `opencode service set env` for a provider key), so Recall stores none for this provider and nothing sensitive reaches `data.json`.
- **Any model it serves.** The model id is the `provider/model` string `opencode models` prints, for example `deepseek/deepseek-flash` or `ollama/qwen2.5:7b`. A model from a keyed provider only appears once that provider has a key, so a missing entry usually means "not signed in" rather than "unsupported".
- **The run has no tools.** opencode's default agent allows every action, and a model told to read a file really will read one. Recall therefore runs under an agent it defines as deny-everything, in a scratch directory outside the vault, so a card prompt cannot touch your notes. This is enforced at the tool layer, not asked for in the prompt.
- **Sessions are cleaned up.** `opencode run` writes a session; Recall deletes it once the answer is read, because card writing fires per highlight and those would otherwise pile up in your opencode session list.
- **Reasoning level lives in the model id.** Append opencode's variant suffix to an id whose model offers it, for example `deepseek/deepseek-flash#high` (`#low`, `#high`, `#max`). The Effort setting does not apply to this provider, because naming a variant a model does not offer fails the call outright.

## Network and data

Recall sends the passage and the prompt to whichever provider you picked, and nothing else leaves the machine.

- **Codex** (default): Recall starts the Codex CLI, and Codex sends the request to OpenAI under your ChatGPT account.
- **DeepSeek**: Recall posts to `https://api.deepseek.com` with your API key.
- **OpenCode**: Recall starts the opencode CLI, and opencode sends the request to whichever provider you signed it in to. Recall holds no key for this provider, and opencode decides where the request goes.

Recall also talks to AnkiConnect on `http://127.0.0.1:8765`. It makes no other network request.

The inbox, the card rules note, and the rule suggestions file are stored in the Recall folder, default `Recall/`.
Text exports go to the Text export folder setting, default `Recall/exports`.
Spaced Repetition notes go to the Spaced Repetition folder setting, default `Recall/spaced`.

### Sending cards to Spaced Repetition

The Spaced Repetition plugin has no API for other plugins: it reads markdown files in the vault. So Recall's other export target writes a note per highlight, tagged as a deck, and the plugin indexes it on its next scan. Reviewing then happens in Obsidian, next to the note the card came from.

- A card goes to one destination, never both: sending a card to Spaced Repetition leaves it out of Anki, and the other way round.
- A note is written once and never rewritten. Sending the same highlight again writes a second, suffixed note with only the cards that have not been sent, because the plugin keeps its review history in the notes themselves.
- Each card becomes one line, so a blank line or a bare `?` inside card text cannot end a card early. A card that would be misread by the plugin is reported instead of written, and stays in the inbox.

## Install

```
npm ci
npm run build
node scripts/install.mjs "<vault path>"
```

Then enable Recall under Settings → Community plugins.

## Checking a provider by hand

`npm test` covers the pure parts and never spawns a process. To exercise a real
backend against the real CLI (network, credentials and all):

```
node scripts/e2e-opencode.mjs
```

It runs a probe, lists models, generates cards through a real schema, reads
plain text, and asserts a bad model id fails with a named fix rather than a
crash. This is the check that caught the `PWD` bug the unit tests could not see:
opencode resolves its project `opencode.json` (which defines the no-tools agent)
from `PWD`, not from the process's working directory, and Node's `spawn` `cwd`
option does not update it.

## Where it came from

Recall was carved out of WikiLM 0.17.0. MIT licence.
