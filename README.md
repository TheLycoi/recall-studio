# Recall — highlight-centric flashcards for Obsidian

Recall turns the sparse things you actually want to remember into Anki cards
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
*Toggle highlighter mode*), then drag across a passage. It is wrapped in
`==…==` and sent to the inbox with no key pressed. This works in the editor
(source and live preview), in reading view, and in Obsidian's PDF viewer,
where the highlight carries its page number instead of a line. The status bar
shows `🖊 highlighter` while the mode is on. Off by default: with it on, every
drag-selection is a capture. Guards: only a drag that started inside the
note or PDF counts, double-clicked words and selections under a minimum
length (setting, default 12 characters) are ignored, already-highlighted
spans are captured without being re-wrapped, and the same passage is never
captured twice in a row.

Commands, for when the mode is off:

| Command | What it does |
| --- | --- |
| **Send selection to inbox** | Captures the selection (or the paragraph under the cursor; in reading view, the selected text), wraps it in `==…==`, and queues card writing. Also in the editor right-click menu. |
| **Send PDF selection to inbox** (also *…with instructions…*) | Captures the text selected in the PDF viewer with its page number and the page's text as context. |
| **Send selection to inbox with instructions…** | Same, plus a one-line instruction for the writer ("one cloze on the number", "cards in Dutch"). |
| **Send all ==highlights== in this note to inbox** | Sweeps a note you highlighted while reading and queues every span not already in the inbox. |
| **AI-highlight this note and write cards** | The "highlight" operation: the model picks spans worth remembering, each is verified verbatim against the note, marked, and queued. Use this for dense material. |
| **AI-highlight this note with instructions…** | Same, with guidance for the highlighter ("only definitions and numbers"). |

Every highlight remembers its note, line, nearest heading and (optionally) a
`^recall-…` block ID, so the inbox can jump straight back to the source. PDF
highlights remember the page and open the PDF at that page.

### What the cards look like

A worked example, from a vault note on Wozniak's minimum information
principle. Four highlights, four cards, nothing in an answer that isn't
stated in the span above it.

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
pass looks for (`src/llm.ts:174-193`). It came back `drop`, so it sits in
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

Once a transcript is attached, both **AI-highlight this note and write
cards** and **AI-highlight this note with instructions…** pick it up
automatically, with no separate step, and the notice they show changes to
mention the transcript.

Limitations:

- Only markdown notes can be AI-highlighted, so a transcript attached to a
  PDF has no effect.
- Transcripts are keyed by the note's file path. Renaming or moving a note
  detaches its transcript; re-add it with **Add transcript for document
  highlighting** afterward.

### Digesting PDF highlights

If you take class notes by highlighting lecture PDFs with PDF++ — a callout
like `[[file.pdf#page=4&selection=2,0,33,19&color=yellow|…, p.4]]` or
`[[file.pdf#page=2&annotation=846R|…]]` plus its quoted text — Recall can
group those highlights by topic, write a short summary for each topic from
the whole paper, and lay out every highlight underneath it as the same
PDF++ callout, so clicking it still opens the PDF at that highlight.

Four commands, active on a PDF (or, for the last two, on a manifest note):

| Command | What it does |
| --- | --- |
| **Extract PDF highlights to manifest** | Collects every highlight of the active PDF — PDF++ links in notes that back-link to it, plus annotations embedded in the file itself — and writes a manifest, then opens it. |
| **Digest PDF highlights into topic notes…** | Asks the configured model to group the manifest's highlights into topic notes and write each one's summary, then shows a preview before writing anything. |
| **Digest PDF highlights from pasted model output…** | Same, but the draft comes from JSON you paste in rather than a live model call — see "Interim: digesting by hand" below. |
| **Ask the notes** | Opens the Recall sidebar in Chat mode (`src/main.ts:172-201`). |

**The manifest.** One file per PDF, in the folder set by **Manifest folder**
(default `recall-manifests/`), named after the PDF
(`<manifestFolder>/<pdf basename>.md`). It lists every highlight in page
order as a PDF++ callout carrying the same link the note would, plus
hand-readable fields (`id::`, `page::`, `kind::`, `color::`, `origin::`,
`before::`, `after::`) that the digest and the pasted-JSON path use to refer
to a highlight by its `id`. Re-running **Extract PDF highlights to
manifest** overwrites the manifest; it never touches a topic note
(`src/manifest.ts:173-187`, `src/pdfHighlights.ts`).

**The topic note.** Written to `<topicFolder>/<class code>/<title>.md`
(default topic folder `classes`; the class code comes from
`sources/class notes/<code>/` or is asked for once). Frontmatter links the
PDF, then a title, a short model-written summary, and every highlight
assigned to that topic as a callout in page order — subdivided by `### Page
N` when the note spans more than one page. Nothing but the summary and
title comes from the model; every link and callout is rendered by code
straight from the manifest. Two highlights on one page render exactly like
this (`src/topicNote.ts:47-73`):

````markdown
---
type: topic
class: HBIO250
created: 2026-09-10
source_file: "[[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf]]"
tags: [hbio250]
---

# Receptors

## Summary
Receptors bind drugs with high affinity and transduce a signal, which is what separates them from inert binding proteins such as albumin; the better the structural fit, the higher the affinity.

## Highlights

> [!PDF|yellow] [[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&selection=2,0,33,19&color=yellow|p.4]]
> > Receptors have 2 important properties: 1. They bind ligands (or drugs) with relatively high affinity, and after they bind a drug… 2. They transduce a signal to produce a biological effect (this property distinguishes receptors from inert binding sites – e.g., albumin – a blood protein that binds/carries many drugs but does not transduce a signal)

