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

Cancellation also joins `killProcessTreeAndWait` before releasing the execution
owner: Windows waits for the owned `taskkill /T` process as well as the shell.
Abort and timeout share one cleanup promise per invocation. Nonzero killer exits
and spawn errors become bounded observation diagnostics, not successful cleanup.
`waitForChildProcess` releases the killer's exit/error/close listeners; no PID
enumeration, polling loop or output callback is introduced.

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
`BackgroundShellTasks.constructor/createLaunch/run/revoke/beginSession/close` (one admitted
task, completion, permission boundary or shutdown),
`BashInvocationAuthorization.consume` (final authorization), and
`createShellToolDefinition.execute` (one-use handoff). `finishOutput` and
`formatOutput` remain execution-completion boundaries. Completion EventBus
delivery uses its existing async listener wrapper once per task, never per chunk.
`createLocalShellOperations` owns the stable `stopChild` callback; its cleanup
promise is created only at the abort/deadline boundary. `beginPromptBoundary`
filters the bounded obligation map on explicit input. `controlsAvailable` reads
effective tool metadata at admission, including the existing `getAllTools`
array/materialization, and compares the original registered schema reference.
It does not retain that list or run on task output/status delivery.
No object pool or recurring task polling was added.

| Owner | Bound | Release |
| --- | --- | --- |
| Scheduler reservations and operations | `maxTasks`, default 64, hard 256 | Each completion/cancel; all settled on shutdown |
| Running command state | `maxConcurrent`, default 16, hard 64 | Existing exit/drain/abort path and `finally` |
| Raw chunk references | Before the existing 50 KiB spill threshold | Spill transition or execution owner collection |
| Decoded rolling tail | Trim above 200 KiB, append decoded at most 64 KiB at a time | Bounded trim, then execution owner collection |
| Active spill data | 5 MiB per running command, including queued stream writes | Close and exact owned-path removal at completion |
| Task history | `maxTasks` active plus latest `maxTasks` terminal records | Completion-order eviction or disposal |
| Terminal text and metadata | <=12000 chars per shell record; numeric truncation data without duplicated `content` | Record/WeakMap key collection |
| Explicit waiters | 64 per kind, timeout <=60s | Completion, timeout, caller abort or disposal |
| False-success guard | 256 late-acceptance IDs, 256 pending checks, 32 terminal/mutation obligations | Pending checks survive ordinary prompts; terminal evidence or session/tree reset releases them. Terminal failures reset on a new prompt; IDs remain bounded until session reset. |
| Task directory | At most shell + subagent providers | Last provider removes discovery listener; runtime unregisters listeners |

Queued tasks release directory authority even when execution never starts.
Permission revocation cancels owned work and suppresses its completion follow-up;
session navigation suppresses obsolete terminal events and awaits pending cleanup,
refusing admission while the boundary drains; shutdown suppresses
terminal delivery and awaits pending cleanup. Retained
records have no controller or execution closure. Cleanup errors preserve their
owned path and block further background admission. Process cancellation reuses
the existing platform process-tree mechanism and observed child exit/drain rules,
and now waits for the Windows tree killer before reporting a terminal task.

## Deterministic counters and samples

`node --expose-gc --experimental-strip-types scripts/bench/background-shell-tasks.ts`
uses synthetic 1153-byte chunks through the production shell consumer and manager,
with no provider traffic. HeapProfiler sampling interval: 4096 bytes. This isolates
the changed consumer; native process/authorization behavior is tested separately.

| 1000 chunks | Foreground comparison | Background |
| --- | ---: | ---: |
| Progress publications | 3 | 0 |
| Completion notifications | 0 | 1 |
| Sampled bytes/chunk, including lifecycle | 5578.088 | 5328.168 |
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
or waiters. Eight event-loop/controlled-GC cycles collected all **110/110** tracked
owners, controllers, closures, bindings and tasks.

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
  same-name/copy-schema tool collisions, capped output, and cleanup failure.
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

Review-fix validation on 2026-10-08: 173 relevant functional tests passed, with
five existing Windows-inapplicable cases skipped; nine AST/source gates passed.
The refreshed background benchmark retained the same deterministic counters:
zero per-chunk Promises/controllers, zero background progress publications,
4/4 running/queued high-water marks, eight releases per lifecycle fixture, and
zero live references out of 110 after controlled GC. The unchanged renderer
measurements above are from the initial PR, not a rerun of this lifecycle fix.
