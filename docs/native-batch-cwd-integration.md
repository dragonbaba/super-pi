# Formal A+B+C integration in PR #45

This is the original C branch, integrated by a normal merge after B truly entered
main. It is not a fourth PR or a direct push of the historical verification tree.

- A/#44 merge: 8f31b54086799359a737f6c0cdc4b2ecdecc7bbe
- B/#46 verified head: 50e61c0fcdcde6170ebcb4121f1813ca1f99623d
- A+B main / C merge parent: 95db7c3b8add13e12f975083ee2e6f828561d853
- Original C head / first merge parent: 1ba7fd16d337436ce937c1539e3d520045420148
- Historical local reference: 0228e168d39515d8d24260f0e764c9df9b62d802
- Historical tree: 56f8b811858f9b08e4263f50688005f268c6036f
- Final C HEAD/tree and observed checks are recorded in the PR evidence after
  commit; this document does not predeclare successful CI or a merge.

## Conflict and content reconciliation

The only conflict is PendingToolAuthorization.consume in runner.ts. The explicit
resolution reuses the reviewed local integration's batch branch plus both Shell
names. It preserves B's single terminal private batch payload and authority
release, C's Bash/PowerShell snapshot agreement and terminal cwd ownership, and
failed-handoff release in finally. No whole-file ours/theirs or production-core
copy was used. Exact final authority/signal checks and all subsequent B repairs
arrive through the true main ancestor.

The runner resolution matches the historical integration. Other production/test
differences from the historical tree are B's subsequently reviewed path/identity,
native evidence, false-success, deadline cleanup, read producer/range/content
proof and bounded progress/indexed lookup fixes. These newer changes are retained,
not overwritten by the historical tree. The mixed test now loads the shipped
default extension manifest (plus its fault-injection auxiliary), and adds actual
edit/write @ normalization versus native literal @ use in the same Session.
The previous individual regression files and the 86-path matrix remain present.
Documentation changes record this formal composition and latest evidence.

## Actual mixed Session regression

The recovered test creates isolated synthetic directories, real SDK AgentSession,
Agent hooks, permission UI boundary and persisted SessionManager, with no live
or paid model. It verifies unique read/edit/write/delete/move/file_batch/Bash/
PowerShell discovery; read then exact edit; native creation/move/delete; no-effect
preview; one necessary batch authorization; shared parents; ordered partial
completion with retained successful receipts; correct normalized and literal @
paths; and queue reacquisition after failures.

Both Shell backends execute on Windows. On Linux, Bash and all file/Session parts
execute; only the Windows PowerShell branch is omitted. Explicit/omitted cwd,
refusal, cancellation, permission sequence invalidation, directory replacement
during approval, and auxiliary/terminal handoff disagreement are covered. Every
captured explicit binding releases; no forbidden marker is created; Session cwd
stays unchanged; pending tools and final authorizations end at zero. Reopening
an actual saved Session preserves collected receipts with no duplication/replay.

Latest-head check, build:offline, test:hot, complete tests, mixed regression,
allocation/release gates, Linux/Windows required CI and actual focused review
remain merge prerequisites. Main push CI is reported separately after merge.


The initial formal working-tree check/build and selected actual integration run
pass: 138 tests, 2 explicit platform skips, zero failures. An exact name-set
comparison finds 22 differences from the historical reference; every path is a
subsequent B change or the two integration files above. Runner content is exactly
the historical resolved content. Final committed-head validation/CI/review is
recorded separately and remains required.
