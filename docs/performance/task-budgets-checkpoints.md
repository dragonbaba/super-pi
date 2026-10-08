# Task budget, checkpoint and quit allocation audit

Contract: [hot-path allocation contract](hot-path-allocation-contract.md).
Base: PR #75, `f9680c578`. Candidate: `codex/task-budgets-checkpoints`.
Offline measurements: Windows, Node 22.19.0, 2026-10-09.

## Complete production chain

Current delegated authorization -> bounded scheduler/reservation -> persisted task
start -> current cwd identity check -> child process and private IPC owner -> child
context preparation -> `before_model_request` -> parent's synchronous shared budget
reservation and optional pending checkpoint commit -> grant -> existing provider
stream -> unchanged deltas / child stdout decoding / bounded message retention ->
assistant completion usage acknowledgement -> existing tool execution -> paired
`turn_end` checkpoint acknowledgement -> next request or child close -> listener,
ledger, checkpoint and prompt-file release -> task terminal commit -> existing
bounded notification/progress -> AgentSession -> InteractiveMode -> renderer/frame
queue -> terminal cleanup. Parent SDK requests use the same admission ledger.

Manual quit -> one `session_before_shutdown` confirmation while UI is alive ->
cancel without teardown, or existing terminal restoration -> runtime abort/join ->
all extension shutdown handlers -> shell job/child tree cleanup -> successful exit.
Signals cancel the confirmation and join that cleanup owner. A failing shutdown
handler cannot skip later owners. No renderer/frame/write production body changed.
Process-tree cleanup errors are latched by shell/subagent owners and propagated
after all their resources are released, preventing a successful exit acknowledgement.
POSIX cancellation sends final SIGKILL to the recorded process group on root close
before clearing escalation, including descendants that ignored SIGTERM.

Stdout `onStdoutData/processLine`, stderr, bounded retention, provider delta and
tool progress producers, observers, renderers and terminal writers gain **zero
callbacks, Promises, controllers, wrappers, arrays, copies or disk writes per
update**. IPC never transports deltas/progress. Existing hot-path AST gates now also
forbid control sends, budget settlement or checkpoint saves from child ingestion.

Named low-frequency intercepting boundaries: SDK `streamFn` admission /
`ExtensionRunner.emitBeforeModelRequest`; subagent `before_model_request`, assistant
`message_end`, `turn_end` and context hooks; `ChildControl.request` and
`SubagentControl.onMessage` for those protocol messages; `TaskBudgetLedger` numeric
reservation/settlement; `SubagentTasks.saveCheckpoint` validation and
`TaskHistory.saveCheckpoint` transaction. Their parsing, projection and bounded
serialization helpers are in the audit. Startup/stop exemptions: child control
construction/initialization/disposal, session start/settled/shutdown, explicit
continuation/reset commands, and interactive `shutdown/performShutdown`.

These request/turn interceptors intentionally create one deferred, timeout and
bounded packet per acknowledged child boundary. At most one is pending per child;
stable IPC/send/disconnect listeners belong to its lifecycle. No recurring polling,
per-delta deferred or pool was added. Checkpoint opt-in adds one initialization write,
one pending write before each granted request, and one write per completed turn.
Numeric accounting adds one reservation and one settlement entry per request.

## Ownership and bounds

| Owner | Bound | Release and exceptional paths |
| --- | --- | --- |
| Budget config | 4096 bytes; four primitive limits | Descriptor closed in `finally`; invalid config rejected |
| Session ledger | Five numbers/flags plus primary counters; one child counter per running child | Numeric entries use the existing session owner; control drops ledger references on close; incomplete requests settle unknown |
| Child control | One pending deferred/timer, stable listener set; 30s deadline | Reply, timeout, disconnect, failure or disposal clears pending references; parent aborts the owned process tree on control failure |
| IPC | 2 MiB string, depth 32, 20000 nodes | Checked before serialization and parse traversal; one packet per boundary, no delta traffic |
| Completed context | 1 MiB, 128 messages, 128 blocks/message; no images/hidden reasoning | Only current checkpoint and bounded continuation seed retained; control disposal clears both; no context in task-map records |
| Restored seed | At most 128 completed messages | Per-request context projection owns one prepend array; child seed released at shutdown; old tools never enter the execution queue |
| History | Existing 128 MiB database, at most 256 active + 256 terminal records | Checkpoint column pruned atomically with owning task; descriptors/statements closed by existing history owner |
| Quit | One shared shutdown deferred and one confirmation AbortController | Cancellation clears owner for retry; signals abort dialog; successful exit follows cleanup |

