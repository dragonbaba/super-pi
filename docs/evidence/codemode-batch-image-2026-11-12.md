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

## B: committed file revisions

Clean native edit/write/create results transfer the private written buffer into
the existing 128-entry / 8-MiB revision owner (2 MiB per file). Original publication
proof, pinned identity and a fresh streamed hash must agree after the result
journal succeeds. Verification uses at most 64 KiB of scratch; no extra full
postimage copy or public buffer is retained. New versions permit exact-text edits,
not unobserved line anchors. External content/identity changes, partial commits,
retained temporary files, cancellation and stale generations cannot mint a version.
Unavailable caching never converts a completed mutation into a replayable failure.

MXC verifies its actual published file and returns a successor SHA for edit/write,
including new files. Ordered partial batch receipts preserve successful hashes;
unknown/not-started items have none. Explicit input hashes, stop/no-rollback and
cross-call content-hash semantics remain. No required identity token is added.
Old blanket reread instructions are retired; C's parent-failure change is separate.

Audited chains: native invocation -> prepare -> publication -> journal -> revision
admission -> result hooks -> Agent critical delivery -> Session/interactive owners;
MXC worker -> validated reply -> tool details -> script; all clear/dispose paths.
Failed critical observations, including tool-result message start/end, revoke only
the originating new revisions. The Agent
error cleanup uses stable owner callbacks and primitive IDs, with no new normal
event closure, Promise, controller, wrapper, array or payload copy. No pool is used.

Targeted native/MXC/commit/event checks passed 135 cases with one existing platform
skip; the additional postimage GC case passed and released 3/3 buffers after clear,
failed observation and disposal. Full CodeMode session tests passed 111/111, actual
dist MXC workspace acceptance 2/2 (zero skips), complete Windows suite (exit 0), type checking and the 12-package
offline build passed. Native lifecycle profiles released all 275 revision and 98
service/plan references, with cache limits unchanged and zero pending invocations.

For 20,000 updates, Agent -> Session -> interactive-stub profiles sampled 1.598 B
per message update and 0.5808 B per tool update; deterministic inline-closure,
wrapper, Promise-tail/array and built-in listener Promise counts were zero. The
coalesced real Agent path delivered one final snapshot from 20,000 raw updates,
sampling 512.9012 B/raw update including existing dispatcher scheduling; controlled
GC heap delta was 608,768 B. This fixture excludes full component/frame rendering.
The real InteractiveMode/ProcessTerminal synthetic-I/O lifecycle ran ten cycles:
input-ready p50/p95 11.38/50.01 ms, mutation 15.41/36.33 ms, and zero remaining tool,
input and resize owners. These are same-machine observations, not speedup claims.

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
node --experimental-strip-types --test --test-concurrency=1 tests/committed-file-revisions.test.ts tests/committed-file-revision-hot-paths.test.ts tests/native-file-service.test.ts tests/mxc-file-worker.test.ts tests/mxc-file-facts-backend.test.ts tests/codemode-session.test.ts
node --expose-gc --experimental-strip-types scripts/bench/native-files-lifecycle.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-session-event-allocations.ts --updates 20000 --warmup 2000
# Actual MXC acceptance: set child SUPERPI_MXC_LIVE=1 and SUPERPI_SANDBOX_USE_DIST=1.
node --experimental-strip-types --test tests/mxc-workspace-live.test.ts
```
