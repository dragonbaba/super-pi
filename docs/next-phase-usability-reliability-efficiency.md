# Next phase: usability, reliability and task cost

Starting point: `origin/main` fetched on 2026-09-26,
`4f547535b830c15d3a9605574c229a0641f94923` (tree
`33eafd2fdfe355ab39da4a116dd8bf27b6a8e148`). The existing worktree and all
pre-existing branches and untracked files are preserved. All new PRs remain
unmerged.

| Theme | Branch / parent | Status | Evidence |
| --- | --- | --- | --- |
| N1: previews and recovery | `feat/file-change-preview-recovery` / main | 必交功能、本地完整门槛、两平台 CI 和实际复审完成 | [N1](next-phase-n1-evidence.md), [Draft #47](https://github.com/dragonbaba/super-pi/pull/47) |
| N2: staged single-file commit | `feat/staged-file-commit-reliability` / N1 | 必交功能、原生交付验证、本地门槛、两平台 CI 和实际复审完成 | [N2](next-phase-n2-evidence.md), [Draft #48](https://github.com/dragonbaba/super-pi/pull/48) |
| N3: shell input and results | `feat/shell-input-result-contract` / N2 | 必交输入/结果/兼容功能、分配门槛、完整验证与复审完成 | [N3](next-phase-n3-evidence.md), [Draft #49](https://github.com/dragonbaba/super-pi/pull/49) |
| N4: measured task cost and bounded work | `perf/task-cost-and-bounded-hotspots` / N3 | 功能、85 组五轮对照、20 个真实 PTY 子进程及代码候选完整验证完成；最终文档 HEAD 验证见 PR | [N4](next-phase-n4-evidence.md), [Draft #50](https://github.com/dragonbaba/super-pi/pull/50) |

Each child must contain its actual current parent HEAD. Successful CI on a child
does not validate parent changes that are absent from that child. Record complete
HEAD/base SHA and the final combined tree after implementation and validation.

Final parent chain: N1 `6ca8869953fd7afdbd07a1107fb7d81d4ec39316` ->
N2 `96820048a04e03b9e42ccdeb72792e4963d790a4` ->
N3 `b50844cc8e201b9aeecc4576b81f149380804ffc` -> N4 measured code
`32fca50f1caa7eff66d1fed8e5d91a8e811fc903` (tree
`f9e1d2271e881add01d8820549c8cba69e9885d0`). N4's later evidence-only commit has
unchanged production/test/measurement source; its final HEAD/tree and checks are
listed on PR #50 and in the delivery coordinates artifact. Parent PRs are not merged.

The user explicitly accepted exact `koffi@3.3.1` and required platform binaries,
and preservation of historical Session import compatibility. The million-field
single-object enumeration is an accepted measured cold-path cost, not constant
cost or rendering work. No global import limit, history truncation or weakened
AST gate was added. Feature/extra-optimization scope is frozen; N5/N6 below remain
design decisions only. Cost results do not establish universal batch savings or
native speedups. Raw final logs, all samples and release records remain outside
the repository at `D:/RMProjects/Pi-next-phase-artifacts/`.

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
