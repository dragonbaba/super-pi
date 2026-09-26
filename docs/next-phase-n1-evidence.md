# N1: preview and recovery evidence

Status: **实现中**. This record does not claim complete N1 acceptance.

## Baseline and environment

- Base: `4f547535b830c15d3a9605574c229a0641f94923`.
- Task worktree: `D:/RMProjects/Pi-next-phase-n1`.
- Windows host; default Node 26.4.0. Task-specific Node 22.19.0 downloaded from
  nodejs.org and used for checks; native SQLite ABI smoke test passed. Linux
  execution must be separately observed.
- Artifact directory: `D:/RMProjects/Pi-next-phase-artifacts`; raw logs stay outside
  the repository. No paid provider requests or user-project mutation fixtures.
- Pre-existing `file_batch` dryRun returns only a preflight summary; expanded
  renderer currently repeats the text summary and ignores per-item patches.

## Planned production path and ownership audit

`Agent.beforeToolCall` → extension runner → `BatchInvocation.prepare` → existing
Session permission controller → final authorization consume → sorted mutation
queue → revalidation → preview or existing commit cores → aggregate tool result
→ Agent/Session → `ToolExecutionComponent` → batch renderer → `Text` → TUI layout
→ terminal frame queue → terminal writer → component/session release.

Preparation owns reservations and temporary before/candidate values. The result
owns only bounded preview strings and existing receipt data. No preview is a
mutation receipt, snapshot, authorization attachment or read evidence. Progress
does not construct per-item trees. Completed presentation is computed once outside
render; component caches must release derived references on final unmount.

## Acceptance ledger

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Actual bounded dryRun previews; no effects/evidence | 已实现待验证 | Four new fixtures failed on baseline; five current cases pass locally |
| Per-file TUI expansion and bounded retained references | 已实现待验证 | 20k updates, ten releases, zero stable-render text changes |
| `/changes` Session pairing, verification and remaining draft | 已实现待验证 | Eight targeted cases, including real default SDK Session/reopen |
| Full Windows checks, minimum Node, allocation gates | 实现中 | Targeted tests/check/hot passed; full candidate checks pending |
| Linux checks and latest-head review | 实现中 | Initial slice CI passed both platforms; two P2 findings fixed; final-head rerun pending |

## Task-cost baseline fixture

`tests/next-phase-cost.test.ts` uses an offline OpenAI-compatible provider serializer
with a fake fetch transport. It loads the real extension bundle and tool-discovery
policy, executes actual SDK Session/Agent tools, and compares one call per response,
multiple calls per response and one batch at 1/4/16 files. Batch discovery is a real
request and is counted. Input is measured from serialized request bodies using
`o200k_base`; output is an estimate of fixture deltas, not provider billing/usage.
No live network provider or credentials are used. The initial fixture covers
successful creation only; it is not the complete N4 task matrix.

Five independent baseline processes passed before existing production paths were
modified. At 16 files, T1/T2/T3 sent 17/2/3 requests, with input estimates around
47,662/5,403/8,829 tokens respectively. T3 includes one discovery request. Thus
batching does not beat multiple single-file calls in one response on this fixture.
These are request-body estimates, not actual charges or a general performance claim.

## Initial slice verification

- `node --experimental-strip-types --test tests/file-change-preview.test.ts tests/file-batch.test.ts`:
  23 passed, 1 skipped (case-sensitive distinct-file test on Windows).
- Mutation contract, batch native evidence and actual SDK mixed Session suites:
  67 passed, zero skipped. Mixed Session exercised 25 calls, 13 approvals, both
  Windows Bash/PowerShell backends and disk reopen; pending tools and final
  authorizations were zero.
- `check` and `test:hot`: passed. No invariant was removed or weakened.
- Existing full tool-leaf allocation benchmark passed on the base; raw report is
  `baseline-tool-leaf.json` in the task artifact directory.
