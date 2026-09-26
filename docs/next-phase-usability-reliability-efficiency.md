# Next phase: usability, reliability and task cost

Starting point: `origin/main` fetched on 2026-09-26,
`4f547535b830c15d3a9605574c229a0641f94923` (tree
`33eafd2fdfe355ab39da4a116dd8bf27b6a8e148`). The existing worktree and all
pre-existing branches and untracked files are preserved. All new PRs remain
unmerged.

| Theme | Branch / parent | Status | Evidence |
| --- | --- | --- | --- |
| N1: previews and recovery | `feat/file-change-preview-recovery` / main | 已实现待验证 | [N1](next-phase-n1-evidence.md), [Draft #47](https://github.com/dragonbaba/super-pi/pull/47) |
| N2: staged single-file commit | `feat/staged-file-commit-reliability` / N1 | 实现中 | [N2](next-phase-n2-evidence.md); platform dependency decision pending |
| N3: shell input and results | `feat/shell-input-result-contract` / N2 | 未开始 | Pending |
| N4: measured task cost and bounded work | `perf/task-cost-and-bounded-hotspots` / N3 | 未开始 | Baseline collection only |

Each child must contain its actual current parent HEAD. Successful CI on a child
does not validate parent changes that are absent from that child. Record complete
HEAD/base SHA and the final combined tree after implementation and validation.

## Scope decisions for later phases

These are **后续阶段设计**, not implemented capabilities.

| Slice | Required capability and acceptance gate |
| --- | --- |
| N5a directories and explicit parents | Platform no-replace directory move primitive; reject overlap, protected descendants, changed ancestors and newly occupied destination. Node `exists` plus `rename` is insufficient. Review native dependency maintenance before adoption. |
| N5b link objects | Separate `lstat`/`readlink` object identity from referenced targets; explicitly validate Windows junction/reparse types, dangling links, outside targets and replacement after approval. |
| N5c bounded recursion | Explicit opt-in; fixed depth/entry/metadata budgets and authorized inventory; no link traversal or mount escape. Changed inventory invalidates authorization; fixed postorder with partial receipts. No blanket recursive force fallback. |
| N5d cross-device ordinary files | Explicit copy/publish/delete stages; exclusive destination publication, bounded streaming, content/metadata verification and source revalidation before deletion. Cancellation preserves already published effects. No atomic-move claim. |
| N6a isolated Git work | Define dirty/untracked input policy and private/large/external exclusions. Worktrees do not copy all inputs or isolate process/network access. Explicit apply detects later user changes; no automatic stash/reset/clean. |
| N6b explicit undo | Decide preimage privacy, quota, retention and cleanup first; undo is a newly authorized mutation conditional on current postimage. Missing preimage cannot restore deletes; partial undo remains partial. |
| N6c multi-file guarantees | Distinguish whole-batch preflight, single-file publication, compensation and observable atomicity. No new transaction claim without a proven isolation/filesystem primitive. |

N5 and N6 need separate user starts. Neither is part of the N1–N4 production
implementation or a reason to block an otherwise complete first wave.
