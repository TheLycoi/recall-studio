# Changelog

## 0.3.1

Fixes the Spaced Repetition export, which wrote its note but never marked the
cards it had written.

- **Cards now leave the inbox when they are sent to Spaced Repetition.** The
  export wrote the note, recorded its path on each card, and stopped there, so
  every card stayed `pending`. Two consequences, both visible in a vault: the
  highlight stayed "ready" and never finished, and pressing the command again
  wrote a second note holding the same cards. The Anki path had always flipped
  `status` to `exported`; the Spaced Repetition path was missing it. This is the
  one-destination-per-card rule the Anki export already followed.
- The export is now covered by tests that run the real function, which is what
  the earlier work lacked. Its serialization had been verified against the
  target plugin's own parser, but the export itself was never executed, so the
  missing status transition had no test at all. `test/spacedExport.test.mjs`
  drives `exportToSpacedRepetition` against a stubbed vault and asserts the note
  is written, the cards are marked, the highlight is finished, and a second send
  writes no second note.
- Nothing else changed. The serialization, the note format, the folder, the
  deck tag, and the refusals are as they were.

## 0.3.0

OpenCode joins Codex and DeepSeek as a provider. Pick one under Settings → Card writer.

- Provider setting: **Codex** (the CLI, on your ChatGPT sign-in, no key), **DeepSeek** (the API, with a key), or **OpenCode** (the opencode CLI, which owns its own credentials, so Recall holds no key for it). Switching takes effect on the next call, with no reload.
- OpenCode runs `opencode run`, so any model that CLI can reach is available, in the `provider/model` form `opencode models` prints. The model list is loaded by Test, and a keyed provider's models only appear in it once that provider has a key.
- The run is locked down. OpenCode's default agent allows every action, so every call runs under an agent Recall defines as deny-everything, in a scratch directory outside the vault. A prompt asking to read a file is refused at the tool layer rather than merely discouraged in the prompt.
- Sessions are cleaned up, failures included. `opencode run` writes a session row, and each run's id comes back in its own event stream, so it is deleted as the run ends rather than after the answer is read. The order matters: cleanup runs before the failure paths throw, because a failed run is exactly the case that would otherwise leave a row behind on every error. Card writing fires per highlight, so leaving them would fill the reader's session list.
- Structured output reuses the DeepSeek path: the zod schema is described in the prompt and the answer is validated locally, so a malformed answer is a reported failure and never a bad card.
- Failures name the fix: a binary that is not where the setting says, an opencode too old to have `--format json`, a model the machine does not serve, and a provider that is not signed in each say what to do about them.

## 0.2.0

DeepSeek joins Codex as a provider. Pick one under Settings → Card writer.

- Provider setting: **Codex** (the CLI, on your ChatGPT sign-in, no key) or **DeepSeek** (the API, with a key). Switching takes effect on the next call, with no reload.
- DeepSeek: JSON-mode structured output validated against the same schema Codex uses, so a malformed answer is a reported failure and never a bad card. Thinking is always on; `low`, `high` and `max` map straight through, and `medium` and `xhigh` land on `high`, which is the level DeepSeek maps them to.
- DeepSeek key resolution: the settings field, then `DEEPSEEK_API_KEY` in the environment, then the macOS keychain under `DEEPSEEK_API_KEY` or `Recall DeepSeek API key`. The keychain keeps the key out of `data.json`, which a synced vault replicates in plaintext.
- Failures name the fix: a rejected key, an empty balance, a rate limit, an overloaded API, and a model id the API does not serve each say what to do about them. An empty answer under JSON mode is retried once, and a truncated one is reported as its own error rather than as broken JSON.
- Settings text and the README now describe both providers.

## 0.1.0

First version. Recall is the card, inbox, Anki and quiz half of WikiLM 0.17.0 as a plugin of its own.

- Cards: capture a selection from a note or a PDF, with or without instructions. Highlighter mode. Sweep every highlight in a note.
- Inbox: review, edit, flag, retry.
- Anki: export through AnkiConnect, or to a text file when Anki is closed.
- Quiz: one free-response question per section of a wiki page, marked against an answer key. Misses can become cards.
- Model: the Codex CLI with a ChatGPT sign-in. No API key.
- Recall reads the wiki folder and never writes to it.
