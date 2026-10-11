# Changelog

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
