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
| Actual bounded dryRun previews; no effects/evidence | 已实现待验证 | Four new fixtures failed on baseline; now pass locally |
| Per-file TUI expansion and bounded retained references | 已实现待验证 | 20k updates, ten releases, zero stable-render text changes |
| `/changes` Session pairing, verification and remaining draft | 未开始 | Not run |
| Full Windows checks, minimum Node, allocation gates | 实现中 | Targeted tests/check/hot passed; full candidate checks pending |
| Linux checks and latest-head review | 未开始 | Not run |

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

Remaining N1 work: `/changes` navigation, bounded Session pairing, permission-bound
active verification, remaining-request draft, missing-history behavior, and the
corresponding full-platform/false-success/fault cases. This first slice is not N1
completion. Partial-read exact diffs currently use an explicit bounded-summary
fallback; this limitation is visible, not fabricated as a full diff.
