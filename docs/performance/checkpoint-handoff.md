# Checkpoint planning and handoff allocation audit

Contract: [hot-path allocation contract](hot-path-allocation-contract.md).
Base: PR #76, `3a932d8f3`. Measurements: Windows, Node 22.19.0, 2026-10-09.
This extends the [responsibility/checkpoint audit](task-budgets-checkpoints.md).

## Production chain and allocation boundaries

Tool description and assignment schema expose runtime and checkpoint limits before
delegation -> bounded assignment/authorization -> shared scheduler reservation ->
actual runtime in the child launch prompt -> private IPC ready acknowledgement with
persisted checkpoint bytes/messages -> child startup/request context -> pending
checkpoint commit at turn_start -> existing provider/tool execution and stdout
ingestion -> completed-turn projection, validation and durable commit -> numeric
capacity reply -> tool disabling and summary context at the handoff threshold ->
child close/disposal -> explicit handoff result -> terminal task persistence and
notification -> AgentSession/InteractiveMode -> render/frame queue -> terminal.

If a final text turn first crosses the threshold, the awaited turn_end hook queues
one custom follow-up through ExtensionAPI.sendMessage ->
AgentSession.sendCustomMessage -> Agent.followUp. The streaming branch queues it
synchronously, and the existing agent loop consumes it before ending. A turn with
tool calls already continues the loop and receives no duplicate follow-up. The
monotonic handoff transition prevents repeated summary requests. setActiveTools([])
removes capabilities for subsequent requests, and the intercepting tool_call hook
blocks any stale/hallucinated call. This is not a token/turn quota.

Foreground and background results retain the handoff reason. Parallel summaries
distinguish handoff from completion; chains return before the next dependent step,
and the existing finally path releases/cancels unstarted reservations. The existing
completed task state records execution ending, not acceptance of the entire goal.

Audited unchanged downstream bodies include onStdoutData/processLine and bounded
message retention, tool progress/observer delivery, InteractiveMode updates,
renderAgentStatus/refreshStatus, render/frame composition and terminal writes. They
gain **zero callbacks, Promises, controllers, wrappers, arrays, string copies or
disk writes per delta/progress/frame**. Their existing UTF-8 decoding, parsing and
bounded message projection allocations remain in the measured profile. No frame
materialization/copy or active/pending writer limit changes.

Named allocation exceptions are tool registration/assignment admission;
runSingleAgent prompt creation; child session_start, before_agent_start, context,
tool_call, turn_start, turn_end and session_shutdown intercepting/lifecycle hooks;
ChildControl.request and SubagentControl.onMessage; checkpoint projection and
SubagentTasks.saveCheckpoint; result formatting at completion. No file-wide or
class-wide exemption is introduced. No polling timer or object pool is added.

Ordinary children retain one initialization exchange and zero per-turn exchanges.
Checkpoint children retain begin/turn exchanges, with one pending deferred and
30-second deadline per child. A child-side projection/encoding capacity failure
replaces the turn packet with a small handoff packet; sequence advances only after
encoding succeeds. Capacity primitives ride the existing replies. Measuring a
saved checkpoint uses Buffer.byteLength on the existing encoded string, with no
extra complete serialization or string copy.

## Ownership, capacity and exceptional paths

| Owner | Bound | Release / failure behavior |
| --- | --- | --- |
| Parent control | Existing checkpoint <=1 MiB / 128 messages, one pending continuation prompt; new primitive capacity/handoff fields | dispose clears process, callback, task, checkpoint, seed and prompt references; small terminal reason is derived only from booleans |
| Child control | Existing <=128-message restored seed, one pending request/deadline and stable message/disconnect/send callbacks | Replies/errors clear request slots; shutdown clears seed/context/guidance and removes listeners |
| Request context | One prepend array of seed plus existing request messages, one ephemeral capacity message and bounded notice per checkpoint request | Returned array is request-owned, never reused as scratch or added to the durable checkpoint; the existing live conversation remains session-owned |
| Handoff request | At most one custom follow-up message at first transition, only if the ending turn has no tool calls | Consumed by the existing agent loop; later capacity replies cannot enqueue more |
| Result | One fixed reason plus existing bounded final output; static marker in progress snapshots | Existing task history retains at most 12000 characters; completion/disposal releases live task owners |