![[HBIO 250 - Pharmacology, Pharmacodynamics, and Pharmacokinetics.pdf#page=4&rect=13,55,713,222|p.4]]

## Related topics
- [[Pharmacology]]

## Flashcard Seeds
````

**Product: Notes / Flashcards / Both.** Every digest run asks which product
to build (default **Notes**). **Flashcards** skips the model call entirely
and queues every highlight with text straight into the inbox, where the
usual writer, critique, and lint chain handles cards. **Both** writes the
topic notes and also queues each written note's highlights into the inbox.
`(src/digest.ts:187-307`, `src/capture.ts` — `captureManifestHighlights`.)

**Never overwritten.** Writing into a topic note that already exists only
appends: a highlight already present — identified by its link's
`highlightKey`, i.e. the page and selection/annotation/rect, ignoring color
— is skipped, and the note's summary and related topics are left exactly as
they are. A note with no `## Highlights` heading gets one inserted before
`## Related topics` (or at the end, if there is no such heading), so a
manually written note gains a highlights section without disturbing what's
already in it (`src/topicNote.ts:152-212`).

**Preview.** Before anything is written, a modal lists every proposed note:
a checkbox (unchecked by default when an existing note would gain nothing),
a `new` or `exists: +added, skipped` badge, the target path, the summary,
the highlights as a compact list (skipped ones struck through), and related
titles. Titles are editable inline, which can move a note between "create"
and "merge into an existing note". Nothing is written until you click
"Write N notes"; Cancel or Esc touches no file.

#### Interim: digesting by hand

No model provider is required to work with manifests and topic notes end to
end — while none is configured (or while a configured one is failing), run
the digest by pasting a model's output instead of calling one from inside
Recall:

1. Run **Extract PDF highlights to manifest** on the PDF. The manifest opens.
2. In a chat session with a model of your choice, paste the system prompt
   below (`DIGEST_SYSTEM`), then this instruction, followed by the
   manifest's body and, if you want it, the PDF's text:

   > Below is a manifest of highlights from one lecture PDF, followed by the
   > paper's text. Return only a JSON object of this shape:
   > `{"notes":[{"title":"…","summary":"…","highlight_ids":["H01"],"related":["…"]}],"unused_ids":["…"]}`.
   > Refer to highlights by the `id::` in each callout. Do not write links or
   > callouts. Existing notes in this class: <titles in classes/<CODE>/>.
   > Write at most 6 notes.

3. With the manifest still the active file, run **Digest PDF highlights
   from pasted model output…**, paste the JSON back in, review the preview,
   and write. Recall renders every link and callout itself from the
   manifest — the model never writes one.
4. Ask (below) works without a model for the evidence half of an answer; a
   model answer needs a configured provider.

<details>
<summary><code>DIGEST_SYSTEM</code> (the digest system prompt, verbatim)</summary>

```
You turn one lecture PDF and the highlights a student made in it into a handful of topic notes. You are given the paper's text, so that you can see what each highlight is about, and the highlights themselves, each with an id and a page. You return, for each topic, a title, a short summary, and the ids of the highlights that belong to it. You never write links, callouts, or ids into your prose: the plugin renders each highlight back into the note from its own record, and prose that mentions H04 will be read by a person, not resolved by a machine.

<what_a_topic_is>
A topic is something the reader would look up by name later: a mechanism, a classification, a definition together with what follows from it, a distinction between two things that are easy to confuse. It is not a slide, not a section of the deck, and not the lecture itself. One lecture usually holds two to six of them. Fewer, larger topics beat many thin ones, because a note with one highlight in it is a note the reader will never open twice.

Every highlight belongs to the topic it serves best, and a highlight may serve more than one: a definition of affinity can sit under both the receptor topic and the dose-response topic, and putting it in both is right when a reader arriving at either would want it. What does not belong in any topic goes in unused_ids: slide titles, course logistics, dates, a name on a title page, a rectangle whose text came out empty. Leaving such a highlight in a topic costs the reader more than dropping it, because it dilutes the note it lands in.

You are told which notes already exist for this class. When one of those titles is the topic a group of highlights belongs to, reuse the title exactly, character for character, because the plugin then appends those highlights to that note instead of creating a second one beside it. Reuse it only when it genuinely fits; a near-match that forces unrelated highlights together is worse than a new note.
</what_a_topic_is>

<the_summary>
Three to five sentences about this topic, drawn from the whole paper but weighted toward what the reader chose to highlight. The highlights tell you what they cared about; the rest of the paper tells you what those highlights mean, and lets you write the sentence that connects two of them. Write in the reader's language, the one the paper is written in, and keep close to its wording so the summary reads as their own note rather than as a stranger's gloss.

Nothing from outside the paper. If you know more about the subject than the paper says, that knowledge does not belong here: the reader will study from this note and cannot tell your additions from theirs. No citations, no links, no highlight ids, no page numbers in the prose. The highlights appear underneath the summary in the finished note, so the summary does not need to quote them; it needs to say what they add up to.
</the_summary>

<titles_and_related>
A title is a short noun phrase in Title Case, the way an index entry reads: "Receptor Binding", "First-Pass Metabolism", "Stages of Change". Not a sentence, not a question, and unique within your response. Two titles that differ only in case or in a plural are the same title, and one of the two notes will be lost.

related lists the titles of other notes you are writing in this response, or of the existing notes you were shown, and nothing else. An invented title points at a note that does not exist. Leave it empty when nothing connects.
</titles_and_related>

<examples>
<example>
<input>Highlights H01 "Pharmacology, Pharmacodynamics and Pharmacokinetics — HBIO 250 Fall 2026" (p.1), H02 "Pharmacology is the study of the action of drugs in the human body" (p.2), H03 "Pharmacodynamics = what drugs do in the body; pharmacokinetics = what the body does to drugs" (p.2), H04 "Receptors bind ligands with relatively high affinity" (p.4), H05 "Receptors transduce a signal to produce a biological effect; this distinguishes them from inert binding sites such as albumin" (p.4). Existing notes: Pharmacology.</input>
<output>Two notes. "Pharmacology" (reusing the existing title) takes H02 and H03, with a summary that defines the field and sets its two branches against each other. "Receptors" takes H04 and H05, with a summary that names the two properties and says why the second one is what separates a receptor from a carrier protein. related on each names the other. H01 is a slide title and goes to unused_ids.</output>
<note>Five highlights, two topics, one dropped. The existing title is reused verbatim so the two highlights land in the note the reader already has.</note>
</example>
<example>
<input>Twelve highlights, of which nine are on absorption, distribution, metabolism and excretion, two are on the definition of half-life, and one is a rectangle with no text.</input>
<output>Two notes, not four. "Drug Disposition" takes the nine, because absorption, distribution, metabolism and excretion are the four stages of one process and a reader looking any of them up wants the others in view; "Half-Life" takes the two, and also takes one of the excretion highlights, since half-life is defined there. The empty rectangle goes to unused_ids.</output>
<note>Splitting one process into four notes of two highlights each would make four notes nobody opens. One highlight sits in two notes because it belongs in both.</note>
</example>
</examples>

Before returning, check your answer against the input: every id you used appears there, every id in the input appears either in exactly the notes it belongs to or in unused_ids, no note has an empty highlight_ids list, no two titles collide, every related title is one you wrote or were shown, and no summary contains a link, an id, or a fact the paper does not state.
```

</details>

### Ask

A chat panel in the Recall sidebar (toggle **Inbox | Chat** in the header,
or run **Ask the notes**), for asking questions against the topic notes the
digest has written, and for running Recall's commands without leaving the
box. It answers only from the vault.

**Retrieval** is lexical, not an embedding or a vector store: every `.md`
under the **Topic notes folder** is indexed into evidence units — every
highlight callout/embed under `## Highlights`, plus any bullet under
`## Key claims` that ends in a wikilink — scored against your question with
Obsidian's own `prepareSimpleSearch`, plus a smaller weight for a match in
the note title. The best matches (**Evidence per question**, default 12,
capped at half from any one note) are numbered `[1]…[k]`
(`src/retrieval.ts`).

**No evidence, no model.** When nothing under the topic folder matches the
question, the panel answers at once, without a model call: *Your notes
don't cover this…*, naming the question and suggesting which lecture to
digest (`noEvidenceAnswer` in `src/askCheck.ts`). A hole in the notes is
reported as a hole, not filled from memory.

**How an answer is assembled.** The model does not write the finished
answer. It returns a structured draft (`AskOut` in `src/schemas.ts`):

- `coverage`: `full`, `partial`, or `none`;
- `quotes`: the verbatim passages it relied on, each with the evidence
  number it came from;
- `sentences`: the answer one sentence at a time, each marked `claim` or
  `gap` and, for a claim, the evidence numbers that state it. The text
  carries no `[n]` markers, links, or ids.

Code then does the checking (`checkAnswer` in `src/askCheck.ts`):

- a quote is **verified** only if, after normalising case, accents, and
  punctuation, it is a substring of the evidence it cites; otherwise it is
  rejected and counted;
- a **claim** sentence keeps only citations inside the evidence range, and a
  claim with none left is **removed** and counted; when coverage is `none`
  every claim is removed, since such an answer may only describe the gap;
- a **gap** sentence is kept as written and carries no citation;
- the citations are appended by code after each kept claim (`Text. [1][3]`),
  so a sentence cannot claim something and quietly omit where it came from.

Under the answer sits a **grounding line** — for example *Grounding: partial
coverage · 3 sentences kept · 1 unsupported removed · 2 quotes verified* —
with an **unverified** badge whenever anything was removed or rejected
(setting **Show the grounding line under answers**). The verified quotes
follow as a blockquote, and the evidence list below marks the items the
answer cited. When every sentence was removed the panel says so instead of
showing an empty answer.

**Optional verify pass.** With **Verify answers with a second model call**
on, the draft goes back to the model as a checker (`VERIFY_SYSTEM`): each
sentence is judged supported only if the evidence it cited states it, and
unsupported claims are removed before assembly. It doubles the cost of a
question and is off by default. If the checker call fails, the answer is
still assembled and the failure is shown on the turn.

**Without a configured provider**, the model call fails and the panel shows
an error line — but the evidence list still appears beneath it, built and
ranked with no model involved, and the no-evidence answer above needs no
provider at all.

**Commands from the chat.** The same box runs Recall's commands
(`src/chatCommands.ts`, `src/commands.ts`):

- `/help` (or `/commands`, `/?`) lists every command with its aliases and
  whether it is available right now;
- `/extract`, `/digest`, `/export` … — a slash followed by an alias, an id,
  or a command name runs it immediately; an unknown name is reported;
- a message equal to a command's name or alias (case-insensitive, trailing
  `…` ignored) also runs it;
