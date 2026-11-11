# MXC search allocation correction

## Problem and fix

The four-unit Unicode excerpt marker sent an otherwise ASCII result through
the grapheme segmentation path on each result update. The equal-length ASCII
marker preserves the 256-unit excerpt and the existing 121-row long-line
fixture. Its explanation remains once in the status header. The actual tool
component benchmark now covers clipped results in expanded and collapsed views.

Directory traversal previously created the entire `readdirSync` array before
checking the 20,000-entry budget. The worker now owns one synchronous directory
cursor with a 32-entry native buffer, closes it in `finally`, and retains at
most 20,000 pending paths and 200 output rows. Both call-owned arrays are
cleared on every exit. An 80,000-entry lazy fixture consumes only 20,001 entries
to establish the budget stop. EOF, row/text/entry limits, read/close errors,
and real directory closure are covered. The source guard now rejects implicit
array and Promise factories; mutations of the actual line scanner prove that
the guard detects the previously accepted `rows.filter(Boolean)` regression.

## Call chain and ownership

Audited AgentSession -> WorkspaceSandboxTools execute/perform -> serial
scheduler -> backend -> MxcProcess -> worker search/read -> validated reply ->
CodeMode/provider projection -> ToolExecutionComponent -> grep/read renderer ->
Text/wrap/ANSI tokenization -> TuiAltScreen -> TerminalFrameQueue -> ProcessTerminal.
Existing async reservations/signals remain at operation boundaries. Backend
fact validation retains its single bounded key array per reply.
The changed worker loops allocate no application objects, arrays, closures,
Promises, AbortControllers or regular expressions per entry/line. Directory
cursors, search facts and pending/output arrays are call-owned; native fs
creates Dirents in bounded batches. The controlled directory producer excludes
native Dirent allocation from its profile. No object pool is used.

The existing renderer creates one context and two wrappers per result update,
with zero component creations in the measured window. Text invalidates its
layout cache on each result update. This measurement exercises result updates,
not idle frames. Result text has one bounded joined payload; no extra complete
result copy or frame materialization was added to production.

## Verification

Windows x64 10.0.26300, Node 26.13.0, PowerShell 7.6.10, MXC SDK 1.0.1.
Type check and all 12 offline package builds passed. The focused source/worker
matrix passed 42/42, regression matrix 116/116, and native dist workspace/image/
subagent matrix 17/17, all with zero skips. Native cancellation and disposal
released queued work, process/stream references, runtime roots and Job handles.

For 100 result updates per case, sampled bytes/update were:

| Clipped result | Former Unicode marker | ASCII marker |
| --- | ---: | ---: |
| Expanded | 5,402,965 | 1,263,560 |
| Collapsed | 697,124 | 177,993 |

The legacy comparison changes only the equal-length marker outside sampling.
The leading Unicode allocation site was `splitIntoTokensWithAnsi` (399 MB over
100 expanded updates); ASCII sites were `visibleWidth` and `breakLongWord`.
Every case released all tracked result/component references after disposal and
four controlled GC cycles. Samples include the harness; they are descriptive,
not timing thresholds.

Across 64 controlled directory-consumer calls: 1,280,064 reads, 64 opens and
64 closes, no full-directory arrays, and zero tracked cursors/results/facts
after four GC cycles. Sampled allocation was 1,039,768 B/call, led by the
bounded pending-path array in `search` and existing name normalization.
The pure content/files/count/read lanes sampled 22,669/1,874/2,561/1,379 B/call,
respectively, with zero retained references after four GC cycles. Content made
4,480 bounded slices; files made 64 pattern searches and zero line scans or
slices; count made 64,064 pattern and 64,000 line searches; read made 8,896
line searches and 64 slices.

The separate 20,000-frame queue lane sampled 110.10 B/frame, led by its clock.
Closures, Promises, AbortControllers, wrappers and full-frame copies were zero;
active/pending frame references and bytes were zero after flush.

Native equivalent-work comparison against main `583ea2679359bf051ccc7ba96d6d1fa2b5b90552`
used four alternating pairs per permission mode and the unchanged corpus hash
`987cb52e922df8880816e2e542aa01819d026149556d5fdc30546960a715200e`.
Both arms returned the same 120 content rows; candidate file/count projections
returned six paths and 20 lines per file. Content wire size was 5,177 bytes in
both arms. Actual candidate worker SHA-256 was
`baa4bcdd713e927ab28bda6f6502f03b86b1fa0df9e68b5feca16d90a5f46390`.
Thirty Jobs were created and final Job/process handles and retained owners
were zero. This small native sample establishes equivalence, not a speedup.

## Rerun

Set child TMP, TEMP and TMPDIR to an owned `.task-tmp/<task-id>-<unique-id>/`.

```powershell
npm.cmd run check
npm.cmd run build:offline
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/source-invariants.test.ts tests/mxc-file-worker.test.ts tests/mxc-file-completeness.test.ts
node --expose-gc --experimental-strip-types scripts/bench/mxc-search.ts
$env:MXC_RENDER_COMPARE_MARKERS='1'
node --expose-gc --experimental-strip-types --test scripts/bench/mxc-result-render.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000 --warmup 1000
$env:SUPERPI_MXC_LIVE='1'
$env:SUPERPI_SANDBOX_USE_DIST='1'
node --experimental-strip-types --test --test-concurrency=1 tests/mxc-workspace-live.test.ts tests/sandbox-image-read-live.test.ts tests/subagent-parent-execution.test.ts
node --experimental-strip-types scripts/bench/mxc-native-compare.ts 583ea2679359bf051ccc7ba96d6d1fa2b5b90552
```
