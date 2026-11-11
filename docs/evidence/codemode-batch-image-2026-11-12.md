# CodeMode batch, revisions and request images

## A: request image budget

Full-history OpenAI-compatible sessions could resend about 50 MB of tool PNG
base64 while remaining below their token window. The request owner independently
projects historical tool images, preserves the complete current assistant batch
or reports insufficient capacity, and leaves canonical history unchanged. PNG,
alpha and existing 2000-pixel / 4.5-MiB defaults remain; tighter views are explicit.
Admission proofs and unchanged hook clones avoid repeat processing. Text-only
models skip preparation; unsupported signature/incremental protocols retain
prior behavior. Cerebras bodyless overflow retains token recovery classification.

Audited chain: Agent transformContext -> submitted-image validation -> context
hooks -> request preparation -> SDK text/contextual/MCP projection -> chat
serializer/SDK fetch -> assistant completion -> session recovery. All 11 policy
sites carry source identity and existing projection ranges or exact probe indices,
so equal or shared images in a projected subsequence keep their occurrence.
Sanitization never restores private MCP sidecars. Fresh views and source changes
invalidate stale projections. No command restrictions or tool replay are added.

The cache bounds are 128 entries, 32 MiB of source bytes and 12 MiB of view bytes;
the weak projection cache charges metadata and derived payloads to a 2-MiB quota.
Encoding reserves known current occurrences and drops older views incrementally.
Transient view storage converges to the selected budget, with at most one newly
encoded view crossing it; oversized current batches fail as soon as known.
Completion, failure, abort, branch/model changes and disposal release transient
ownership. Stale completion cannot evict a new generation. No object pool is used.
Byte observation scans the existing serialized string without another JSON or
payload buffer; the one fetch wrapper per HTTP request is a request-bound
exemption. Warm image projection adds no per-image callbacks or Promises.

For 44 valid synthetic 1920x1080 PNGs with ancillary padding (50,160,000 base64
bytes), actual serialized body size was 50,177,086 -> 11,418,674 B. Eight warmed
requests sampled 100,769,607 -> 23,174,422 B/request, dominated by SDK
FallbackEncoder; CPU p50/p95 was 51.98/53.32 -> 21.46/28.74 ms. Initial preparation
took 401.65 ms and encoded ten selected images; warm requests encoded zero.
Metadata inspected 44 sources once. Four controlled GC cycles released all
tracked owners/messages. These same-machine samples include the harness.

Real session/serializer tests cover presentation on/off, blocked images, text-only
continuation with a 13-MiB image, one/two 413s, unchanged-body refusal and
connection-error -> 413 -> recovery. Recovery reduced about 11.4 -> 5.7 MB,
without compaction or tool replay; the 44-image canonical history was unchanged.
The final request/schema/projection matrix passed 81/81. Boundary cases include
300 selected views across cache eviction (1,200 measured/projected bytes), 129
mutable/rebuilt views, MCP and ordinary suffix subsets with identical/shared
images, exact strides, current batches, UTF-8, cancellation and generation changes.

A 99-view expansion fixture retained a shared current occurrence while dropping
old views: request peak <=13 MiB, converged 12 MiB, zero transient bytes after
completion, eleven bounded cached views after GC and zero references after clear.
Over-capacity 100-image current batches stopped after thirteen unique encodes or
one shared encode. Contextual 1/2/4/8-result profiling released all coordinators,
entries and tracked sources; result copies/serializations, envelope wrappers,
Promises and controllers were zero. The 20,000-frame queue profile sampled
106.45 B/frame, with zero new frame closures/Promises/controllers/wrappers/copies
and zero active/pending references after flush. Type check and the 12-package
offline build passed. Native MXC image acceptance passed both modes, zero skips.

## Rerun

Use native absolute child TMP/TEMP/TMPDIR under the task's .task-tmp root.

```powershell
npm.cmd run check
npm.cmd run build:offline
npm.cmd test -- --keep-going
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/request-image-budget.test.ts tests/request-image-budget-session.test.ts tests/request-image-budget-hot-paths.test.ts tests/tool-result-presentation.test.ts tests/tool-result-contextual-budget.test.ts tests/tool-result-contextual-budget-source-invariants.test.ts tests/tool-result-presentation-source-invariants.test.ts tests/settings-json-schema.test.ts
node --expose-gc --experimental-strip-types scripts/bench/request-image-budget.ts
node --expose-gc --experimental-strip-types scripts/bench/tool-result-contextual-budget.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000 --warmup 1000
```
