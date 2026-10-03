# WikiLM

Turn your sources into a wiki you can question: highlight-grounded concept and entity pages, a chat that answers only from them, and flashcards pushed to Anki for long-term retention.

WikiLM builds wiki pages in your vault from the passages you highlight in PDFs and notes, and every claim on a page links back to the highlight it came from.
You can ask questions in a chat panel, and the answer comes only from those pages, with the sources listed under it.
The setting **Answer from general knowledge when your notes do not** is off by default. Turn it on and such an answer carries a warning.
Highlights you want to remember become flashcards in an inbox, and the cards you approve go to Anki.

How each part works, the full prompts and a map of the source are in [docs/architecture.md](docs/architecture.md).

## Requirements

- Obsidian 1.7.2 or later, on desktop. WikiLM does not run on mobile.
- A model. Pick one under Settings → WikiLM → **Provider**:
  - **Anthropic (API key)**
  - **Google Gemini (API key)**
  - **Claude Code (Claude subscription)**, which runs the `claude` CLI you are already signed in to. No key.
  - **Codex (ChatGPT subscription)**, which runs OpenAI's `codex` CLI signed in with your ChatGPT account. No key.
- For export, Anki with the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on. Without it you can export a text file and import that into Anki.
- Optional: the [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) plugin. The digest reads PDF++ highlight links, and AI highlight on a PDF writes them.

**Where API keys are kept.** You can type a key into the settings tab.
It is then saved in `.obsidian/plugins/wikilm/data.json` in plain text, and anything that syncs or backs up your vault copies it.
If you leave the field empty, WikiLM reads `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` from the environment.
On macOS it also looks in the keychain, so the key never touches the vault:

```
security add-generic-password -s ANTHROPIC_API_KEY -a wikilm -w
security add-generic-password -s GEMINI_API_KEY -a wikilm -w
```

**One provider or three.** Lint, Ask (query) and the digest can each run on their own provider and model.
Turn that on in the settings tab. Card writing and the quiz stay on the main provider. AI highlight on a PDF follows the Digest choice.

## Network and data

WikiLM sends your text to one place: the model provider you chose.

- **What is sent.** The highlights you capture, the text of a PDF or note you run a command on, your questions with the passages that answer them, and quiz answers.
  These go to the provider set for that job and to no one else.
- **Which servers.** Anthropic goes to Anthropic's API. Gemini goes to `generativelanguage.googleapis.com`.
  Claude Code and Codex are programs on your machine. WikiLM starts them, and they send the request to Anthropic or OpenAI under your subscription.
  Codex runs in an empty temporary folder with a read-only sandbox, so it cannot change your files, but its sandbox does not stop it reading them. Claude Code runs with its tools turned off, so it cannot open them.
- **Lint wiki sends page bodies.** With the setting **Model reviews pages on lint** on, which is the default, **Lint wiki** sends each page that has findings to the provider, up to 6,000 characters per page.
  The fix plan's buttons for aliases and duplicate pages send page excerpts too, and only when you press them.
  Turn the review off and the scan stays on your machine.
- **The included engine.** **Lint wiki (llm-wiki)** and the two Ingest commands run the included obsidian-llm-wiki engine.
  Its model calls go through the same providers. Its online PDF converter is switched off.
- **Anki.** Cards go to AnkiConnect at the URL in settings. The default is `http://127.0.0.1:8765`, which is your own computer.
- **Nothing else.** WikiLM has no telemetry and no analytics. Nothing is sent to the plugin author.

## Install

**From Obsidian.** Once WikiLM is listed, open Settings → Community plugins → Browse, search for WikiLM, install it and enable it.

**By hand.**

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release on this repository's Releases page.
2. Create the folder `.obsidian/plugins/wikilm/` inside your vault and copy the three files into it.
   The release also has `NOTICE`, `NOTICE-llm-wiki` and `LICENSE-APACHE-2.0.txt`. Copy them too, so the licence notices stay with the code.
3. Reload Obsidian and enable WikiLM under Settings → Community plugins.

