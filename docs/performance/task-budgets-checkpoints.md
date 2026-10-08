# Subagent responsibility, checkpoint and quit allocation audit

Contract: [hot-path allocation contract](hot-path-allocation-contract.md).
Base: PR #75, f9680c578. Candidate: PR #76.
Offline measurements: Windows, Node 22.19.0, 2026-10-09.

This records PR #76. The subsequent capacity guidance and graceful handoff change
is audited in [checkpoint handoff](checkpoint-handoff.md), including updated
intercepting hooks, capacity fallback and allocation/lifecycle measurements.

## Complete production chain

Bounded assignment validation -> current delegated authorization -> shared
scheduler/reservation -> one assignment string per launch -> persisted task start
-> current cwd identity check -> child process/private IPC initialization -> child
context preparation -> optional checkpoint pending commit at turn_start -> existing
provider stream -> stdout decoding / bounded message retention -> existing tool
execution -> optional paired turn_end checkpoint acknowledgement -> child close ->
IPC listener, checkpoint and prompt-file release -> terminal task commit -> bounded
notification/progress -> AgentSession -> InteractiveMode -> renderer/frame queue ->
terminal cleanup. SDK stream admission checks an already-aborted signal before any
provider call. No token/turn quota hooks, ledger, configuration reads or usage
acknowledgements remain. Existing final usage display is observational.

Manual quit -> one session_before_shutdown interaction while the UI is alive ->
cancel without teardown, or existing terminal restoration -> runtime abort/join ->
all extension shutdown handlers -> shell job/child tree cleanup -> successful exit.
The confirmation uses the interaction category, so the CLI's 30-second safety-hook
timeout cannot dismiss it. Signals cancel the dialog and join the cleanup owner.
A failing shutdown handler cannot skip later owners. Cleanup errors are latched
before queue release, block new tasks and prevent a successful exit acknowledgement.
POSIX root close escalates the recorded process group before releasing its timer.

Stdout onStdoutData/processLine, stderr, bounded retention, provider deltas, tool
progress, observers, renderers and terminal writers gain **zero callbacks,
Promises, controllers, wrappers, arrays, string copies or disk writes per update**.
Source/AST gates prohibit IPC and checkpoint writes from child ingestion. These
methods still have their existing bounded UTF-8 decoding, JSON parsing and final
message projection allocations; the profile below includes them. No frame or
terminal production body changed; existing one-active/one-pending frame ownership
and at-most-one final frame materialization remain unchanged.

Named low-frequency boundaries: assertAssignments/assertAssignment and
formatAssignment at batch admission/child launch; runSingleAgent prompt creation;
child session_start/before_agent_start/context/turn_start/turn_end/session_shutdown
hooks; ChildControl.request and SubagentControl.onMessage at initialization or
checkpoint boundaries; checkpoint projection, validation and bounded serialization;
SubagentTasks.saveCheckpoint -> TaskHistory.saveCheckpoint transaction; manual
InteractiveMode shutdown/performShutdown and extension shutdown delivery.

Ordinary children send one initialization packet and no per-turn packets. An
opted-in checkpoint sends begin and completed-turn packets, never deltas/progress.
Each acknowledged boundary owns one deferred, timeout and bounded packet, with at
most one pending per child; listeners and send/disconnect callbacks are stable
lifecycle fields. No recurring polling or pools. Role instructions are composed
once at launch; fresh children do not receive irrelevant continuation guidance.

## Ownership and bounds

| Owner | Bound | Release and exceptional paths |
| --- | --- | --- |
| Assignment | One objective plus three nonblank fields, each <=1024 chars; formatted total <=16384 chars | Validate every batch item before launch; expand/check each chain step once; existing bounded batch owner releases after completion/failure |
| Child prompt | Role definition <=128 KiB plus constant responsibility instructions | One temporary prompt file per launch; recorded directory removed in runSingleAgent finally, including startup/abort failures |
| Child control | One pending deferred/timer, stable listeners; 30s IPC deadline | Reply, timeout, disconnect, failure and disposal clear pending references; parent failure aborts its exact child tree |
| IPC | <=2 MiB string, depth 32, 20000 nodes | Checked before serialization and parse traversal; no per-delta traffic |
| Completed context | <=1 MiB, 128 messages, 128 blocks/message; no images/hidden reasoning | Checkpoint and bounded seed only; disposal releases both; no transcript in the task map |
| Restored seed | <=128 completed messages | Context hook owns one prepend array per request; seed released at shutdown; old tools never enter execution queue |
| Continuation prompt | One formatted assignment plus six-character Task prefix | Held outside durable history until first completed turn; cleared after save and on disposal; inherited uncertainty survives interruption |
| History | Existing 128 MiB database, <=256 active +256 terminal records | Checkpoint pruned with task; descriptors/statements closed by history owner |
| Quit | One shared shutdown deferred and confirmation AbortController | Cancellation clears owner for retry; signals abort dialog; successful exit follows cleanup |

