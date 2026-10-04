# Changelog

## 0.16.0

- Lint wiki finds links by reading. Every page is searched for the names of your other pages: a filename, a heading or an alias, as a whole word. Where a page names another one without linking it, the fix plan offers a row under Missing links that links the first mention where it stands. Your words stay as the link's text, so "muscle contraction" in Muscle Tension becomes a link to Muscle Contraction and reads the same.
- This pass uses no model and runs on every page, including pages with no other findings.
- A phrase that is a longer page's name goes to that page: "linear kinematics" is not a mention of Kinematics. A plural counts. An acronym is matched by its exact case. A name in a parenthesis is found on its own, so "GRF" finds Ground Reaction Force (GRF).
- A page that already links the other gets no row. Headings, quotes, tables, code and frontmatter are never touched, and a source note is never edited.

## 0.15.1

- In the quiz, a long paragraph counts as one point per sentence. A page's opening is often one paragraph holding several ideas; as a single point, an answer that gave exactly what the question asked was marked partial for leaving out the rest.
- The grader marks against the question: what a point holds beyond what was asked is not a missing part.

## 0.15.0

- The quiz asks real questions. Each one is about the main idea of a section and is answered from memory in a few sentences. It no longer says "write down everything you remember", and it is never multiple choice or yes/no.
- Each question carries its own answer key: the one to four points a full answer contains. You are marked on those, not on every line of the section.
- The difficulty follows you. The first question asks you to state the thing. A full answer moves the next one up to why or how, then to how ideas connect. A miss steps it back down.
- The grader's feedback says what you got right and what a full answer adds, tied to what you wrote.
- A question about a section that is one long paragraph is no longer rejected for sharing the subject's words, which is what used to leave you with the bare heading as the question.
- Starting a second quiz while one runs now says plainly that your next message is read as an answer, and how to switch.

## 0.14.3

- A digest says each thing once. A highlight that a bullet paraphrases and cites is no longer printed again as a quote beneath it. Quotes are kept for wording worth keeping: a definition the source states outright, a formula, a list of criteria, a figure, or a highlight of 200 characters or more. A quoted highlight that no bullet cites is always kept.
- A section built only from cited bullets links its heading to the slide, and its highlights count as added in the preview.

## 0.14.2

- In the digest preview, the box on each row is the note the topic goes into. Type the name of a note you already have and the topic is filed there: a new topic becomes a branch under its own title, with its sub-sections as headings beneath it. Type a new name and it becomes a new note. Existing notes are suggested as you type, and the line under the box says where the topic will land.
- The box can be typed in. A long badge used to squeeze it to nothing on new rows, and rows that merge into a page were read-only.
- A topic filed into a page as a branch keeps its sub-sections as headings one level down, where a mind map draws them, instead of bold lines.

## 0.14.1

- AI highlight on a PDF now writes pages through the digest. The spans it picks join the PDF's own highlights and go through the digest's draft, preview and merge, so the page gets an opening and branches of a lead line and cited bullets. Before, it wrote one labelled link per span and a separate heading per subject. The flashcards-only option is unchanged.
- The digest preview says why it would write nothing: all the PDF's highlights are already on these pages, and an instruction cannot add slides nobody highlighted. It points at PDF++ highlighting or AI highlight for the rest of the deck.
- Digest sections are written as a mind map: a lead line, then bullets, never a paragraph. The output schema now says so, and the default schema note no longer asks for raw links or the old `## Highlights` shape.
- A digest merge sees the reader's `###` branches. Before, only `##` headings were matched, so a new section was founded beside a branch of the same name instead of filing into it.
- On a page that nests its branches, a new digest section is a `###` inside the `##` named for the page, founded when missing. Flat digest pages keep `##`.
- Text spliced into an empty section no longer runs into its heading.

## 0.14.0

The first public release.

- The plugin names itself WikiLM in its banner. The personal install path is gone, and so are the unused AI SDK packages.
- Examples in user-facing text, code comments and test fixtures are neutral.
- Dead manifest rendering and lint buttons nothing could reach are removed.
- PDF++ is credited for the ported text extraction.
- A public README with a Network and data section. The design log and prompts moved to `docs/architecture.md`.
- `minAppVersion` is 1.7.2.
- One **Digest…** command with a picker: tick one PDF, several, or a whole folder.
- **Lint wiki** is named for links ("create missing links, fix dead links, check quotes") and its fix plan opens on the rows that write links.
- **Lint wiki (llm-wiki)** left the palette. It still runs from the chat box as `smart-fix` or `llm-wiki-lint`.
- Digest sections are a lead line and cited bullets.
- The quiz is free recall, one section of a note at a time.
- Decide dead links with Obsidian's resolver, and never pre-tick an unlink
- Mark highlights in the live note text, one block id per line
- Keep the open card edit when a background card lands; extra instructions last one run
- A digest merge keeps the reader's callout whole and writes every coalesced section
- Count only verified recall marks; a failed cue falls back and a failed grade still finishes
- Snapshot a reader-written index or log before the engine rewrites it
- Default the topic folder to wiki, where the rest of the plugin already writes
- Inbox store goes read-only when it cannot read, and stops writing after unload
- Link rewrites keep tables, brackets and case variants intact

**Hotkeys lost in this release.** A hotkey bound to `digest-folder` no longer fires. Bind **Digest…** and tick the folder in its picker. `lint-wiki-upstream` is chat-only, so a hotkey bound to it no longer fires either.

## 0.13.0

- obsidian-llm-wiki 1.27.2 is included under `vendor/llm-wiki/` (Apache-2.0) and runs the ingest and its own lint.
- **Ingest source** and **Ingest folder** run the included engine behind a guard of WikiLM's. Each existing page is saved before it is overwritten, and a rewrite that would drop a heading, a quote, a PDF link, an embed or a frontmatter key is refused.
- **Lint wiki (llm-wiki): scan and Smart Fix All** runs upstream's lint in its own report modal, every write behind the same guard. Duplicate pages are linked, never merged.
- The palette carries the workflow commands in workflow order. The rest run from the chat box by alias.

**Hotkeys lost in this release.** A hotkey bound to one of these ids no longer fires. Bind the command that replaced it:

- `capture-pdf-selection` → **Send selection to inbox**
- `capture-pdf-selection-with-instruction` → **Send selection to inbox with instructions…**
- `ai-highlight-with-instruction`, `ai-highlight-pdf`, `add-transcript` → **AI highlight…**
- `ingest-source`, `ingest-folder`, `capture-markdown-highlights`, `retry-failed` → chat only

A hotkey bound to `ai-highlight` keeps firing. It now opens the AI highlight form instead of running at once, and Cmd/Ctrl+Enter in the form runs it.

## 0.12.x and earlier

See the git history.
