# WikiLM — a wiki you can question, grounded in your own highlights

WikiLM turns the sparse things you actually want to remember into Anki cards
without making you wait for the AI. It is built around three ideas:

1. **Highlights, not documents.** Every card belongs to a highlight: a span
   you selected, a `==markdown highlight==`, or a span the AI picked for you.
   The card writer only sees that span plus a little context, so it writes
   tight, grounded cards instead of a card for everything in the note.
2. **A flashcard inbox.** Sending a highlight is fire-and-forget. Cards are
   written in the background and land in an inbox you triage later, grouped
   by source note and by highlight, packed densely for fast scanning.
3. **Anki is the memory system.** Reviewed cards go straight into a deck via
   AnkiConnect (or a text-import file when Anki is closed). Nothing is
   rehearsed inside Obsidian.

## Workflow

```
read a note ──▶ select text ──▶ "Send selection to inbox"     (≈2 seconds)
                                        │
                     background: the model writes 1–5 cards for that span
                                        │
open inbox ──▶ scan / edit / delete ──▶ "Export" ──▶ Anki deck
```

### Capturing

**Highlighter mode** is the primary path. Click the pen in the ribbon (or run
*Toggle highlighter mode*), then drag across a passage. It is sent to the
inbox with no key pressed, and your note is left untouched. This works in the editor
(source and live preview), in reading view, and in Obsidian's PDF viewer,
where the highlight carries its page number instead of a line. The status bar
shows `🖊 highlighter` while the mode is on. Off by default: with it on, every
drag-selection is a capture. Guards: only a drag that started inside the
note or PDF counts, double-clicked words and selections under a minimum
length (setting, default 12 characters) are ignored, already-highlighted
spans are captured without being re-wrapped, and the same passage is never
captured twice in a row.

Every command WikiLM registers. Each one runs from the command palette under
its name, and from the chat box by any of its aliases, with or without a
leading slash; the whole table is `COMMAND_TABLE` in `src/commandTable.ts`,
and `/help` in the chat prints it.

| Palette name | Chat aliases | When available |
| --- | --- | --- |
| **Send selection to inbox** | `capture`, `send` | needs an open note |
| **Send PDF selection to inbox** | `pdf` | needs an open PDF |
| **Send PDF selection to inbox with instructions…** | `pdf-instruct` | needs an open PDF |
| **Send selection to inbox with instructions…** | `capture-instruct` | needs an open note |
| **Send all ==highlights== in this note to inbox** | `highlights`, `sweep` | needs an open note |
| **AI-highlight this note and write cards** | `ai` | needs an open note |
| **AI-highlight this note with instructions…** | `ai-instruct` | needs an open note |
| **Ingest source: read this markdown into the wiki** | `ingest`, `read-source` | needs an open note |
| **Ingest folder: read every note in a folder into the wiki** | `ingest-folder`, `read-folder` | always |
| **Cancel the running AI highlight or ingest** | `cancel`, `stop-run` | while a run is in progress |
| **Add transcript for document highlighting** | `transcript` | needs an open note |
| **Digest PDF highlights into topic notes…** | `digest` | needs an open PDF, or a note with PDF++ links |
| **AI-highlight this PDF into the wiki…** | `suggest` | needs an open PDF |
| **Open chat: ask the notes** | `chat`, `ask` | always |
| **Lint wiki: find gaps, dead links and ungrounded quotes** | `lint`, `wiki` | always |
| **Open inbox** | `inbox` | always |
| **Export all reviewed cards to Anki** | `export` | always |
| **Retry failed highlights** | `retry` | always |
| **Open the schema note** | `schema` | always |
| **Review schema suggestions** | `suggestions` | always |

What the capture commands do: **Send selection to inbox** takes the selection
(or the paragraph under the cursor; in reading view, the selected text) and
queues card writing, and is in the editor right-click menu too. The PDF
variants take the text selected in the PDF viewer with its page number and
the page's text as context. The two *…with instructions…* forms add a
one-line instruction for the writer ("one cloze on the number", "cards in
Dutch"). **Send all ==highlights== in this note to inbox** sweeps a note you
highlighted while reading and queues every span not already in the inbox.
**AI-highlight this note and write cards** has the model pick the spans worth
remembering, each verified verbatim against the note before it is queued; use
it for dense material. **AI-highlight this PDF into the wiki…** does the same
for a PDF, mapping each verified span to a PDF++ selection and assigning it to
a same-class wiki note — under one of that note's own `##` headings when the
span is a subtopic of it — or to a proposed new one, previewed span by span,
then written as callouts.

**Capture does not edit your notes.** WikiLM sends the passage to the inbox and
leaves the file alone. Writing `==…==` into a note is available as an opt-in
setting ("Mark captured text in the note"), but it is off by default: a passage
that spans a heading or a list item cannot be wrapped in `==…==` without
breaking the formatting, and WikiLM now refuses to mark those spans even when
marking is on.

Every highlight remembers its note, line, nearest heading and (optionally) a
`^wikilm-…` block ID, so the inbox can jump straight back to the source. With
marking off, clicking a highlight in the inbox re-locates it by its text, so the
jump survives edits made elsewhere in the note. PDF highlights remember the page
and open the PDF at that page.

### What the cards look like

A worked example, from a vault note on Wozniak's minimum information
principle. Four highlights, four cards, nothing in an answer that isn't
stated in the span above it.

Two rules shape what the writer drafts before any of this reaches the
critique. An **open list** — one signalled by "include", "such as", "for
example", "among others" — is never asked for as a closed answer or
clozed member by member the way a closed list (one that states its full
membership) is; instead the writer tests the membership criterion where
the highlight states one, and each named example in the example →
category direction. And when a highlight defines or explains a
**concept**, the writer traces its edges — what's always, sometimes, or
never true of it, what it's confused with, what it contains and belongs
to, what it does and why, why it matters — using only the lenses the
highlight actually supports, so every answer is still stated in the
highlight (`src/llm.ts`, `WRITER_SYSTEM`).

**Highlight** — *"Simplicity improves the accuracy of interval scheduling,
because recall of a simple item is closer to all-or-nothing."*

```
qa | Why does item simplicity improve interval scheduling?
   | Recall of a simple item is closer to all-or-nothing.
```

**Highlight** — *"Compound questions are split: 'What are the
characteristics of the Dead Sea?' becomes several specific questions
(location, salinity, why one floats, etc.)."*

```
cloze | A compound question like "What are the characteristics of the
      | Dead Sea?" should be split into {{c1::several specific questions}}
      | covering {{c2::location, salinity, and why one floats}}.
```

**Highlight** — *"a card repeatedly forgotten is often one that violates the
minimum information principle and should be split"*

```
qa | What is the usual diagnosis for a leech card?
   | It violates the minimum information principle and should be split.
```

The fourth card drafted from this note asked what the principle *is* and
answered by restating its definition — the near-tautology case the critique
pass looks for (`src/llm.ts`). It came back `drop`, so it sits in
the inbox flagged with its reason rather than being deleted, and cannot be
exported until it's fixed or kept deliberately.

Each exported card carries the verbatim highlight and an `obsidian://` link
in its extra field, plus a `source::<note-slug>` tag.

### Transcript-guided highlighting

Attach a lecture transcript to a note and the two **AI-highlight** commands
use it as evidence of what the lecturer emphasised, so the model prefers
spans the lecturer dwells on, repeats, calls important, or says will be
tested, instead of spreading picks evenly across the note. Spans are still
copied verbatim from the note; the transcript itself is never quoted.

Run **Add transcript for document highlighting** on an active `.md` note.
The modal shows the current transcript (origin, character count, added
date, whether it was cut to the size limit) when one is attached, and lets
you:

- Paste a transcript into the textarea.
- **Choose a file from the vault…**, which opens a fuzzy file picker
  restricted to `md`, `txt`, `vtt`, and `srt` files and reads the chosen
  file's contents into the textarea.
- **Save** the transcript (an empty textarea shows a notice instead), **Clear**
  it (only shown when a transcript already exists), or **Cancel**. `Cmd`/`Ctrl+Enter`
  in the textarea also saves.

Saving cleans the text before it's stored: WebVTT headers and `NOTE`
comment blocks are dropped, SRT cue numbers and `-->` timestamp lines are
removed, leading `[m:ss]`/`[h:mm:ss]`/`(m:ss)`/`(h:mm:ss)` timestamps are
stripped from the start of a line, and `<v>`, `<c>`, `<b>`, and `<i>` tags
are removed. Speaker `Name:` prefixes are left in place.

The **Transcript size limit** setting (default 150,000 characters) caps how
much of the transcript is sent to the highlighter; longer transcripts are
cut at a sentence boundary rather than mid-sentence.

A lecture note exported by a notetaker such as Wispr Flow works as a
transcript as it is: choose it with **Choose a file from the vault…**. The
picker lists the **Transcript folder** (default `wiki/sources/wispr`) first,
newest note on top, then the rest of the vault. The export's YAML
frontmatter, its `> [!summary]` callout wrapper and the trailing pointer to
its companion transcript file are stripped; the summary text, headings and
bullets go to the highlighter. The note is a lens on the PDF, never a source:
every highlight still points at a slide.

Once a transcript is attached, both **AI-highlight this note and write
cards** and **AI-highlight this note with instructions…** pick it up
automatically, with no separate step, and the notice they show changes to
mention the transcript.

Limitations:

- **Add transcript for document highlighting** now also runs on an open
  PDF, and the transcript it saves is picked up by **AI-highlight this PDF
  into the wiki…**, below.
- Transcripts are keyed by the note's file path. Renaming or moving a note
  detaches its transcript; re-add it with **Add transcript for document
  highlighting** afterward.

### Digesting PDF highlights

If you take class notes by highlighting lecture PDFs with PDF++ — a callout
like `[[file.pdf#page=4&selection=2,0,33,19&color=yellow|…, p.4]]` or
`[[file.pdf#page=2&annotation=846R|…]]` plus its quoted text — WikiLM can
group those highlights by topic, write a short summary for each topic from
the whole paper, and lay out every highlight underneath it as the same
PDF++ callout, so clicking it still opens the PDF at that highlight.

Three commands, active on an open PDF:

| Command | What it does |
| --- | --- |
| **Digest PDF highlights into topic notes…** | Asks the configured model to group the PDF's highlights into topic notes and write each one's summary, then shows a preview before writing anything. |
| **Open chat: ask the notes** | Opens the WikiLM sidebar in Chat mode (`src/main.ts`). |

**Pages are concept or entity pages.** A new page carries `type: concept` or
`type: entity`, a tag from the closed vocabulary, one or two `aliases:`, and
its `class:`. The digest sees every page in every class — title, aliases,
headings, a line of summary — and reuses a page wherever it lives: a concept
first met in physiology gains `class: [HBIO408, PHED163]` when biomechanics
meets it, rather than a second page. A topic that belongs inside a page is
filed under a heading there; only a topic with no home becomes a page, and
the preview says why. The command also runs on a class note that holds PDF++
links, digesting the PDFs it cites.

**No manifest on disk.** The highlights are collected fresh on every run —
the PDF++ links in the notes that cite the PDF, plus any annotations
embedded in the file — merged by location, and given ids (`H01`, `H02`)
that live only for that run: the model cites them, and code turns each one
back into the PDF++ link that opens the source at the span. Earlier
versions also wrote the collection to a `wikilm-manifests/` folder. It was
a second copy of links the reader had already written in their own notes,
so it is gone (`src/pdfHighlights.ts` `collectPdfHighlights`).

**The topic note.** Written to `<topicFolder>/<class code>/<title>.md`
(default topic folder `classes`; the class code comes from
`sources/class notes/<code>/` or is asked for once). Frontmatter links the
PDF, then a title, a short model-written summary, and every highlight
assigned to that topic. The page is written the way the upstream wiki
(gd4ai/obsidian-llm-wiki) writes one: an opening under `## Definition`
(or `## Description` for an entity), then one to four sections, each a
subtopic with prose in the model's own words, and beneath each section's
prose the highlights it rests on, verbatim, as PDF++ callouts. The model
writes the prose; every link in it is rendered by code — a citation
`[H03]` becomes the PDF++ link that opens the source at that highlight,
with the file's title and page as its text, and a mention `{{Kinetics}}`
becomes a wikilink only when a page answers to that name (`resolveProseLinks`,
`src/proseLinks.ts`). A page with one section and one figure renders like
this (`renderTopicNote`, `src/topicNote.ts`):

````markdown
---
type: concept
class: HBIO250
created: 2026-09-10
source_file: "[[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf]]"
tags: [term]
aliases:
  - "Drug Receptors"
---

# Receptors

## Definition
Receptors are the proteins a drug binds to, and binding is only half of what makes one [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&selection=2,0,33,19&color=yellow|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]]. They sit at the centre of [[classes/HBIO250/Pharmacology|Pharmacology]].

