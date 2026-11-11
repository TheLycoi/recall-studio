# Changelog

## 0.1.30 beta: remove unfinished Learn integration and repair failure boundaries

Remove the unfinished LearnHarness pane, its commands, settings controls and
installer. Remove the unsafe direct-copy installer and the obsolete host probe
for retired Verify/rule-learning controls. Saved settings, external LearnHarness
files, shared readers and existing study records are not migrated or deleted.

Reject failed or cancelled CLI runs even if they emitted valid text. DeepSeek
cancellation now releases pending local work without waiting for remote HTTP.
Provider schema errors and unexpected generation failures use fixed diagnostics.

Refuse export when acceptance cannot be saved. Detect conflicting store writes
instead of replacing newer data; preserve unsupported future inbox snapshots.
Validate legacy topic links and Basic field mappings. Bind exports to the accepted
settings and payload, retain completed text-file receipts across partial failures,
and preserve those receipts when an explicit rewrite forks a replacement.

Keep unresolved source concerns through duplicate audit envelopes and refuse
wording rewrites until those concerns are resolved. Reader, writer and grader
prompts, Restore default, one-sentence defaults and bounded split repair remain.

Refresh the Obsidian development-dependency chain. Verification uses synthetic
transports and vaults; it does not measure live-model quality or certify native
Obsidian/Anki behavior. This release does not install itself.

Earlier version notes remain in Git history and GitHub releases.
