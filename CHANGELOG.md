# Changelog

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
- Bug fixes from the release review: see the commits. <!-- orchestrator fills -->

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