**First run.**

1. Settings → WikiLM → **Provider**. Pick one, add a key if it needs one, and press **Test**.
2. Open Anki, then press **Detect** in the Anki section so WikiLM finds your note types.
3. Pick a default deck.

## Commands

Run these from the command palette. Each one also runs from the chat box by any of the words in backticks, with or without a leading slash.
Type `help` in the chat to see them all.

- **AI highlight…** (`ai`, `ai-instruct`, `suggest`, `transcript`): the model picks the passages worth keeping in the open note or PDF, guided by an optional lecture transcript or study guide.
- **Digest…** (`digest`, `digest-folder`): pick one PDF, several, or a whole folder, and its highlights become wiki pages behind a preview.
- **Lint wiki: create missing links, fix dead links, check quotes** (`lint`, `wiki`): checks the wiki and opens a fix plan. Nothing is written until you tick a row.
- **Send selection to inbox** (`capture`, `send`, `pdf`): queues the selected text for card writing. On a PDF it keeps the page number.
- **Send selection to inbox with instructions…** (`capture-instruct`, `pdf-instruct`): the same, with a one-line instruction for the card writer first.
- **Open chat: ask the notes** (`chat`, `ask`): opens the chat panel.
- **Open inbox** (`inbox`): opens the flashcard inbox.
- **Export all reviewed cards to Anki** (`export`): sends every card you approved to Anki.
- **Cancel the running AI highlight, digest or ingest** (`cancel`, `stop-run`): stops a long run at its next step.
- **Open the schema note** (`schema`): opens your house rules for the model, and creates the note if needed.
- **Review schema suggestions** (`suggestions`): rules WikiLM proposes from the edits you keep making. Accept, edit or dismiss each one.

These run from the chat box only:

- **Lint wiki (llm-wiki): scan and Smart Fix All** (`llm-wiki-lint`, `smart-fix`): obsidian-llm-wiki's own lint and fix buttons, behind WikiLM's guard.
- **Ingest source: read this markdown into the wiki** (`ingest`, `read-source`): the included engine reads the open note into wiki pages, behind the guard.
- **Ingest folder: read every note in a folder into the wiki** (`ingest-folder`, `read-folder`): the same for every note in a folder.
- **Send all ==highlights== in this note to inbox** (`highlights`, `sweep`): queues every `==highlight==` in the open note that is not in the inbox yet.
- **Retry failed highlights** (`retry`): tries the card writer again on highlights that failed.

There is also a highlighter mode. Turn it on with **Toggle highlighter mode** or the highlighter button in the ribbon.
While it is on, any passage you drag across goes to the inbox. It is off by default.

## The wiki folder

These are the defaults. Every folder can be changed in settings.

```
wiki/<class code>/      topic pages the digest writes (Topic notes folder)
wiki/concepts/          concept pages from AI highlight and ingest
wiki/entities/          entity pages from AI highlight and ingest
wiki/sources/           source summaries the ingest engine writes
wiki/sources/wispr/     lecture notes and transcripts (Transcript folder) (named for the Wispr Flow dictation app whose exports it was made for)
wiki/index.md           the ingest engine's index, rebuilt on each run
wiki/log.md             the ingest engine's log
wiki/schema/            WikiLM's own files (Schema folder)
  wikilm.md             the schema note
  wikilm-suggestions.md rules WikiLM proposes
  config.md             the ingest engine's own schema note
  inbox.json            the flashcard inbox
  exports/              Anki text-file exports
```

Ask, the quiz and **Lint wiki** read the pages under the **Topic notes folder**, which is `wiki/` by default, so they see the pages AI highlight, ingest and the digest write.
The schema folder and the transcript folder are skipped, so they never count as pages.
An install from before 0.14.0 that already keeps its topic pages in `classes/` goes on using `classes/`.