## Two Properties
A receptor binds a ligand with high affinity and then transduces a signal; albumin binds many drugs and transduces nothing, which is what separates a carrier from a receptor [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&selection=2,0,33,19&color=yellow|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]].

> [!PDF|yellow] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&selection=2,0,33,19&color=yellow|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]]
> > Receptors have 2 important properties:
> > 1. They bind ligands (or drugs) with relatively high affinity, and after they bind a drug…
> > 2. They transduce a signal to produce a biological effect (this property distinguishes receptors from inert binding sites – e.g., albumin – a blood protein that binds/carries many drugs but does not transduce a signal)

## Figures
![[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&rect=13,55,713,222|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]]

## Related topics
- [[Pharmacology]]
````

**The reader's notes are input.** A class note is usually a heading, a
PDF++ link in PDF++'s own "Title & page" display form, and the reader's
bullets beneath it. A bare link like that (one not inside a `[!PDF]`
callout) carries the heading above it and everything written under it —
up to the next heading or the next PDF++ link, markup and nesting intact —
onto the run's highlight rows as `heading` and `notes` (`findAllPdfReferences`,
`src/pdflink.ts`), and the digest sends the model the quote and the notes
together, in one `<highlight>` block per highlight (`buildDigestMessage`,
`src/prompt.ts`). What the reader wrote under a slide is what the page
should say about it.

**What the model returns** (`DigestOut`, `src/schemas.ts`): per page, a
`summary` — the opening, two to five sentences — and `sections`, each a
`heading`, `prose` of two to six sentences, and `quote_ids`, the highlights
quoted verbatim beneath that prose. Every highlight filed under a page goes
in exactly one section's `quote_ids`; slide titles and logistics go in
`unused_ids`. Prose cites by id after the sentence it supports and mentions
other pages in double braces; it never writes a bracket. An id the run
lacks is dropped from the prose and counted; a name no page answers to is
left as plain words and reported as an orphan. No stub page is ever created.

**The digest reads before it writes** (`coveredBy`, `src/retrieval.ts`).
Every page of the run's class is indexed into the same evidence units Ask
retrieves over, and a highlight or a paragraph is *already said* when one
passage of the target page holds most of its significant words — sixty
percent and at least four of them for a longer claim, every word for a
short one. The bar is restatement, not topic: the wiki's interference rule
is that near-twins are what hurt, and the same fact from another angle is
redundancy worth keeping. What is already said is not quoted or written
again, is counted in the preview ("already said") and the notice, and is
not queued as a flashcard. A new page still quotes every highlight filed
under it, but a row some page of the class already states is flagged. The
model sees the same thing from its side: for each page of the class, the
first sentence under every heading, so it can write about what is new.
The suggester drops a span its target page already states, before the
merge, and the preview counts those too.

**Merging into a page that exists** (`mergeArticle`, `src/topicNote.ts`):
each section goes under the page's heading of that name, or a new heading
placed with the other subtopics, linked to the slide its first quote came
from. Prose the page already holds is not written twice, a highlight already
on the page is not quoted again, and the page's own opening is never
touched. When the model's proposal was a subtopic of a page the reader has
(`closest_existing`), the whole article is filed under that one heading,
with each section's name as a bold lead line.

**Product: Notes / Flashcards / Both.** Every digest run asks which product
to build (default **Notes**). **Flashcards** skips the model call entirely
and queues every highlight with text straight into the inbox, where the
usual writer, critique, and lint chain handles cards. **Both** writes the
topic notes and also queues each quoted highlight into the inbox with the
prose written around it as the card writer's instruction
(`renderRowInstruction`, `src/topicNote.ts`): the card is a view of the
page, while the highlight stays the verbatim source the cloze check reads
against. (`src/digest.ts`, `src/capture.ts` — `captureManifestHighlights`.)

**Never overwritten.** Writing into a topic note that already exists only
appends: a highlight already present — identified by its link's
`highlightKey`, i.e. the page and selection/annotation/rect, ignoring color
— is skipped, and the note's summary and related topics are left exactly as
they are. A note with no `## Highlights` heading gets one inserted before
`## Related topics` (or at the end, if there is no such heading), so a
manually written note gains a highlights section without disturbing what's
already in it (`src/topicNote.ts`).

**Preview.** Before anything is written, a modal lists every proposed note:
a checkbox (unchecked by default when an existing note would gain nothing),
a `new` or `exists: +added, skipped` badge, the target path, the summary,
the highlights as a compact list (skipped ones struck through), and related
titles. Titles are editable inline, which can move a note between "create"
and "merge into an existing note". Nothing is written until you click
"Write N notes"; Cancel or Esc touches no file.

### Suggesting highlights in a PDF