Workspace identity uses decimal bigint strings: Windows inode values can exceed
JavaScript's safe integer range. Checkpoints contain projected conversation fields,
not auth environment, grants or backend extras. Prompt/tool text is explicitly opt-in.
Pending markers survive a failed/aborted request. Invalid/oversized context stops its
task without poisoning unrelated work; a storage/ownership fault blocks new work.
Schema v1 -> v2 migration and full bounded validation happen in the same transaction
before recovery, owner claim and pruning. Reads validate one row at a time.

## Deterministic measurements and controlled GC

`scripts/bench/task-control.ts` uses production protocol handlers, validation,
durable checkpoint writes and ledger settlement; fixture transport performs no model
calls. HeapProfiler sampling interval: 4096 bytes. Each fixture owns eight tasks.

| Fixture | Granted requests | Replies | Numeric entries | Checkpoint writes | Sampled bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Three completed turns/task | 24 | 80 | 48 | 56 | 2466424 |
| Abort after first admission | 8 | 16 | 16 | 16 | 984320 |
| Refuse fourth request/task | 24 | 88 | 48 | 56 | 2382648 |

All fixtures end with zero pending requests, message listeners, database handles,
task-map entries and waiters. Exact control reference slots are cleared; eight
event-loop/GC cycles collect **156/156** tracked contexts, controls, channels,
ledgers, task records/controllers, history owners and databases. These allocations
are deliberate request/lifecycle costs, not streaming costs or a speedup claim.

Existing production benchmarks were also run on this candidate:

- Subagent ingestion: 8/16/64 children, 1000 updates each; zero progress snapshots
  and full-message serializations; at most three retained messages per child.
  Sampled bytes/update: 8520.904 / 8660.616 / 8714.528. **344/344** references released.
- Task history: 8 tasks per complete/fail/cancel/dispose fixture; 24/24/24/16
  lifecycle writes. Eight interrupted tasks restored in the disposal fixture.
  Zero open handles/maps/waiters; **144/144** references released.
- Background shell: 1000 chunks; zero per-chunk writes/Promises/controllers;
  three durable lifecycle writes and one completion notification. Four native
  Windows job fixtures end with zero handles. **118/118** references released.

Samples include cold loading and synchronous durable writes; they are stochastic.
Downstream renderer audits remain applicable because those bodies are unchanged.
Existing source/AST gates and focused shutdown tests cover the changed ownership
boundary instead of rerunning unrelated rendering benchmarks.

## Validation scope

Focused tests cover unlimited defaults, shared last-turn admission by real children,
per-child limits, reported tokens and overshoot, incomplete accounting, corruption/
write refusal, restoration, SDK admission and previews; real child IPC hooks and
failure messages; paired bounded context, migration/recovery/eviction, new task IDs
and fresh role/workspace authorization; one quit dialog across both providers,
cancel/confirm/signal races, later cleanup after a failing handler, and existing
active provider/tool/compaction/startup shutdown paths. Typecheck, coding-agent build,
subagent/history/shell/source AST gates and the above allocation profiles are the
local scope. Repository-wide Linux/Windows checks remain CI's responsibility.

Local typecheck, coding-agent build, focused tests and named source gates passed.
An injected Windows taskkill failure additionally proves queued children never start,
owned roots terminate through fallback, and shutdown reports the cleanup uncertainty.
The POSIX process-group escalation fixture and existing POSIX file-replacement race
are Linux-only and skipped on this Windows host. The startup/quit collection tests
were rerun with their required `--expose-gc` flag. Final self-review fixed exact
Windows directory identity, byte-bound accounting, final-turn control failures,
confirmation cleanup, and process-cleanup error propagation before submission.