- a plain sentence of eight words or fewer that does not end in `?` and
  shares at least two words with a command name or alias (for example
  *extract pdf highlights*) shows a **Run** chip with an **Ask instead**
  button, so a question is never mistaken for an order;
- anything else is a question for the model.

A command that is not available (for example `/extract` with a note rather
than a PDF active) says so with its hint. Commands behave exactly as from
the command palette, modals and notices included; the chat logs that they
ran.

| Command | Aliases | Available |
| --- | --- | --- |
| Send selection to inbox | `/capture`, `/send` | needs an open note |
| Send PDF selection to inbox | `/pdf` | needs an open PDF |
| Send PDF selection to inbox with instructions… | `/pdf-instruct` | needs an open PDF |
| Send selection to inbox with instructions… | `/capture-instruct` | needs an open note |
| Send all ==highlights== in this note to inbox | `/highlights`, `/sweep` | needs an open note |
| AI-highlight this note and write cards | `/ai` | needs an open note |
| AI-highlight this note with instructions… | `/ai-instruct` | needs an open note |
| Add transcript for document highlighting | `/transcript` | needs an open note |
| Extract PDF highlights to manifest | `/extract` | needs an open PDF |
| Digest PDF highlights into topic notes… | `/digest` | needs an open PDF or manifest note |
| Digest PDF highlights from pasted model output… | `/digest-json`, `/paste` | needs an open PDF or manifest note |
| Ask the notes | `/chat`, `/ask` | always |
| Open inbox | `/inbox` | always |
| Export all reviewed cards to Anki | `/export` | always |
| Retry failed highlights | `/retry` | always |

