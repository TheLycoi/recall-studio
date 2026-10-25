---
type: implementation-plan
status: in-progress
created: 2026-10-24
---

# Recall review fixes and quality gate

Conrad authorized implementation with Sol workers, cross-review, verification before pushing, and installation through BRAT after publication. Scope covers all 15 findings in [[projects/recall/outputs/full-code-review-2026-10-24]], automatic pre-Inbox correction, and the user's correction that cards lack context. The earlier design's proposal-only and no-release limits are superseded by this authorization.

## Baseline and ownership

- Source repository: `TheLycoi/recall-studio`, repository ID `1363497772`.
- Exact base: `43b330f2f30625430fab5b434dc978aa20f775be`, a clean successor of installed `0.1.15` (`f1e8c78fdf51fa1864aacba3a0bf2772e6f411bc`). Preserve the successor's evidence inspector, export summaries and deduplicated explanations.
- Running target: `academicwiki`, plugin ID `review-inbox`. BRAT registration and frozen `0.1.15` version verified at task start.
- Worker runtime: `gpt-6.1-sol` on `openai-codex`, verified from current delegation configuration.
- Isolated worktrees: `/Users/conradkelonu/.hermes/cache/scratch/recall-remediation-2026-10-24/{integration,learning,generation,editor,export,lifecycle,diagnostics}`. Each starts at the exact base. Dependencies match the base lockfile.
- Parent alone integrates, edits vault tracking, pushes, publishes and installs. Workers commit explicit source/test paths only. No worker may change live vaults, export to Anki, invoke a paid provider or publish anything.

## Fix assignments and acceptance

| Owner | Finding or request | Proposed fix and required regression |
| --- | --- | --- |
| learning | 1: missing spaced-ID proposals | Round-trip actual observer output, read legacy spaced IDs and collapse duplicate open occurrences without losing decision history. |
| editor | 2: split rewrite unsupported | Implement a validated bounded array response for explicit rewrites, with a one-card compatibility path for repair/convert. Keep the original until all replacements pass; distinct fresh unexported IDs for split drafts; no old receipt inheritance. |
| learning | 3: wrong occurrence stamped | Separate pattern identity from proposal occurrence; accept/dismiss the selected open occurrence, retaining historical decisions. |
| learning | 4: overlapping duplicate learning | Serialize the full transaction or recheck inside atomic mutation; return the count actually inserted. |
| learning | 5: reversed edits counted | Count distinct cards with retained net corrections; undo and repeated editing must not manufacture support. |
| learning | 6: contradicted pending rules | Reconcile pending suggestions and revalidate acceptance; retain deliberate custom wording, never rewrite previously accepted rules. |
| learning | 7: other suggestion draft lost | Preserve each proposal's unsaved wording across another row's Accept/Dismiss. |
| learning | 8: failed action strands buttons | Catch failures, explain partial outcomes, retain wording and restore controls for retry. |
| learning | 9: partial Accept duplicates rule | Persist occurrence identity with acceptance; retry finishes the missing stamp, without appending/counting twice. |
| editor | 10: stale manual Save | Compare editor-open content before plain Save as well as rewrite; preserve conflict drafts without imposing model-only lifecycle gates on manual edits. |
| editor | 11: saved manual correction not learned | Learn a successful manual save despite later rewrite failure/unchanged output; avoid duplicate calls on full success. |
| export | 12: stale content marked exported | Verify existing Anki note content against the exact serialized draft; report mismatch without overwrite or exported status. Preserve safe matching retries. |
| lifecycle | 13: migration failure strands history | Fail closed or retain recovery state; a new save cannot bypass failed legacy migration. Test restart and eventual successful recovery. |
| lifecycle | 14: startup after unload | Guard deferred and awaited startup boundaries with instance lifetime; no generator restart, rule write or leaf migration after unload. |
| diagnostics | 15: provider secrets in errors | Sanitize every provider-controlled error surface, including thrown transport errors and CLI events, before display/persistence. Test synthetic credentials and benign diagnostics. |
| generation | Automatic repair before delivery | Stage drafts privately, audit, repair rejected candidates once, independently recheck, publish only verified candidates. Hold unresolved drafts/reasons for explicit retry; no automatic preference evidence. |
| generation | Context-poor atomic cards | Require a self-contained front naming the subject and necessary conditions. Keep one meaningful retrieval target; preserve relationships and short procedures. Do not strip context to satisfy arbitrary word limits. Extra/source links do not substitute for front context. |

## File boundaries and dependencies

