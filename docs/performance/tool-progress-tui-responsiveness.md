# Tool progress / TUI responsiveness: implementation work order

Date: 2026-09-16. Repository: `dragonbaba/super-pi`.

## Status and scope

This is the work order for a new performance PR, not a completed optimization report. The initial commit changes documentation only. No production fix, Windows reproduction, benchmark improvement, or successful implementation task is claimed by this document.

- Branch: `perf/tool-progress-tui-responsiveness`.
- Starting commit: `ef6fe1c696e5f76fa915befd8c8dc0a4d982287f` (main after PR #36).
- PR #36 is merged; do not amend its branch or undo its recovery behavior.
- User report: when the model runs some Node tests, the TUI becomes unresponsive or stutters and recovers only after the tests finish. The user also identifies excessive closures and temporary objects in hot paths.
- The exact Windows terminal, affected test command, extension combination, and execution-time profile have not yet been captured. Do not invent them.
- The initiating environment could read GitHub through its connector but could not clone the repository into its execution container. Therefore this starting commit contains a precise implementation and validation brief rather than speculative production changes.

The requested outcome is **responsive input, scrolling and rendering while a test is still running**, together with measured reductions in unnecessary hot-path allocations and clearer ownership. Faster rendering after the subprocess exits is not sufficient.

## Implementation instruction

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
