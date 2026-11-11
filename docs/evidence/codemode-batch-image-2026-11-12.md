# CodeMode batch, revisions and request images

## A: request image budget

The full-history OpenAI-compatible path could resend about 50 MB of tool PNG
base64 despite remaining below the token window. An isolated byte-budget owner
now projects historical tool images independently of optional result presentation,
preserves current images or reports insufficient capacity, and leaves canonical
history unchanged. Source occurrences are counted independently even when tools
reuse image objects. Request views preserve PNG/alpha and existing 2000-pixel /
4.5-MiB defaults; tighter dimensions/bytes are explicit settings. Admission proofs
prevent repeat processing by read/MXC and final tool normalization.

The audited path is Agent loop transformContext -> submitted-image validation ->
extension context -> request image owner -> SDK conversion/body projection ->
OpenAI chat serializer/SDK fetch -> assistant completion -> session recovery.
Model views do not enter TUI/canonical persistence. Body-size observation walks
the existing SDK string without a second JSON serialization or byte buffer.
One fetch wrapper per HTTP request is an explicit request-bound exemption;
there are no new callbacks/promises per stream delta or per image in warmed
projection. New-image encoding is sequential and owns/terminates its existing
worker. Source bytes are cached numerically, source strings are never copied for
accounting, and output reference arrays are created only for changed messages.

The session owner bounds strong image cache storage to 128 entries, 32 MiB of
source bytes and 12 MiB of view bytes. Projection metadata has a conservative
2-MiB admission quota; keys are weak. Transient oversized selected views are
request-owned and bounded by the selected image budget. Clear, failure, abort,
branch/model changes and disposal release references; stale encoding completion
cannot evict a new generation. No object pool is used.

For 44 valid synthetic 1920x1080 PNGs with ancillary padding (50,160,000 base64
bytes), the actual chat serializer sent 50,177,086 B before projection and
11,418,674 B after projection. Eight warmed requests sampled 100,714,630 and
23,140,324 B/request, led by the SDK FallbackEncoder. Observed CPU p50/p95 was
58.03/73.76 ms versus 27.88/38.29 ms, including byte observation in the candidate.
The initial saved-history preparation took 407.57 ms and encoded ten selected
images; warmed requests encoded zero. All 44 metadata sources were inspected
once, no full payload copy was made for counting, and tracked owners/messages
were gone after four controlled GC cycles. These same-machine samples include
the harness and are descriptive, not timing thresholds.

Real session + serializer tests cover presentation on/off without token-budget
dependence, blockImages, one/two 413 responses, unchanged-body rejection and
connection-error -> 413 -> recovery. A representative retry reduced 11.4 MB to
5.7 MB; the original 44-image history remained unchanged and no compaction or
tool replay occurred. Cerebras bodyless overflow retains its token recovery
classification. Unsupported signature/incremental protocols keep prior behavior.

The separate 20,000-frame queue profile sampled 106.45 B/frame; frame closures,
Promises, controllers, wrappers and full-frame copies were zero. Active/pending
references and bytes were zero after flush. Type checking and the 12-package
offline build passed. Image/session regression coverage passed 83 cases with
one unavailable Windows temp-alias skip; the source/encoding/retry matrix passed
59 cases; the final combined request/source matrix passed 86/86. Native dist
image acceptance passed both MXC modes, zero skips. Additional request tests
cover shared identities, cache quotas, UTF-8, current-batch boundaries and
lifecycle failures.

The final boundary regressions also cover 300 selected views across the 128-entry
cross-request cache (1,200 measured and projected bytes), all results from one
assistant tool-call batch, release of the recovery upload ceiling after a clean
response, and unchanged/modified context-hook clones. Schema and projection
invariants passed 36/36; the actual serializer/source follow-up passed 12/12.
The updated allocation sample was 100,701,865 -> 23,148,278 B/request, with zero
warm encodes and zero tracked references after four controlled GC cycles.
Configured/contextual text wrappers now pass the original source and an exact
image probe index through all 11 policy sites, retaining occurrence decisions
even for shared image objects. Text-only actual serializers send no images and
continue with a 13 MiB historical image. The contextual 1/2/4/8-result profile
retained zero coordinators, source references or entries after disposal; full
result copies/serializations, envelope wrappers, Promises and controllers were
zero. Native Windows full-suite execution passed with the documented platform
skips; the RPC overlap fixture also passed independently (two applicable cases).
Sanitized MCP images are matched to their ordered source occurrence by unchanged
bytes/MIME; view selection uses that source without restoring private sidecars.
Fresh cache-miss views invalidate each affected projection, source data/MIME
changes invalidate prior decisions, and repeated occurrences reuse one active
view even after LRU eviction. These regressions and the final request/schema/
projection matrix passed 75/75. The updated request profile sampled 100,736,178
-> 23,140,980 B/request (CPU p50 52.12 -> 21.82 ms), with zero warm encodes and
zero tracked references after four GC cycles.

## Rerun

Use a native absolute child TMP/TEMP/TMPDIR under the task's .task-tmp root.

```powershell
npm.cmd run check
npm.cmd run build:offline
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/request-image-budget.test.ts tests/request-image-budget-session.test.ts tests/request-image-budget-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/request-image-budget.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000 --warmup 1000
```
