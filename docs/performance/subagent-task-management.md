# Subagent task-management performance evidence

Contract: [hot-path allocation contract](hot-path-allocation-contract.md).
Baseline: `8b7308691`. Measurements: Windows, Node v26.4.0, 2026-10-08.

## Production call-chain audit

The producer is `SubagentProcessRun.onStdoutData -> processLine ->
appendBoundedMessage -> boundedMessage`. JSON decoding/parsing and at most three
retained messages per child remain necessary allocations. The already measured
event-line byte count now bounds retention without serializing the entire message
again. Oversized messages retain bounded text head/tail and primitive usage;
large argument objects are omitted instead of serialized again. UTF-8 truncation
uses bounded binary searches and preserves surrogate pairs.

`processLine` no longer calls `emitSingleResultUpdate`. Child startup and terminal
completion/error in `runSingleAgent` are explicit lifecycle publication boundaries.
They create owned status snapshots containing role, state, timing and primitive
usage, with no task prompts, child messages or stderr. Parallel/chain handlers do
not copy their input batch arrays before snapshotting. Published snapshots never
alias mutable child usage or message arrays. Their maximum length is `maxTasks`,
hard-bounded at 256, and their owner is the tool result/observer lifecycle.

The downstream production chain remains tool update -> Agent's coalesced observer
delivery -> `snapshotObserverEvent` (`structuredClone` and freeze at delivery) ->
`AgentSession._handleAgentObserverEvent/_emit` -> `InteractiveMode.handleEvent` ->
`ToolExecutionComponent` -> `SubagentStatusText` -> the existing render/frame queue.
Built-in ordinary event delivery is synchronous. Status text uses primitive dirty
and elapsed-second slots to avoid reconstructing unchanged rows on every render.
It introduces no timer or repaint polling loop.

## Deterministic counters and allocation profile

`scripts/bench/subagent-management.ts` drives the real production stdout/parser/
retention methods. For the baseline it reproduces the previous parallel callback
and uses `structuredClone` to model observer isolation. This is a producer/snapshot
microbenchmark, **not** an end-to-end application speedup measurement. It warms 100
events and measures 1,000 roughly 4 KiB assistant-completion events per case.

| Children represented | Baseline sampled bytes/update | Candidate sampled bytes/update | Baseline / candidate batch publications | Baseline / candidate full message serializations |
| ---: | ---: | ---: | ---: | ---: |
| 8 | 142,548 | 8,795 | 1,000 / 0 | 1,000 / 0 |
| 16 | 265,175 | 8,505 | 1,000 / 0 | 1,000 / 0 |
| 64 | 976,949 | 8,761 | 1,000 / 0 | 1,000 / 0 |

Leading baseline allocation sites: progress publication and observer cloning.
Candidate sites: JSON parsing, stdout decoding and framing. No inline closures,
Promises, AbortControllers, Promise tails, or new batch containers are introduced
per raw event. Retained message arrays cap at three entries per child (24, 48 and
192 entries in these fixtures); no object pool is used. Text/framing allocations
remain and are not represented as zero-cost work.

The unchanged downstream lane was separately exercised with
`tui-tool-leaf-allocations.ts --paced --updates 1000 --warmup 100 --history-items 100`.
All four production fixtures delivered 50 coalesced snapshots with correct final
sentinels, zero built-in delivery Promises and zero pending scheduler tasks. The
existing built-in/custom renderer boundaries still allocate presentation wrappers
(100 each in this run); those are not new subagent per-event allocations. The
generic/image fixtures had zero such wrappers. No terminal frame representation
or queue ownership was changed.

## Ownership, capacity and release

- One scheduler belongs to one extension/session runtime. Admission reserves at
  most `maxTasks` child slots across unfinished calls; reservations are held until
  the whole call settles, bounding retained batch arrays even when one child has
  a long tail. At most `maxConcurrent` processes run. Queue nodes,
  AbortControllers and deferreds are task-lifecycle allocations. Cancelling a
  queued node removes its listener and queue reference before rejection.
- Each accepted call releases its reservation in `finally`, including model
  preflight errors and unstarted chain steps. Slot release follows process and
  prompt-file cleanup. Cross-call writer reservations last until the call ends.
- Active task records cap at `maxTasks`; completed records independently cap at
  `maxTasks`. A finished record stores at most 12,000 characters plus a marker and
  clears its AbortController. Credentials, prompts and process objects live only
  in the active execution closure, released when the operation settles.
- Waiting is explicit, with at most 64 pending waiters and 60 seconds per wait.
  Completion, timeout, abort and disposal remove timers, signal listeners and
  task references. Cancelling a wait does not affect the child.
- Permission changes abort obsolete work. Shutdown suppresses notifications,
  cancels owned children, rejects queued slots, awaits owned operations, then
  clears history. Existing platform process-tree cleanup remains in use.

For 64 tasks and 16 running slots, completion, failure, cancellation and disposal
each reached running high-water 16 and queue high-water 48, then zero active slots,
queued nodes, reservations, retained task records and waiters. After eight yielded
controlled-GC passes, all **344 weak references** to producer results and managed
task records were collected (0 live).

Real offline subprocess regressions additionally verify that cancelling a running
child and closing the session wait for that PID to exit, while an unrelated child
can complete and notify normally. No paid model calls are used. Cross-platform
process behavior remains subject to the normal Linux/Windows PR CI.

## PR review correction: overlapping batch workspaces

`subagent.execute -> consumeDelegatedTaskPolicies -> scheduler.reserve ->
workspacesConflict -> isPathInside` now checks pairs inside a parallel batch before
creating a reservation, task record or child. This is a startup admission boundary,
not a delta/progress/render path. At the 256-task hard limit, internal admission
performs at most 32,640 pair checks, with no pair arrays, closures or asynchronous
state. Read-only pairs skip path normalization; writer comparisons use the existing
bounded path helpers. Sequential chains skip internal conflict checks but retain
cross-call exclusion until their final release.

The focused regressions first failed on the reviewed commit, then passed after
the fix: nested/equal writer and reader/writer pairs fail atomically in either
order, read-only pairs and sibling paths remain valid, foreground/background
rejections create no child or task record, and chain timestamps verify sequential
execution. Rejected admission retains zero slots, queue nodes or reservations.
Self-review also corrected the old recovery advice to require all overlapping
tasks to be read-only, rather than leaving one writer alongside a reader.

The producer/downstream audit above remains unchanged. The allocation benchmark
rerun sampled 8,838 / 8,800 / 8,759 bytes per update for 8 / 16 / 64 children, with
zero raw-event publications and full-message serializations. All four lifecycle
cases again released every counter; all 344 weak references were collected. The
21 management/hot-path tests, four source invariants and type check passed. This
rerun validates the unchanged event lane and lifecycle release, not admission-time
throughput; no performance improvement is claimed for the conflict check.

## Reproduction

```text
node --experimental-strip-types --test tests/subagent-management.test.ts tests/subagent-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/subagent-management.ts --baseline 8b7308691
node --expose-gc --experimental-strip-types scripts/bench/subagent-management.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-tool-leaf-allocations.ts --paced --updates 1000 --warmup 100 --history-items 100
npm run check
```

Sampling numbers vary between runs. Portable gates are the AST invariants, exact
publication/serialization counters, capacity bounds and lifecycle release counts.
The benchmark's temporary baseline module has a recorded unique filename, is
created exclusively, and is removed after the run.
