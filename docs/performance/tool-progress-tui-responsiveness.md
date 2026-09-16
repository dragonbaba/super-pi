# Tool progress / TUI responsiveness: scoped implementation and investigation

Date: 2026-09-16. Repository: `dragonbaba/super-pi`.

## Status and scope

The initial commit was a documentation-only work order. The first implementation batch below now records production changes, local regressions and measured Bash results. It does not establish the cause of the original severe stall; the existing PR remains Draft and the broader work order is retained for follow-up.

- Branch: `perf/tool-progress-tui-responsiveness`.
- Starting commit: `ef6fe1c696e5f76fa915befd8c8dc0a4d982287f` (main after PR #36).
- PR #36 is merged; do not amend its branch or undo its recovery behavior.
- User report: when the model runs some Node tests, the TUI becomes unresponsive or stutters and recovers only after the tests finish. The user also identifies excessive closures and temporary objects in hot paths.
- Two possible command excerpts and the execution-wait phase were supplied later; the exact triggering command, Windows terminal, extension combination and execution-time profile remain unconfirmed.
- The initiating environment could read GitHub through its connector but could not clone the repository into its execution container. Therefore this starting commit contains a precise implementation and validation brief rather than speculative production changes.

The requested outcome is **responsive input, scrolling and rendering while a test is still running**, together with measured reductions in unnecessary hot-path allocations and clearer ownership. Faster rendering after the subprocess exits is not sufficient.

## First implementation batch: measured results (2026-09-16)

**The scoped Bash rendering optimization is implemented and verified locally. The original severe Node-test stall is not reproduced or resolved by this evidence. PR #37 remains Draft.** The broader investigation below remains a follow-up list, not a claim that its entire acceptance matrix has passed.

### Revisions and environment

- Worktree: `D:/RMProjects/Pi-tool-progress-tui-responsiveness`; existing branch `perf/tool-progress-tui-responsiveness`.
- Fetched PR head / implementation parent: `a0ef95cf3945dbefc57ae44f3f7146a99b691a96`.
- Baseline production revision: `ef6fe1c696e5f76fa915befd8c8dc0a4d982287f`, loaded read-only from the existing main checkout. `git diff ef6fe1c696e5f76fa915befd8c8dc0a4d982287f a0ef95cf3945dbefc57ae44f3f7146a99b691a96 -- packages` is empty.
- Candidate source revision: implementation working tree, recorded as a commit in the final publication update. Measurements precede that commit; committing does not change the measured source.
- Measured production Git blob IDs: `bash.ts = 233a60d6b28ca4d90d03b44341cf07c63c7c818c`, `extensions/types.ts = 2557c24e565ba03a701a00f2e823c1af651af4d2`, `tool-execution.ts = 068c0ba1da335469cd0554dace83f330b61feb89`.
- Node `v26.4.0`, Windows 11 Pro for Workstations `10.0.22631`, Intel Core i7-14700KF, 28 logical processors. PowerShell `D:\PowerShell\7\pwsh.exe`. No Git Bash was available.
- Viewport 120 columns x 40 rows; dark theme. Renderer microbenchmark has one real built-in Bash row, a long command and 100 output lines (empty output for quiet). Live benchmark has 100 historical rows, or 5,000 for off-tail; commands are 103 / 2,424 UTF-16 code units. No extensions, online provider, Chrome, user source or user session data.
- Base and candidate processes ran sequentially on the same machine. Allocation sampling and unsampled responsiveness are separate runs. Both use the final same harness, loading only the selected source module graph.

The pre-existing main worktree and its untracked user plan were left untouched. No second implementation branch, duplicate source checkout, lockfile change or raw profile is part of this patch.

### Confirmed cause and production changes

The old Bash interval called `context.invalidate()`. This entered the full ToolExecutionComponent invalidation path, marked the command dirty and cleared descendant layout caches even when only elapsed time changed. Rebuilding a collapsed result also created a fresh anonymous preview (with render/invalidate closures) and a new timing Text each time. Existing prepared-output/preview-line caches already avoided some work; they were retained.

The production path is now:

```text
BashElapsedTimer.tick (same 1,000 ms interval, lifecycle-owned callback)
  -> stable ToolRenderContext.refreshResult (invalidate fallback for older hosts)
  -> ToolExecutionComponent.updateDisplay (existing dirty/args-only/custom decisions)
  -> Bash renderResult / retained result children
  -> notifyVisualInvalidation
  -> retained transcript child invalidation + requestRender
  -> existing TuiAltScreen / ScrollView layout and frame queue
  -> existing terminal completion callback
```

- `extensions/types.ts` adds an optional backwards-compatible result refresh hook. The stable component callback does not set or clear command dirtiness and does not invoke recursive full invalidation. Dynamic custom renderCall still runs; args-only custom calls still rerender on explicit invalidation. Pending argument/theme/state dirtiness survives.
- `bash.ts` owns one preview component per result lifecycle. Its render method reads current owner state instead of capturing prior styled output. Field-by-field content comparisons still detect same-reference mutations. Width, theme, output and expansion dependencies retain their existing semantics.
- Timing Text and truncation-warning Text are retained and updated only when their full styled display string changes. Existing expanded output Text reuse remains. The bounded child array is emptied and repopulated without releasing children or invalidating their Text layout caches.
- The timer owner retains state only while active and weakly references the stable host callback, not a short-lived render context. Stop clears timer/state/callback references; generation and completion checks reject late callbacks. Finalization freezes `Took`; cache release preserves primitive start/end times so remount does not erase the duration.
- Touched snapshot/comparison/styling helpers use direct loops instead of per-update traversal callbacks. No pool, global output Map, new scheduler or per-tick closure/Promise/options object was added. Existing updateDisplay context/result wrappers and frame/preview line arrays still allocate; this is not an all-path zero-allocation claim.

### Deterministic counters

Initialization and warm-up precede counting. The benchmark uses 100 warm-up updates and 1,000 measured updates per scenario, repeated three times. The unit tests independently gate 100 updates. All three benchmark runs agreed on the following actual invocation/identity counts:

| Measured work per 1,000 updates | Baseline | Candidate |
| --- | ---: | ---: |
| Pure timer: command renderer calls | 1,000 | 0 |
| Pure timer: command Text.setText / layout cache misses | 1,000 / 1,000 | 0 / 0 |
| Pure timer: command Text.render calls (including cache hits) | 1,000 | 1,000 |
| Pure timer: retained-view invalidation notifications | 1,000 | 1,000 |
| Unchanged collapsed content: snapshot / preview-line replacements | 0 / 0 | 0 / 0 |
| Unchanged collapsed content: preview / timing Text identity replacements | 1,000 / 1,000 | 0 / 0 |
| Changed collapsed content: snapshot / preview-line replacements | 1,000 / 1,000 | 1,000 / 1,000 |
| Changed collapsed content: preview / timing Text identity replacements | 1,000 / 1,000 | 0 / 0 |
| Unchanged expanded content: output Text / timing Text replacements | 0 / 1,000 | 0 / 0 |

Candidate-only optional numeric diagnostics count actual Bash child constructor branches and cache recomputations. After warm-up, stable scenarios construct zero preview, timing, warning or expanded components. Output changes recompute prepared output and preview lines 1,000 times; unchanged timing text receives zero setText calls. Advancing the clock 1,000 times updates timing text 1,000 times. These are separate from ToolExecutionComponent construction counts and from AST results. The baseline lacks the new constructor diagnostics; its missing counters are not reported as measured zeroes.

Structure/lifecycle costs are separate: the warning regression creates one warning, reuses it for 100 ticks, updates it once when its dependency changes, then removes it. Five expand/fold cycles create five expanded Text instances as expected, retain one preview, and leave only two attached children. A released/remounted lifecycle may create new components. The dedicated expanded test also intercepts Text.setText and actual layout cache misses: both stay zero for 100 unchanged timer refreshes.

### Allocation and unsampled render timing

HeapProfiler sampling interval is 8,192 bytes, with collected objects included. Values below are the median of three repeats within each revision's process, in **sampled bytes/update**, not exact allocated bytes or retained heap. Timing is from the separate unsampled pass in each repeat, includes harness overhead and a rendered tool row, and reports the median of the three per-run p95 values.

| Scenario | Baseline bytes/update | Candidate bytes/update | Change | Baseline p95 ms | Candidate p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Quiet timer, no output | 217,742.848 | 117,846.264 | -45.88% | 0.2165 | 0.1517 |
| Timer, unchanged collapsed output | 229,838.480 | 130,505.504 | -43.22% | 0.2480 | 0.1839 |
| Changing collapsed output | 312,840.016 | 313,582.272 | +0.24% | 0.4270 | 0.4046 |
| Timer, unchanged expanded output | 327,836.152 | 226,398.344 | -30.94% | 0.2838 | 0.2375 |

Changing-output allocation is essentially unchanged; component reuse does not remove complete output styling, visual-line work or frame composition. Leading remaining sampled sites include background application, visibleWidth and, for changing output, getPreparedBashOutput and visual-line helpers. The quiet baseline also prominently samples command wrapping/repetition that the candidate avoids. No broad latency or throughput improvement is inferred from these small fixtures.

### Running input and frame completion

The offline SDK provider requests one actual local shell execution, then receives its canonical result. On Windows the fixture uses the built-in PowerShell tool and real finite Node child; it shares the Bash result renderer and local process operations. Non-Windows selects Bash, but that path was not run here. The fixture calls the real InteractiveMode tool event handler, retained transcript, ScrollView, fullscreen input dispatcher and terminal frame queue. Startup/editor chrome is a minimal harness, and the terminal sink is simulated with a 2 ms asynchronous write callback: this does **not** measure Windows Terminal/ConPTY paint.

After observing the child's readiness file, six absolute-time wheel-input probes are scheduled at 200, 600, 1,100, 1,600, 2,100 and 2,500 ms during its 3 s wait. Each records planned and actual handling times, changed viewport, matching submitted viewport and corresponding frame completion time. Each matching frame must complete before the child's recorded exit time. A 20 ms host heartbeat includes the final gap, so a stalled probe cannot simply disappear from statistics.

Two runs per revision, four scenarios per run:

| Scenario | Base planned-input to matching frame p95, ms (run 1 / 2) | Candidate (run 1 / 2) |
| --- | ---: | ---: |
| Short quiet command | 38.047 / 37.468 | 43.685 / 45.186 |
| Long quiet command | 44.339 / 44.265 | 43.049 / 41.780 |
| Initial output then quiet | 45.137 / 42.537 | 43.390 / 45.558 |
| Long history, scrolled off tail | 37.161 / 44.043 | 45.407 / 44.627 |

Each scenario has only six probes, so its nearest-rank p95 equals its maximum; it is not a high-confidence tail estimate. All 48 probes per revision changed the viewport and completed their corresponding frames **while the child was running**. Each execution had three timer refreshes; follow-output remained false through completion. Both revisions remained responsive on this fixture; there is no demonstrated response-latency improvement.

| Maximum across the eight executions | Baseline ms | Candidate ms |
| --- | ---: | ---: |
| Planned probe to handling (includes scheduling delay) | 14.841 | 15.217 |
| Input dispatch/handling duration | 0.795 | 0.543 |
| Handling to matching frame completion | 31.663 | 32.453 |
| Planned probe to matching frame completion | 45.137 | 45.558 |
| Host event-loop delay | 17.121 | 16.876 |
| Single updateDisplay duration | 0.292 | 0.319 |
| Host heartbeat longest no-progress gap | 61.260 | 46.733 |
| Consecutive probe-frame gap | 515.501 | 513.183 |

The last row includes the intentionally approximately 500 ms probe spacing; it does not denote continuous rendering work or a freeze. Baseline produced 97 total frames across eight executions, candidate 96; totals include startup/final frames. The pre-exit assertion concerns the 48 matching probe frames. Physical-write high-water was one. Every execution produced one tool call, one canonical result and two offline provider calls; the output scenario had two progress events, others one. All active writes, sink timers and input callback references were zero after dispose.

### Lifecycle and compatibility evidence

The result release diagnostic now covers eleven fields, including preview, time, warning and metrics references (the baseline exposed five). All eleven return zero after release; timer owner diagnostics separately report zero handle/state/refresh references. Tests cover success, failed execution, abort, repeated release/stop/dispose, generation replacement, late callbacks, fold/unfold/remount, multiple simultaneous owners, older contexts and frozen final duration. An externally retained released preview can no longer reach output state.

A separate **no-sampler** controlled-GC run uses five warm-up lifecycles then 20 measured lifecycles x 100 changing updates, explicit release assertions and three event-loop-turn/GC cycles:

| Metric | Baseline | Candidate |
| --- | ---: | ---: |
| Heap before measured lifecycles, bytes | 21,521,416 | 21,596,696 |
| Heap after release/GC, bytes | 21,640,392 | 21,729,600 |
| Process heap delta, bytes | +118,976 | +132,904 |
| Live tool owners among 20 weak references | 0 | 0 |
| Pending controlled timers / nonzero derived reference fields | 0 / 0 | 0 / 0 |

These small positive process-heap deltas include harness/JIT effects; they are not exact retained component sizes. Collection of owners supplements, rather than replaces, explicit checks of timers, callbacks, fields and parent-child references. The separate profiler pass's `controlledGcHeapDeltaWithHarnessBytes` includes profiler/harness state and is not used as a leak conclusion.

Real finite-child tests cover nonzero exit and abort as well as success. The existing agent loop asks the provider once more with an aborted signal to settle cancellation; the offline provider honors that signal. The test asserts one aborted provider request and no repeated tool execution, instead of changing the agent loop.

### Commands and results

Run from the implementation worktree in PowerShell. These are full files, not name-filtered tests:

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/tui-final-unmount-cache-owners.test.ts tests/tui-tool-leaf-closeout.test.ts tests/tool-progress-backpressure.test.ts tests/bash-render-reuse.test.ts tests/bash-running-responsiveness.test.ts tests/tui-retained-tool-progress.test.ts tests/tui-retained-source-invariants.test.ts tests/tui-frame-queue.test.ts
node --experimental-strip-types --test tests/tui-real-hot-paths.test.ts tests/tui-hot-paths.test.ts tests/tui-frame-hot-paths.test.ts tests/powershell.test.ts
git diff --check
```

All passed: 177 tests in the first group and 31 in the additional group, zero failures/skips. The new Bash files contain 14 deterministic/AST regressions and six live child regressions. Static checking and the full offline build exited zero. AST checks inspect touched helper/callback bodies and existing retained/frame invariants; their outcome is distinct from runtime allocation measurements.

```powershell
node --expose-gc --experimental-strip-types scripts/bench/bash-render-allocations.ts --updates 1000 --warmup 100 --runs 3 --source-root D:/RMProjects/Pi
node --expose-gc --experimental-strip-types scripts/bench/bash-render-allocations.ts --updates 1000 --warmup 100 --runs 3
node --expose-gc --experimental-strip-types scripts/bench/bash-render-allocations.ts --lifecycle --source-root D:/RMProjects/Pi
node --expose-gc --experimental-strip-types scripts/bench/bash-render-allocations.ts --lifecycle
node --experimental-strip-types scripts/bench/bash-running-responsiveness.ts --runs 2 --source-root D:/RMProjects/Pi
node --experimental-strip-types scripts/bench/bash-running-responsiveness.ts --runs 2
node --expose-gc --experimental-strip-types scripts/bench/tui-tool-leaf-allocations.ts --updates 100 --warmup 20 --history-items 100
```

All direct benchmark commands exited zero. Paths here record the measured checkout; the harness accepts another existing baseline through `--source-root`. The existing leaf benchmark's built-in fixture is **read**, verified in createFixture; it is not Bash evidence. Its four small smoke fixtures had correct final sentinels and zero pending scheduler tasks. Its declaration-style sourceInvariant fields are not counted as new dynamic measurements. New package scripts are `bench:bash-render` and `bench:bash-responsive`; direct Node commands above avoid this host's npm/PowerShell argument-forwarding issue (one initial npm invocation rejected the flags before running the benchmark).

### Remaining limits and follow-up

- The reported long Node/inline Python commands and timing phase inform the quiet/long fixture, but the user's actual generator/source, full session and terminal were unavailable. No specific template or test-code defect is inferred.
- No real Windows terminal/ConPTY, Linux run, complete test suite, online model replay, CPU-saturation experiment or user-extension workload was performed. Local fake-terminal responsiveness does not close the original severe-stall report. CI status must be assessed separately after publication.
- ToolProgressDelivery/drain, the full visual-truncate algorithm, OutputAccumulator decoding/spill/persistence and general Agent/terminal scheduling were not rewritten. Existing context wrappers and whole-output/frame costs remain candidates for measured follow-up, not silently claimed zero.
- Permissions, read projections, canonical output, execution side effects and final flush ordering are preserved by this scope; no retry/replay or output suppression was introduced. This batch does not repeat all of PR #36's unrelated projection tests.
- Keep PR #37 Draft. Component reuse and narrow timer refresh have passed their scoped checks; the broader responsiveness investigation remains open. No model recovery-rate, batching-rate or task token-cost claim is made.

## Implementation instruction (original broader work order)

Continue in this branch and this PR. Read root and applicable nested `AGENTS.md`, `docs/performance/hot-path-allocation-contract.md`, and the previous `tool-recovery-edit-ux.md` before changing implementation. Read the actual current files; function names below are navigation aids, not permission to patch unseen content.

Complete reproduction, attribution, a small coherent production fix, regression tests and measured documentation. Do not stop at counting arrow functions or adding another plan. If a platform-specific cause cannot be reproduced, implement only independently verified improvements, keep the Windows claim open, and state the limitation. Do not invent a production fix merely to satisfy the task.

The user authorizes a new performance PR. Task-specific implementation commits and pushes to this branch are allowed. Do not merge, enable auto-merge, force-push, rewrite published history, alter branch protections, or modify unrelated user changes. If working locally, use an independent clean worktree as needed and do not stash/reset/clean the user's existing work. Keep the PR draft until the measured implementation and relevant checks are available.

## Existing evidence versus hypotheses

The prior validation record reports high allocation in paced large-argument/cardinality scenarios, approximately 1.39–2.47 MB per raw update in that particular measurement. This is a **reported stress-fixture observation**, not a new measurement and not proof that it explains the Node-test freeze. Likewise controlled-GC release at the end does not establish low allocation churn during execution.

Source review provides these candidates, not established root causes:

1. `createLocalShellOperations` in `packages/coding-agent/src/core/tools/bash.ts` uses asynchronous `spawn`. Do not claim synchronous process creation is the established cause. Audit the actual configured backend, wrappers and extension path as well.
2. `ToolProgressDelivery.startDrain` in `packages/agent/src/agent-loop.ts` creates fulfillment/rejection closures around a drain Promise; `drain` constructs update events and awaits delivery. Measure the invocation frequency, synchronous/async branches, Promise activity, fairness and ownership before refactoring.
3. Bash output publication already has a 100 ms throttle. Do not add a second blind timer or assume every raw chunk currently produces a frame. Audit work done **before** throttling, each published snapshot, and the elapsed-time invalidation path.
4. `snapshotBashResultContent` and `bashResultContentMatches` use map/every callbacks; `rebuildBashResultRenderComponent` creates an anonymous collapsed-preview component and render/invalidate closures. Measure their allocation rate during real progress and while scrolling off the tail.
5. `OutputAccumulator.appendDecodedData` makes decoder view/options objects; tail trimming materializes buffers; spill creation and one-time old-spill cleanup include synchronous filesystem work. Determine which operations occur during a stall and whether first-use I/O, output volume, or repeated tail processing is material. Do not mechanically convert security-sensitive or atomic filesystem operations to async.
6. Large streamed tool arguments, observer snapshots/deep freeze, full-result scans, layout, frame generation, terminal backpressure and test-runner CPU contention are distinct possible costs. Establish the dominant path instead of optimizing every occurrence of an arrow function.

Callbacks created once per session/tool lifecycle and callbacks created once per chunk/progress/frame must be counted separately. Moving a closure into an instance-field initializer that runs per event does not remove its allocation. Removing explicit arrow syntax is not proof of zero allocation or a responsiveness fix.

## Production call-chain audit

Audit the complete touched chain, including existing helpers:

```text
actual shell backend / Node child stdout and stderr
  -> output decoding, accumulation, truncation and bounded spill
  -> Bash progress publication
  -> ToolProgressDelivery / Agent dispatch
  -> authoritative extension hooks and display-only observer delivery
  -> AgentSession
  -> InteractiveMode / ToolExecutionComponent / Bash result component
  -> viewport layout and render scheduling
  -> terminal-frame generation / TerminalFrameQueue
  -> ProcessTerminal / actual Writable callback and drain
```

Also trace the input/scroll/resize/abort lane and the lifecycle completion/flush lane. Identify which work occurs in the host process and which occurs only in a Node test child. A synchronous call inside the child is not, by itself, a synchronous block in the TUI host.

Useful starting points, subject to the current tree:

- `packages/agent/src/agent-loop.ts`, `agent.ts`, `event-delivery.ts`.
- `packages/coding-agent/src/core/tools/bash.ts`, `output-accumulator.ts`, shell/child-process utilities and applicable PowerShell backend.
- `packages/coding-agent/src/core/agent-session.ts`, tool result/render wrappers and relevant extension delivery.
- `packages/coding-agent/src/modes/interactive/` and `components/tool-execution.ts`.
- `packages/tui/` scheduler, layout, frame queue and process-terminal implementation.

Do not broaden this into a general rewrite of provider configuration, evidence storage or all TUI components. The bounded read fixes from #36 are regression constraints, not the default optimization target.

## Reproduction matrix

Use finite deterministic offline workloads, then confirm the relevant path with the real SDK, built-in shell and TUI. Do not call paid/online providers or start Chrome.

| Workload | What it distinguishes |
| --- | --- |
| Idle TUI and short quiet child | Scheduling/input baseline and fixed lifecycle cost |
| Quiet CPU-bound Node child, first with controlled single-worker load | Host vs child CPU contention; not an output-rendering test |
| Quiet timed child plus active scrolling/input | A wait/flush lock that suppresses UI for the duration |
| Paced stdout, burst stdout, mixed stderr | Output-path cost and event/backpressure behavior |
| Small total bytes split into many tiny writes versus fewer large writes | Per-chunk overhead vs total output volume; record actual OS chunk counts |
| ANSI, carriage-return updates, split UTF-8, CRLF and long physical lines | Stateful decoding, boundary handling and preview cost |
| Multiple independent tool outputs | Fairness, bounded pending state and lifecycle isolation |
| Large streamed arguments before tool start, then quiet execution | Argument snapshot/serialization cost separate from test execution |
| Real repository Node tests at recorded concurrency | Integrated workload, with child CPU/resource contention identified |
| Short and long transcript, expanded/collapsed output, scrolled away from tail | Whole-history rebuilds and viewport invalidation |
| Slow terminal sink, delayed callback/drain and terminal resize | Terminal ownership, backpressure and responsiveness |

Run the same child workload outside Super Pi as a diagnostic control. Output redirection, disabling observers, lowering concurrency or substituting a fake terminal may be useful **controls**, not the production fix or sole acceptance evidence.

Use the user's Windows platform for final symptom verification when available. Linux CI and a fake Writable do not prove Windows Terminal/ConPTY or another Windows terminal is smooth. Record terminal type/version and rendering mode rather than assume them. If unavailable, leave a precise Windows validation gap and runnable test instructions.

## Measurement requirements

Record base and candidate SHA, Node version, OS, CPU/core count, terminal and viewport dimensions, render mode, enabled extensions, test concurrency, output bytes/lines/chunk counts and pacing. Compare base and candidate on the same machine with identical workloads and settings, including repeat runs and warm-up. Do not compare different machines or quietly change the workload.

Measure execution phases separately: argument generation; child start; child running; output drain; result finalization; post-test idle. Include a wall-clock duration and timestamps for the unresponsive interval.

Required measurements:

- Host input/scroll event arrival -> UI handling -> corresponding physical frame completion, with p50/p95/p99/max and longest no-progress interval.
- Event-loop delay and utilization in the **host**, host CPU and separately observed child CPU. Utilization is not a CPU profile or proof of a particular function's cost.
- Frame scheduling latency, rendering/layout duration, frame bytes and physical write callback/drain delay. A write submission is not physical completion or terminal paint.
- Produced chunks, accumulated bytes, generated progress snapshots, delivered display updates, coalesced updates and frames; active/pending high-water marks and completion counts.
- Explicit closure/Promise/wrapper/array/string-materialization counters on the touched chain, classified by chunk/update/frame/lifecycle.
- Heap allocation samples and leading sites, plus GC frequency/pause observations when possible. Heap slope after GC is a retention metric, not total allocated bytes.
- Retained references and resource counts after success, failure, abort, stop/restart and dispose.

Keep measurement optional and bounded: reuse existing counters and hooks, do not add full-payload logging, an unbounded event list, or one profiling object per output byte. Measure latency without allocation sampling first; profile separately to identify observer overhead. Use scheduled-vs-actual timestamps and a final sample so a long stall cannot disappear from the histogram because the probe itself could not run.

Define responsiveness targets before candidate measurement on a documented controlled fixture. A useful initial target is input-to-frame p95 <= 100 ms and p99 <= 250 ms, with no operation-length UI freeze; these are engineering targets, not claims about arbitrary saturated machines. Use measured base/candidate distributions, not a fabricated percentage. Shared CI should primarily gate deterministic ordering, resource bounds and progress-before-child-exit; keep noisy strict wall-clock performance gates on a controlled benchmark environment.

## Allowed optimization directions

Choose the smallest changes justified by the profile.

### Progress and dispatch

- Preserve a synchronous fast path where the actual consumer returns void; do not manufacture Promises for ordinary observations.
- Keep truly asynchronous extension hooks, rejection handling, final flush and awaited-update semantics intact.
- Replace high-frequency closures with module-level or lifecycle-owned stable callbacks only where ownership, generation and reentrancy are proven correct.
- Coalesce **display snapshots/render intents** before expensive snapshotting/formatting when permitted. Do not coalesce away append-only byte deltas, authoritative tool results, errors or required hook events.
- Keep one bounded latest pending value where the current contract permits it; do not replace Promise tails with an unbounded task queue.
- If profiling demonstrates event-loop starvation, use bounded work and an existing scheduler/macrotask yield with appropriate fairness. Repeated `await Promise.resolve()` or nextTick/microtask chains are not evidence that input/I/O can run. Do not add an unconditional timer/yield per byte/chunk.

### Output and rendering

- Avoid repeated whole-buffer or whole-transcript materialization. Preserve the exact canonical output/truncation/spill contract and finite memory limits.
- Reuse the existing Bash preview component and valid derived state instead of rebuilding anonymous components on every published snapshot, if measurements support this change.
- Limit re-layout to changed visible regions and preserve off-tail scroll position. Update elapsed-time display without forcing unrelated output parsing/layout when possible.
- Keep terminal frame content and cursor atomic; obey callback-plus-drain completion and existing physical writer ownership after logical cancellation.
- Do not hide output, suppress errors, disable scrolling, freeze progress until test completion or simply lower the refresh rate to make allocation numbers look better.

### Style and ownership

Use descriptive names, explicit lifecycle ownership, small cohesive methods and stable object shapes. Do not replace readable code with compressed one-liners or introduce a generic dispatcher framework for a local bottleneck.

Never reuse mutable agent events, messages, tool results, extension-visible objects or provider payloads as pooled scratch. Preserve snapshot isolation at actual delivery time and exact file/permission/authorization checks. Do not weaken structured-clone/deep-freeze boundaries merely to pass a benchmark.

Do not introduce pools or workers by default. Any pool must satisfy the existing allocation contract, including capacity, release, reentrancy, stale-generation and measured-improvement gates. Worker offload requires evidence that its scheduling/serialization cost is worthwhile and is not the default first change. Increasing heap limits, forcing GC or lowering test concurrency is not a code-performance fix.

## Regression and acceptance gates

Add tests for the changed production behavior, not just a microbenchmark of a copied helper.

1. While a real finite Node subprocess is still running, injected UI input/scroll probes are handled and frames advance. Verify pre-exit progress rather than only a correct final screen.
2. Final stdout/stderr representation, exit status, truncation metadata and documented spill cap/marker remain correct. Preserve ordering guarantees actually offered by the backend; do not invent a total order between separate OS streams.
3. Success, spawn failure, hook rejection, timeout, abort, late data/callback/drain and dispose do not leak resources or emit stale updates into a replacement execution.
4. Tool-end/message-end/agent-end are not observed before required pending updates and final-frame handling; cancellation remains responsive.
5. Multi-tool and reentrant listeners do not share mutable scratch, lose terminal ownership or corrupt public snapshots. Required intercepting hooks still execute as specified.
6. Memory and queue use stay bounded under tiny-chunk flood and slow sinks; flush/abort/dispose clear logical references and leave only explicitly required physical-write ownership.
7. Existing source/AST invariants are not weakened or given file-wide exemptions. Audit helpers reached from modified hot methods as well as new lines.
8. Re-run #36's core recovery, bounded-read/cursor/source-identity and snapshot atomicity regressions if shared delivery changes can affect them.
9. Run `npm run check`, `npm run build:offline`, appropriate repository tests and affected allocation benchmarks using actual scripts in package.json. Candidate CI must cover Linux and Windows. Do not claim a pending CI run passed.
10. Demonstrate a measured decrease at the targeted allocation site and no unacceptable regression in latency, throughput, final heap or correctness. Report tradeoffs explicitly. Structural zero-arrow checks alone are insufficient.

Relevant existing benchmark names to verify before use: `bench:tui-tool-leaf-allocations`, `bench:tui-paced-streamed-tool-args`, `bench:tool-result-budgeted-model-view`, `bench:tool-result-contextual-budget`. Add or reuse a real shell-execution responsiveness benchmark; projection-only benchmarks cannot certify runtime scrolling.

Do not change lockfiles, runtime/tool schemas, default permissions, output budgets or unrelated model behavior without a demonstrated task-critical reason. Do not delete tests or reduce assertions to make the candidate pass.

## Delivery

Update this document in place with an explicitly labeled results section rather than retaining a plan as a completion claim. Include the root-cause evidence, complete touched call chain, exact commands, base/candidate table, allocation counters and profile method, lifecycle proof and known limits. Preserve the original user symptom and distinguish it from generic stress fixtures.

Keep logs/profiles bounded and sanitize paths/secrets. Commit only useful fixtures, tests, measured summaries and task source changes; do not commit raw user sessions, huge profiler files, node_modules or duplicate source trees. Clean only resources created by this task and identified by recorded ownership.

Before publishing implementation commits, review the full diff and actual status, run `git diff --check`, and verify no unrelated work is included. Push only to this branch, update this PR with actual results and request review when an implementation exists. Do not merge.

If Windows reproduction remains unavailable, say so prominently. If measured allocation improves but TUI stalls remain, report **allocation optimization complete, freeze not resolved** rather than closing the user symptom. No claim of model recovery-rate or token-cost improvement without an appropriate model evaluation.