- Learning owns `preferences.ts`, `schemaNote.ts`, `schemaFile.ts`, suggestion UI in `modals.ts`, their focused tests and small new supporting modules.
- Generation owns `generator.ts`, `generation.ts`, generation fields in `model.ts`, lint/rubric changes, generation request assembly in `llm.ts`, and corresponding tests. It must leave the rewrite response schema/method to the editor worker. The parent adds blocked-stage UI once the actual state contract is available.
- Editor owns `inboxView.ts`, explicit rewrite action helpers, rewrite response schema/method in `llm.ts`, and rewrite/editor tests. It must leave generation request assembly and shared rubric changes to generation. Separate worktrees prevent shared working-tree writes; parent resolves any shared-file textual overlap explicitly.
- Export owns `anki.ts`, export identity helpers and export tests. Prefer comparing actual remote fields to the outgoing serialized snapshot over adding a new persisted receipt format. Coordinate any unavoidable model change with the parent.
- Lifecycle owns `store.ts`, `main.ts` and focused store/plugin lifecycle tests. Generation owns `generator.ts`; communicate needed changes rather than editing that file.
- Diagnostics owns `deepseek.ts`, `codex.ts`, `opencode.ts`, shared diagnostic helpers and their tests. Do not modify `llm.ts`; report any required boundary change to the parent.
- Parent owns release metadata, canonical project records, blocked-state UI integration, all merges and final acceptance. No editing of `wiki/` or live rules/card content.

## Generation and rewrite constraints

Use [[projects/recall/outputs/automatic-quality-design-2026-10-24]] as the detailed quality design, including the context correction. The user-approved split fix expands its earlier blocked-split limitation for explicit rewrites, not permission to rewrite old cards automatically.

Mandatory independent audit replaces bypass through the legacy critique setting. A provider error or missing/duplicate verdict is not approval. Deterministic syntax, rendered answer-leak and grounding checks remain gates; warnings need adjudication rather than blind shortening. Use captured source, rules, plan/fact links and siblings for repair. Preserve the original staged draft on failure. Retain stable IDs/checkpoints and audit history; check cancellation, source, rules, settings, sibling state and lifetime before dispatch and after awaits. Do not automatically rerun unknown-outcome paid calls after restart. Surface blocked counts and an explicit retry without making unresolved drafts editable/exportable as normal cards.

Use the existing source-grounded writer and shared rubric. No new retrieval engine, provider, scheduling system, note export, automatic existing-card repair or broad cleanup.

## Execution and review gates

1. Each worker reproduces its defect with a failing production-module test, implements the smallest complete fix, runs focused tests/build/diff checks, and commits only owned paths. Save RED/GREEN evidence and report limitations. A baseline defect assertion that passes is not a fixed-behavior test.
2. Parent reads each actual commit/diff and reruns the focused suite. Integrate accepted commits into the isolated integration branch. Resolve shared `llm.ts` edits without losing either caller contract.
3. Independent Sol cross-reviewers inspect other workers' changes on the combined candidate. First check requirements, then correctness, security, persistence and regressions. Require actionable findings or explicit approval tied to exact commit/hash. Fix findings and re-review changed areas; do not count author self-review as independent review.
4. Parent runs the full test suite, production build and diff checks; independently probes each of the 15 defects and the new generation/context contracts. Run quiet synthetic host checks against actual classes without touching user cards or invoking Anki. Separate synthetic safety evidence from real-model quality claims.
5. Recheck live installed version and candidate ancestry. Bump the next unused release version consistently, update changelog/docs, and verify the exact final candidate again. Never publish a candidate with unresolved acceptance failures.
6. Push the verified branch and tag, read back their exact SHAs, require successful exact-head release CI, compare draft assets with the accepted build, publish the same draft and compare downloaded published assets again.
7. Require idle generation/provider work and no active card editor. Privately snapshot current settings, stored cards/rules and interaction state. Inspect and use BRAT's actual private-repository pinned-version update route. Recheck state immediately before reload; preserve newer user edits rather than restoring stale snapshots.
8. Read back BRAT registration/pin, installed asset hashes and loaded runtime version. Exercise installed-class changed paths and verify settings, card identities, revisions, source/editor state and no synthetic residue. Report evidence and remaining untested areas accurately.

## State preservation and stopping rules

The projects vault has an unborn HEAD and unrelated staged files. Preserve its index byte-for-byte. Commit implementation and a plan copy in the source integration branch; do not sweep unrelated vault files into a first commit.

No real Anki writes or automatic changes to existing cards are needed for this release. No paid card-model calls are authorized to workers. If local deterministic and host tests cannot settle semantic quality, report that limitation rather than inventing live results. Stop publication/installation on a failed review, failing exact candidate, unsafe reload, missing credentials or active user state that cannot be preserved. Keep bounded review rounds and record remaining blockers instead of starting unrelated refinements.
