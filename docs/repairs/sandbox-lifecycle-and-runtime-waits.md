# Sandbox lifecycle and CodeMode waits

## Evidence and acceptance plan

Baseline: `fd5bbf4858735e3146107e92db06a3c853968a83` on Windows, Node 26.13.0,
PowerShell 7.6.9. The affected session's image reads now succeed. Later failures
form a different chain:

1. An existing-file write omitted its read snapshot. The worker correctly refused
   it. A subsequent script confused the CodeMode result reference with the file
   snapshot hash.
2. After that refusal discarded the VM, the next startup's `wsb list --raw`
   timed out. Its control process settled with exit 2148734208 and a cancellation
   diagnostic; no start was dispatched.
3. The lifecycle journal recorded `closed-before-start`, with no active control,
   execution or connection owner. The backend accepted only `closed`, falsely
   retained the VM, closed workspace admission and masked the CLI failure.
4. Subsequent calls reported the same ambiguous busy/closed error. Shutdown
   repeated the false cleanup failure.
5. Retrying scripts used `setTimeout`, which the current CodeMode VM does not
   provide. Swallowing that ReferenceError also caused one retry to run without
   waiting.

The private journal and transcript are inspected in place; neither is copied
into repository evidence. The exact scratch root for this task is
`.task-tmp/sandbox-lifecycle-34acecd769ea/`.

Acceptance proceeds through cleanup-state regression tests, read/write snapshot
contract tests, bounded timer lifecycle tests, source/allocation invariants,
offline build, and isolated live sandbox validation. Preserve stale-write checks,
directory grants, PS7-only execution and confirmed physical ownership release.
Never replay a failed command automatically or delete an uncertain old owner.

PR policy: first push waits for review; later pushes request `@codex review`.
Merge only the reviewed final head with all CI checks passing, then return to
main, remove this task's branches and rebuild locally.

## Implementation and observed verification

- Backend cleanup accepts both lifecycle terminal states, only after all physical
  control/execution/connection slots are empty. A pre-start failure preserves its
  original cause and allows a fresh invocation. Blocked cleanup retains the VM
  and artifact owners; the next explicit cleanup re-observes the same owner.
  Re-observation is opt-in (`cleanup(true)`) at the workspace owner. Ordinary
  lifecycle consumers keep the first completion, including its failure.
- Closed admission and busy admission have separate diagnostics. Aggregate
  failures include bounded operation and cleanup reasons and the owner journal
  location, without adding transcript or environment dumps.
- Sandbox read/write descriptions and precondition errors specify
  `result.details.snapshot`, distinguish it from the display `ref`, and require
  reconciliation after a stale read. Version/publication checks remain intact.
- CodeMode provides function-only `setTimeout` and `clearTimeout`: 256 creations
  per script, finite delays of 0..300000 ms, bounded by the script deadline.
  Timer waits remain charged even alongside pending tools. No recurring timer,
  ambient I/O or string evaluation was added.

Observed on the baseline environment:

| Check | Result |
| --- | --- |
| Targeted runtime, image, cleanup and lifecycle regressions | 75 passed |
| Hot-path suite | 111 passed |
| TypeScript check | passed |
| Offline build after CI correction | 12/12 packages, 7609 ms, peak parallelism 2 |
| Packaged sandbox + real Windows VM + CodeMode | read hash → write → reject stale hash → fresh VM → read committed content → repeated close; passed in 15.7 s |
| Live cleanup | zero owned artifacts, source-file references or active VM; test root removed after close |

The broader runtime run initially exposed an old test expecting the pre-timer
idle-message ceiling. It now verifies the explicit `MAX_CALLS + MAX_TIMERS + 1`
ceiling while keeping result-sequence and call-count checks unchanged.

### Allocation and release audit

Audited chain: script timer API → private primitive bridge → worker timer owner
→ scoped VM callback → queued jobs → idle/deadline accounting → completion or
abort → VM/port/worker release. Also checked workspace admission → failed run →
shared discard → lifecycle physical owners → artifact release → session drain.

Each VM owns one stable timer delivery callback and one stable timer-fire
callback. There are no new per-result/progress callbacks, Promise tails,
AbortControllers, regexes or full-output copies. Timer maps are allocated only
on first use (one guest map and one worker map); each explicitly requested timer
owns its guest callback/argument record and native Timeout until fire/cancel/close.
No object pool was introduced. AST invariants include both timer-delivery methods.

`node --expose-gc --experimental-strip-types scripts/bench/codemode-runtime.ts
--compiled --pool` passed all existing allocation/CPU/retention gates. Its isolated
diagnostic worker now also exercises fire, cancellation and unawaited completion:
90 timers created, 30 released at script completion, 31/31 VMs disposed with their
handles cleared; 308 tracked VM, request, map and Timeout references were all
released after controlled GC. The worker itself was released after close.
Sampled worker allocation was 13,014,752 bytes across this diagnostic lifecycle;
the leading site was WASM instantiation (8,891,216 bytes).

The existing pooled-vs-fresh benchmark measured 51.7% fewer sampled host bytes,
CPU p95 ratio 0.367 and final host-heap ratio 1.006. These compare execution modes,
not before/after performance of this fix. They do not establish VM startup or
interactive terminal latency. The live test covers isolated fixture files, not
the user's private project or replay of completed mutations.

### CI compatibility correction

The first head (`d922614aa`) received a review with no findings, but full CI exposed
three existing lifecycle regressions: fixed cancellation, timeout and the volume-sharing
dispatch guard require ordinary repeated `cleanup()` to preserve its first
failure. The cancellation and sharing failures reproduced locally; timeout
showed the same assertion and mechanism in both Windows and Linux CI. Retry was narrowed to explicit
`cleanup(true)` from the workspace owner; the existing tests remain unchanged.
The lifecycle test also proves default callers still receive the original failed
promise before an explicitly requested retry. All 33 lifecycle/consumer checks
then passed, including the unchanged cancellation, timeout and sharing guards.
The legacy compile regression created and confirmed removal of its exact
`.artifacts/wsb-cancel-compile-*` fixtures with suffixes
`8d07c99a-ab8e-4e8d-873e-178a0f4fc453` and
`bf28b757-c2b1-4b42-a86e-bbe77bc170a7`. The attempted negative name filter did not
exclude that test, so the second run also compiled; no such fixture remains.
