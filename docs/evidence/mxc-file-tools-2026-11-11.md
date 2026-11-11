# MXC file tool completeness

The pre-MXC VM acceptance source is archived at b9843f859. The current MXC
workspace and image tests passed in both permission modes after retiring the
old VM scripts and test-runner routing (4 passed, zero skips).

## Reproduction and fix

The baseline worker returned bare no-match output for a file with its only
match beyond 2 MiB, clipped a 40,003-unit read without status, and showed a
256-unit prefix without identifying it as clipped. The worker now reports
read-window and search-coverage facts, the backend validates them, and tools
keep the facts in details and put actionable notices before the body. A clipped
line suffix suppresses nextOffset; a missing LF or CRLF terminator at the
output boundary allows the next physical line. The legacy input range remains
accepted, including offsets at Number.MAX_SAFE_INTEGER and Number.MAX_VALUE.
A short excerpt mark shares the existing per-row budget. The 150-long-line
fixture returns 121 records, matching the baseline record capacity.

## Verification

Windows x64 10.0.26300, Node 26.13.0, MXC SDK 1.0.1, PowerShell 7. TypeScript
and 12/12 offline builds passed. The file, transport, projection, image,
ownership and real dist workspace tests passed 86/86, zero skips. The eight
CodeMode/provider cases cover direct results and both display modes at 256
and 16,384 tokens. No model API was contacted.

The production path runs from AgentSession through the MXC owner, serial
scheduler and isolated worker, then through backend JSON validation to
CodeMode/provider projection and ToolExecutionComponent/TUI. File loops
allocate no per-line objects, closures, promises or line arrays. The bounded
backend reply validation enumerates one key array per read/search result.
The scan
retains at most 200 rows and 20,000 pending paths and clears both on exit.
The source invariant passed. Over 64 calls the search fixture made 4,480
excerpt slices including 64 rejected candidates. The read fixture made 8,896
line scans and 64 slices. Sampled allocation was 22,142 and 1,469 bytes/call,
respectively, including instrumentation. Each lane had zero live fixture
references after four controlled GC cycles.

A host-worker result probe delivered production read and grep results through
the existing tool renderer and alt-screen frame path. Both status strings
were visible. Each lane rendered 100 result updates, with 100 renderer calls
and zero component creations in the measurement window. Both renderer and
result references were released after disposal and four GC cycles. The
renderer source and frame scheduler are unchanged.

## Grep output modes

The optional files and count projections share the literal match and complete
file eligibility rules. The worker returns one row per matching file. Count
increments once per matching line. Tests cover LF-start and cross-line
patterns, regex metacharacters, encoding suffixes and bounded partial output.
The focused worker/transport/provider matrix passed 69/69. The provider
capture covered all 16 direct/CodeMode cases. Its top-level schema was 12,002
bytes and it ran entirely offline.

Across 64 scans, files used 64 pattern searches and no LF searches or slices.
Count used 64,064 pattern searches, 64,000 LF searches and no slices. Sampling
including fixture instrumentation yielded 2,144 and 2,442 bytes/call. Both
lanes released all tracked references after four controlled GC cycles.

## Native acceptance and equivalent results

The final 12-package build and type check passed. The final targeted run
passed 147/147 with zero skips. That includes all 17 tests in the native workspace, image and
subagent files, with zero skips. In both permission modes the packaged MXC
worker returned the expected status and projections. The workspace tests also
verified CRLF continuation, huge-offset EOF, an oversized-file gap, PowerShell
7, permission enforcement and release of the process, streams, root and Job
handles. Child cancellation left zero queued backend calls and zero subsequent
writes. Candidate first-read and reused-owner read samples were 728/187 ms in
read-only and 610/165 ms in sandbox-write.

For the equivalent-work probe, the b9843f859 worker and packaged candidate
worker ran in the same MXC transport with the same process limits and one
reused owner per arm. The synthetic corpus is file-0.txt through file-5.txt,
each with 20 copies of "needle needle: fixture <index>\n". Both content arms
returned the same 120 rows. Each permission mode used four alternating pairs
and also verified six file paths and count 20 for each file. Raw wire sizes,
including the newline, were 4,806 B for baseline content, 5,177 B for
candidate content, 495 B for files and 513 B for count. Observed medians in
read-only were 180.30/177.99 ms and in sandbox-write 167.42/172.07 ms.
These warmed native-worker measurements exclude startup and provider work.
The small timing sample establishes no speedup.

The targeted renderer benchmark delivered 100 identical completed results
per case through ToolExecutionComponent and TuiAltScreen. The read/grep status
was visible. Sampled bytes/update were 667,470 and 29,958, with one existing
render context and two existing wrappers per result, zero component creations,
and zero retained component/result references after four GC cycles. Separately,
the 20,000-frame queue benchmark sampled 110.20 B/frame, led by its clock,
with zero frame closures, promises, AbortControllers, wrappers or full-frame
copies and zero active/pending references and bytes after flush.

## Rerun

Set child TMP, TEMP and TMPDIR to an owned task directory.

~~~powershell
npm.cmd run check
npm.cmd run build:offline
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/mxc-file-worker.test.ts tests/mxc-grep-output-modes.test.ts tests/mxc-file-completeness.test.ts tests/mxc-file-facts-backend.test.ts tests/mxc-file-projection.test.ts tests/mxc-workspace-lifecycle.test.ts tests/sandbox-workspace-paths.test.ts tests/sandbox-image-read.test.ts
node --experimental-strip-types --test --test-name-pattern="sandbox literal search scans monotonically" tests/source-invariants.test.ts
node --expose-gc --experimental-strip-types scripts/bench/mxc-search.ts
node --expose-gc --experimental-strip-types --test scripts/bench/mxc-result-render.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000 --warmup 1000
~~~

Set SUPERPI_MXC_LIVE=1 and SUPERPI_SANDBOX_USE_DIST=1 in the live-test child
and run tests/mxc-workspace-live.test.ts, tests/sandbox-image-read-live.test.ts
and tests/subagent-parent-execution.test.ts with Node's test runner.
