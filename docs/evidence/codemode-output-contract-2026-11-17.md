# CodeMode output data contract

## Problem and reproduction

A foreground command can exit 0 with a complete capture while its returned display is truncated or decorated. Parsing that display as JSON fails after the command succeeded. A separate incident used fail-fast `Promise.all` for independent calls, canceling a pending shell after another child failed. This change addresses the data boundary; independent-batch behavior and command-entry convergence are separate follow-ups. No private transcript or real project command is reproduced here.

## Change

- Native foreground Bash/PowerShell captures and verified MCP `structuredContent` issue explicit data references. `readOutput` selects JSON fields or pages arrays/text using the original data, never decorated content. Execution facts remain separate from data errors.
- Branch-owned data references survive failed scripts without requiring successful store writes. They retain at most the existing 256-result/1 Mi UTF-16 inline cache capacities; larger MCP data uses its existing 10 MiB envelope. Native shell capture stays capped at 5 MiB. Clear/reload/branch restore/disposal release references; historical data never grants fresh mutation evidence.
- Source files use the existing private-output owner/expiry machinery. Reads verify identity, length and SHA-256, reject incomplete documents, close descriptors in `finally`, and serialize explicit data operations so concurrent pages do not retain multiple large read/parse buffers. Redacted/replaced native content loses the original data channel.
- Structured data serialization is shared with bounded presentation recovery. Selected bridge values are serialized once, and the host uses that exact bounded encoding. No new command parsing, command precheck, approval, tool quota or automatic replay is introduced.

## Verification and performance

The offline production fixture runs a real child process producing a large 344-item JSON report, then fails postprocessing. A later script selects the saved last four rows; the producer counter remains exactly one. A production Worker fixture reads typed MCP data mixed with diagnostic text. Regressions cover capped/unknown output, invalid JSON, tampering, field selection, redaction, eviction, branch invalidation, and disposal.

Initial full local verification: **6,413 passed, 117 skipped, 0 failed across 469 units**, with `npm run check` and all 12 offline package builds passing. Final focused verification includes the added queued/in-flight branch invalidation regression. Live provider, live MCP server and MXC execution are not claimed; the existing 10-API/14-configuration request-prefix matrix is included in the full suite.

Audited chain: shell `onData` → accumulator append/decode/spill → finish/close → source capture → CodeMode result/Worker bridge → explicit data read/selection → branch restore/disposal. Normal output chunks add **zero callbacks, Promises, AbortControllers or metering buffer copies**. SHA updates borrow the already written buffer; one hash is owned by an opted-in spill and one descriptor is issued at completion. Plain presentation accumulators do not enable hashing. Data I/O and its single read-owner deferred are explicit helper operations, not per-progress/frame work. No object pool is used.

Same-machine Node 26.13.0 Windows baseline/candidate, identical 12 × 4 MiB raw buffers, decoded tails, saved bytes, finish/close and exact-file cleanup: sampled allocations 550,264 → 562,192 bytes; CPU 109,000 → 156,000 µs; peak heap 30,593,176 → 28,314,608 bytes; final heap 10,832,016 → 10,831,680 bytes; retained accumulator owners after controlled GC **0 → 0**. The candidate includes integrity hashing and final source descriptors; this is measured overhead, not a speedup claim. A real SDK/Worker/read/error lifecycle workload kept 418 child calls, 11/11 Worker starts/stops, 55 tracked references and **0 retained references / pending evidence**; sampled host bytes 37,627,848 → 38,306,712, warm p95 15.75 → 15.69 ms. Timing and sampled allocations are observations, not portable thresholds.

Rerun:

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/codemode-data-output.test.ts tests/codemode-output.test.ts tests/codemode-bounded-json.test.ts tests/codemode-hot-paths.test.ts tests/codemode-session.test.ts
node --expose-gc --experimental-strip-types scripts/bench/captured-output.ts
node --expose-gc --experimental-strip-types scripts/bench/codemode-session.ts --handled-failures
npm test -- --keep-going
```