At 768 KiB or 96 messages, the child switches to summary-only work before the
1 MiB / 128-message hard capacity. Current and remaining persisted capacity are
visible from the first request, including resumed history. The parent must plan
bounded phases and a stopCondition handoff point before launch; it must inspect
the result before choosing a fresh bounded assignment. Nothing creates extra
agents automatically or enlarges permissions.

A single completed turn may exceed the reserve. Capacity failure restores the
in-memory checkpoint length, turns, timestamp and pending flag to their previous
values. The last durable pending checkpoint remains intact, no partially appended
continuation instruction persists, and further checkpoint writes are frozen while
the child returns its summary. Results explicitly warn about unsaved effects and
require workspace inspection before retry. Unsupported/corrupt context, history
ownership/storage failure and protocol failures retain their fatal behavior.
Transport guards and runtime deadlines remain enforced; this change does not
promise a successful model/provider response under those failures.

## Deterministic counters, sampled allocations and release

`scripts/bench/task-control.ts` exercises production protocol, projection,
validation and durable storage with eight tasks per mode. HeapProfiler interval:
4096 bytes. Normal initialization, three completed turns, abort, invalid content,
early handoff and a 1.2 MB completed-turn overflow are measured without model calls.

| Mode | Turn starts | Replies | Checkpoint writes | Failures | Handoffs | Sampled bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Ordinary | 0 | 8 | 0 | 0 | 0 | 725280 |
| Complete | 24 | 56 | 56 | 0 | 0 | 2595472 |
| Abort | 8 | 16 | 16 | 0 | 0 | 929232 |
| Invalid | 8 | 16 | 16 | 8 | 0 | 901952 |
| Handoff | 16 | 40 | 40 | 0 | 8 | 3660640 |
| Overflow | 16 | 40 | 16 | 0 | 8 | 20187528 |

Leading ordinary/complete sites include filesystem ownership checks and checkpoint
encoding. Handoff includes keys (520616 bytes), checkpointMessage (483120),
decodeCheckpoint (351928), next (349920) and realpathSync (242800). Overflow includes
encodeControl (6426856), decodeControl (6417752) and charCodeAt (6404592); these
include the deliberately large fixture strings, JSON serialization/parsing and
capacity scan. No full-result copy was introduced merely to measure capacity.
Samples are stochastic lifecycle costs, not per-delta costs or a speedup claim.

Every mode ends with zero owned message listeners, database handles, task entries
and waiters, and all parent control reference slots cleared. Eight event-loop/GC
cycles collect **354/354** tracked task/controller, checkpoint/message-array,
channel/control, continuation-prompt and database/history owners. Real child IPC
tests additionally verify message/disconnect listeners return to their initial
counts after normal, handoff, oversized and invalid-content shutdown.

`scripts/bench/subagent-management.ts` measures production ingestion and scheduler
completion/failure/cancel/disposal with 1000 updates per profile:

| Children | Sampled bytes/update | Progress snapshots | Full-message serializations | Retained messages |
| --- | ---: | ---: | ---: | ---: |
| 8 | 8640.928 | 0 | 0 | 24 |
| 16 | 8702.800 | 0 | 0 | 48 |
| 64 | 8628.608 | 0 | 0 | 192 |

Leading sites remain processLine and UTF-8 write/onStdoutData. Retention remains
three messages per child. All four lifecycle fixtures reach zero retained
scheduler/task state; **344/344** references are collected. Scheduler high-water
marks are 16 active / 48 queued. There is no new pool and no measured justification
for one. Existing renderer and terminal audits remain applicable.

## Focused validation and self-review

Root typecheck, task-control/checkpoint tests, subagent-management tests and
subagent AST/source invariants pass. A new AST gate restricts child-control work
to the named intercepting/lifecycle events, excluding provider delta, tool progress
and message updates. Focused cases cover upfront limits and actual runtime;
near-full startup and continuation; text and tool-result threshold crossings;
exactly one final-text follow-up; no duplicate follow-up for tool calls; UTF-8
checkpoint/IPC overflow; durable rollback; unsupported content remaining fatal;
foreground/parallel/background reporting; dependent-chain suppression; and listener
cleanup. No paid model calls are used. The POSIX process fixture is skipped on this
Windows host; Linux execution and full repository checks remain CI's responsibility.

Self-review traced awaited turn hooks through active-tool updates, follow-up queue
consumption, checkpoint transaction/rollback, terminal result formatting and
reservation/disposal release. Child capacity notices are model guidance rather
than a proof of semantic compliance; parent review still verifies the deliverable.