<details>
<summary><code>ASK_SYSTEM</code> (the Ask system prompt, verbatim)</summary>

```
You answer a student's question about their own class notes, using numbered evidence taken from those notes. Each piece of evidence is something they highlighted in a lecture PDF or a claim they wrote down themselves, and it carries the note it came from and the page it was highlighted on. Your answer goes into a small sidebar beside their notes, with the evidence listed underneath it, so the reader can check every sentence you write against the passage it came from.

You do not write the finished answer. You return the passages you leaned on and then the answer one sentence at a time, each sentence saying which evidence states it, and the software assembles what the reader sees. It also checks you: a quote that is not in the evidence is dropped, and a claim that names no evidence is removed from the answer and counted. Those checks run on every answer, so treat them as the shape of the work rather than as a warning.

<answer_only_from_the_evidence>
The evidence is the whole of what you may assert. You know a great deal about most of these subjects, and none of it belongs here: the reader is revising for an exam set on this material, and a true sentence their course never taught them is one they cannot rely on and cannot trace back to a slide. If a fact is not in the evidence in front of you, it is not in the answer, however certain you are of it.

The conversation so far, when there is one, is there so that a follow-up makes sense: it tells you what "it" refers to and what has already been said. It is not evidence. Nothing said in an earlier turn may be asserted in this one unless the evidence in front of you now states it.
</answer_only_from_the_evidence>

<when_the_notes_do_not_cover_it>
Saying that the notes do not answer the question is a correct answer, and often the most useful one: it tells the reader their notes have a hole in them, which is exactly what they would want to know before an exam. It is never a failure to reach for.

Set coverage to full when the evidence answers the question, partial when it answers some of it, and none when it does not touch the question at all. A none answer is one or two gap sentences and no quotes: say what the evidence does hold and what it does not, naming what would settle the question ("nothing here gives a half-life for any drug"). Do not attach a claim to a none answer; there is nothing for it to rest on. A partial answer carries both kinds: the part the evidence settles, then a gap sentence for the part it leaves open.
</when_the_notes_do_not_cover_it>

<quotes_first>
Before you write a sentence, copy into quotes the passages your answer will rest on: the words themselves, character for character, from the evidence they appear in, with the number of that piece. Not a paraphrase, not a tidied version, not two fragments spliced with an ellipsis. The software looks each one up in the evidence you named and shows the reader only the ones it finds, so a quote you smoothed out is a quote that disappears.

Extracting them first is the point of the exercise, not bookkeeping after the fact. Finding the exact words that carry the answer is what tells you whether the answer is there at all; often the passage you were sure you remembered turns out to say something narrower, and the sentence you were about to write becomes a gap sentence instead. Keep them short, a clause or a sentence, and copy only the spans doing the work. Leave quotes empty when coverage is none.
</quotes_first>

<sentences_and_their_numbers>
Write the answer one sentence per entry, in the order the reader will read them. Do not write [1] or any other marker inside the text; the software appends the citations from the numbers you list, and a marker you typed yourself is stripped out.

A claim sentence asserts something, and it lists in cited every evidence number that states it: one number, or both when the sentence rests on two pieces. A claim whose cited list is empty is removed from the answer before the reader sees it, so if you cannot name the evidence for a sentence, either find the number or rewrite the sentence as what the evidence does say. Never invent a number: if the evidence stops at [8], there is no [9], and a sentence citing one is removed.

A gap sentence says what the evidence does not cover, and it cites nothing, because there is no passage to point at for an absence. That is the one kind of sentence that carries no numbers.

A sentence that is a list item starts with "- " and is one entry like any other.
</sentences_and_their_numbers>

<how_to_write_it>
Prefer the reader's own wording. These are their highlights, in the vocabulary their lecturer used, and an answer in that vocabulary is one they can match against the slide. Where two pieces of evidence use different words for the same thing, use the one the question used.

Be short. A few sentences, or a small list when the question asks for several things. This is a sidebar, not an essay, and the evidence is right there underneath: you do not need to reproduce it, only to say what it means for the question. Plain markdown, bold and code at most, no headings, no links, no ids.
</how_to_write_it>

<examples>
<example>
<evidence>[1] (Receptors, p.4) Receptors have 2 important properties: they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect (this distinguishes receptors from inert binding sites such as albumin, which binds and carries many drugs but does not transduce a signal).</evidence>
<question>What distinguishes a receptor from albumin?</question>
<output>Coverage is full. One quote, from [1]: "transduce a signal to produce a biological effect (this distinguishes receptors from inert binding sites such as albumin, which binds and carries many drugs but does not transduce a signal)". Two claim sentences. The first, "Both bind drugs, but only a receptor transduces a signal to produce a biological effect.", cites [1]. The second, "Albumin binds and carries drugs without transducing anything, which is what makes it an inert binding site.", cites [1] as well.</output>
<note>The quote is the span that actually carries the distinction, copied whole rather than trimmed to look neat. Both sentences rest on the same piece, so both name it. Nothing is added about albumin's structure or its other roles, true though that would be.</note>
</example>
<example>
<evidence>[1] (Pharmacology, p.2) Pharmacokinetics = what the body does to drugs. [2] (Drug Disposition, p.7) Metabolism converts drugs into more water-soluble forms for excretion.</evidence>
<question>What is the half-life of aspirin?</question>
<output>Coverage is none. No quotes. Two gap sentences, neither citing anything: "Your notes do not cover this." and "The evidence here defines pharmacokinetics and describes metabolism in general terms, but nothing in it gives a half-life for aspirin or for any other drug."</output>
<note>The gap is named rather than filled. Half-life is a number worth knowing and one you could supply from memory, which is exactly why it must not appear: the reader would have no way to tell it apart from what their lecturer taught. No sentence is a claim here, so no sentence cites anything, and there is nothing to quote.</note>
</example>
</examples>

Before you return, read each sentence back against the evidence you cited for it. Ask of every claim whether that piece of evidence, on its own, says what the sentence says, and not merely something compatible with it; if it does not, drop the sentence or turn it into a gap sentence. Check that every quote is in the evidence you attributed it to, word for word, and that every number you used is one you were given.
```