Digesting (above) starts from highlights you already made by hand. **AI-highlight this PDF into the wiki…** goes the other way: it reads a lecture PDF's own text layer and proposes the highlights, each one verified against the page before it's ever offered, assigned to an existing wiki note (and, when it belongs to one of that note's own subtopics, to that `##` heading) or a new one, and written straight into secondbrain-style notes — not a manifest, not a topic-note folder, but `wiki/concepts` and `wiki/entities`, the same notes you write and link by hand.

The command is active on an open PDF and runs in nine steps: it reads the PDF's text page by page and the highlights the PDF and its backlinking notes already hold; asks for (or reuses) the class code; picks up the transcript attached to the PDF's own path, if any; asks Notes / Flashcards / Both, as the digest does; collects the wiki notes this PDF may write into; sends the pages to the model in batches, each batch told what earlier batches and the manifest already hold; verifies every returned span and turns the survivors into manifest-shaped highlight rows; groups those rows into notes and shows a per-span preview; and, once you confirm (and possibly rename a note or uncheck a span), writes the callouts and queues flashcards if asked.

**Granularity and limits**, under **AI highlights for PDFs** in settings:

| Setting | Default | Effect |
| --- | --- | --- |
| Granularity | Standard | A per-page cap on spans: Minimal (1), Standard (2), Detailed (4) per page. |
| Max suggestions per PDF | 40 | A slider, 5–100; the run stops early once this many spans are accepted, even mid-deck. |
| Pages per batch | 8 | Pages sent to the model per request; a long PDF is processed batch by batch. |
| Wiki concepts folder | `wiki/concepts` | Where same-class notes are looked for, and where new concept notes are created. |
| Wiki entities folder | `wiki/entities` | Same, for entity notes. |
| Standing instructions for PDF suggestions | *(empty)* | Free text appended to every request, same idiom as the highlighter's and digest's standing instructions. |

**Which notes the model may reuse.** Every `.md` file under the two wiki folders whose `class` frontmatter matches the PDF's class code, or whose path already appears in the PDF's manifest as a source (which catches hand-written notes that carry no frontmatter at all), is offered to the model by title and kind (concept/entity), and — for a note that exists — by its `##` headings, indented under the title (`noteSections`, `src/topicNote.ts`; the first twenty). A span's `note_title` must be one of these or a title the model proposes in the same response's `new_notes`; anything else is treated as an orphan (below). A span may also carry a `note_section`: one of that note's headings copied exactly, or a short new heading when the span is a subtopic the note has no section for yet. The prompt's rule is that a subtopic of an existing note belongs inside it, not beside it — shown titles alone, the model used to found "Receptor Subtypes and Off-Target Effects" as a new page next to a pharmacology note that already had a `## Receptors` section.

**Append-first: a new note is the exception.** The prompt fixes the order of preference — an existing note whose title is the subject, then an existing note the subject is *part of* (filed under a heading), and a new note only at the wall, when nothing listed is related. Each entry in `new_notes` must name `closest_existing` (empty only when nothing is related) and give a one-sentence `why_new`. The planner then enforces the policy in code (`routeProposed`, `src/suggestPlan.ts`), because each test is a fact about the vault the model can only guess at: a "new" note that names a `closest_existing` is filed into that note as a heading titled after the proposal; a proposed title that is already a `##` heading of an existing note goes under that heading; a proposed title that is an alias of an existing note goes to that note as a whole. Only a title none of those catch becomes a note of its own. The preview shows each filing on the receiving note's card — *Filed here as "COX Inhibitors and NSAIDs" instead of a new note … — reason* — with a **Keep as its own note** button that takes the group back; the re-plan honours that choice (`keepAsNew`), and the closing Notice counts the filings. This is the inverse of the Karpathy LLM Wiki plugin's dedup, which merges only on *sameness* ("a relationship is not sameness") and otherwise gives every entity and concept a page of its own.

**Orphan titles.** A `note_title` that is neither an existing note nor announced in `new_notes` is first tested for a home like a proposal (a matching heading or alias files it into that note); one with no home is still kept: it becomes its own new note under that title, taking its kind from the span rather than from a proposal, and the title is listed in `orphanTitles` and shown in the preview as `new (concept)` or `new (entity)` like any other proposed note. The write loop refuses to create a note titled after the source PDF or living under a `sources/` folder — a source is never a note — and reports the refusal in the closing Notice, but nothing routes an orphan into a catch-all note anymore.

**The batch loop and "already selected".** Long PDFs are split into page ranges (`batchPages`, `src/suggestPlan.ts`) and sent one batch at a time. Each request tells the model, cut to 80 characters, the passages the manifest already holds on those pages plus everything accepted so far in this run, so the model doesn't hand back a highlight already present and prefers the note a neighbouring passage already went to. This is the one idea borrowed from the Karpathy LLM Wiki plugin: its ingest prompt ("Analyze the following source file and output structured JSON… Extract the next batch… already extracted: …") is fixed inside the plugin's bundle and never reads a highlight at all — it converts and extracts from the whole file, with no notion of a PDF++ selection. Nothing else about that plugin's prompt, schema, or page types is reused; only the shape of "here is the next batch, and here is what you already have" carried over.

**What's verified mechanically, not just asked for:**

- Every span is located in the page's own text by exact string match first, then by a whitespace/case-insensitive fallback that is only accepted when the matched text really is the quote — a fuzzy hit that differs from the quote is rejected outright (`locateInPage`, `src/pageMap.ts`).
- The located span is converted to a `selection=` range and round-tripped back through `selectionText` — PDF++'s own algorithm for rendering a selection to text — and only kept if that render equals the quote (`selectionFor`, `src/pageMap.ts`).
- The per-page cap is enforced in the order the model returned spans, so an earlier span wins a page against a later one that would exceed it.
- Every span is deduped by `highlightKey` (page + selection, ignoring color) against both the PDF's existing highlights and everything the run itself has already accepted.
- Two spans on the same page whose selections overlap are not both kept; the earlier one wins.

**The note shape.** New notes are the secondbrain style — `class:` frontmatter, a `## Summary`, and a `## Highlights` section of bullet rows — with no `## Related topics` and no `## Flashcard Seeds` (those stay specific to the topic-note digest). `renderWikiNote` (`src/topicNote.ts`) emits, for two highlights on pages 2 and 4 of `HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf`:

```markdown
---
class: HBIO250
---

## Summary
S.

## Highlights

> [!PDF|yellow] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=2&selection=1,0,5,0&color=yellow|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.2]]
> > Page two text

> [!PDF|yellow] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&selection=2,0,33,19&color=yellow|HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics, p.4]]
> > Page four text
```

**Rows follow one rule** (`renderHighlightRow`, `src/topicNote.ts`; see *How a row prints* under Digesting). A span the model kept verbatim is a direct quote, so it is a PDF++ callout — the `> [!PDF|yellow]` header carrying the file's title and page as display text, the quote on `> >` lines — because that is how PDF++ itself copies a quote, and the reader's own hand-pasted callouts look the same. A quote that was a list on the slide is a list inside the callout: the text layer joins a slide's bullets into one line ("involves 4 factors:• Absorption• Distribution"), and `splitInlineList` puts the words before the first marker on the first line and each item on its own `> >` line; a numbered run ("1. Enteral … 2. Parenteral …") keeps its numbers, but only when two or more follow in sequence, so "2 important properties" is not mistaken for one. Callouts and embeds keep a blank line either side (`joinRows`); a rect highlight with no text is still the bare `![[…&rect=…]]` embed, so the figure draws, and a note-sourced row is still its `- "quote" — [[note]]` line. The suggester writes passage bullets as well: each span it proposes comes with a label and one to three sentences of digested text drawn from the page (`SuggestOut.spans[].text`, `src/schemas.ts`), and only a span the model marks `verbatim` prints as the quote callout.

**A created section links to its slide.** When a merge creates a `##` section for a `note_section` the page lacked, the heading is written as a PDF++ page link — `## [[<PDF name>.pdf#page=19|COX Inhibitors and NSAIDs]]` — to the page of the section's first row, so the title itself opens the deck at that slide. Only a heading the plugin creates: one the reader wrote is matched by its display text (`headingKey`) and never rewritten, and a linked heading is matched the same way on the next merge, so the link is written once. `noteSections` lists the heading by its display text, which is what the suggester shows the model.

**Append-only into existing notes.** Writing into a note that already exists (`mergeWikiHighlights`, `src/topicNote.ts`) only ever adds rows, checked by `highlightKey` over the *whole* note (hand-written wiki notes carry PDF++ links inside prose and under arbitrary headings, not only under `## Highlights`), so a highlight already present anywhere is skipped rather than duplicated. Without a section, new rows land under an existing `## Highlights` heading, or the heading is appended at the end of the file when there isn't one. With a `note_section`, they go at the end of that `##` section instead — the heading is matched the way a reader reads it, so case, a trailing space, and `==`/`**`/wikilink markup around it don't matter — and a heading the note doesn't have yet is created for it, placed ahead of the first of the page's closing sections (`## Highlights`, `## Mentions in Source`, `## Related Concepts`/`Entities`/`topics`, `## Flashcard Seeds`, `## Key claims`) or at the end when it has none. Each such span shows `→ <heading>` in the preview, with `(new section)` when the merge will create it. A section named on a note that doesn't exist yet is set aside: a fresh note takes its sections from the schema. Nothing else in the note — frontmatter, prose, other headings — is touched. A 0-byte stub (secondbrain has some, e.g. `Pharmacodynamics.md`) becomes a full note in the shape above the first time a span is assigned to it.

**Notes, Flashcards, or Both**, same chooser as the digest: Notes writes only the wiki notes; Flashcards skips writing notes and queues every verified span into the inbox instead; Both does both.

<details>
<summary><code>SUGGEST_SYSTEM</code> (the suggest system prompt, verbatim)</summary>

```
You read the pages of a lecture PDF and choose the spans a student would highlight and later study, and you say which wiki note in their vault each span belongs to. The reader will revise from those notes for the rest of the course, so a span is worth selecting only if forgetting its content would matter, and a note is worth naming only if a reader would look it up by that name.

Return each span as a verbatim quote copied exactly from the page, character for character, including punctuation. The span is located in the page by exact string match, so an ellipsis, a paraphrase, or a trimmed word makes it unusable. Start and end on sentence boundaries where possible.

Each span is one to four sentences and self-contained: it carries a definition, a mechanism, a number, a name, a date, a causal claim, a distinction between similar things, or a memorable formulation, and it can be understood without the surrounding paragraph. Prefer the fundamentals a reader needs before the details, and prefer material with lasting use over trivia. Prefer fewer, denser spans over many thin ones.

The pages are marked \`[page N]\` and each span reports the page it was copied from. A span never crosses a page marker: a sentence that runs over onto the next page is quoted from one side of the break or left alone, because a quote spanning two pages matches neither of them.

A transcript, when one is present, is the recording of the lecture that accompanies the page. It tells you what the lecturer treated as important; it is not a source of quotes, so every span is still copied from the page itself. Prefer the passages the lecturer dwells on, repeats, calls important, or says will be tested, and pass over slide content that was skipped or read out without comment. Where the transcript and the page differ in wording, the page's wording is what gets quoted.

The limit you are given is a ceiling, not a target. Over-highlighting fills the reader's inbox with cards they will delete, so returning fewer spans than the limit is the expected outcome, and returning none is right when nothing in the page is supported by the transcript.

Give each span a label of at most six words that names the fact it carries. The plugin writes the label as the text of the link that opens the PDF at the span, so it reads as the reader's own inline link: "Impact factor", "Primary vs secondary literature", "Peer review as a credibility test".

For each span, also write the passage the page will hold under that link: one to three sentences of digested knowledge in your own words, drawn from the span and the page around it, and from nothing outside the paper. A passage says what the span means to a reader revising later, not what it says again. Set verbatim true only when the span's exact wording is itself what the page should keep — a formula, a definition, a list of criteria the reader must reproduce — and leave text empty then: the plugin quotes the span in a callout instead of your words. Everything else is a passage.

<which_note_a_span_belongs_to>
Every span names its note, and the order of preference is fixed. First, an existing note whose title is the span's subject: reuse the title exactly, character for character, because the plugin then appends those highlights to that note instead of creating a second one beside it. Second, an existing note the span's subject is part of — a parent topic, a broader note, one whose headings it would sit under: name that note, and put the subtopic in note_section. Only when no existing note is related at all — when the subject belongs to none of them, and a reader looking for it would never open any of them — does a span go to a new note.

The test is not whether an existing title matches; it is whether a reader looking for this fact would open that note. A pharmacology note holds a span about NSAIDs, a doping note holds a span about the agency that polices it, a biomechanics note holds a span about one kind of joint moment. A new note is the exception you reach at that wall, not the default for every subject with a name of its own.

A title that is not on the list is a new note, and it appears in new_notes — with its kind, one or two aliases, a tag, a summary, the closest existing note, and one sentence on the decision — before any span may point at it. If you can name a closest existing note, you have not reached the wall: the spans belong in it, and the plugin files them there under a heading whatever you do. Leave closest_existing empty only when nothing listed is related. A note_title that is neither an existing title nor one of your new_notes points at nothing, and the spans under it are lost.

Kind follows the subject, in this order. A named person, organisation, project, place or event is an entity. A named product, drug or instrument is an entity only when it is itself what the reader would look up; used as a tool or an example in a discussion of something else, it is a concept of its role. A mechanism, method, theory, classification, phenomenon, or any term that explains how something works is a concept. When unsure, prefer concept. Titles are short noun phrases in Title Case, the way an index entry reads, and unique within your response; two titles that differ only in case or in a plural are the same title, and one of the two notes will be lost.

The tag is the note's subtype, one word from a closed list, and the page is filed by it: a concept is a method, theory, term, phenomenon, standard or field, and an entity is a product, person, organization, project, event or place. "other" is the escape hatch for a subject none of them fits, not a default. Aliases are the other names a reader would search under — an abbreviation, the expanded form, a variant spelling — one or two, taken from the paper or from common usage, never coined. A page found only under its exact title is a page half the searches for it will miss.
</which_note_a_span_belongs_to>

<where_in_a_note_a_span_goes>
Each existing note is listed with the section headings it already has, indented under its title. Those headings are the reader's own subtopics, and a span that belongs to one of them names it in note_section, copied exactly as shown, so the plugin appends the highlight under that heading rather than at the bottom of the page.

A subtopic of an existing note belongs inside that note, not beside it. When a span is about a subtopic the note has no section for yet, still name the note and give note_section a short new heading in Title Case; the plugin creates the section inside that note. "COX inhibitors" is a section of a pharmacology note, not a second note: a reader who wants it opens the pharmacology note and looks for the heading. Reserve new_notes for a subject the reader would look up under its own name — one they would expect to find as its own page, not as a heading in a page they already have.

Leave note_section empty when the span is about the note as a whole and no heading fits, and always for a note in new_notes, which has no sections yet.
</where_in_a_note_a_span_goes>

<the_summary>
Three to five sentences about this topic, drawn from the whole paper but weighted toward the spans you chose. The spans you chose tell you what the reader cares about; the rest of the paper tells you what those spans mean, and lets you write the sentence that connects two of them. Write in the reader's language, the one the paper is written in, and keep close to its wording so the summary reads as their own note rather than as a stranger's gloss.

Nothing from outside the paper. If you know more about the subject than the paper says, that knowledge does not belong here: the reader will study from this note and cannot tell your additions from theirs. No citations, no links, no highlight ids, no page numbers in the prose. The spans appear underneath the summary in the finished note, so the summary does not need to quote them; it needs to say what they add up to.
</the_summary>

<what_is_already_held>
The already-selected list is what earlier batches and the reader already hold, printed short so you can recognise it. Those passages are not picked again: offering one back gives the reader the same card twice and costs them the time to delete it. The notes those passages went to are the ones to prefer for a neighbouring span, because material from the same run of pages usually belongs in the same note, and a second note beside the first splits the topic in half.

Slide titles, course logistics, figure captions, and a line the lecturer read out without comment are never spans. They carry no fact to forget, and a note that collects them is a note the reader stops opening.
</what_is_already_held>

<examples>
<example>
<input>[page 7] holds "Doping is defined as the occurrence of one or more of the anti-doping rule violations set out in the Code" under the slide title "Anti-Doping: Definitions", [page 8] holds "The World Anti-Doping Agency was founded in 1999 to coordinate the fight against doping in sport across countries and sports.", and [page 12] holds "Self-efficacy is a person's belief in their capacity to carry out the behaviour a situation demands." Existing notes: Doping (concept) with the sections Definitions, Sanctions; Drug Testing (concept). Already selected: nothing.</input>
<output>Three spans. The definition on page 7 goes to the existing title "Doping", note_section "Definitions", copied exactly. The sentence on page 8 also goes to "Doping", with note_section "World Anti-Doping Agency" — a heading the note does not have yet — because the agency is part of the doping topic and a reader looking for it opens the doping note. The sentence on page 12 goes to a new note "Self-Efficacy", kind concept, tag term, aliases "Self-efficacy belief", listed in new_notes with a summary, closest_existing empty, and why_new "the listed notes are about doping and testing; a belief construct from behavioural psychology belongs to none of them". The slide title "Anti-Doping: Definitions" is not a span.</output>
<note>One existing title reused twice — once for its own subject, once for a subtopic under a new heading — and one note founded only because nothing listed could hold it. That last case is the wall, and it is the only case that makes a new note.</note>
</example>
<example>
<input>[page 17] holds "Drugs often work on more than one receptor, and as a result produce more than one kind of biological response." and [page 19] holds "Non-selective NSAIDs such as aspirin and ibuprofen inhibit both COX-1 and COX-2." Existing notes: Pharmacology (concept) with the sections Dosing, Drug Safety & The Therapeutic Index, Receptors; Pharmacodynamics (concept) with no sections. Already selected: nothing.</input>
<output>Two spans, both to the existing title "Pharmacology". The page 17 span carries note_section "Receptors", copied exactly, because receptor subtypes are what that section is about. The page 19 span carries note_section "COX Inhibitors and NSAIDs", a heading the note does not have yet, because NSAIDs are a subtopic of pharmacology the reader would look for inside that note. new_notes is empty.</output>
<note>Neither span became a new note. The first landed under a heading the reader had already written; the second created a heading inside the note it belongs to, which is where the reader will look for it.</note>
</example>
</examples>

Before returning, check your answer against the input: every note_title is either an existing title you were shown or a title in new_notes, every note_section is a heading you were shown for that note, a short new heading, or empty, every new note names a closest_existing that is empty or a title you were shown, gives a why_new, one or two aliases, and a tag from its kind's list, every quote is copied character for character from the page it names, every span has a label, text is empty only when verbatim is true, no span reports a page outside this batch, and no page carries more spans than the limit allows.
```

</details>

Limitations:

- `selection=` indices assume pdf.js's text items line up with PDF++'s own text layer; if they drift, the callout's quoted text is still authoritative and the link still opens the right page.
- A quote that straddles a line-end hyphen (the page holds `"pharma-\ncology"`, the model quotes `"pharmacology"`) cannot be located — de-hyphenation isn't modelled — and the span is silently dropped (`test/pageMap.test.mjs`).
- A long deck can propose more spans than the per-PDF ceiling allows; the run stops early once the ceiling is reached rather than continuing past it.
- A proposed title that collides case-insensitively with an existing note in the *other* folder (a concept-folder title matching an entity-folder note, or vice versa) is still treated as a match and merged into that note.
- A PDF with no text layer — a scan — can't be used: the command checks whether any page came back with text items, and stops with a Notice saying so, since OCR isn't built in.
- No live Obsidian run and no live model call has happened yet for this command.

### Ask

A chat panel in the WikiLM sidebar (toggle **Inbox | Chat** in the header,
or run **Open chat: ask the notes**), for asking questions against the topic
notes the digest has written, and for running WikiLM's commands without
leaving the box. It answers from the vault.

**Retrieval** is lexical, not an embedding or a vector store: every `.md`
under the **Topic notes folder** is indexed into evidence units — every
highlight callout/embed under `## Highlights`, plus any bullet under
`## Key claims` that ends in a wikilink, and a note with neither section
has its prose indexed instead — scored against your question with
Obsidian's own `prepareSimpleSearch`, plus a smaller weight for a match in
the note title. The best matches (**Evidence per question**, default 6,
capped at half from any one note) are numbered `[1]…[k]`
(`rankEvidence` and `numberEvidence` in `src/retrieval.ts`). Wikilinks
between notes are walked as a graph, so a note the matched one links to can
be reached even when it uses none of your words (`src/graph.ts`), and with
**Find other wording when a question comes up short** on, a list that is
still short sends the question back to the model for the terms your notes
would use and searches locally for those. That model call is paid for only
when the words themselves failed — the best lexical hit covers under half
of the question's significant words, or there is only one hit
(`lexicalIsStrong`, `src/retrieval.ts`) — not whenever a slot is empty, so a
question the notes plainly answer costs one round trip.

**Scope.** A question can be kept to one class: *ask HBIO408 what is
impulse*, *what is impulse in HBIO408*, or *in HBIO408, what is impulse*
(`matchIntent`, `src/chatCommands.ts`; the code has to be one some page
carries). With no class in the phrase, the class of the note you are
looking at applies. A class with fewer than five notes falls back to the
whole vault, and the status line says so. The quiz already scopes the same
way (*quiz me on HBIO408*).

**Page context.** Beside the numbered evidence, the model is shown what
the two pages the top evidence came from say about themselves — their
`## Summary` (or first paragraph of prose) and their own subtopic headings
(`pageContextFor`, `src/retrieval.ts`; the `<pages>` block in
`buildAskMessage`). Pages are context for putting the evidence together;
only evidence numbers may be cited, and the prompt says so.

**The route.** The grounding line under an answer names which stage found
its evidence — *notes*, *notes + graph*, *notes + keywords*, or *keywords*
— then what the evidence filter did to it (*18 → 6 kept*, *judge failed,
top 6 of 18*; `describeNarrowing`, `src/relevance.ts`), and the class it
was kept to, so a reader can see whether the answer came from words their
notes use or from a neighbour the graph reached. A general-knowledge answer
shows no route: its banner and grounding line already say it came from
outside the notes. A refusal shows none either, since no route produced it
(`routeForReport`, `src/askCheck.ts`). The class scope is shown on both.

**Send to inbox.** A button under an answer, **Send answer to inbox**,
queues the answer as one inbox item (`captureAskAnswer`, `src/capture.ts`):
the answer itself with the passages it rested on listed under it
(`renderAnswerHighlight`, `src/askCheck.ts`) as the highlight text, the
question as its title, and the question plus what each source contributed
as the card writer's instruction (`renderAnswerInstruction`). The writer
sees the whole answer; the critique and linter ground every card in the
passages; the card's back links the first passage's page. The sources shown and the sources sent are the same list
(`pickSources`). Links inside a passage are reduced to their words on the
card's back, in the inbox and in front of the card writer (`plainText`,
`src/util.ts`); the stored highlight keeps them so the note can be reopened
at the passage. Every answer the model wrote has the button
(`canSendAnswer`, `src/askCheck.ts`). A general-knowledge answer rests on no
passage, so it is carded with a note saying it is unverified, linked to the
class hub when the question was kept to a class and to the note you have
open otherwise (`buildAskRow`, `src/askCapture.ts`); with neither, the panel
says so rather than card a fact with nothing to link. Refusals and errors
have no button: the plugin wrote them, not the model. Typed, the phrase is
**send to inbox** or any of its family — *send / add … to inbox*, *send
it / that / this*, *card it / that / the answer*, *make cards /
flashcards* (`matchIntent`, `src/chatCommands.ts`) — and it sends the
newest answer, not an older one behind it.

