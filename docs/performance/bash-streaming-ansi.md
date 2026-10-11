# Streaming ANSI in user bash output

T06.1 fixes chunk-dependent text in interactive `!` and RPC `bash`. Baseline:
`2beef1bad09661b35881294c4c48bfb1397910af`. The upstream reference is
[27c7b6ff48](https://github.com/earendil-works/pi/commit/27c7b6ff48).
This implementation uses numeric parser state instead of buffering and repeatedly
matching an unfinished suffix. The existing stateless `stripAnsi` API is unchanged.

## Behavior and ownership

`AnsiStreamFilter` owns one number, with six possible states. It accepts ESC/CSI,
OSC terminated by BEL, ESC-backslash or C1 ST, and ordinary ESC intermediate/final
sequences. CSI and OSC C1 introducers are supported after UTF-8 decoding. A malformed
non-OSC sequence recovers at its first invalid character; an OSC continues until its
terminator. An incomplete control is discarded when the command ends. This is an
output filter, not a complete terminal emulator or a parser for every control-string
family. Complete controls, even very long ones, retain no payload between calls.

The executor owns two independent filters and UTF-8 decoders, one per stdout/stderr
source. `BashOperations.onData(data, source?)` carries a primitive source label;
the local backend always supplies it. Legacy callbacks may ignore it, and legacy
custom producers may omit it: unlabelled output is one logical stream using the
stdout slot. An already merged remote stream cannot recover independent source
identity; remote adapters with separate pipes should forward the label.

`TextDecoder` owns only its incomplete UTF-8 prefix. On success or accepted
cancellation each decoder is flushed once; a final invalid UTF-8 prefix becomes U+FFFD. A
flush observer failure rejects even after cancellation. Observed shell input,
observation and incomplete-drain errors retain their previous rejection semantics.
No retry is added. Settled producers cannot append through an old `onData`, including
during asynchronous error-log cleanup. Both decoders stop accepting data before
final callbacks; residual bytes are flushed stdout then stderr. Normal visible
updates retain delivery order without buffering one channel behind the other.
Finally clears both decoders, both parsers, observer,
rolling text references and the local stream reference. A successful log's path
still transfers to the result; error logs are closed and removed by their exact path.

The rolling buffer now trims only the excess prefix, including inside a large
chunk. Dropping a whole oversized chunk previously made a later small chunk erase
the required tail. Its retained logical size is at most `2 * DEFAULT_MAX_BYTES`
(102400 UTF-16 code units); all entries are nonempty, so its entry count has the same
upper bound. The command owns this array and clears it on every exit. V8 may keep a
sliced string's larger backing storage during the command; this is not a claim of
a strict 102400-byte heap limit. Full log writes happen before trimming. Ordinary
output remains caller/session-owned after completion. There is no object pool.

## Complete call-chain audit

1. `createLocalShellOperations` installs two stable, command-owned source
   forwarding callbacks on stdout/stderr, including Windows job child pipes;
   its `finally` removes those exact listeners and releases input/process ownership.
   Remote custom operations use the same public callback boundary.
2. `executeBashWithOperations`: decode -> ANSI filter -> binary sanitizer -> CR
   removal -> optional spill -> rolling output -> stable observer. The decoded
   string and necessary visible-span strings are output allocations. Plain strings
   pass through the filter unchanged. No old input or complete accumulated output
   is rescanned by the filter. Control-only chunks do not allocate buffer entries,
   spill writes or progress events. Final join/truncation and stream creation are
   command/threshold boundaries. Disk backpressure/permissions remain the existing
   storage implementation and are not measured as zero-cost operations here.
3. `AgentSession.executeBash` owns one controller and stable bridge per command.
   Each nonempty delivery still creates its existing `bash_execution_update` event.
   The controller is removed in `finally`; the completed result is recorded once.
   RPC calls this method, serializes events/responses and owns the final result.
   These event objects and JSON strings are existing downstream allocations.
4. InteractiveMode's lifecycle/component guards forward to
   `BashExecutionComponent.appendOutput`, invalidate the viewport child and request
   rendering. Existing component work includes redundant stateless sanitization,
   split/slice arrays, accumulated output joins, truncation options/results,
   preview arrays, a mapping closure, Text/preview construction and styled strings.
   Its output lines are transcript-owned, not bounded parser scratch. The loader
   stops on completion; release clears preview/layout references. These legacy
   per-update allocations are explicitly included in the interactive profile and
   are not described as compliant zero-allocation code.
5. Container/viewport rendering -> `TuiBase.requestRender/scheduleRender` uses
   stable callbacks and a primitive coalesced render request. Composition submits
   one completed frame to `TerminalFrameQueue`; logical active/pending ownership
   remains at most one each. `ProcessTerminal.writeFrame` uses stable callback and
   drain listeners; completion releases them. An orphan OS write retains physical
   ownership until it actually settles. None of these production files changed.

## Reproducible gates and measurements

```sh
node --experimental-strip-types --test tests/bash-output-stream-isolation.test.ts tests/bash-streaming-ansi.test.ts tests/bash-streaming-ansi-hot-paths.test.ts tests/shell-observation-hot-paths.test.ts tests/shell-process-observation.test.ts tests/tui-frame-hot-paths.test.ts tests/tui-hot-paths.test.ts tests/tui-real-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/bash-streaming-ansi.mjs --baseline 2beef1bad09661b35881294c4c48bfb1397910af --output /absolute/evidence/path
node --expose-gc --experimental-strip-types scripts/bench/bash-streaming-ansi.mjs --baseline 9640b5d215efd99762afe97f212fe7564bc5eb9b --output /absolute/review-evidence/path
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000
```

The new AST gate audits parser write/reset, both executor delivery helpers, the
existing binary sanitizer and both local source forwarders. Per delivery it permits zero callbacks, Promise or
AbortController constructors, object/array literals, regex literals or async
continuations. The executor's prior decoder-options object site changes from one
per chunk to zero. Two decoders and two parsers are allocated once per command,
as is the append callback; the local backend adds two stable forwarding callbacks
per command, not per data event. The decode options object is module-owned. String slices and
output array storage are necessary output work, not counted as zero heap bytes.

The benchmark loads real baseline/candidate executor and local backend sources with identical
transpilation and import resolution. Its recorded temporary module directory is
removed in `finally`; it does not require `.git` to be a directory. Both variants
use the unchanged stateless helper and surrounding production modules. The
candidate uses the new parser. Inputs are built before sampling. Each non-UI
scenario processes 20000 chunks (200 commands); the interactive scenario renders
1000 updates (10 commands) with the real BashExecutionComponent at width 100 and
no physical terminal. There are three alternating pairs after warmup. HeapProfiler
samples every 1024 bytes and includes allocations collected by minor/major GC.
The current six-scenario benchmark saves 36 raw profiles and full summaries when
`--output` is supplied. It adds tagged interleaving and local-pipe scenarios to the
original four. The local-pipe case runs each version of createLocalShellOperations,
real PassThrough streams, source callbacks, decoder/filter and output storage;
only process creation is simulated. Every command checks removal of data/process
listeners. A real Node-child regression separately checks OS-pipe source labels.

## Initial implementation measurements at 9640b5d

These historical measurements predate the stream-isolation review fix. The current
two-stream measurements and lifecycle counts follow in the next section.

Lifecycle probes retain the producer's callback after each of 12 commands spanning
success, error and cancellation. After eight GC/event-loop cycles, the baseline
retains 12 observers, 12 callbacks and 12 decoders. The candidate releases all 48
watched observer/callback/decoder/parser objects even while those producer callbacks
remain reachable; late deliveries are inert. Releasing producer callbacks also
releases all 36 baseline objects. Numeric-state tests feed multi-megabyte unfinished
OSC/CSI bodies without adding parser fields or retaining input strings.

Measurements below are recorded after final validation; they measure JS heap
allocations rather than native memory. Heap readings include the harness and
sampler and are observations, not a continuous maximum. Timing is the percentile
of command mean time per input chunk, not an individual-delta latency percentile.
The split-input baseline is incorrect and delivers leaked/empty fragments, so its
lower or higher timing cannot establish equal-output performance.

Recorded on 2026-10-11, Windows x64, Node v26.4.0, Intel i7-14700KF, after the
test/build processes had exited:

| Scenario | Baseline sampled bytes/input chunk, three runs | Candidate, three runs | Median baseline -> candidate |
| --- | --- | --- | --- |
| Plain UTF-8 | 363.05 / 290.47 / 290.30 | 252.84 / 247.96 / 253.58 | 290.47 -> 252.84 |
| Complete colored UTF-8 | 443.55 / 433.31 / 425.13 | 395.70 / 405.00 / 397.90 | 433.31 -> 397.90 |
| Split CSI/OSC | 248.77 / 239.94 / 239.10 | 169.96 / 176.05 / 172.86 | 239.94 -> 172.86 |
| Colored interactive rendering | 42237.76 / 41738.91 / 41738.68 | 42056.58 / 41820.54 / 41722.00 | 41738.91 -> 41820.54 |

Plain/colored workloads both deliver 20000 updates. The split workload delivers
20000 baseline fragments versus 10000 nonempty candidate updates. Interactive
workloads both deliver 1000 updates. Plain execution's leading sampled sites are
TextDecoder's Uint8Array/decode, final join and output append. For the second colored
pair, baseline leaders are Uint8Array (2.18 MB), decode (1.61 MB), replace (1.24 MB)
and sanitizeBinaryOutput (1.12 MB); candidate leaders are Uint8Array (2.08 MB), decode
(1.66 MB), AnsiStreamFilter.write's visible strings (1.33 MB), and sanitizer (1.13 MB).
Interactive leaders remain split/repeat/match/join, approximately 6.6/5.7/5.4/4.3 MB
per 1000 updates in each implementation. This is not evidence that UI allocations
have been eliminated.

Median command-mean p95 times, in microseconds/input chunk: plain 0.39 -> 0.46;
colored 0.68 -> 1.73; split 0.42 -> 0.58; interactive 53.00 -> 53.72. The stateful
scan costs about one additional microsecond for a small colored chunk compared
with the old native regex. This is a correctness/bounded-state tradeoff, not a
claim of a CPU speedup. Interactive variation spans 32.96–66.67 us on the candidate;
the small timing sample does not establish a significant end-to-end change.
For the second interactive pair, observed candidate heap was 24.908 -> 28.650 ->
24.902 MB (before/after workload/after GC); baseline was 24.902 -> 28.657 -> 24.909 MB.
The explicit WeakRef probe, rather than these noisy heap deltas, supports release.

The unchanged queue benchmark processed 20000 64-KiB frames: zero application
closures, frame Promises/controllers/wrappers, frame copies or queue-created frame
strings; flush left zero active/pending references and bytes. Sampled total was
112.12 bytes/frame, dominated by performance.now and harness timing storage.
Source gates cover the production queue and terminal writer; this immediate-sink
benchmark does not measure OS-terminal latency or disk IO.

Validation: eight original minimal regressions failed before the ANSI changes;
the oversized-chunk regression also failed before the rolling-tail fix. All 25
new tests pass. Final type check, offline workspace build (and coding-agent rebuild
after the tail fix), and `npm test -- --jobs 4` pass: 258 execution units, 4238 tests,
4146 passed, 92 skipped, zero failed/cancelled. Existing source invariants and
shell-observation/lifecycle tests are included. Local evidence is under
`.git/t06-1-streaming-ansi-20261011/`; `profile-validated` holds the final raw profiles,
source hashes and exact temporary-module cleanup records. Both complete-suite
temporary roots were verified absent. File-permission changes remain T06.2.

## Review fix: independent stream state

[P2 review feedback](https://github.com/dragonbaba/super-pi/pull/101#discussion_r4239850087)
identified a real loss of stderr diagnostics while stdout held an unfinished OSC
(and the symmetric stderr case). Shared UTF-8 decoding could also combine unrelated
byte prefixes. Separate source labels and fixed decoder/parser slots address both,
without a stream map, per-delivery metadata object, callback or Promise.
The shared generic bash/PowerShell tool's raw OutputAccumulator is not changed by
this fix; the corrected text-filter consumer is the Session/interactive/RPC executor.

On the same Windows/Node/CPU setup, three alternating sample pairs compare against
the reviewed head and against original main. Values are median JS sampled bytes per
input chunk. Each pair uses identical source-loading and fixture paths.

| Scenario | Reviewed 9640b5d -> fixed | Original main -> fixed (separate run) |
| --- | --- | --- |
| Plain UTF-8 | 255.89 -> 253.27 | 288.56 -> 249.67 |
| Complete colored UTF-8 | 396.32 -> 402.48 | 435.55 -> 404.69 |
| Split CSI/OSC, one source | 175.74 -> 178.46 | 247.76 -> 173.47 |
| Interactive component | 42008.30 -> 41927.45 | 42085.70 -> 41898.24 |
| Interleaved sources | 176.44 -> 187.09 | 239.93 -> 181.45 |
| Local backend + Node pipes | 956.98 -> 965.37 | 1006.49 -> 957.70 |

Review comparison's local-pipe bytes/input chunk across all three runs are
993.85/956.98/924.89 before and 965.37/966.65/911.08 after; colored execution is
399.12/396.32/394.58 before and 402.48/402.42/403.12 after. Small increases include
the second command-owned decoder/filter and its EOF flush. Hot callback bodies
still have zero object/array/callback/constructor sites. In the interleaved cases,
the reviewed head drops diagnostics (10000 updates / 40000 visible code units),
while the fix correctly delivers 15000 / 95000. Original main emits unfiltered
fragments (20000 / 115000). Their speeds are not equal-output comparisons.

The second review local-pipe pair's leading allocation sites are getShellEnv
(6.42 -> 6.11 MB), writable buffering (2.57 -> 2.25 MB), decoder Uint8Array
(2.11 -> 2.14 MB), environment keys (1.65 -> 1.63 MB), and Node nextTick
(1.02 -> 0.95 MB), over 20000 input chunks. Existing spawn preparation and Node
stream allocations remain visible. No claim is made that Node or downstream
rendering allocates zero bytes. Median command-mean p95 times are plain
0.630 -> 0.607 us, colored 1.809 -> 1.805 us, split 0.629 -> 0.606 us,
interactive 41.204 -> 32.236 us, interleaved 0.657 -> 0.650 us, local pipes
6.283 -> 5.038 us. These small timing samples and changed correct output do not
establish an end-to-end speedup. Local candidate heap in that pair was
29.740 -> 31.497 -> 29.755 MB before/after workload/after GC, including harness.

Both-channel success/error/cancel GC probes now watch 72 references: 24 decoders,
24 parsers, 12 callbacks and 12 observers. All release while producers retain their
callbacks; late deliveries on either source are inert. The reviewed head's 48
references also release (its defect was shared state, not retention). Original
main still retains 36 until the producer releases its callback. The parser stores
two numbers total, no pending ANSI bytes or input references; UTF-8 incomplete
prefixes are bounded independently. Both local data listeners are removed at the
existing lifecycle boundary. No pool, timer, queue or controller was added.

The new regressions cover both OSC/CSI source directions, interleaved Unicode,
unfinished tail, success/error/cancel, old producer/observer compatibility, real
Node output labels and deterministic production pipe fanout. Existing spill and
AgentSession/component tests now interleave stderr inside stdout controls.
The first synthetic pipe fixture emitted close before readable EOF; it was repaired
to model Node's event order. The production fix was not weakened to accept an
undrained pipe. A readonly ChildProcess test typing issue was also fixed in the
fixture. Evidence is in `.git/t06-1-streaming-ansi-20261011/review-1/`, with 72 raw
profiles across the two comparisons, source hashes and exact module cleanup paths.

Final review-fix validation: 106 focused tests (101 passed, 5 platform skips),
type check, offline build and full `npm test -- --jobs 4` pass. The full suite has
259 units / 4249 tests: 4157 passed, 92 skipped, zero failed/cancelled. This adds
10 isolation/compatibility tests and one listener-ownership source gate to the
initial PR's 25 tests. The repeated 20000-frame queue run leaves zero active/pending
references or bytes and retains its zero application callback/Promise/controller/
wrapper/copy counters; sampled 109.61 bytes/frame is primarily harness timing.
The recorded complete-suite root `super-pi-test-run-Z3CDnw` and all eight recorded
benchmark module directories were verified removed; no process/timer is left running.
