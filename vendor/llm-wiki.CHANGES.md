# Changes to the vendored obsidian-llm-wiki

`vendor/llm-wiki/` holds the source of obsidian-llm-wiki
(https://github.com/GD4AI/obsidian-llm-wiki), licensed under the Apache
License, Version 2.0. Section 4(b) of that licence requires every modified
file to carry a prominent notice that it was changed. This file lists every
file under `vendor/llm-wiki/` that WikiLM has modified, added or removed.

`vendor/llm-wiki.manifest.json` records the sha256 of every file as imported
from upstream. `scripts/vendor-manifest.mjs` computes it from git's squash
commit for the latest import, never from the working tree, so regenerating it
does not absorb a change to a vendored file. `test/vendorProvenance.test.mjs`
fails when a file differs from the manifest and is not listed here, when a
listed file lacks its marker, or when a file is missing and its removal is not
recorded.

## The marking rule

When you change a file under `vendor/llm-wiki/`, or add one:

1. Add a line at the top of the file that starts with the marker for its kind,
   followed by the date and a few words on the change:
   - Markdown and HTML: `<!-- Modified by WikiLM on 2026-09-29: what changed. -->`
   - every other file: `// Modified by WikiLM on 2026-09-29: what changed.`
2. Add a row to the table below. The File column is the path relative to
   `vendor/llm-wiki/`, in backticks.

When you remove a file, add a row whose Reason starts with `Removed`.

`LICENSE` and `NOTICE` are upstream's and may never be changed, removed or
listed here. Keep the existing copyright, patent, trademark and attribution
notices in every file you change.

## Changed files

| File | Date | Reason |
| --- | --- | --- |