**The schema note.** `wiki/schema/wikilm.md` is yours to edit.
WikiLM writes it once from a template, then reads it before every model call and hands its sections to the model as house rules.
Add a line such as "answers in German" or "never cloze a date" and it applies from the next call.
Delete a line and it stops applying.
After the first write, WikiLM only ever adds to the `## Learned` section, and only when you accept a suggestion.

## What the guard does not protect

**Lint wiki (llm-wiki)** and the Ingest commands let the included engine rewrite existing pages. A guard of WikiLM's sits between the engine and your vault.
It refuses a rewrite that would drop a heading, a quote or callout line, a link to a PDF, wiki page or note, an embed, or a frontmatter key.
It refuses any write outside the wiki folder, and it never deletes or moves a page that existed before the run.

Know its limits:

- **Prose can change.** The engine can rewrite paragraphs, lists and tables under a heading it keeps. The guard does not compare prose.
- **Pages it made are its own.** A page the engine created in the same run is not checked.
- **Index and log.** `wiki/index.md` and `wiki/log.md`, when the engine wrote them, are rebuilt on every run and are not saved. An index or log you wrote yourself is snapshotted and loss-checked like any page.
- **Snapshots are limited.** Before a page is overwritten, its old text is saved under `.obsidian/plugins/wikilm/snapshots/`, one folder per run.
  Only the last 20 runs are kept. Older ones are deleted.

The digest, AI highlight and **Lint wiki** do not use the engine. They show a preview or a plan first and write only what you approve.

## Development

```
npm install
npm run vendor:types   # once, and after vendor/llm-wiki changes
npm run build
npm test
node scripts/install.mjs <vault path>
```

`npm run vendor:types` builds type declarations for the included obsidian-llm-wiki.
It runs `npm ci` inside `vendor/llm-wiki`, which needs network access to the registry named in that folder's lockfile.
`npm run build` stops and tells you to run it when the declarations are missing or out of date.
`node scripts/install.mjs` copies the build and the licence notices into `<vault path>/.obsidian/plugins/wikilm/`. It leaves `data.json` alone.

`node scripts/lint-baseline.mjs "<vault path>" [wikiFolder=wiki]` prints the lint counts for a vault.

## Built on

WikiLM includes the source of [obsidian-llm-wiki](https://github.com/GD4AI/obsidian-llm-wiki) 1.27.2 (commit `acabfcb`) under `vendor/llm-wiki/`.
The parts WikiLM imports are compiled into `main.js`.
Its NOTICE reads "Copyright 2025-2026 Greener-Dalii" and lists as contributors CCRRAY-DESIGN (Ray), Dima Marchevsky (dmarchevsky), DocTpoint, eucher, Franco Tampieri (FrancoTampieri), Greener-Dalii (green-dalii), Hashim1999164, joffroy59, Matthew Harper (Indexed-Apogrypha), Roman Kuzmin (rkuzmin) and Younian (YounianC, xiaochuanlu).
That code is licensed under the Apache License, Version 2.0, and stays under it.
Its own `LICENSE` and `NOTICE` are in `vendor/llm-wiki/`, a copy of the licence is at [LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt), and every file WikiLM changed there is listed in [vendor/llm-wiki.CHANGES.md](vendor/llm-wiki.CHANGES.md).
Several parts of WikiLM's own code were also written against obsidian-llm-wiki's published design. [NOTICE](NOTICE) names each one.

Text extraction in `src/pdftext.ts` is ported from [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) 0.40.31, Copyright (c) 2023 Ryota Ushio, under the MIT License.

The evidence filter in Ask follows the design of the per-result relevance filter in [WikiChat](https://github.com/stanford-oval/WikiChat), reimplemented here.

The quiz takes its ideas from [amosblomqvist/learn](https://github.com/amosblomqvist/learn): a question with a definite answer, the ground first, and a difficulty that follows you. They are written in WikiLM's own words with no code or text taken, and the questions are free response, never multiple choice.

## Licence

WikiLM is MIT licensed, Copyright (c) 2026 Conrad Kelonu. See [LICENSE](LICENSE), and [NOTICE](NOTICE) for the included and credited work.
