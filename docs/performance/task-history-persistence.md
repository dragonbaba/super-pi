# Task history allocation and lifecycle audit

Contract: [hot-path allocation contract](hot-path-allocation-contract.md).
Candidate: `codex/task-history-persistence`, based on `5cd30347f` (PR #74).
Measured on Windows, Node v26.4.0, 2026-10-08, using offline fixtures.

## Production chain and boundaries

Shell final authorization -> background admission -> `SubagentTasks.create` ->
`TaskHistory.save` (queued commit) -> bounded scheduler -> `SubagentTasks.start`
(running commit) -> original shell executor / Windows job -> `handleData` ->
`OutputAccumulator` -> process/output cleanup -> bounded terminal text/facts ->
`SubagentTasks.finish` (terminal commit) -> existing terminal event/notification ->
AgentSession -> InteractiveMode -> tool renderer -> terminal release.

Subagent authorization/preflight -> bounded batch reservations -> task admission
commits -> scheduler -> start commit -> `runSingleAgent` / `SubagentProcessRun`
stdout -> decoder / `processLine` / bounded message retention -> child/prompt-file
cleanup -> finish commit -> one completion notification or foreground lifecycle
snapshot -> observer -> AgentSession -> InteractiveMode -> renderer / frame queue.
Tree navigation now drains subagent children in `session_before_tree`, as shell
tasks already did. Old-authority notifications remain suppressed.

The existing chunk consumers, decoders, bounded tail/message retention and all
downstream frame paths are unchanged. Shell output still creates its documented
buffer views, decoded strings and bounded tail copies. Child JSON ingestion still
parses bounded messages. Task history adds **zero callbacks, Promises,
AbortControllers, wrappers, arrays, full-output serializations or disk writes per
chunk/progress event/frame**. No output callback can reach storage. No new frame
materialization or full-frame copy exists. SQLite is required lazily at the first
admission or restoration of an existing database, never when an empty session opens.

Named low-frequency boundaries are `TaskHistory.constructor/open/load/save/close`
(including `validate`, `readRecord` and `projectShellExecution`),
`SubagentTasks.configureHistory/create/start/finish/closeHistory/dispose`,
`configureTaskHistory`, the providers' session-start/tree/shutdown handlers, and
explicit task-control commands. They allocate task records, bounded observation
arrays, filesystem identity metadata and terminal-facts JSON. They create no
recurring timers or Promise chains. Startup/disposal join existing bounded pending
operations. No object pool is proposed: no profiler evidence justifies one.

## Ownership and failure policy

| Owner | Bound | Release |
| --- | --- | --- |
| Runtime task map, per kind | `maxTasks` active + `maxTasks` terminal, hard 256/256 | Terminal-order eviction; all references cleared at disposal |
| Result text | 12000 UTF-16 units, truncation marker included | Eviction/disposal; no second full-output copy |
| Shell facts in storage | Explicit root/output schema projection, JSON <=128 KiB; backend extras and serialization hooks excluded | Two projected objects and one validation wrapper at the save/load boundary; temporary JSON ends at save; restored facts released with history |
| Pre-recovery validation | <=512 rows, one current decoded row at a time; byte bounds checked in SQL first | Iterator unwinds on success/throw; no unpruned row array retained |
| Restore array | At most `maxTasks` observations after bounded SQL pruning | Return/startup only; never held by delivery callbacks |
| SQLite owner | One connection + three retained prepared statements per kind | Statements cleared and database closed even on close/identity errors |
| Main database, per session/kind | 32768 pages of 4096 bytes (128 MiB); <=512 logical records | Page reuse after eviction; persisted intentionally with the session |
| Rollback journal | SQLite DELETE mode, bounded by affected database pages | Commit/rollback or SQLite crash recovery |
| Writer record | One token, local PID and hostname per kind | Normal close clears claim; a definitely absent local PID permits recovery |

The main file is created with mode 0600 (Windows inherits its directory ACL),
bound to the session ID/cwd/kind and checked by file/directory identity. Linked,
oversized, foreign or invalid-version files fail clearly. Bound checks precede
row materialization. Transactions arbitrate claims; there is no stale-timeout
lease, process scan, signal-based takeover, or command replay. A live/reused PID,
uncertain existence check or foreign hostname refuses ownership. Writer metadata
must be entirely empty or a complete valid claim; partial tuples are rejected
before liveness inspection. All rows, including rows due for eviction, receive full
ID/timestamp/facts validation inside the transaction before recovery, claim or
pruning. A validation failure rolls back without rewriting the original evidence.
This metadata protection is not an OS sandbox or a distributed/network-filesystem
protocol.

Admission/start writes complete before command launch. Every save and recovery
commit is followed by a file/directory identity and writer-token check. Failure
blocks launch or restore; it does not attempt to roll back an already committed
transaction or mask the identity error. Terminal failures keep the
live actual result, display the storage error and block new work; restart uses only
committed observations. Unknown completion becomes interrupted, not successful or
still running. Restored records have no controller and do not publish verification
events. Waiting/cancelling history never targets an old process. Forks use separate
session files. Sidecars are not copied into transcript exports or removed by the
existing session selector; their backup/deletion behavior is documented explicitly.

## Deterministic counters, profiles and reference release

`scripts/bench/background-shell-tasks.ts` now enables real persistence for its
production background consumer profile. For 1000 chunks:

| Counter | Foreground comparison | Persisted background |
| --- | ---: | ---: |
| Progress publications | 3 | 0 |
| Per-chunk writes | 0 | 0 |
| Lifecycle task writes | 0 | 3 (admission/start/finish) |
| Completion notifications | 0 | 1 |
| Per-chunk Promises / AbortControllers | 0 / 0 | 0 / 0 |
| Sampled bytes/chunk, including lifecycle | 5502.624 | 5429.016 |

Leading sites remain `Buffer.createFromString`, decoder, `Buffer.toString`, typed
array views and line scanning. Samples are stochastic, not a claimed performance
improvement. The persistent connection returns to zero open handles. Four existing
scheduler lifecycle fixtures return all ownership counters to zero; four Windows
job fixtures release their native handles. Controlled GC releases **118/118** owners.

`scripts/bench/task-history.ts` measures eight real persisted tasks followed by
restore/disposal, with HeapProfiler sampling at 4096 bytes:

| Fixture | Task writes | Recovered interruptions | Sampled bytes/task | Whole lifecycle ms | DB bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Completed | 24 | 0 | 98968 | 230.98 | 118784 |
| Failed | 24 | 0 | 83429 | 218.58 | 118784 |
| Cancelled | 24 | 0 | 97218 | 228.49 | 118784 |
| Disposal without observed completion | 16 | 8 | 48557 | 160.21 | 20480 |

Each successful task has exactly three durable lifecycle writes. Cancelled queued
work needs only admission/terminal writes. The first fixture includes cold SQLite
binding load. Leading allocations are bounded row restoration, filesystem stats /
canonical directory identity, SQLite bindings and cancellation events. Synchronous
FULL-durability transactions impose a real lifecycle cost; the measurements are
not a streaming cost or a latency guarantee for slower filesystems. All four
fixtures end with zero open handles, task-map entries and waiters. Eight event-loop
and controlled-GC cycles collect **144/144** tracked records, controllers, owners,
databases and prepared statements, including restored observations.

Before review hardening, sampled bytes/task were 86127 / 57712 / 64202 / 39994
on the same runtime. Full pre-recovery validation reads bounded rows before the
post-pruning load, and post-commit checks allocate additional filesystem metadata.
These are deliberate lifecycle costs, with no change in per-update counters.
The samples include cold binding load and are not a claimed speed improvement.

The unchanged production subagent ingestion benchmark covers 8/16/64 children
and 1000 updates per fixture: zero progress snapshots/full-message serializations,
8542.488 / 8810.416 / 8858.536 sampled bytes per update, principally JSON parsing
and decoding. Four 64-task scheduler lifecycles release all counters; **344/344**
tracked owners are collected. Downstream renderer allocation is unchanged and
retains the existing audits; it is not reprofiled as a purported change here.

## Validation

Focused tests cover actual process-exit recovery, live-owner refusal, normal
restart, completion-order eviction, reduced limits, Unicode truncation, separate
providers/sessions, corrupt/oversized metadata, unchanged damaged rows/owner after
failed recovery (including would-be evictions), all six partial writer tuples,
empty writer tokens, root/nested facts projection and serialization-hook exclusion,
storage identity replacement before and during commit,
terminal/start write failure, historical wait/cancel, real extension reload with
no notification/replay/verification event, and tree-transition child cleanup.
Source gates name the persistence lifecycle callers and retain the existing shell,
subagent, source and TUI invariants. Root typecheck and coding-agent build are
required; the PR's normal Linux/Windows CI supplies repository-wide validation.

Local results after review fixes: 56 focused cases and 20 source/AST and related
hot-path gates pass under the official Node 22.19.0 runtime. One real POSIX rename
race is Linux-only; portable commit-time file/directory identity injection and
Windows open-file replacement refusal pass locally. Root typecheck and coding-agent
build pass. Self-review covered ownership claims, commit-before-launch, partial
batch admission, unknown terminal outcomes, pre-tree cleanup, restored authority,
bounded reads including embedded NULs, storage replacement and final handle release.
Commit-time identity failures release all database handles, preserve the first
storage error and block new admission. Both allocation/reference-release benchmarks
were rerun after the fixes; unchanged subagent ingestion figures above are retained
from the original candidate audit, not presented as a new measurement.