</details>

<details>
<summary><code>VERIFY_SYSTEM</code> (the verify-pass system prompt, verbatim)</summary>

```
You check an answer that has already been written. You are not the writer: you do not improve sentences, fill gaps, or suggest better wording, and no sentence changes because of what you say beyond being kept or removed.

You are given numbered evidence from a student's notes and the sentences drafted from it, each printed with the evidence numbers it cited. For each sentence, say whether the evidence it cited states what the sentence says.

Supported means stated. Not plausible, not likely, not true as far as you know, not something the cited passage is consistent with or implies to a reader who already knows the subject. If the sentence names a number, the cited evidence carries that number; if it names a mechanism, the cited evidence describes that mechanism. Evidence that is about the right topic but does not carry the sentence's claim is not support. A sentence citing nothing, or citing a number that is not in the evidence, is unsupported.

Judge each sentence only against the pieces it cited, not against the evidence as a whole: a sentence that is stated somewhere else in the list but not in what it pointed at is unsupported, because the reader will follow the citation it was given. The reason is one clause naming which words are or are not there.

<example>
<evidence>[1] (Receptors, p.4) Receptors bind ligands with relatively high affinity and transduce a signal to produce a biological effect. [2] (Drug Disposition, p.7) Metabolism converts drugs into more water-soluble forms for excretion.</evidence>
<draft>
0. Receptors transduce a signal to produce a biological effect. [1]
1. Receptor binding is saturable, so the response plateaus at high doses. [1]
</draft>
<verdicts>0 supported: [1] states transduction of a signal to produce a biological effect in those words. 1 not supported: [1] mentions affinity and transduction but says nothing about saturation or a plateau.</verdicts>
<note>The second sentence is true of receptors and would pass a reader who knew the subject. It is unsupported anyway, because the passage it cites does not say it.</note>
</example>
```

</details>

### Quiz mode

The same chat box runs retrieval-practice quizzes on your topic notes, in
the spirit of your wiki's retrieval-practice and generation-effect pages:
you produce the answer from memory, the model grades it against the
highlight, and the passage is shown after every answer. Everything comes
from the vault; nothing is asked that the evidence does not state.

| Command | What it does |
| --- | --- |
| `/quiz` | quiz on every topic note under the topic folder |
| `/quiz this` | quiz on the active note |
| `/quiz <words>` | quiz on the highlights and claims that share words with `<words>` |
| `/hint` | show the question's hint (once) |
| `/skip` | move on; the answer and passage are shown |
| `/idk` (or `idk`, `?`, an empty line) | "I don't know": the answer and passage are shown, nothing is graded as wrong |
| `/stop` | end the quiz and show the summary |

Plain phrases work too: "quiz me", "quiz me on receptors", "test me on
this note", "start a quiz about affinity"; while a quiz runs, "stop",
"skip", "next", and "give me a hint" act as the commands, and outside a
quiz those words are ordinary questions.

