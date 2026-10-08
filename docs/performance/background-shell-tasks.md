# Background shell allocation and lifecycle audit

Contract: [hot-path allocation contract](hot-path-allocation-contract.md).
Candidate: `codex/background-shell-tasks`, based on merged `eb36e30f7`.
Measured on Windows, Node v26.4.0, Intel i7-14700KF, 2026-10-08.
Measurements below are development fixtures, not physical-terminal or OS sandbox guarantees.

## Production chain and ownership

Final shell authorization -> one-use launch -> bounded scheduler -> original
`executeForeground` -> local Bash/PowerShell spawn -> `waitForChildProcess` ->
`handleData` -> `OutputAccumulator.append/appendDecodedData/appendDecodedText`,
`trimTail/writeTempData` -> final capture/close/discard -> shell facts -> bounded
task record -> terminal event and one completion notification -> AgentSession
custom-message/follow-up delivery -> InteractiveMode/TUI -> terminal release.
Explicit `tasks` queries clone only the bounded terminal details.

Windows background commands use `WindowsShellJob.spawn`: load fixed kernel32
bindings, create a kill-on-close Job Object, start a passive Node host, assign
that host to the job, then send the original shell/argv/environment through IPC.
The host cannot launch the command before assignment. OS stdio handles are
inherited directly; the host never forwards stdout chunks through JavaScript.
Membership survives MSYS parent exit/reparenting, which broke `taskkill /T` for
the official Node 22.19.0/npm 10.9.3 launcher in the original CI fixture.
This uses [Windows Job Object inheritance](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), without breakaway flags or PID scans.

Completion, abort and timeout join one job cleanup promise. Cleanup terminates
remaining owned descendants and queries the job's active count until zero, with
a 5000ms deadline and 10ms waits only during cleanup. Normal output delivery has
no ownership timer. Every path closes the job; kill-on-close is also the fallback
when the parent exits. Native failures become bounded observation diagnostics.
Foreground Windows execution still awaits its `taskkill` helper; Linux retains
the existing process-group path. These are process-lifetime controls, not a
sandbox for deliberate OS/service escape.

Background execution passes no progress callback to the existing consumer.
`scheduleOutputUpdate` exits before producing snapshots or timers; no raw stdout
event reaches the agent observer, UI or frame queue. Existing stable data/drain
callbacks and one lifecycle-owned output AbortController are retained. Foreground
execution continues through the same function and renderer.

The audit includes the existing accumulator's allocations: each at-most-64-KiB
decode creates a buffer view and decoder-options object and produces decoded
text; tail trimming makes a bounded UTF-8 buffer/string copy. These pre-existing
allocations are not moved or hidden. Background orchestration adds zero
callbacks, Promises, AbortControllers, wrappers or arrays per output chunk.
It does not copy a complete command output or materialize full terminal frames.

Exact low-frequency owners of new callbacks/containers: `registerManagedTasks`
(startup discovery/registration and explicit control commands),
`BackgroundShellTasks.constructor/createLaunch/run/revoke/beginSession/checkCleanup/close` (one admitted
task, completion, permission boundary or shutdown),
`BashInvocationAuthorization.consume` (final authorization), and
`createShellToolDefinition.execute` (one-use handoff). `finishOutput` and
`formatOutput` remain execution-completion boundaries. Completion EventBus
delivery uses its existing async listener wrapper once per task, never per chunk.
`createLocalShellOperations` owns the stable `stopChild` callback; its cleanup
promise is created only at completion/abort/deadline boundaries. Exact additional
owners are `WindowsShellJob.spawn/constructor/onMessage/onSend/stop/close` and
`loadBindings` (startup/stop), plus the fixed host's one message, spawn-error, exit
and disconnect handlers. `observeVerificationStart` records bounded invocation
sequence numbers; `observeToolResult` hashes verification commands once at
acceptance/completion, retaining only a 64-character digest. A sibling or a
different command cannot repair a failed check; a matching retry must have been
admitted after the failure. Missing start evidence fails closed.
`beginPromptBoundary` filters the bounded obligation map on explicit input.
`controlsAvailable` reads
effective tool metadata at admission, including the existing `getAllTools`
array/materialization, and compares the original registered schema reference.
It does not retain that list or run on task output/status delivery.
No object pool or task-status polling was added.

| Owner | Bound | Release |
| --- | --- | --- |
| Scheduler reservations and operations | `maxTasks`, default 64, hard 256 | Each completion/cancel; all settled on shutdown |
| Running command state | `maxConcurrent`, default 16, hard 64 | Existing exit/drain/abort path and `finally` |
| Windows job ownership | One passive Node host and job per running background command; one transient process handle; 144-byte limits + 48-byte accounting buffer per owner | Transient handle closed after assignment; job drained/closed and IPC listener removed at completion/abort/failure |
| Raw chunk references | Before the existing 50 KiB spill threshold | Spill transition or execution owner collection |
| Decoded rolling tail | Trim above 200 KiB, append decoded at most 64 KiB at a time | Bounded trim, then execution owner collection |
| Active spill data | 5 MiB per running command, including queued stream writes | Close and exact owned-path removal at completion |
| Task history | `maxTasks` active plus latest `maxTasks` terminal records | Completion-order eviction or disposal |
| Terminal text and metadata | <=12000 chars per shell record; numeric truncation data without duplicated `content` | Record/WeakMap key collection |
| Explicit waiters | 64 per kind, timeout <=60s | Completion, timeout, caller abort or disposal |
| False-success guard | 256 late-acceptance IDs, 256 pending checks, 256 execution-start IDs, 32 terminal/mutation obligations | Pending checks and background failures survive ordinary prompts. Matching later retry / terminal success / session reset releases them. Start IDs are consumed by results; IDs/failures remain bounded. |
| Task directory | At most shell + subagent providers | Last provider removes discovery listener; runtime unregisters listeners |

