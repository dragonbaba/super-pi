# Response and tool duration persistence (F03.2)

## Design gate

Baseline: `9fcbd5983973ba7be7942f570f9a7a27f83627e0` (PR #118 merged).
Assistant and tool messages have no duration field. Lazy setup failures currently
stamp the failure instant rather than the request start. Tool execution outcomes
do not retain time independently of observer draining and result hooks.

Add optional `durationMs` to assistant/tool messages and tool-end events. Time
assistant completion with a monotonic clock from stream creation; preserve an
existing duration and leave older/deferred responses untimed. Fix lazy setup
error timestamps before enabling timing. Preserve structural compatibility with
`EventStream<AssistantMessageEvent, AssistantMessage>`: add no private/protected
members to the assistant subclass. Store two primitive clock values in a
module-owned WeakMap, one record per live response, removing it on completion or
end. No new references to messages, timers, listeners, controllers or pools.

Tool timing starts immediately before the actual execute call, after policy and
input validation, and ends when it returns/rejects. Exclude subsequent progress
drain, nested cleanup and result hooks; retain the measured value if observation
later fails. Refused, unknown, invalid and unstarted cancelled tools have no
duration. Normal, failed, aborted, parallel and nested calls use the same path.

Audit chain: provider/lazy setup -> AssistantMessageEventStream -> agent stream
consumption and final snapshot -> AgentSession critical/observer delivery ->
SessionManager append/reopen -> interactive live/deferred/history rows -> renderer
context -> retained viewport -> Main/Alt -> TerminalFrameQueue -> ProcessTerminal.
Tool chain: preparation/authorization -> execute -> progress drain/finalization ->
end event + persisted tool message -> the same session/render chain. Nested events
preserve the field while adding parent identity. HTML export passes the stored
duration to result render contexts. Legacy records remain undefined, with no
history migration or estimates from timestamps. Existing timing-label layout and
outputPad are outside this persistence/context goal.

No added work per provider delta except a terminal-event type branch. Tool timing
uses primitive local variables and existing outcome/event/message objects. Live
tool rows and deferred read records carry one optional number, using positional
arguments rather than result wrappers or producer mutation. Existing independent
public render-context snapshots gain one primitive field; their allocation and
ownership remain intact. Cold HTML export receives an optional primitive argument.

Validate controlled-clock assistant success/error/end/lazy/forwarded/deferred
cases and stream assignability; real agent execution timing versus delayed hooks,
drains, refusals and nested calls; persisted session reload and live/deferred/HTML
render contexts. Run relevant source/AST gates, baseline/candidate production leaf
profiles, queue gate, and a focused stream allocation/lifecycle probe. Record
deterministic counters, sampled sites and controlled-GC release; no full local
suite or unrelated provider calls. Exact evidence directory:
`.git/f03-2-duration-persistence-20261012/`.

## Verification

Baseline probes failed on missing assistant duration and lazy setup timestamp
(2000 instead of request start 1000). The candidate passes 64 targeted checks:
duration behavior/persistence/rendering, stream FIFO/lazy contracts, real tool
leaf closeout and relevant source/AST frame/retained invariants. `npm run check`
and AI offline, agent-core and coding-agent builds pass. No full local suite,
external provider call, global installation or real terminal session was used.

The server protocol v1 intentionally retains its existing projection: host timing
metadata is omitted, as with other host-only metadata. Its exhaustive host-field
allowlist accounts for both additions; wire types and version remain unchanged.

Same-machine profiles: Windows x64, Node v26.4.0, baseline commit above; candidate
production file hashes are saved with the evidence. Commands:

```text
node --expose-gc --experimental-strip-types scripts/bench/duration-persistence.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-tool-leaf-allocations.ts --updates 2000 --warmup 500 --history-items 500
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts
```

The stream probe delivers 100001 events from 100000 deltas and one completion.
Delta clock reads are 0; sampled bytes/delta are 9.33 baseline / 9.19 candidate,
dominated by the existing FIFO array push. Queue and waiter lengths are 0 after
draining. Done/error/abort/end and the profiled stream expose 10 WeakRefs, with
0 retained after four task/GC boundaries. The new WeakMap stores only two numbers
per response and deletes the record on terminal/end; abandoned streams are weakly
owned. No pool, message references, controllers or timers were added.

| Tool leaf (2000 deliveries) | Sampled bytes/delivery before -> after | CPU p95 ms before -> after | Contexts/wrappers before = after |
| --- | --- | --- | --- |
| Generic | 1171.37 -> 966.73 | 0.0036 -> 0.0033 | 0 / 0 |
| Built-in | 1066.76 -> 958.98 | 0.0024 -> 0.0026 | 2000 / 4000 |
| Custom | 1317.58 -> 1218.80 | 0.0024 -> 0.0028 | 4000 / 4000 |
| Image | 1706.42 -> 1718.44 | 0.0037 -> 0.0042 | 0 / 0 |

All four final hashes match baseline; component creation, progress promises,
argument serialization, snapshots and pending scheduler tasks are 0. Existing
render contexts and result wrappers remain public compatibility allocations;
only an optional number is added. Leading sampled sites remain fixture delivery,
text formatting, context creation, container child insertion and measurement
clocks. These short profiles show sampling/timing variation, including higher
p95 for three fixtures; they do not establish a performance improvement. The
leaf fixture uses real AgentSession/InteractiveMode/components/retained viewport,
but direct delivery and a fake terminal; agent delivery is covered by behavior
checks, and frame queue allocation is checked separately.

The queue probe writes 20000 prebuilt frames: closures, per-frame promises,
controllers, wrappers, queue string materializations and full-size copies are 0;
active/pending counts and bytes are 0 after flush. Sampling is 110.45 bytes/frame,
mostly measurement clocks and fixture code. The change does not alter terminal
queue ownership or backpressure. Session/render fixtures dispose their sessions,
clear transcript rows and remove their recorded temporary directories. Local
logs and profiles are evidence artifacts, not repository payloads.