While a quiz runs, anything else you type that is not a slash command is your
answer. Each question is written by one model call from the frozen evidence
pool and carries a verbatim quote that code verifies against the cited
passage before the question is shown; a draft that fails is regenerated once
with the reason, then that passage is dropped. Yes/no answers are rejected.
Grading is one model call that sees only the passage, the question, the
expected answer, and yours; it returns ✓ correct, △ partly, or ✗ not quite
with feedback in the passage's own words, then the expected answer and the
passage as a PDF++ callout or quote block.

Difficulty escalates: a correct answer moves the next question from recall
(a fact) to why (a mechanism) to distinguish (what separates two similar
things); a wrong answer keeps the level and re-asks the same passage from
another angle once. Five questions by default (**Questions per quiz**),
retries included. The summary shows the score and the missed passages with
two chips: **Send N missed to inbox**, which hands those passages to the
card writer, critique, and linter like any capture (they arrive with the
origin "quiz miss"), and **Quiz again**.

Settings: **Questions per quiz** (5), **Evidence pool per quiz** (20
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
The expected answer must be stated in the evidence you cited, and the passage that states it goes into quote, copied character for character from that piece: the words themselves, not a paraphrase, not a tidied version, not two fragments spliced with an ellipsis. The software looks the quote up in the evidence you named, and a question whose quote is not found there is thrown away and asked again, so a quote you smoothed out is a question the reader never sees.

Finding that passage first is also how you tell whether the question is askable. If you cannot point at the words that answer it, the evidence does not answer it, and you should be asking something else about the same passage.
</the_answer_must_be_in_the_evidence>

<what_makes_a_question_worth_asking>
Five properties, each of which rules out a common failure:

Focused: ask about one detail, not three, so the reader's attention lands in one place instead of being split across a list.
Precise: ask so that you and the reader agree on what is wanted; a vague question gets a vague answer that nobody can grade.
Consistent: ask so that the same question would draw the same answer every time, not one of several defensible ones.
Tractable: ask something a reader who studied this passage would get right; obscurity is not difficulty.
Effortful: ask something that requires retrieval rather than recognition, inference from the wording, or a guess.

Never ask a yes/no question, and never one whose answer is a choice between two things you named. Half of those are right by luck, and the reader learns nothing from a coin that lands well. If the answer you are about to write is "yes" or "no", the question is wrong, not the answer.

Never give the answer away in the wording. A question that contains the term it is asking for, or that describes the mechanism and then asks what it is called, is answered by reading it. The reader's own vocabulary is fine and preferred; the answer itself is not.
</what_makes_a_question_worth_asking>

<difficulty>
You are told which tier to write at.

Difficulty 1 is recall of one fact: a definition, a number, a name. Set kind to recall.
Difficulty 2 is a mechanism or a reason: why something happens, or how it works. Set kind to why.
Difficulty 3 is a distinction or an application: what separates two similar things, or which case a rule applies to. Set kind to distinguish.

The tier describes what is asked, not how obscure it is. A difficulty 3 question is still answerable from the passage in front of you by a reader who studied it; it just asks them to do something with it rather than repeat it.
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
<output>question: "What are the two properties that define a receptor?"; answer: "Binding ligands with high affinity, and transducing a signal to produce a biological effect."; evidence_n: 3; quote: "they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect"; hint: "One is about what it attaches to, the other about what it does next."; kind: "recall".</output>
<note>The quote is the span that carries the answer, copied whole. The question names the subject so it is answerable without the passage in view, and it does not contain either property, so reading it gives nothing away. The hint points at the shape of the answer without naming affinity or transduction.</note>
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

Quote the passage that settles the grade, copied character for character from the evidence, not paraphrased. It is checked against the evidence and shown only if it is found there, which is what lets the reader overrule you when they think you were wrong.
</feedback_and_quote>

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
<question>What are the two properties that define a receptor?</question>
<expected_answer>Binding ligands with high affinity, and transducing a signal to produce a biological effect.</expected_answer>
<student_answer>they bind to ligands</student_answer>
<output>verdict: "partial"; feedback: "Binding ligands with high affinity is one of the two; the other is that they transduce a signal to produce a biological effect."; quote: "they bind ligands with relatively high affinity, and they transduce a signal to produce a biological effect".</output>
<note>Half of what was asked for, so partial rather than incorrect. The feedback names the missing half in the evidence's words and stops there, without explaining what transduction is.</note>
</example>
</examples>

Before you return, check that your verdict rests on what the evidence states and not on how the answer was phrased, that every fact in your feedback is in the passage, and that the words in quote appear in the evidence exactly as you copied them.
```

</details>

**Settings**, all in Settings → Recall:

| setting | default | effect |
| --- | --- | --- |
| Manifest folder | `recall-manifests` | where one manifest file per PDF is written |
| Topic notes folder | `classes` | topic notes go to `<folder>/<class code>/<title>.md` |
| Max topic notes per PDF | 6 | caps how many topics the model may return per digest |
| Paper text limit | 60,000 characters | how much of the PDF's text is sent for the summary, cut at a sentence boundary |
| Standing instructions for the digest | *(empty)* | appended to every digest prompt |
| Evidence per question | 12 | how many ranked evidence units Ask sends per question |
| Conversation turns kept | 10 | how many prior turns Ask keeps for follow-ups |
| Standing instructions for Ask | *(empty)* | appended to every Ask prompt |
| Verify answers with a second model call | off | re-checks each drafted sentence against its cited evidence before assembly; doubles the cost of a question |
| Show the grounding line under answers | on | the coverage / kept / removed / verified summary and the unverified badge |
| Questions per quiz | 5 | graded questions per `/quiz` session, retries included |
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
- Grounding is checked one sentence at a time: a claim can cite evidence
  that is only loosely related and pass. The optional verify pass tightens
  this at the cost of a second call. Best-of-N sampling is not implemented.
- Quote verification is a normalised substring check, so a paraphrase is
  rejected even when its meaning is in the evidence. That is intended.
- Digest, Ask, the verify pass, and the card writer have each run live
  through the Claude Code provider (2026-09-12); the digest command's modal
  flow and an export have not been driven in that session.
- Handwritten professor annotations on scanned decks are images, not
  extractable text, and are out of scope.

**Where the Karpathy LLM Wiki plugin fits.** It is a consumer of the notes
this feature writes, never their producer. Its ingest pipeline only writes
`entities/`, `concepts/`, and `sources/` pages from a fixed prompt with no
custom page template, converts a whole PDF to markdown rather than reading
its annotations, and reports provenance at the source level only (never a
page or a selection) — none of which is what a PDF++-highlighting workflow
needs. Recall's topic notes are ordinary markdown with wikilinks, so once
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
sits at (`src/llm.ts:44-58`, `src/llm.ts:162-237`). It checks grounding
(every answer and cloze deletion must be stated in the highlight), whether
the cards interfere with each other (two cards whose questions read alike
but want different answers, or that share an answer), and near-tautology
(an answer that just restates a word already in the question)
(`src/llm.ts:174-193`). A `revise` verdict replaces the card's fields and
records the reason on `critiqueReason`; a `drop` verdict does not delete
the card — it sets `status: "flagged"` and keeps the reason attached
(`src/generator.ts:95-110`). If the critique call fails (network, quota),
the drafted cards are kept as written and simply skip critique rather than
being lost (`src/generator.ts:112-117`). To avoid spending a model call on
a highlight that clearly doesn't need one, the critique is skipped when a
highlight drafts zero or one card and that one card already lints clean
(`src/generator.ts:82-84`).

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
(`src/llm.ts:185`, `src/model.ts:31-32`).

**Deterministic lint** (`src/lint.ts`) runs on every card regardless of
whether the critique is on, both on the freshly drafted cards and again on
any card the critique revised, since a revision changes the text the
grounding check needs to see (`src/generator.ts:79`, `:105`). It is pure
regex- and word-count-based, no model call. Nine checks can fail a card:

| id | what it catches |
| --- | --- |
| `cloze-not-grounded` | a `{{cN::…}}` deletion whose text isn't found in the highlight |
| `cloze-count` | a cloze card with fewer than 1 or more than 3 distinct deletions |
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
`lintFailures` and a critique rejection (`src/inboxView.ts:615`, `:626`).
`duplicate-card` (this card repeats a sibling drafted in the same batch)
and `shared-answer` (two Q&A cards in the same batch have the same
answer, which risks confusing them in review) are computed per batch and
stored on the card as `lintWarnings` (`src/generator.ts:126-127`).
`cross-interference` is different: rather than being computed once per
batch, the inbox recomputes it on every render over every pending card
under every ready highlight across the whole inbox, the same population
`pendingItems` uses in `src/main.ts` (`findCrossInterference` in
`src/lint.ts:136`, `rebuildCrossInterference` in
`src/inboxView.ts:155-167`). It badges two cards from *different*
highlights whose normalized answer or cloze text collide (same kind
only), naming the other card's note in the tooltip; because it's derived
rather than stored, binning or exporting one partner clears the other's
badge on the next render. Labels for all twelve ids, shown in the inbox,
live in `LINT_LABELS` in `src/lint.ts`.

**The three settings**, all in Settings → Recall → Card quality:

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
chain ever deletes a card (`src/settings.ts:99-101`).

The cost of turning the critique on is time, not capture speed: it is one
extra model call per highlight, so cards take longer to appear after you
send a highlight. Capture — selecting text, dragging with the highlighter,
sending a PDF selection — is unaffected either way, because everything
above happens in the background queue after capture has already returned
(`src/settings.ts:279`).

A **flagged** card (`status: "flagged"`) is one the critique dropped or
that failed lint under a mode other than "badge only". It stays in the
inbox with its reason attached rather than being deleted — nothing is
silently thrown away — but it is excluded from export: only cards with
`status === "pending"` are ever sent to Anki, whether through AnkiConnect
or the text-file fallback, so a flagged card cannot reach Anki until you
review and fix it (`src/model.ts:9`, `src/main.ts:284-292`).

### Triage

Open the inbox from the ribbon, the status bar (`Recall ✎ 2 · ⧉ 7` = 2
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
  [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on. Recall
  talks to it through Obsidian's own request layer, so no CORS origin needs
  whitelisting. Duplicates are checked per deck before adding.
- **Text file** (fallback): *Inbox menu → Export reviewed as Anki text file*
  writes a tab-separated file with `#notetype`/`#deck`/`#tags` directives into
  `recall-exports/`; import it with *File → Import* in Anki.

Cards are tagged `recall` and `source::<note-slug>`. The `source::` tag is the
namespace the Anki Wiki Sync add-on resolves back to vault pages, so synced
deck pages link to the note the card came from. The extra field carries the
verbatim highlight and an `obsidian://` link to the source.

## Setup

1. Settings → Recall → **Provider**. Three options:
   - **Codex (ChatGPT subscription)** — no API key. Recall runs OpenAI's
     Codex CLI (`codex exec`) signed in with your ChatGPT account. Leave
     *Codex CLI path* empty and Recall finds `codex` on the PATH or the copy
     bundled inside the ChatGPT desktop app
     (`/Applications/ChatGPT.app/Contents/Resources/codex`); otherwise paste
     the output of `which codex`. Sign in once through the ChatGPT app or
     `codex login`. Default model `gpt-5.5`; effort levels the model does not
     support are rounded down. Each request runs in a throwaway temp folder
     with a read-only sandbox, `--ephemeral` (no session files) and
     `--ignore-user-config` (your `~/.codex/config.toml` hooks, plugins and
     MCP servers are not loaded), so the agent never sees the vault.
   - **Claude Code (Claude subscription)** — no API key. Recall runs the
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
     Recall reads `ANTHROPIC_API_KEY` from the environment or from the macOS
     keychain (a generic password whose service is `ANTHROPIC_API_KEY` or
     `Recall Anthropic API key`). The keychain route keeps the key out of
     `data.json`, which iCloud syncs in plaintext:
     `security add-generic-password -s ANTHROPIC_API_KEY -a recall -w`.
     Default model `claude-opus-5`.

   Effort defaults to `high` (highlights are small, so this is cheap). Click
   **Test** to confirm the provider answers.
2. Open Anki, then Settings → Recall → **Detect** note types. Recall prefers
   `Janus - Basic (v2)` / `Janus - Cloze (v2)` when present, otherwise
   `Basic` / `Cloze`, and maps the front/back/extra fields.
3. Pick a default deck (the inbox header lets you change it per session).

## Development

```
npm install
npm run dev            # watch build → main.js
npm run build          # type-check + minified bundle
npm test               # unit tests for the pure helpers
npm run install:vault  # build and copy into the vault's .obsidian/plugins/recall
```

State: settings in `data.json`, the inbox in `inbox.json`, both inside the
plugin folder. Notes are only touched when you choose to mark highlights.

Layout:

- `src/capture.ts` — selection / reading-view / PDF / `==highlight==` / AI-highlight capture
- `src/highlighter.ts` — highlighter mode (drag-to-capture gesture, ribbon toggle)
- `src/pdf.ts` — reads a selection out of Obsidian's pdf.js viewer (and, for the digest, opens a PDF with Obsidian's bundled pdf.js)
- `src/pdflink.ts` — PDF++ link grammar: parse and render `#page=…&selection|annotation|rect…` subpaths, callouts, and find PDF references in markdown
- `src/pdftext.ts` — pdf.js text geometry: annotation quads → text, `selection=` → text, page text
- `src/manifest.ts` — the highlight manifest: merge, order, ids, render and parse
- `src/pdfHighlights.ts` — collects a PDF's highlights (backlinks + embedded annotations) into a manifest; paper text
- `src/topicNote.ts` — topic note render/parse, merge by highlight key, digest planner
- `src/digest.ts` — the extract and digest commands' flow (model or pasted JSON, preview, write, flashcards)
- `src/retrieval.ts` — Ask: evidence index, lexical ranking, citation check, evidence rendering
- `src/chatPanel.ts` — the Chat half of the sidebar
- `src/askCheck.ts` — Ask answer assembly: quote verification, citation appending, unsupported-claim removal, the grounding report
- `src/commandTable.ts` — the fifteen commands as pure data (ids, names, aliases, hints)
- `src/commands.ts` — their availability checks and bodies; `main.ts` registers them in one loop
- `src/chatCommands.ts` — `/slash`, exact-name, and Run-chip matching for the chat box
- `src/quiz.ts` — quiz sessions: scope, frozen evidence numbering, grounded question checks, grading state, difficulty, rendering
- `src/schemas.ts` — zod output schemas for the digest and Ask (pure, so tests can bundle them)
- `src/pdflink.ts` — parses and renders PDF++ links, subpaths, and callouts
- `src/pdftext.ts` — quad-to-rect, selection-to-text, and page text over pdf.js text content
- `src/pdfHighlights.ts` — collects a PDF's highlights (backlinks + embedded annotations) into a manifest
- `src/manifest.ts` — the manifest model: render, parse, merge, sort/assign ids
- `src/topicNote.ts` — topic note render/parse/merge and the digest planner
- `src/retrieval.ts` — Ask's lexical evidence index, ranking, and citation check
- `src/digest.ts` — digest orchestration: manifest/model/paste in, topic notes out
- `src/chatPanel.ts` — the Ask chat panel owned by the inbox view
- `src/schemas.ts` — pure zod schemas (`CardsOut`, `HighlightsOut`, `DigestOut`, `AskOut`) shared by `llm.ts` and the pasted-JSON path
- `src/llm.ts` — prompts, zod output schemas, provider dispatch, error text
- `src/backend.ts` — the `LlmBackend` interface (`probe`, `complete`, `abort`)
- `src/anthropic.ts` — Anthropic backend (SDK over Obsidian `requestUrl`, native structured outputs)
- `src/codex.ts` — Codex backend (`codex exec --json --output-schema` over stdin, JSONL parsing, effort clamping)
- `src/claudeCli.ts` — Claude Code backend (`claude -p --json-schema` with the prompt on stdin; structured output read from the JSON envelope)
- `src/keys.ts` — Anthropic API key resolution (settings → environment → keychain)
- `src/generator.ts` — background queue
- `src/inboxView.ts` — the inbox and the Ask chat panel's host (Inbox | Chat toggle)
- `src/anki.ts` — AnkiConnect client, note building, export
- `src/store.ts`, `src/model.ts`, `src/util.ts`, `src/settings.ts`, `src/modals.ts`