**No evidence, no model.** When nothing under the topic folder matches the
question, the panel answers at once, without a model call: *Your notes
don't cover this…*, naming the question and suggesting which lecture to
digest (`noEvidenceAnswer` in `src/askCheck.ts`). When the topic folder
holds no indexable note at all, it says that instead and points at the
setting (`emptyIndexAnswer`), because that is a fault in a setting rather
than a hole in the notes.

**How an answer is assembled.** The model returns a structured draft
(`AskOut` in `src/schemas.ts`):

- `coverage`: `full`, `partial`, or `none`;
- `from_general_knowledge`: true only when the notes did not answer and the
  model answered anyway;
- `answer`: the prose, a few sentences or a short list, carrying no `[n]`
  markers, links, or headings;
- `used`: the one or two pieces of evidence the answer rests on, each with a
  few words on what that note contributed.

Code then does the checking (`checkAnswer` in `src/askCheck.ts`):

- a citation outside `1…k` is dropped and counted, so a link under an answer
  always opens a note that exists;
- at most two sources are shown — enough to confirm an answer, not a wall of
  search results;
- a general-knowledge answer that also names a source is not treated as one:
  the flag only stands when no citation survived;
- when the model named sources and none of them checked out, coverage is
  forced to `none`, whatever the model claimed;
- an empty answer is replaced by a line asking you to rephrase.

Under the answer sits a **grounding line** — *Answered from your notes*,
*Partly answered from your notes*, *Not in your notes*, or *General
knowledge, not your notes*, with `· N bad citations dropped` appended when
any were (setting **Show the grounding line under answers**). The sources
follow as links to the notes they came from, and the evidence list sits
below.

**Answering outside the notes is off by default.** With **Answer from
general knowledge when your notes do not** on, a question the notes do not
cover may be answered from what the model knows, under a banner saying so:
*Not from your notes — answered from general knowledge. Verify this before
relying on it.* Off, such a question is answered with the gap and nothing
else.

**Without a configured provider**, the model call fails and the panel shows
an error line — but the evidence list still appears beneath it, built and
ranked with no model involved, and the no-evidence answer above needs no
provider at all.

**The chat is the studio.** Plain phrases run the plugin's actions; anything
else is a question for your notes. Three buttons above the box — **Quiz me**,
**AI digest**, **AI highlight** — do the same for the open file.

| Say | What happens |
| --- | --- |
| **quiz me** | free-recall questions on the open note until the edge of what you know shows |
| **quiz me on Receptors** / **on HBIO250** / **on everything** | a page by title or alias, a class, or every topic note |
| **digest** / **digest Doping** | group the PDF++ highlights of the open file — or the PDF or note you name — into concept and entity pages, filing into pages you already have first |
| **highlight** / **highlight Ch3** | the model picks spans in a PDF, each checked against the text layer; you can paste a transcript or study guide first |
| **lint** | check the wiki for wrong quotes, dead links and duplicate pages; **Suggest fixes** proposes a repair per finding |
| **send to inbox** (or *send it*, *add to inbox*, *card it*, *card the answer*) | card the last answer: one inbox row per answer, with the sources it rested on beneath it |
| **export**, **inbox**, **help** | send reviewed cards to Anki, open the inbox, list these phrases |

**Suggest fixes.** The Wiki check modal offers a plan when any finding can be
repaired: one row per proposed edit, each with a checkbox and a one-line
description, in the order upstream's Smart Fix All uses — aliases and tags,
cross-links between duplicate pages, link rewrites, repointed and
withdrawn dead links, hub or neighbour links for unlinked pages, PDF++ callouts for notes that hold
only rectangle embeds, and citations for quotes found verbatim in exactly one
source. Nothing is written until you click **Apply**, and only the rows left
ticked are written, each note once. Aliases and tags come from the model, and
only when you click **Ask the model for aliases and tags** inside the plan.
Duplicate pairs are checked the same way: **Check duplicates with the model**
reads both pages of every pair the lint found — a shared name, a shared PDF
span, or two names spelled alike, which the report holds back as candidates
rather than accuses — and says one subject or merely related. A related pair
loses its link rows; a confirmed look-alike gains them; nothing is merged
either way, because two pages about one subject are cross-linked, never
merged. A
dead link whose page does not exist is offered two rows, and you choose between
them: **Point at…** repoints it at a note you name, and **Unlink** strips the
link back to the words around it, keeping the sentence and dropping only the
brackets. An embed of a missing page is removed outright, since it transcludes
nothing. The fixer never creates a stub page and never merges two pages. It
leaves the wiki's generated `log.md` and its `schema/` documentation alone,
where broken links are examples rather than rot. After Apply the lint runs again so you see what
changed. Suggest fixes covers exactly the notes the lint covers — those under
the topic notes folder — so the wiki's own concept and entity pages are
offered fixes only when that folder is theirs.