Queued tasks release directory authority even when execution never starts.
Permission revocation cancels owned work and suppresses its completion follow-up;
the pre-tree hook suppresses obsolete terminal events and awaits cleanup before
new-branch evidence restoration, regardless of later tree-hook order. Admission
is refused while the boundary drains; shutdown suppresses
terminal delivery and awaits pending cleanup. Retained
records have no controller or execution closure. Cleanup errors preserve their
owned path/diagnostics and block further background admission. Cleanup failure
disposes the scheduler before its slot can drain another queued command.

## Deterministic counters and samples

`node --expose-gc --experimental-strip-types scripts/bench/background-shell-tasks.ts`
uses synthetic 1153-byte chunks through the production shell consumer and manager,
with no provider traffic. HeapProfiler sampling interval: 4096 bytes. This isolates
the changed consumer; native process/authorization behavior is tested separately.

| 1000 chunks | Foreground comparison | Background |
| --- | ---: | ---: |
| Progress publications | 3 | 0 |
| Completion notifications | 0 | 1 |
| Sampled bytes/chunk, including lifecycle | 5560.280 | 5370.288 |
| Promises during synchronous chunk delivery | 0 | 0 |
| AbortControllers during synchronous chunk delivery | 0 | 0 |

Leading sampled sites are the existing buffer `createFromString`, decoder,
buffer `toString`, typed-array views and line scanning. Sampling is stochastic;
the comparison is not a claimed percentage improvement. Exact async-hook and
constructor counters, callback AST gates and zero background publications are
the regression criteria.

Four lifecycle fixtures (complete, fail, cancel, dispose) each admit eight tasks
with four concurrent slots. Each measured running/queued high-water marks of 4/4,
eight released handoffs, and zero retained scheduler slots, reservations, records
or waiters. Four additional real Windows job fixtures cover completion, failure,
cancellation after child start, and executable-not-found. They created four jobs,
performed four final active-count queries, and left zero job/process handles and
zero IPC message listeners. Eight event-loop/controlled-GC cycles collected all
**118/118** tracked owners, controllers, closures, bindings, tasks and native hosts.
The four native lifecycles sampled 1,438,696 bytes in the parent, including cold
Koffi binding load; this is not a per-chunk cost or a whole-process RSS claim.
Each running Windows background command adds one Node host. That explicit
startup/process cost buys reliable descendant ownership; concurrency bounds it.

The unchanged downstream shell renderer was also measured with
`scripts/bench/bash-render-allocations.ts --updates 1000 --warmup 100`:

| Scenario | Sampled bytes/update | New preview/time/warning/expanded components | Pending timers after disposal |
| --- | ---: | ---: | ---: |
| quiet | 118576.448 | 0 | 0 |
| collapsed | 130503.560 | 0 | 0 |
| changing output | 287907.536 | 0 | 0 |
| expanded | 226361.144 | 0 | 0 |

These are renderer stress updates, not background stdout updates. Leading sites
remain box background formatting, visible-width calculation and changed-output
preparation. All twelve renderer reference counters returned to zero. A separate
unprofiled `--lifecycle` run released 20/20 components, left zero live WeakRefs,
and measured +112024 bytes of aggregate retained heap after controlled GC; this
single heap delta is reported as noise/context, not proof of a leak or reduction.

## Regression gates

- `background-shell-tasks.test.ts`: early limits, queue/cancel, authority freshness,
  real Bash/PowerShell cleanup, both providers through the actual loader,
  terminal result guard across interactive/RPC follow-ups, drained tree navigation,
  same-name/copy-schema tool collisions, capped output, cleanup failure before
  queue drain, input/terminal races, sibling successes, and pre-tree hook ordering.
- `shell-process-observation.test.ts`: deterministic Windows root-exit-before-killer
  regression (failed before the fix), including failed killer exit/spawn and zero
  retained process listeners. The real nested `npm test` fixture asserts the owned
  descendant is dead immediately after the navigation hook returns, without a
  later task wait masking the boundary.
- `tool-lifecycle-postmerge.test.ts`, `shell-explicit-cwd.test.ts`,
  `shell-result-contract.test.ts`: existing authorization and producer-fact gates.
  Final authorization still creates exactly one approved-argument container;
  the background field is part of that snapshot.
- `shell-observation-hot-paths.test.ts`, `source-invariants.test.ts`,
  `tui-hot-paths.test.ts`, `subagent-hot-paths.test.ts`: exact callback/source gates.
- `subagent-management.test.ts`: shared scheduling and legacy controls.
- Root typecheck and coding-agent build. Linux/native compatibility remains part
  of the repository's existing CI, rather than an unobserved local claim.

Review-fix validation on 2026-10-08: 18 background cases passed using the official
Node 22.19.0/npm 10.9.3 runtime that reproduces the original CI failure. The five
related functional suites covered 176 passing cases with five existing platform
skips; the renderer diagnostic case needed a shorter temporary Node executable
path to keep its expected ENOENT text inside its fixed 120-column fixture.
Ten AST/source gates passed. Root typecheck and coding-agent build passed.
The refreshed background benchmark retained the same deterministic counters:
zero per-chunk Promises/controllers, zero background progress publications,
4/4 running/queued high-water marks, eight releases per lifecycle fixture, and
zero live references out of 118 after controlled GC. The unchanged renderer
measurements above are from the initial PR, not a rerun of this lifecycle fix.