Assignment prose does not grant file permissions or mechanically prove semantic
compliance. Existing workspace identity/delegation checks and readOnly enforce
capabilities. Instructions require a single objective, no duplicate investigation,
minimal necessary verification and immediate return on completion or a blocker.
Parent review remains responsible for assessing the delivered work.

Checkpoint identity uses decimal bigint strings because Windows inode values can
exceed JavaScript's safe integer range. Checkpoints project conversation fields,
not auth environment or execution grants. Prompt/tool text is explicitly opt-in.
Pending markers survive failed/aborted turns; continuation never persists its new
instruction until completion. Oversized/invalid context stops that task while
preserving the previous durable checkpoint; storage ownership failure blocks new
admission. Existing bounded migration, validation and pruning remain transactional.

## Deterministic counters, allocation profile and controlled GC

scripts/bench/task-control.ts exercises the production protocol handlers,
validation and durable checkpoint writes. HeapProfiler interval: 4096 bytes.
Each fixture owns eight tasks; no model calls.

| Fixture | Turn starts | Replies | Checkpoint writes | Failures | Sampled bytes |
| --- | ---: | ---: | ---: | ---: | ---: |
| Ordinary initialization | 0 | 8 | 0 | 0 | 759232 |
| Three completed turns/task | 24 | 56 | 56 | 0 | 2384208 |
| Abort after first begin | 8 | 16 | 16 | 0 | 909656 |
| Invalid checkpoint content | 8 | 16 | 16 | 8 | 1033216 |

Leading sites include getStatsFromBinding / realpathSync / assertOwner during
history ownership checks and encodeCheckpoint / decodeCheckpoint during bounded
storage. All fixtures finish with zero message listeners, database handles, task
entries and waiters. Exact control slots are cleared. Eight event-loop/GC cycles
collect **236/236** tracked contexts, controls, channels, task records/controllers,
history owners, databases and continuation prompts. Samples include fixture and
cold-loading costs and are stochastic; these are lifecycle costs, not per-delta
costs or a speedup claim.

scripts/bench/subagent-management.ts exercises production stdout/parse/retention
and completion/failure/cancel/disposal ownership:

| Children | Updates | Sampled bytes/update | Progress snapshots | Full-message serializations | Retained messages |
| --- | ---: | ---: | ---: | ---: | ---: |
| 8 | 1000 | 8684.968 | 0 | 0 | 24 |
| 16 | 1000 | 8795.728 | 0 | 0 | 48 |
| 64 | 1000 | 8756.160 | 0 | 0 | 192 |

Leading sites remain processLine and UTF-8 decoder write/onStdoutData. At most three
messages per child survive ingestion. All four lifecycle fixtures finish with zero
retained scheduler/task state; **344/344** tracked references are released. Existing
history/shell and downstream renderer audits remain applicable; no new per-chunk or
per-frame work was introduced. No object pool is justified or used.

## Validation and self-review

Local root typecheck and coding-agent build passed. Focused offline checks cover
required fields and whole-batch refusal, formatted child/system prompts, ignored
stale quotas and multi-turn children, scheduling/cancellation/authorization,
checkpoint pairing/recovery/continuation, real child control, shell/subagent
management and one quit dialog across regular/fullscreen UI. The safety-deadline
regression uses a fake scheduler; it does not sleep for a real minute. Source and
subagent AST gates pass. The exact failing Windows normal-shutdown fixture now
supplies the no-handler extension runner its synthetic runtime previously omitted.

Self-review covered assignment bounds and role guidance, the awaited turn-start
path before provider dispatch, checkpoint interruption and prompt ownership, fresh
workspace authorization, disposal after errors, and quit classification/cleanup.
Linux's process.kill fixture now changes the existing mock implementation instead
of mocking the same method twice, which had left a no-op kill installed under
Node 22 and caused later child cancellation tests to time out. POSIX execution is
skipped on this Windows host and remains CI's responsibility. Full repository
validation is left to CI; local checks use no paid model calls.