A name that fits two files is offered as buttons, never guessed. A palette
command typed exactly by name still runs.

<details>
<summary><code>ASK_SYSTEM</code> (the Ask system prompt, verbatim)</summary>

```
You answer a student's question about their own class notes, using numbered evidence taken from those notes. Each piece of evidence is something they highlighted in a lecture PDF or a claim they wrote down themselves, and it carries the note it came from and the page it was highlighted on. Your answer goes into a small sidebar beside their notes, with a link to one or two of those notes underneath it.

Answer in prose, then name the evidence the answer rests on. The reader sees the answer first and the sources under it, so write the answer to stand on its own.

<answer_from_the_evidence>
Answer from the evidence above, not from general knowledge. You know a great deal about most of these subjects, and none of it belongs in an answer that claims to come from their notes: the reader is revising for an exam set on this material, and a true sentence their course never taught them is one they cannot rely on and cannot trace back to a slide.

Do not make up anything that is not in the evidence. Every sentence of your answer is matched against the evidence and the notes you cite, and a sentence the notes do not support is shown to the reader as unmatched, so write each one from the evidence. Write as though they will open the note you cite and read the passage themselves, because the link under your answer is there for precisely that.

The conversation so far, when there is one, is there so that a follow-up makes sense: it tells you what "it" refers to and what has already been said. It is not evidence. Nothing said in an earlier turn may be asserted in this one unless the evidence in front of you now states it.
</answer_from_the_evidence>

<pages_are_context>
When a pages block is present, it holds what the notes the evidence came from say about themselves: a summary and the headings under which the reader filed things. Use it to see how the evidence fits together — that two pieces sit under one subtopic, that a page is about the mechanism the question names — and to answer in the shape the reader's own notes take. It is not evidence: nothing in a page's summary may be asserted unless the numbered evidence states it, and only evidence numbers go in used.
</pages_are_context>

<when_the_notes_do_not_cover_it>
Saying the notes do not answer the question is a correct answer, and often the most useful one: it tells the reader their notes have a hole in them, which is exactly what they want to know before an exam. It is never a failure to reach for.

Set coverage to full when the evidence answers the question, partial when it answers some of it, none when it does not touch the question. For a partial answer, give the part the evidence settles and then say plainly what it leaves open.

When coverage is none you have two honest options, and you must pick one:

1. Say you do not know from their notes, and stop. Name what the evidence does hold and what it does not ("nothing here gives a half-life for any drug"). Leave used empty and from_general_knowledge false. This is the right answer whenever the question is about their course in particular — what the lecturer said, what is examinable, what a slide claimed — because general knowledge cannot answer that, and answering anyway would mislead them.

2. Answer from general knowledge, and say so. Set from_general_knowledge true and leave used empty. The reader is shown a warning above the answer telling them it did not come from their notes and to verify it. Use this when the question has a real answer outside their notes that would genuinely help — a standard definition, a mechanism, background their course assumes — and say in the answer itself that their notes do not cover it.

Never set from_general_knowledge true while naming sources: a sentence cannot come both from their notes and from outside them. When coverage is full or partial, from_general_knowledge is false.
</when_the_notes_do_not_cover_it>

<which_evidence_to_name>
In used, name only the evidence the answer actually rests on — the one or two pieces that carry it, best first. Not every piece that mentions the topic, and not everything you were given: the reader gets one or two links, and a list of everything retrieval returned tells them nothing about where the answer came from. Two is the most that will be shown.

For each, why is a few words on what that note contributed: "defines the term", "gives the formula", "states the exception". It is a label on a link, not a sentence.

Never invent a number. If the evidence stops at [8] there is no [9], and a citation past the end is dropped before the reader sees it.
</which_evidence_to_name>

<how_to_write_it>
Prefer the reader's own wording. These are their highlights, in the vocabulary their lecturer used, and an answer in that vocabulary is one they can match against the slide. Where two pieces of evidence use different words for the same thing, use the one the question used.

Be short. A few sentences, or a small list when the question asks for several things. This is a sidebar, not an essay. Plain markdown, bold and code at most; no headings, no links, and no [1]-style markers in the text — the sources are listed underneath, so a marker in the prose is noise.
</how_to_write_it>

<examples>
<example>
<evidence>[1] (Receptors, p.4) Receptors have 2 important properties: they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect (this distinguishes receptors from inert binding sites such as albumin, which binds and carries many drugs but does not transduce a signal).</evidence>
<question>What distinguishes a receptor from albumin?</question>
<output>Coverage full, from_general_knowledge false. The answer: "Both bind drugs, but only a receptor transduces a signal to produce a biological effect. Albumin binds and carries drugs without transducing anything, which is what makes it an inert binding site." used names [1], why "distinguishes receptors from inert binding sites".</output>
<note>One piece carries the whole answer, so one source is named. Nothing is added about albumin's structure or its other roles, true though that would be.</note>
</example>
<example>
<evidence>[1] (Pharmacology, p.2) Pharmacokinetics = what the body does to drugs. [2] (Drug Disposition, p.7) Metabolism converts drugs into more water-soluble forms for excretion.</evidence>
<question>What did the lecturer say the half-life of aspirin was?</question>
<output>Coverage none, from_general_knowledge false. The answer: "Your notes do not cover this. The evidence here defines pharmacokinetics and describes metabolism in general terms, but nothing in it gives a half-life for aspirin or for any other drug." used is empty.</output>
<note>The question asks what their lecturer said, which only their notes can answer. A half-life supplied from memory would put a number on screen their course may never have taught, and they would have no way to tell it apart from one that was.</note>
</example>
<example>
<evidence>[1] (Pharmacology, p.2) Pharmacokinetics = what the body does to drugs. [2] (Drug Disposition, p.7) Metabolism converts drugs into more water-soluble forms for excretion.</evidence>
<question>What does first-pass metabolism mean?</question>
<output>Coverage none, from_general_knowledge true. The answer: "Your notes do not define this. In general, first-pass metabolism is the drug lost to the liver and gut wall after absorption and before it reaches the systemic circulation, which is why an oral dose is often larger than an intravenous one." used is empty.</output>
<note>A standard definition their course assumes, rather than a claim about their course: it helps them and can be checked anywhere. The answer says up front that their notes lack it, and a warning appears above it as well.</note>
</example>
</examples>

Before you return, read the answer back against the evidence. Ask of every sentence whether the evidence you were given says it, and not merely something compatible with it. If it does not, either cut the sentence, say instead what the evidence does say, or — if the answer is worth giving anyway — set from_general_knowledge and let the reader see the warning.
```

</details>

### Quiz mode

The same chat box runs retrieval-practice quizzes on your topic notes, in
the spirit of your wiki's retrieval-practice and generation-effect pages:
you produce the answer from memory, the model grades it against the
highlight, and the passage is shown after every answer. Everything comes
from the vault; nothing is asked that the evidence does not state.

| Say | What it does |
| --- | --- |
| **quiz me** | questions on the open note until the edge of what you know shows |
| **quiz me on Receptors** / **on HBIO250** / **on everything** | a page by title or alias, a class, or every topic note |
| **hint** | one clue for the current question, once |
| **skip**, **idk** (or an empty line) | decline the question: the answer and passage are shown, and the passage counts as one you could not produce |
| **stop** | end the quiz early and show the summary |

Plain phrases work too: "quiz me", "quiz me on receptors", "test me on
this note", "start a quiz about affinity"; while a quiz runs, "stop",
"skip", "next", and "give me a hint" act as the commands, and outside a
quiz those words are ordinary questions.

While a quiz runs, anything else you type that is not a quiz control (hint,
skip, stop) is your answer. Each question is written by one model call from
the frozen evidence pool and carries a verbatim quote that code verifies
against the cited passage before the question is shown; a draft that fails
is regenerated once with the reason, then that passage is dropped. Yes/no
answers are rejected.
Grading is one model call that sees only the passage, the question, the
expected answer, and yours; it returns ✓ correct, △ partly, or ✗ not quite
with feedback in the passage's own words, then the expected answer and the
passage as a PDF++ callout or quote block.