- `SP_PREVIEW_PROFILE=1 node --expose-gc --experimental-strip-types --test --test-name-pattern 20k tests/file-change-preview.test.ts`:
  20,000 updates, ten retained-owner releases, zero remaining derived characters;
  sampled allocation 472,032 bytes (23.60 bytes/update, including lifecycle work).
  Controlled-GC heap was 45,256,440 before and 45,840,704 after; this includes
  inspector/JIT/test ownership and is not a claim of zero whole-process retention.

The release hook uses a shared, versioned symbol because bundled extensions and
the source host load in different module scopes. It carries only derived UI
cleanup, never authorization. The stable render path allocates no inline closure,
Promise, AbortController, result wrapper, array, hash or diff. Width changes use
the existing Text layout cache. No pool or terminal-frame change was introduced.

Five independent Node 22.19.0 preview profile processes then passed. Sampled
bytes/update were 22.6984, 23.6732, 21.0092, 22.4976 and 20.9216 (median 22.4976).
Every run delivered 20,000 updates across ten owners, with zero stable-render text
changes and zero retained derived characters after release. Controlled-GC process
heap increased by 0.55–0.56 MiB including profiler/JIT/test lifetime. This is release
evidence for the measured owners, not a whole-process leak or speedup claim. The
existing full tool-leaf allocation benchmark and the added AST gate also passed.
These profiles measure the working candidate before its final commit.

The second slice adds `/changes` through the existing permission extension. Its
list is capped at 128 items from 512 Session entries. Viewing, verification and
drafting do not call a provider or execute a mutation. Verification checks current
scope/identity, hashes at most 32 MiB with a 64 KiB buffer, and persists a small
versioned Session entry. Partial/unknown outcomes require observation but never
become automatically replayable. Draft placement preserves concurrent user input.
The actual default SDK Session regression uses genuine offline Agent messages;
host-only dispatch deliberately redacts arguments and cannot serve as reconstruction
evidence. Missing or ambiguous original requests are refused.

Review of `7704a6e33c69389729fa165b261f912802c4f4b1` found two valid P2 issues:
overwrite preview growth could bypass the pre-stat bound, and planned parents were
not displayed. The candidate now opens a bounded handle, verifies its object/size,
reads at most initial size plus one sentinel byte, and renders deduplicated planned
parents. A deterministic handle-stat growth fault verifies rejection before any
post-growth read. The zero-mutation counter fixture now includes a real-create
positive control and synchronizes native module bindings so a detached mock cannot
falsely prove zero effects.

The initial full local suite passed, but source work continued while it ran, so it
is development feedback rather than final-head acceptance. Final N1 checks, both
platforms and review must be rerun against the completed candidate. Partial-read
exact diffs currently use an explicit bounded-summary fallback. Host-redacted
arguments and legacy alias paths without pairing remain unreconstructable; these
limitations are visible rather than guessed.

Draft PR: [#47](https://github.com/dragonbaba/super-pi/pull/47). Initial candidate
`7704a6e33c69389729fa165b261f912802c4f4b1` received an actual Codex review and
[successful Linux/Windows CI](https://github.com/dragonbaba/super-pi/actions/runs/36251336745).
The second slice's six targeted suites passed 99 tests, with one Windows
case-sensitivity skip. Check, offline build and hot-path gates passed locally.
This older CI does not validate the added recovery command.

The completed second slice `a7b5e41c11a7d9a410f722ecc7e00c792c062c34` then passed
Windows Node 22.19.0 check, offline build, hot gates and the full suite with the
worktree fixed at that commit. Its exact-head preview profile/tool-leaf gate and
[Linux/Windows CI](https://github.com/dragonbaba/super-pi/actions/runs/36253075251)
also passed. Actual review found three further P2 issues in recovery pairing and
observation. The follow-up requires a unique preceding call and ordered intervening
v2 intent/preparation, rechecks all observed identities/absence before accepting
verification, and refuses relative legacy receipts with unknown originating cwd.
New single-file results record canonical targets. Six regression suites now pass
102 tests with one Windows case-sensitivity skip; final-head gates and review are
pending for this follow-up. No completed review with findings is counted as approval.