**The quiz runs until it finds the edge of what you know.** There is no
fixed number of questions. The probe rules follow
[amosblomqvist/learn](https://github.com/amosblomqvist/learn): a correct
answer jumps the tier, from recall (a fact) to why (a mechanism) to
distinguish (what separates two similar things), and two in a row go
straight to the top; a wrong or declined answer drops it. The edge is
located only when it is *bracketed*: a tier you cleared (a floor) sitting
below a tier you missed twice (a ceiling). A run of right answers is not
"done", it means the questions were too easy, and one miss is not done
either, because a slip and a real gap look the same at one data point. So
the grader also names what an answer revealed, *slip*, *vocabulary*,
*detail*, or *misconception*, with a note on the specific gap: a
misconception is probed twice more from other angles, a slip not at all.
**Question cap per quiz** (30) is a runaway guard, not a target.

**One more chance.** A first wrong or partial answer shows the question's hint
and asks once more; only the second answer is recorded. Right after the hint
counts as correct but holds the tier and starts no streak, and is never sent
to the inbox as a miss.

The summary shows the score, why the quiz stopped, and the missed passages
with two chips. **Send N missed to inbox** hands each missed passage to the
card writer, critique, and linter like any capture, with the question you
missed, the expected answer, and the grader's diagnosis attached as the
highlight's instruction, so the card tests the fact you missed rather than
whichever fact in the passage the writer would have picked. Slips are not
sent: you knew it. The highlights arrive titled with the missed question and
with the origin "quiz miss". **Quiz again** reruns the same scope with a
fresh pool.

Settings: **Question cap per quiz** (30), **Evidence pool per quiz** (20
matching highlights and claims), **Standing instructions for quizzes**.

**What is checked before you see it (0.8.1).** The expected answer must be
stated in the cited passage; a hint that shares no word with it is dropped; a
question that contains its own answer or asks for a list is regenerated; the
grader's quote is shown under the grade only when it is found in the passage,
and a grade whose quote or feedback strays outside the passage is marked
*unverified*; a verdict that contradicts plain word overlap (wrong although
you wrote the expected wording, or right with no overlap and no verified
quote) carries a note so you can overrule it.

<details>
<summary><code>QUIZ_QUESTION_SYSTEM</code> (verbatim)</summary>

```
You write one question at a time to quiz a student on their own class notes. The numbered evidence you are given is taken from those notes: passages they highlighted in a lecture PDF, or claims they wrote down themselves. They will type an answer from memory, in their own words, with the passage hidden, and the software will grade it against the evidence afterwards.

This is retrieval practice, not a comprehension test. The value is in the effort of pulling the answer out of memory: a question that can be answered by reading it, or guessed by someone who studied nothing, produces no learning however well phrased it is. Write the question that makes the reader reach.

<the_evidence_is_the_whole_source>
Ask only about what the evidence in front of you states. You know a great deal about most of these subjects, and none of it belongs in a question: the reader is revising for an exam set on this material, and a question about something their course never taught them is one they will fail for the wrong reason and cannot trace back to a slide.

One question tests one piece of evidence. Pick the number of the piece you are testing and put it in evidence_n. Do not build a question that needs two pieces to answer.
</the_evidence_is_the_whole_source>

<the_answer_must_be_in_the_evidence>
The expected answer must be stated in the evidence you cited, and the passage that states it goes into quote, copied character for character from that piece: the words themselves, not a paraphrase, not a tidied version, not two fragments spliced with an ellipsis. The software looks the quote up in the evidence you named, and a question whose quote is not found there is thrown away and asked again once; if that fails too, the passage is set aside for the rest of the quiz, so a quote you smoothed out is a question the reader never sees.

Finding that passage first is also how you tell whether the question is askable. If you cannot point at the words that answer it, the evidence does not answer it, and you should be asking something else about the same passage.
</the_answer_must_be_in_the_evidence>

<what_makes_a_question_worth_asking>
Five properties, each of which rules out a common failure:

Focused: ask about one detail, not three, so the reader's attention lands in one place instead of being split across a list.
Precise: ask so that you and the reader agree on what is wanted; a vague question gets a vague answer that nobody can grade.
Consistent: ask so that the same question would draw the same answer every time, not one of several defensible ones.
Tractable: ask something a reader who studied this passage would get right; obscurity is not difficulty.
Effortful: ask something that requires retrieval rather than recognition, inference from the wording, or a guess.

Never ask a yes/no question, and never one whose answer is a choice between two things you named; the software rejects a question whose wording contains its own answer, and one that asks for a list. Half of those are right by luck, and the reader learns nothing from a coin that lands well. If the answer you are about to write is "yes" or "no", the question is wrong, not the answer.

Never give the answer away in the wording. A question that contains the term it is asking for, or that describes the mechanism and then asks what it is called, is answered by reading it. The reader's own vocabulary is fine and preferred; the answer itself is not.
</what_makes_a_question_worth_asking>

<difficulty>
You are told which tier to write at.

Difficulty 1 is recall of one fact: a definition, a number, a name. Set kind to recall.
Difficulty 2 is a mechanism or a reason: why something happens, or how it works. Set kind to why.
Difficulty 3 is a distinction or an application: what separates two similar things, or which case a rule applies to. Set kind to distinguish.

The tier describes what is asked, not how obscure it is. A difficulty 3 question is still answerable from the passage in front of you by a reader who studied it; it just asks them to do something with it rather than repeat it.

The tier moves because the quiz is searching for one thing: the edge of what this reader knows — the point where what they can produce runs out. A right answer only proves a floor, so the tier jumps rather than inches; a wrong answer or an admitted gap marks a ceiling, so it comes back down to find where between the two the edge actually sits. Write the hardest honest question the tier allows. A quiz the reader answers perfectly has told them nothing they did not already know.
</difficulty>

<what_has_been_asked_already>
When an already_asked block is given, it lists the questions this reader has already answered in this quiz. Do not ask any of them again, and do not ask a differently worded question that tests the same fact: repeating a fact wastes one of five questions and tells the reader nothing new about what they know.

When you are told to ask again about a piece of evidence from a different angle, keep that evidence and change what you ask of it. The reader missed the first question, so the passage is worth a second attempt, but the same question in new clothes only asks them to fail twice. Ask why after asking what; ask for an example after asking for a definition; ask what a term is contrasted with after asking what it means.
</what_has_been_asked_already>

<the_hint>
The hint is one clause the reader can ask for when they are stuck. It narrows the field without handing over the answer: it names the kind of thing wanted, or the part of the topic it belongs to. "It is one of the two properties that define a receptor" is a hint; "it transduces a signal" is the answer.
</the_hint>

<examples>
<example>
<evidence>[3] (Receptors, p.4) Receptors have 2 important properties: they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect.</evidence>
<task>Difficulty 1: a definition, a number, a name: recall of one fact.</task>
<output>question: "With what degree of affinity do receptors bind their ligands?"; answer: "Relatively high affinity."; evidence_n: 3; quote: "they bind ligands with relatively high affinity"; hint: "It is about how tightly, not about what happens next."; kind: "recall".</output>
<note>One fact, not a list: the passage names two properties, and a question asking for "the two properties" would be a set the reader has to recite whole, which the software rejects. The quote is the span that carries the answer, copied whole. The question names the subject so it is answerable without the passage in view and does not contain the answer, so reading it gives nothing away. The hint points at the kind of thing wanted without naming it.</note>
</example>
<example>
<evidence>[5] (Receptors, p.4) Receptors bind ligands with high affinity and transduce a signal to produce a biological effect; this distinguishes receptors from inert binding sites such as albumin, which binds and carries many drugs but does not transduce a signal.</evidence>
<task>Difficulty 3: a distinction or application: what separates two similar things, or which case a rule applies to.</task>
<output>question: "Albumin binds many drugs but is not called a receptor. What does it fail to do?"; answer: "Transduce a signal to produce a biological effect."; evidence_n: 5; quote: "which binds and carries many drugs but does not transduce a signal"; hint: "It is the second of the two defining properties."; kind: "distinguish".</output>
<note>The distinction is the thing being tested, so the question sets up both sides and asks for what separates them. It would have been easy to write "Is albumin a receptor?", which the reader answers correctly by guessing. The wording names albumin and binding, both of which the reader needs to understand the question, but not transduction, which is the answer.</note>
</example>
</examples>

Before you return, read the question back as the reader will see it, with the passage hidden. Ask whether it can be answered without knowing the material, whether its answer is yes or no, whether the wording contains the answer, whether one piece of evidence settles it, and whether the words in quote appear in that evidence exactly as you copied them. If any of those goes the wrong way, write a different question about the same passage.
```

</details>

<details>
<summary><code>QUIZ_GRADE_SYSTEM</code> (verbatim)</summary>

```
You grade one answer a student typed from memory during a quiz on their own class notes. You are given the passage the question was written from, the question, the expected answer, and what the student wrote. Your verdict and your feedback are shown to them immediately, with the passage underneath.

You are a grader, not a teacher. You do not explain the topic, extend the answer, add the fact they missed beyond naming that it is missing, or offer advice for next time. The passage is shown to them anyway; it teaches better than a paragraph from you would.

<the_three_verdicts>
Correct: the answer states what the evidence states. Wording does not matter and is not what you are judging. A paraphrase in the student's own words is exactly what free recall is supposed to produce, and it is correct if it carries the same content as the expected answer; a spelling mistake, a missing article, or a rougher phrase is still correct.

Partial: the answer states part of what was asked and misses the rest, or is right in direction but too vague to show they know it. Two properties were asked for and one was given: partial. "Something to do with signals" where the evidence says transduces a signal to produce a biological effect: partial.

Incorrect: anything else. The answer states something the evidence contradicts, or something about a different topic, or nothing that bears on the question.

A blank answer never reaches you, and neither does "I don't know" or any of its variants: the software catches those before it calls you and shows the reader the answer without grading it. So do not consider whether the student was admitting ignorance. What you are given is an attempt.
</the_three_verdicts>

<feedback_and_quote>
Feedback is one or two sentences saying what the answer got right and what it missed, in the evidence's own words. Never introduce a fact the evidence does not state, however true it is and however much it would help: the reader is checking your feedback against the passage printed below it, and a sentence they cannot find there is one they cannot use.

Quote the passage that settles the grade, copied character for character from the evidence, not paraphrased. It is checked against the evidence and shown under the grade only if it is found there; a quote that is not found marks the grade as unverified, which is what lets the reader overrule you when they think you were wrong.
</feedback_and_quote>

<what_the_answer_reveals>
A verdict says whether the answer was right. It does not say what to do next, and those are different questions: a careless slip and a confidently-held wrong belief both score incorrect, but one needs nothing and the other needs dislodging. So name the kind of gap the answer reveals, in "gap":

none — nothing worth recording. A correct answer, or one whose only fault is wording.
slip — they know this. A typo, a misremembered name, an answer that contradicts itself in a way a second's thought would catch.
vocabulary — the idea is right and the term for it is missing or wrong. They understand the thing and cannot name it.
detail — the shape of the answer is right and a specific fact inside it is missing or wrong.
misconception — they stated something the evidence contradicts, as though it were true. This is the one that matters most: a wrong model produces more wrong answers until it is replaced, so it is worth more attention than a fact that is merely absent.

"gapNote" is one short clause naming the specific thing — the belief they hold, or the piece they lack. "Thinks self-efficacy rises from watching others succeed" is a gapNote; "did not understand the question" is not. It is what the next question probes, so it has to be specific enough to write a question against. Leave it empty when gap is none.

Judge the gap from the answer in front of you, not from what a reader like this usually gets wrong.
</what_the_answer_reveals>

<examples>
<example>
<evidence>[1] (Receptors, p.4) Receptors bind ligands with relatively high affinity and transduce a signal to produce a biological effect.</evidence>
<question>What does a receptor do after it binds a ligand?</question>
<expected_answer>It transduces a signal to produce a biological effect.</expected_answer>
<student_answer>it passes the signal on so something happens in the cell</student_answer>
<output>verdict: "correct"; feedback: "That is signal transduction: the evidence says the receptor transduces a signal to produce a biological effect."; quote: "transduce a signal to produce a biological effect".</output>
<note>The wording is nothing like the expected answer and the verdict is still correct, because the content is the same. Grading the phrasing here would teach the student to recite rather than to recall.</note>
</example>
<example>
<evidence>[1] (Receptors, p.4) Receptors have 2 important properties: they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect.</evidence>
<question>What does a receptor do after it binds a ligand?</question>
<expected_answer>It transduces a signal to produce a biological effect.</expected_answer>
<student_answer>it binds things and then something happens</student_answer>
<output>verdict: "partial"; feedback: "Something does happen, but the evidence names it: the receptor transduces a signal to produce a biological effect."; quote: "they transduce a signal to produce a biological effect".</output>
<note>Right in direction, too vague to count as recall of the fact, so partial rather than incorrect. The feedback supplies the missing words from the evidence and stops there, without explaining what transduction is.</note>
</example>
</examples>

Before you return, check that your verdict rests on what the evidence states and not on how the answer was phrased, that every fact in your feedback is in the passage, and that the words in quote appear in the evidence exactly as you copied them.
```

</details>

**Settings**, all in Settings → WikiLM:

| setting | default | effect |
| --- | --- | --- |
| Provider | Anthropic | Anthropic (API key), Google Gemini (API key), Codex (ChatGPT subscription) or Claude Code (Claude subscription). **Test** sends one tiny request and loads that provider's model list |
| Model (per provider) | the provider's default | a dropdown of the models the last Test found, plus **Other…** to type an id; Claude Code lists its aliases, Codex reads `~/.codex/models_cache.json` |
| Use different models for lint, query and digest | off | on, **Lint**, **Query** and **Digest** each pick a provider and model with their own Test; card writing, critique, quizzes and highlighting stay on the main provider (`src/modelRoles.ts`) |
| Topic notes folder | `classes` | topic notes go to `<folder>/<class code>/<title>.md` |
| Schema folder | `wiki/schema` | the plugin's own folder inside the wiki: `wikilm.md`, `wikilm-suggestions.md` and `inbox.json`, the inbox itself; not indexed, linted or graphed as pages |
| Transcript folder | `wiki/sources/wispr` | where lecture notes and transcripts live; the transcript picker lists it first, newest on top |
| Propose schema rules from my edits | **on** | watches your card edits and proposes a rule when the same correction repeats |
| Max topic notes per PDF | 6 | caps how many topics the model may return per digest |
| Paper text limit | 60,000 characters | how much of the PDF's text is sent for the summary, cut at a sentence boundary |
| Standing instructions for the digest | *(empty)* | appended to every digest prompt |
| Evidence per question | 6 | how many ranked evidence units Ask sends per question |
| Conversation turns kept | 10 | how many prior turns Ask keeps for follow-ups |
| Standing instructions for Ask | *(empty)* | appended to every Ask prompt |
| Find other wording when a question comes up short | on | one extra call turns the question into the terms your notes use, and those are searched for locally |
| Filter evidence with the model | on | retrieves three times the evidence count (at most 30), and one extra call keeps only the passages that bear on the question; when it keeps none, the reply says so and no answer call is made |
| Check the answer's sentences | on | matches each sentence of the answer against the cited notes, with no model call; sentences that match no passage are counted, never deleted |
| Answer from general knowledge when your notes do not | off | lets the model answer a question the notes do not cover, under a banner saying it did not come from them |
| Show the grounding line under answers | on | the one-line coverage summary, with counts of any citations dropped and of sentences that matched no passage, then the route, what the evidence filter kept, and the class searched |
| List unmatched sentences | on | lists the sentences that matched no passage under the grounding line; the count on the line stays when this is off |
| Question cap per quiz | 30 | a runaway guard: a quiz ends when it brackets the edge of what you know, and this only stops one that never does |
| Evidence pool per quiz | 20 | matching highlights and claims a quiz draws from |
| Standing instructions for quizzes | *(empty)* | appended to every question-writing prompt |

**Limitations:**

- Embedded PDF annotations and rect embeds need the pdf.js text layer's
  per-character geometry; without it they carry a page and a link but no
  text.
- `selection=` indices assume PDF++'s text-layer divs line up with pdf.js's
  `textContent.items`; the callout's quote is authoritative and a mismatch
  only produces a warning.
- Merging into an existing topic note only appends highlights — its summary
  and related topics are never edited by a later digest run.
- Retrieval is lexical: a question phrased with none of a note's own words
  will find nothing there. The evidence list is what makes that visible.
- Grounding is asked for in the prompt, not re-derived from the answer: the
  code checks that every citation points at a piece of evidence that exists,
  not that the evidence says what the sentence says. A citation that is only
  loosely related passes.
- Digest, Ask, and the card writer have each run live through the Claude Code
  provider (2026-09-12); the digest command's modal flow and an export have
  not been driven in that session.
- Handwritten professor annotations on scanned decks are images, not
  extractable text, and are out of scope.

**Where the Karpathy LLM Wiki plugin fits.** It is a consumer of the notes
this feature writes, never their producer. Its ingest pipeline only writes
`entities/`, `concepts/`, and `sources/` pages from a fixed prompt with no
custom page template, converts a whole PDF to markdown rather than reading
its annotations, and reports provenance at the source level only (never a
page or a selection) — none of which is what a PDF++-highlighting workflow
needs. WikiLM's topic notes are ordinary markdown with wikilinks, so once
written they can still be ingested by that plugin like any other note; they
are simply produced here, by a tool built to read the highlights PDF++
leaves behind.

### Card quality

Every card goes through a fixed chain before it reaches the inbox: the
writer drafts, a critique pass reviews the draft, and a deterministic
linter checks the result. The linter always runs and costs nothing; the
critique is on by default and can be turned off. All of this happens
inside the background queue
(`Generator.run` in `src/generator.ts`), so capture itself never waits on
it — a highlight just takes a little longer to turn into ready cards when
the critique is on.

**Critique pass** (setting, on by default) sends the whole set of cards
drafted for one highlight to the model in a single call and gets back a
verdict per card: `keep`, `revise`, or `drop`, plus the Bloom level the card
sits at (`CRITIC_SYSTEM` and `VerdictsOut` in `src/llm.ts`). It checks grounding
(every answer and cloze deletion must be stated in the highlight), whether
the cards interfere with each other (two cards whose questions read alike
but want different answers, or that share an answer), and near-tautology
(an answer that just restates a word already in the question)
(`src/llm.ts`). A `revise` verdict replaces the card's fields and
records the reason on `critiqueReason`; a `drop` verdict does not delete
the card — it sets `status: "flagged"` and keeps the reason attached
(`src/generator.ts`). If the critique call fails (network, quota),
the drafted cards are kept as written and simply skip critique rather than
being lost (`src/generator.ts`). To avoid spending a model call on
a highlight that clearly doesn't need one, the critique is skipped when a
highlight drafts zero or one card and that one card already lints clean
(`src/generator.ts`).

**Bloom level** is the critique's judgment of how much a card actually
asks of the reader, reported using Bloom's taxonomy: a six-level ladder of
cognitive demand running remember → understand → apply → analyze →
evaluate → create. The one failure this is meant to catch is a highlight
that explains a mechanism or a reason getting turned into a card that only
asks what something is called — the reader can recite the label back
without knowing how the thing works. This is not a push toward the higher
end of the ladder: a highlight that states a plain definition and nothing
more is correctly a "remember" card, and the critique says so rather than
asking for a harder question the source doesn't support
(`src/llm.ts`, `src/model.ts`). The level shows as a badge on
every judged card in the inbox, and the header shows a stat for cards
at remember, turning red once every judged card sits there and there
are at least five — the sign that a set has settled into testing
labels rather than understanding (`src/inboxView.ts`).

**Deterministic lint** (`src/lint.ts`) runs on every card regardless of
whether the critique is on, both on the freshly drafted cards and again on
any card the critique revised, since a revision changes the text the
grounding check needs to see (`src/generator.ts`). It is pure
regex- and word-count-based, no model call. Nine checks can fail a card:

| id | what it catches |
| --- | --- |
| `cloze-not-grounded` | a `{{cN::…}}` deletion whose text isn't found in the highlight |
| `cloze-count` | a cloze card with fewer than 2 or more than 3 distinct deletions; a one-deletion draft is filed as a question/answer card instead (`demoteSingleCloze`) |
| `cloze-numbering` | deletion numbers that skip (e.g. 1, 3, no 2) |
| `cloze-framing` | a deletion body over 6 words, or one containing a linking word like "is"/"which"/"because" — a sign it hides a clause, not a short atom |
| `qa-empty` | an empty question/answer, or a cloze card with no deletion at all |
| `qa-answer-long` | a Q&A answer over 12 words |
| `qa-yes-no` | a question starting with "is", "are", "does", "can", and the like |
| `card-long` | question + answer + cloze text together over 60 words |
| `answer-in-question` | the answer sits verbatim inside the question, so there's nothing to retrieve |

Three more checks are warnings rather than failures — they show as a
softer badge than a failure, never change the card's status, and are not
picked up by the "Fix with linter notes" wrench, which only acts on
`lintFailures` and a critique rejection (`src/inboxView.ts`).
`duplicate-card` (this card repeats a sibling drafted in the same batch)
and `shared-answer` (two Q&A cards in the same batch have the same
answer, which risks confusing them in review) are computed per batch and
stored on the card as `lintWarnings` (`src/generator.ts`).
`cross-interference` is different: rather than being computed once per
batch, the inbox recomputes it on every render over every pending card
under every ready highlight across the whole inbox, the same population
`pendingItems` uses in `src/main.ts` (`findCrossInterference` in
`src/lint.ts`, `rebuildCrossInterference` in
`src/inboxView.ts`). It badges two cards from *different*
highlights whose normalized answer or cloze text collide (same kind
only), naming the other card's note in the tooltip; because it's derived
rather than stored, binning or exporting one partner clears the other's
badge on the next render. Labels for all twelve ids, shown in the inbox,
live in `LINT_LABELS` in `src/lint.ts`.

**The three settings**, all in Settings → WikiLM → Card quality:

| setting | default | effect |
| --- | --- | --- |
| Critique pass | **on** | runs the critique described above; adds one model call per highlight |
| Lint mode | badge only | what happens to a card that fails a lint check: badge it but keep it pending, collapse it behind a "N flagged" toggle, or flag it so it can't be exported |
| Learn from my decisions | **on** | shows the writer and critique a few cards you kept or edited, and a few you deleted, from your own inbox history |

The quality chain is on by default, because a card you delete during review
cost more than the model call that would have caught it. The linter is free
and always runs. The critique costs one extra model call per highlight;
turn it off if you are drafting in bulk and would rather triage by hand.

Lint mode stays at **badge only** by default, which is the conservative
choice: a card that fails a check is still yours to keep. Nothing in this
chain ever deletes a card (`src/settings.ts`).

The cost of turning the critique on is time, not capture speed: it is one
extra model call per highlight, so cards take longer to appear after you
send a highlight. Capture — selecting text, dragging with the highlighter,
sending a PDF selection — is unaffected either way, because everything
above happens in the background queue after capture has already returned
(`src/settings.ts`).

A **flagged** card (`status: "flagged"`) is one the critique dropped or
that failed lint under a mode other than "badge only". It stays in the
inbox with its reason attached rather than being deleted — nothing is
silently thrown away — but it is excluded from export: only cards with
`status === "pending"` are ever sent to Anki, whether through AnkiConnect
or the text-file fallback, so a flagged card cannot reach Anki until you
review and fix it (`src/model.ts`, `src/main.ts`).

### The schema note

`schema/wikilm.md` is your file. WikiLM writes it once, from a template that
describes what the plugin is already doing, and reads it before every model
call. The sections in it are handed to the model as your house rules, so a
line you add there — "answers in German", "never cloze a date", "spell out
every abbreviation the first time" — applies from the next card onward. There
is no setting for it and no code to edit. Delete a rule and it stops applying;
empty a whole section and nothing from it is sent.

It is modelled on `wiki/schema/config.md` from
[gd4ai/obsidian-llm-wiki](https://github.com/gd4ai/obsidian-llm-wiki): a
reader-owned configuration note with page templates and naming conventions,
reimplemented here with a flashcard half and the text written fresh. Open it
with **Open the schema note**, which creates it if you have not seen it yet.

Which sections steer which call is decided by the heading. A heading naming
cards or Learned (**Card Templates**, **Card Rules**, **Learned**) goes to the
card writer, the critique and the rewrite. A heading naming the wiki, pages,
naming or structure (**Wiki Structure**, **Concept Page Template**, **Entity
Page Template**, **Naming Conventions**) goes to the digest and the PDF
highlighter. A heading matching neither list — one you invented — goes to
both, because a rule you wrote and WikiLM could not classify should reach one
call too many rather than one too few (`src/schemaNote.ts`).

**## Learned** starts empty and fills only when you accept something. WikiLM
watches the edits you make in the inbox — what you retype by hand, what you
ask a rewrite for — and when the same correction turns up three or four times
it writes a proposal to `schema/wikilm-suggestions.md`: the pattern in a
sentence, the rule it would add, and the edits that earned it. The inbox
header grows a **2 schema suggestions** chip, and **Review schema
suggestions** opens them. Each one shows its rule in a box you can rewrite
before accepting — the wording is what the model sees, so it should be yours.
Accept writes it under `## Learned` with the date and the evidence count.
Dismiss records that you said no and keeps that pattern quiet for 30 days;
neither entry is deleted, so the same observation is never proposed twice.
Turn the whole thing off with **Propose schema rules from my edits**.

The invariant: WikiLM creates the note once and afterwards only ever appends
under `## Learned`, and only when you press Accept. Nothing else in the file is
ever rewritten by the plugin, and no rule is ever inferred silently
(`src/schemaFile.ts`, `src/preferences.ts`).


### Triage

Open the inbox from the ribbon, the status bar (`WikiLM ✎ 2 · ⧉ 7` = 2
writing, 7 to review), or the **Open inbox** command.

- Cards sit beside the highlight they came from. Click the highlight to open
  the note at that line.
- Per card: edit in place, delete, rewrite with an instruction, convert
  Q&A ⇄ cloze. A cloze whose deletions are not found verbatim in the
  highlight gets a *not in highlight* badge (a deterministic check, no model).
- Per highlight: export, write more cards, add a card by hand, retry, dismiss.
- Per note: export everything reviewed from that note.
- Keyboard: `j`/`k` move, `e` edit, `x` delete, `o` open source,
  `Enter` export the focused highlight, `⌘⏎` export everything reviewed.

### Exporting

- **AnkiConnect** (default): Anki must be open with the
  [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on. WikiLM
  talks to it through Obsidian's own request layer, so no CORS origin needs
  whitelisting. Duplicates are checked per deck before adding.
- **Text file** (fallback): *Inbox menu → Export reviewed as Anki text file*
  writes a tab-separated file with `#notetype`/`#deck`/`#tags` directives into
  `wikilm-exports/`; import it with *File → Import* in Anki.

Cards are tagged `wikilm` and `source::<note-slug>`. The `source::` tag is the
namespace the Anki Wiki Sync add-on resolves back to vault pages, so synced
deck pages link to the note the card came from. The extra field carries the
verbatim highlight and an `obsidian://` link to the source. A card whose
highlight reached the inbox through a **Both** digest also carries a
`Topic:` link to the topic note it was digested into, right after the
source link; cards captured any other way are unchanged
(`src/anki.ts`, `src/model.ts`).

## Setup

1. Settings → WikiLM → **Provider**. Four options:
   - **Codex (ChatGPT subscription)** — no API key. WikiLM runs OpenAI's
     Codex CLI (`codex exec`) signed in with your ChatGPT account. Leave
     *Codex CLI path* empty and WikiLM finds `codex` on the PATH or the copy
     bundled inside the ChatGPT desktop app
     (`/Applications/ChatGPT.app/Contents/Resources/codex`); otherwise paste
     the output of `which codex`. Sign in once through the ChatGPT app or
     `codex login`. Default model `gpt-5.5`; effort levels the model does not
     support are rounded down. Each request runs in a throwaway temp folder
     with a read-only sandbox, `--ephemeral` (no session files) and
     `--ignore-user-config` (your `~/.codex/config.toml` hooks, plugins and
     MCP servers are not loaded), so the agent never sees the vault.
   - **Claude Code (Claude subscription)** — no API key. WikiLM runs the
     `claude` CLI signed in to your Claude subscription (`claude auth status`
     shows `loggedIn: true`). It passes the system prompt and a JSON schema,
     sends the message on stdin, disables the CLI's tools and settings
     sources, never uses `--bare` (that would skip the keychain read that
     holds the login), and strips `ANTHROPIC_API_KEY` from the child's
     environment so billing stays on the subscription. Leave *Claude Code CLI
     path* empty to auto-detect `claude` on the PATH or in `~/.local/bin`.
     The session limit is shared with your interactive Claude Code sessions,
     so the default model is `sonnet`; set `opus` for quality.
   - **Anthropic (API key)** — paste a key, or leave the field empty and
     WikiLM reads `ANTHROPIC_API_KEY` from the environment or from the macOS
     keychain (a generic password whose service is `ANTHROPIC_API_KEY` or
     `WikiLM Anthropic API key`). The keychain route keeps the key out of
     `data.json`, which iCloud syncs in plaintext:
     `security add-generic-password -s ANTHROPIC_API_KEY -a wikilm -w`.
     Default model `claude-opus-5`.
   - **Google Gemini (API key)** — paste a key from Google AI Studio, or
     leave the field empty and WikiLM reads `GEMINI_API_KEY` from the
     environment or from the macOS keychain (a generic password whose
     service is `GEMINI_API_KEY` or `WikiLM Gemini API key`), the same
     keychain route the Anthropic provider uses:
     `security add-generic-password -s GEMINI_API_KEY -a wikilm -w`.
     Calls go to the `generateContent` REST API with a JSON response schema,
     through Obsidian's `requestUrl` so no CORS proxy is needed. Default
     model `gemini-3.1-pro-preview`; `gemini-3-flash-preview` is faster and
     cheaper. Gemini's thinking scale stops at `high`, so the `xhigh` and
     `max` effort levels are rounded down to it.

   Effort defaults to `high` (highlights are small, so this is cheap). Click
   **Test** to confirm the provider answers.
2. Open Anki, then Settings → WikiLM → **Detect** note types. It uses
   Anki's stock `Basic` and `Cloze` types and maps the front/back/extra
   fields. Stock `Basic` has no extra field, so a card's source link needs a
   note type that has one.
3. Pick a default deck (the inbox header lets you change it per session).

## Development

```
npm install
npm run dev            # watch build → main.js
npm run build          # type-check + minified bundle
npm test               # unit tests for the pure helpers
npm run install:vault  # build and copy into the vault's .obsidian/plugins/wikilm
```

State: settings in `data.json` inside the plugin folder; the inbox in
`inbox.json` inside the schema folder (`wiki/schema`), moved there from the
plugin folder on first load. Notes are only touched when you choose to mark highlights.

Layout, one line per module:

- `src/anki.ts` — AnkiConnect client, note building, and export, over Obsidian's `requestUrl` so no CORS origin has to be whitelisted
- `src/anthropic.ts` — the Anthropic backend, with an adapter that lets the official SDK use `requestUrl` as its transport
- `src/askCheck.ts` — Ask answer assembly: the answer, the one or two source notes under it, and the grounding line
- `src/backend.ts` — the `LlmBackend` interface and the shape of one structured-output request
- `src/cancel.ts` — a request to stop a long run at its next batch boundary, never mid-call
- `src/capture.ts` — selection, reading-view, PDF, `==highlight==` and AI-highlight capture into the inbox
- `src/chatCommands.ts` — deciding what a line typed into the chat box means: an action to run, or a question for the notes
- `src/chatPanel.ts` — the Chat half of the sidebar: turns, evidence, quizzes, and the lint modal
- `src/claudeCli.ts` — the Claude Code backend, shelling out to `claude -p` signed in with a Claude subscription
- `src/codex.ts` — the Codex backend, shelling out to `codex exec` signed in with a ChatGPT subscription
- `src/gemini.ts` — the Google Gemini backend over the generateContent REST API with an API key
- `src/modelRoles.ts` — which provider and model a role (lint, query, digest) runs on; the model lists behind the settings dropdowns
- `src/gemini.ts` — the Gemini backend, calling Google's `generateContent` REST API with an API key
- `src/commandTable.ts` — the twenty commands as pure data: ids, palette names, chat aliases, availability hints
- `src/commands.ts` — their behaviour half: an `available` predicate and a `run` action per entry, registered by `main.ts` in one loop
- `src/digest.ts` — digest orchestration: the glue between the highlight collector, the model or a pasted draft, the planner, the preview and the vault
- `src/digestGate.ts` — whether a source has enough highlights to digest, or needs some made first
- `src/duplicates.ts` — two pages about one subject, found from a shared name or a PDF span both cite; names spelled alike are candidates the model judges, never findings
- `src/examples.ts` — style examples drawn from your own triage decisions across the inbox
- `src/fixPlan.ts` — the plan behind **Suggest fixes**: one proposed edit per finding, as a pure text-to-text function
- `src/fixer.ts` — the vault side of that plan: gathering the facts it needs, and the only place in the feature that writes
- `src/generator.ts` — the background queue that turns a captured highlight into cards, surviving reloads through the store
- `src/graph.ts` — the wikilink graph between notes and Personalized PageRank over it, so a neighbour of a match can be retrieved too
- `src/highlighter.ts` — highlighter mode: the drag-to-capture gesture and its guards, in the editor, reading view and the PDF viewer
- `src/icon.ts` — WikiLM's icon set, drawn to Lucide's proportions so it sits beside the built-in icons
- `src/inboxView.ts` — the inbox: highlights grouped under their source note, cards packed densely for triage, and the host of the chat panel
- `src/ingestSource.ts` — markdown ingest: the glue between a source note, the model and the vault, the counterpart of `suggest.ts`
- `src/keys.ts` — Anthropic key resolution in order: the setting, the environment, then the macOS keychain
- `src/lint.ts` — the deterministic post-generation card linter: regex and word counts, no model call
- `src/llm.ts` — the system prompts, the provider dispatch, and the error text every call shares
- `src/main.ts` — the plugin class: wiring the store, generator, backends, views, ribbon, status bar and command loop
- `src/manifest.ts` — the pure highlight model: the row shape a run collects, and the merge/sort/id helpers behind it
- `src/modals.ts` — the modals: instructions, deck picker, digest and suggestion previews, the fix plan
- `src/model.ts` — the card and highlight records, their statuses, and the Bloom level the critique judges
- `src/pageMap.ts` — an offset-preserving view of a PDF page's text, so a quote can be inverted back to a `selection=` subpath
- `src/pdf.ts` — what you have selected in Obsidian's own pdf.js viewer, read straight off the text layer
- `src/pdfHighlights.ts` — collects one PDF's highlights, from backlinking PDF++ links and embedded annotations, for the run
- `src/pdflink.ts` — pure PDF++ link grammar: parse and render `#page=…&selection|annotation|rect…` subpaths and callouts
- `src/pdftext.ts` — text extraction over pdf.js page data, ported from PDF++: annotation quads, `selection=` ranges, page text
- `src/prompt.ts` — message assembly for every call, kept out of `llm.ts` so block order can be tested without a backend
- `src/quiz.ts` — the quiz engine: scope, frozen evidence numbering, grounded question checks, grading state, difficulty
- `src/retrieval.ts` — pure retrieval for Ask: index notes into evidence units, rank them, number them, check the citations
- `src/schemas.ts` — the zod output schemas, importing nothing but zod so a test can parse a pasted draft standalone
- `src/settings.ts` — the settings type, `DEFAULT_SETTINGS`, and the settings tab
- `src/sourceMap.ts` — the markdown analogue of `pageMap.ts`: segment a note by heading and paragraph, and invert an offset back
- `src/store.ts` — the persistent inbox, kept as `inbox.json` in the schema folder with debounced writes
- `src/suggest.ts` — AI highlight suggestion for a PDF: the glue between the text layer, the model, the planner, the preview and the vault
- `src/suggestPlan.ts` — its pure planning layer: page batches, span verification, highlight rows, and grouping into wiki notes
- `src/topicNote.ts` — pure topic-note render, parse and merge by highlight key, and the digest planner
- `src/util.ts` — pure helpers shared across the plugin, kept free of Obsidian imports
- `src/vaultFix.ts` — repairs for what the vault lint finds: the dead link that is only a spelling apart from its page, and the unwrap that withdraws one whose page was never written
- `src/vaultLint.ts` — structural checks over the notes themselves: what can be found, what links anywhere, what Ask could quote

## License and credits

WikiLM is MIT licensed; see [LICENSE](LICENSE).

Parts of it were written against the published design of
[obsidian-llm-wiki](https://github.com/gd4ai/obsidian-llm-wiki) (Apache-2.0,
Copyright 2025-2026 Greener-Dalii) — the retrieval cascade, the vault lint
scanners, dead-link repair with count-gated fix buttons, and filing new
material into a section of an existing page. None of its source code is
included here: each part was reimplemented against this plugin's own types and
credits it in a comment at the point of use. [NOTICE](NOTICE) lists them.

Where the two disagree, WikiLM keeps its own policy. The clearest case is what
happens to a new subject: upstream gives every entity and concept a page of its
own and merges only when an existing page denotes the same thing, while WikiLM
appends into an existing page whenever one is related and creates a page only
when nothing is.
