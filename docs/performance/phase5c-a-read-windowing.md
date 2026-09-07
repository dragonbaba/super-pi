# Phase 5C-A large-file read windowing

Goal: SUPER-PI-PHASE5C-A-LARGE-READ-WINDOWING.
Baseline: origin/main d8e0e655c25628eb3aa5711cb3ea7b58cded17c9 (fetched).
Branch: phase/5c-a-large-read-windowing.

Current closeout: **Corrected Draft Merge Gate**, awaiting external incremental
review and explicit merge authorization. The external-final-review correction
section at the end supersedes the earlier candidate's gate/results. Exact final
HEAD and CI links are recorded in the PR #25 review envelope.

## Previous manual gate closed

G2 / G2S manually validated and accepted-area frozen. User-reported passes:
real configured startup; new session; resume; regular /quit; fullscreen Ctrl+D;
double Ctrl+C; terminal cursor/input/paste restoration; final assistant message delivery.

D-TUI-SMOOTH-STREAMING-REVEAL: GPT-6 Astra output may mix small increments with
larger visible bursts. Non-blocking presentation preference, not a demonstrated
TUI throughput or correctness regression. No smooth reveal, animation timers,
fake typing, grapheme reveal state, or streaming presentation controller belongs here.

All G2/G2S, lifecycle, Assistant/Markdown streaming, terminal queue, ANSI,
artifact, continuation and contextual-budget production areas remain frozen.
No MCP, Evidence Ledger, operation-id, Harness v2, Phase 8 soak, or unrelated TUI work.

## Plan gate

Interactive/SDK: tool registry -> createReadToolDefinition -> wrapper -> execute ->
resolveReadPathAsync -> access -> 4,100-byte image sniff -> readFile -> UTF-8 decode ->
split(LF) -> slice/join -> truncateHead -> extension-visible result -> existing G2
projection / UI. The server harness separately uses ExecutionEnv.readBinaryFile.

No existing file-size threshold. Output limits are 2,000 lines / 50 KiB. Offset is
1-based, zero/omitted starts at 1, negative clamps to 1. Numeric schema accepts
fractional inputs; slice coercion is part of the existing small-file behavior.
LF separates lines, CR is preserved, final LF adds an empty selectable entry, and
empty files have one selectable empty entry. Out-of-range errors include total lines.
Supported images are processed separately; other bytes decode with UTF-8 replacement.
Minified first lines over 50 KiB currently yield a shell fallback notice.

The old reader allocates full bytes, full decoded text, the complete split array,
and selected joined text before output truncation. G2 then optionally applies model
budgets. G2 continuations address persisted message content, not live files; retain
that infrastructure unchanged for each bounded result and add a file-specific cursor.

One PR; production changes limited to local read dispatch and its scanner. Tests,
benchmark and this review packet accompany it. Preserve simple reads through 256 KiB.
No sparse index by default. Measure repeated middle/end scans before reconsidering.

Stop: Draft Candidate Gate — awaiting external final review and explicit merge authorization.

## Candidate implementation and compatibility

After closeout: registry/wrapper -> resolve path -> access/MIME sniff -> small
descriptor snapshot. Ordinary small files (<=256 KiB) use one Buffer sized to the
reported size plus one EOF-probe byte, with generation/path revalidation.
Zero/unreliable sizes read through EOF with bounded growth, capped at 256 KiB + 1.
They retain original decode/split/slice/truncate results; no stream/index framework.
Images retain their original path. Large or changed local text -> canonical workspace/path -> open ->
descriptor generation -> bounded scan -> bounded incremental UTF-8 decode ->
descriptor and path generation revalidation -> close -> bounded text/notice/details
-> unchanged extension, G2 model projection, artifact/continuation and UI paths.

Only `packages/coding-agent/src/core/tools/read.ts` and the new `read-window.ts`
change production. `tests/read-windowing.test.ts`, `scripts/bench/read-windowing.ts`
and this packet complete the five-file candidate. Small-file text, numbering,
offset/limit coercion, error strings and details compare against the existing
custom-operations path, including empty text, CRLF, Unicode, zero/negative/fractional
inputs, first-line overflow and line truncation. Render functions are untouched;
identical small results enter identical projection/rendering paths. The schema
adds optional `cursor`; existing custom `ReadOperations` remain source-compatible.

Scope assumption reported before implementation: interactive/SDK local filesystem.
The separate server harness has only an abstract whole-file read capability;
it and custom remote operations remain unchanged. No Node filesystem bypass is
introduced into remote environments. Those paths do not claim large-read windowing.

## Window and cursor contract

- First reads use line-based offset/limit. Large-file limits must be positive
  integers and are capped at 2,000 lines; offsets clamp at one and truncate fractions.
- Output has an emergency ceiling of 16,384 source bytes / 16,384 UTF-16 code units.
  Invalid UTF-8 can expand to at most 49,152 output UTF-8 bytes. Cursor/notice bytes
  are additional and still pass through the unchanged G2 model budget.
- Scanning toward an offset reuses one 256 KiB Buffer. Reads starting at line one
  or a cursor use one 16 KiB Buffer. No complete-file string or line array exists
  on this path. Only selected bytes are decoded. Prefix scanning only searches LF.
- A chunk ending inside a UTF-8 prefix or immediately after CR rereads at most
  three bytes or one CR. TextDecoder uses streaming decode, replacement on malformed
  UTF-8, and preserves BOM like Buffer.toString. No decoder state is persisted.
- Partial lines are labeled in model-visible text. `details.window` includes
  startByte/endByte (exclusive text range), nextByte, startLine/nextLine,
  startsPartial/partial, done, binary and cursor. A line-limit window consumes its
  terminating LF while excluding that separator from displayed text, matching
  slice/join. Byte-boundary windows retain included LF. A final empty logical line
  remains selectable. Full line/file completion is never inferred from a partial.
- Use the same path and returned cursor, omit offset; limit can change between
  windows. File totals are deliberately unknown until scanned, avoiding a full scan
  solely to render the old remaining-line count. G2 cursors continue the bounded
  message; `read-v1` cursors continue the source file. Their storage is not coupled.
- Cursor metadata binds canonical path, canonical workspace/session digest,
  dev/inode, size, nanosecond mtime/ctime/birthtime, UTF-8, byte and logical line,
  partial state and schema/policy version. Size is capped at 8,192 characters;
  benchmark cursors are 506–516 characters. There is no file-content payload.
- Scope-bound HMAC integrity covers metadata, using session identity and workspace.
  It is not filesystem access control: ordinary file permissions still apply.
  No full-file hashing occurs. Resume uses the persisted session ID. Standalone
  tools without session context get a random instance scope and fail closed across
  new tool instances. There is no cursor registry, retained Map/Set or index to clear.
- No new telemetry/logging calls or cursor telemetry fields are introduced. Cursor
  text is necessarily part of tool messages/session history, not instrumentation.

| Mutation / operation | Outcome |
| --- | --- |
| Unchanged, sequential, same-session resume | Continues at exact byte/line |
| Append / truncate (including below threshold) | stale-cursor |
| Replace, including equal-size content | stale-cursor via identity/generation |
| Delete | stale-cursor |
| Symlink retarget / same-path target replacement | stale-cursor |
| Malformed/tampered, foreign workspace/session, offset with cursor | invalid-cursor |
| Mutation observed during scan/final validation | stale-cursor; no result/cursor issued |
| Abort before open | no descriptor opened |
| Abort/error after open | awaited close in finally before rejection |
| Permission failure on initial open | original EACCES preserved |

Minified JSON/JS follows the same partial-line byte ceiling. Supported images
retain their existing route. General binary detection is intentionally only a
NUL check on the returned range; binary-looking output is explicitly labeled as
UTF-8 with replacement. It is not a whole-file binary classifier or lossless binary
export. Remaining bytes are reachable through the cursor. No new summary or binary
artifact routing is added.

## Measured work and allocations

Windows, Node v26.4.0, same machine, eight paired calls/process. One exploratory
16 KiB scan-buffer process exposed IO overhead (middle 9.52 ms vs 7.81 ms old;
end 16.37 ms vs 7.23 ms old). Two independent processes then measured the simple
256 KiB scanning buffer; no sparse index was implemented or benchmarked. The
streaming path already reduces retained memory from O(file) to O(chunk+window).

| Fixture | Old median ms (two processes) | New median ms | Change |
| --- | --- | --- | --- |
| Small, production dispatch | 0.240 / 0.203 | 0.277 / 0.282 | +0.037 / +0.079 ms |
| 10 MiB middle, 10 lines | 7.292 / 7.979 | 3.432 / 3.327 | 53% / 58% faster |
| Same fixture near end, 10 lines | 7.106 / 7.373 | 5.567 / 5.324 | 22% / 28% faster |
| 10 MiB single line | 6.152 / 6.111 | 0.768 / 0.754 | 88% faster |

Small-path timing describes the first candidate's extra stat and duplicate path
resolution. The closeout descriptor-snapshot fix supersedes that dispatch: no final
small-path timing is claimed, and no additional performance processes were run.
Large comparisons
isolate the scanner versus a test-only full-read/decode/split/slice/truncate reader;
they exclude both production dispatch and G2 costs. Near-end scans still inspect
the required prefix on each offset request. Use cursors for sequential O(window)
continuation. No index complexity is justified by these results.

| Scanner counter / window | Middle | End | Single |
| --- | ---: | ---: | ---: |
| Actual bytes read | 5,505,024 | 10,485,760 | 16,384 |
| Read calls | 21 | 40 | 1 |
| Decoded characters | 639 | 639 | 16,384 |
| LF separators inspected | 81,929 | 163,839 | 0 |
| Prefix/selected scan bytes accounted | 5,243,455 | 10,485,695 | 16,384 |
| Maximum retained source Buffer | 262,144 | 262,144 | 16,384 |
| Source Buffer allocations | 1 | 1 | 1 |
| Bounded Buffer views / decode strings / output appends | 2 | 1 | 1 |
| Complete-file copies / line-array entries | 0 / 0 | 0 / 0 | 0 / 0 |
| TextDecoder create / flush | 1 / 1 | 1 / 1 | 1 / 1 |
| Descriptor opens / closes | 1 / 1 | 1 / 1 | 1 / 1 |
| Continuations issued | 1 | 1 | 1 |

The initial production MIME sniff adds up to 4,100 read bytes, one Buffer and one
open/read/close; cursor calls bypass sniffing. Closeout small-file admission adds
one descriptor open/stat/close before the large scanner (no source Buffer for a
large descriptor). Stable ordinary small files instead allocate their initial size
plus one byte, one Buffer, bounded positional reads through EOF, and generation checks. If they
change, the small Buffer is released and scanning begins afresh. The deterministic
growth regression observes all opens/closes and caps every requested read. Cursor encoding allocates one bounded
metadata Buffer, decoding a supplied cursor allocates one, and crypto has its own
small native allocations. Counters are explicitly scanner-owned, not claims about
all V8/Node internals. `separatorsInspected` counts LF matches used by the scan;
`scanBytes` is accounted source range, not a CPU instruction count for Buffer.indexOf.

Per chunk: zero application closures, Promise tails/arrays, AbortControllers,
inline callbacks, line arrays, complete-source copies or JSON serializations.
Each actual FileHandle.read is an awaited OS Promise boundary with a Node result
object; Node internally allocates additional Promise/FS state. A selected chunk
has one Buffer view and decode string; skipped chunks have neither. The function
owns one decoder/options object, one result/counters object and bounded cursor
metadata per window. The dispatcher creates bounded result/content/details wrappers
and notice strings. No object pool. The old small-file Promise wrapper stays only
on the compatibility path. The AST test enforces the scanner loop restrictions.

One targeted HeapProfiler sampling run (1,024-byte sampling interval), 12 middle
plus 12 single reads: initial heap 31,082,288; observed peak 34,255,960; final
20,116,872 bytes. Leading sampled sites: decoder 16,400 bytes, Buffer.indexOf 13,504,
scanner 10,504; Node FS read 2,608 and FileHandle 2,576. Samples describe surviving
sampled allocations, not total allocated bytes or a precise peak between awaits.
24 source Buffers/decoders and 24 matching descriptor opens/closes; 264 reads,
36 selected views/decode strings; zero complete-file copies/line-array entries.
The aggregate max-chunk counter originally overwrote its value per call and was
corrected to take the maximum (256 KiB); other listed counts were unaffected.

One controlled-GC lifecycle fixture covers success, continuation, mid-scan abort
and out-of-range error. The first execution exposed one reference owned by the
fixture's local result variable; explicitly dropping it corrected the fixture.
Corrected execution: all 14 WeakRefs cleared; 4/4 descriptors opened/closed;
heap initial 19,677,624, observed peak 23,100,152, final 19,740,952 bytes. Three
decoders flush; aborted decoder is released without flushing. This is release
evidence, not a promise that every runtime has identical heap values.

## Verification and review status

Focused read suite: 31 tests after final correction (30 pass and one Linux-only
procfs test skipped locally on Windows; final Linux CI executes that test).
There were 26 at first candidate and 29 at closeout review. Existing G2 artifact and budgeted-model-view suites:
16 pass. `npm run check` and `npm run build:offline`: pass during development.
The single local candidate `npm test` run passed (exit 0), including memory tests.
`git diff --check` passed; status contained exactly the five intended files.
Exact-head Linux/Windows CI is recorded in the PR review envelope at closeout.
CI configuration is unchanged: Node 22.19.x, npm ci, check, offline
build, existing alpha:g2-probe and npm test, checking the PR head SHA explicitly.
No additional manual G2S soak, startup/shutdown or historical matrix was run.

Local self-assessment (external review pending):

- B0: none identified in this scoped candidate.
- B1: none identified in this scoped candidate; exact CI is still a candidate gate.
- C: small-read descriptor/generation-check cost; prefix scan for random offsets; NUL-only binary
  indication; filesystem metadata cannot detect adversarial changes that preserve
  every available generation field; remote/harness whole-file reads remain scoped out.
  Size-unreported virtual sources over 256 KiB fail explicitly and require a regular
  file snapshot; no stable live-file continuation is claimed for them.
- D: D-TUI-SMOOTH-STREAMING-REVEAL remains non-blocking and unimplemented.

Rollback point: d8e0e655c25628eb3aa5711cb3ea7b58cded17c9. No main modification,
merge, Mark Ready, rebase, reset/clean, force-push or branch deletion is authorized
or performed. One Draft Candidate Review will be requested on the PR. Merge remains
subject to external final review and explicit user authorization.

## Candidate Review and single closeout increment

The Candidate Review of 056866d45611f2f431ab8e1167fa093ad158e7f9 reported two B1s
and one C (review 5126222305). All three are addressed in the closeout increment:

- B1 growth between size classification and whole-file read: local text never
  calls unbounded readFile. The simple small descriptor snapshot above bounds reads
  even if a writer appends after fstat. A deterministic test appends 1 MiB during
  the small descriptor's first read, verifies bounded window routing/read sizes,
  and observes every descriptor closing.
- B1 suffix presented as complete at LF/EOF: startsPartial now emits an independent
  model-visible partial-line suffix label. Tests cover LF and final EOF.
- C NFC/NFD filename fallback: initial and cursor reads both use resolveReadPathAsync;
  the cursor still verifies canonical target and generation. Same-spelling resume
  through NFC input / NFD actual filename is tested.

No scanner algorithm, retention policy, or frozen area changed in closeout. Existing
scanner allocation/profile/GC evidence applies; dispatch overhead additions are
counted above, not hidden in scanner counters. No new local npm test, profiling
matrix, or soak was run. Focused tests/check/build passed; exact final-head CI and
the one authorized incremental review are recorded in the PR envelope.

The incremental review of a17c328 identified a further B1: procfs/sysfs can expose
readable content while reporting zero size. The final correction probes through
EOF, handling zero and overreported sizes without claiming an empty result.
Ordinary small files still use one Buffer. Only inaccurate sizes or concurrent
growth require bounded geometric Buffer growth: at most 19 allocations, maximum
capacity 262,145 bytes, at most 524,289 bytes transiently in old/new Buffers and
less than 524,288 copied bytes. These are deterministic source bounds for that
fallback, not new profile claims. No complete large-file Buffer/string is created.
Zero-size regular files that grow acquire a nonzero stat size and route to the
scanner; size-unreported virtual sources that exceed the ceiling fail explicitly,
since no stable generation/size contract for their continuation is available.

Two tests cover zero/overreported metadata, the explicit virtual-source ceiling,
descriptor closure, and real Linux /proc/version. Check/build and the focused
suite pass locally. The two-review budget is consumed; no third automated review
is requested. The final correction remains subject to external final review.

## External final review: B0-5C-A-01 / B1-5C-A-02

Previous exact candidate: ca2a594e6c6918829c85336e003b3af6b62025d5. Its three
commits remain intact. Test-only red commit:
acdb993ce234f1e9e546953c9473794fe3879dd2 (`test(read): reproduce short-read stalls
and underreported file sizes`). Production fix commit:
10299c3b005fc631b6ce7c671055f2437d825e8f. Only `read-window.ts` changes production;
`read.ts`, public cursor format/HMAC/scope, all prior notices/fallbacks, G2, and all
other frozen production areas have no diff against ca2a594.

The red run had 13 cases: 4 pass / 9 fail. CR/UTF-8/consecutive/boundary cases
failed with the finite NON_PROGRESS_REPEATED_POSITION sentinel. The production
underreported-size fixture recorded a successful result with text `x`, startByte 0,
endByte/nextByte 1, done true and no cursor despite actual content of 262,244 bytes
and a stable reported size of 1. No reset/amend was used to preserve this evidence.

The scanner now fills its current preallocated Buffer using direct numeric
`requested`, `count`, `bytesRead`, and `readPosition` slots. Each additional fill
read advances both source position and Buffer offset. Positive short reads never
reach CR/UTF trimming as incomplete chunks. EOF before the expected chunk is full
throws stale-cursor, preserving the existing scanner snapshot contract. No async
per-chunk helper, closure, timer, Promise tail/array, AbortController, carry array,
queue, larger window/buffer, or index is introduced. Normal filesystem read Promises
remain the only asynchronous fill boundary. An outer-loop progress invariant
throws before repeating without logical progress; a non-done cursor must also
advance from the call's startByte. Existing UTF-8 alignment across windows remains
unchanged (up to three prefix bytes may be reread by a new window).

Deterministic first-window traces are `(file position, Buffer offset, requested,
returned)`:

| Case | Trace |
| --- | --- |
| CRLF / four-byte UTF-8 | (0,0,16384,1), (1,1,16383,16383) |
| Repeated ASCII one-byte reads | (0,0,16384,1), (1,1,16383,1), (2,2,16382,1), (3,3,16381,16381) |
| Six consecutive one-byte reads | positions/offsets 0,1,2,3,4,5, then (6,6,16378,16378) |
| Immediately before window boundary | (0,0,16384,16381), (16381,16381,3,1), (16382,16382,2,1), (16383,16383,1,1) |
| Abort between fill reads | only (0,0,16384,1); descriptor closes before rejection |

The small-snapshot ceiling now rechecks the descriptor size for **any** reported
size, not only zero. If actual content exceeds 256 KiB and stat still reports at
most that ceiling, `UnreliableReadSizeError` propagates with stable code
`unreliable-size`. No successful partial content, cursor or automatic scanner retry
is returned. Ordinary growth reflected by a stat size over 256 KiB still routes to
the normal scanner. No `read.ts` plumbing is needed.

Before returning done at reported EOF, the scanner probes exactly one byte with
the existing source Buffer. It does not append that byte or flush the decoder
before verifying EOF. Existing descriptor/canonical-path/generation validation
runs first: an observed generation change is stale-cursor; an unchanged generation
with probe data is unreliable-size. Confirmed EOF (zero returned bytes) permits
decoder flush and the normal successful result.

| Reported size / actual source | Outcome |
| --- | --- |
| 0 / 8,000 bytes | Complete bounded small result, unchanged |
| 1 / 8,000 bytes | Complete bounded small result |
| 16,000 / 8,000 bytes (overreported) | Complete bounded small result at real EOF |
| 0 or 1 / 262,244 bytes, metadata stable | unreliable-size; exactly two production descriptors (MIME + small snapshot), both closed; no retry/cursor |
| Ordinary file grows and stat becomes >256 KiB | Normal bounded scanner; prior growth regression passes |
| Direct scanner, size 1 / 262,244 actual | One-byte EOF probe detects data; unreliable-size |
| Probe detects data plus generation change | stale-cursor takes precedence |
| Reliable EOF, including empty/CRLF/UTF-8 files | One probe returns zero; unchanged text and done=true |

New internal counters: `eofProbes`, `eofProbeBytes`, `shortReadFillCalls`,
`shortReadBytes`, `unreliableSizeDetections`, `zeroProgressPrevented`.
`shortReadFillCalls` counts additional reads after a positive partial fill;
`shortReadBytes` counts bytes returned by positive reads shorter than the remaining
request. Direct unreliable EOF: bytesRead=2, readCalls=2, eofProbes=1,
eofProbeBytes=1, unreliableSizeDetections=1, decoderFlushes=0,
continuationCount=0, opens/closes=1/1. Reliable EOF: eofProbes=1,
eofProbeBytes=0, source Buffer allocations=1. All progressing short-read fixtures
have zeroProgressPrevented=0. Small-path rejection is observed through its typed
exception and descriptor seam, not falsely included in scanner-owned counters.

### Bounded closeout evidence

Focused suite: 45 cases, 44 pass / one Linux-only skip locally on Windows. The
existing 16 G2 artifact/model-budget cases pass. Check and offline build pass.
The single local npm test run passed. Exact final-head Linux/Windows CI outcomes are
recorded in the PR envelope. No broad automated review is requested; the original
two-review budget remains consumed. All four prior review regressions pass and
their thread replies/resolution are recorded on PR #25.

The existing controlled-GC fixture ran **once** after the final production fix:
14 WeakRefs, zero retained; 4 descriptors opened / 4 closed; initial heap
19,702,880, observed peak 22,932,480, final heap 19,771,168 bytes. Four source
Buffers/decoders, zero complete-file copies or line-array entries; one zero-byte
EOF probe; zero non-progress detections. No HeapProfiler campaign was repeated.

Exactly **three** independent timing processes were used for both requested
checks (40 measured pairs plus five warm-up pairs per fixture, Windows Node 26.4.0).
Small-file numbers compare the full current local tool with its legacy custom
ReadOperations path. This measures the existing snapshot/validation cost, not a
new short-read regression. Scanner numbers compare directly against the immutable
ca2a594 module extracted into a test-only temporary file, removed with its fixture.
No baseline reader enters production and no tuning was made from timing noise.

All times below are milliseconds; each row lists process 1 / 2 / 3.

| Fixture | Before p50 | After p50 | Absolute delta p50 | Before p95 | After p95 | Absolute delta p95 |
| --- | --- | --- | --- | --- | --- | --- |
| Small 1 KiB | .1808/.1801/.1895 | .3582/.3572/.3884 | +.1774/+.1771/+.1989 | .2849/.3121/.2910 | .4955/.5744/.4951 | +.2106/+.2623/+.2041 |
| Small 8 KiB | .1783/.1974/.1867 | .3528/.3816/.3771 | +.1745/+.1842/+.1904 | .3009/.3043/.3206 | .5937/.6206/.5037 | +.2928/+.3163/+.1831 |
| Small 32 KiB | .1925/.2002/.2059 | .3694/.3739/.3874 | +.1769/+.1737/+.1815 | .3409/.2789/.3227 | .5278/.5451/.6302 | +.1869/+.2662/+.3075 |
| 10 MiB middle | 2.3747/2.4813/2.3257 | 2.4208/2.4248/2.4203 | +.0461/-.0565/+.0946 | 3.2292/2.8454/2.7840 | 2.9219/2.8693/2.9262 | -.3073/+.0239/+.1422 |
| 10 MiB end | 4.2911/4.1470/4.2574 | 4.2487/4.2420/4.2921 | -.0424/+.0950/+.0347 | 4.5437/4.4543/4.5672 | 4.6573/4.6215/4.6525 | +.1136/+.1672/+.0853 |
| 10 MiB single line | .3061/.3056/.3126 | .3118/.3160/.3020 | +.0057/+.0104/-.0106 | .4883/.4836/.5138 | .4506/.5124/.6303 | -.0377/+.0288/+.1165 |

Scanner p50 changes are within about 4.1%; there is no consistent material
regression. One single-line p95 sample increased by .1165 ms and is retained as
noise/uncertainty evidence, not omitted. Small-path overhead versus the legacy
reader is .174–.199 ms p50 and remains a documented C cost; correctness checks
were not weakened to remove it.

Current self-assessment: B0-5C-A-01 and B1-5C-A-02 are addressed with red/green
evidence; no unresolved B0/B1 is identified locally, pending external incremental
review. C: existing snapshot overhead, unreliable virtual sources fail explicitly,
metadata-generation limits and previously scoped remote/harness behavior. D:
Smooth Streaming Reveal remains frozen/deferred. No third broad automated review,
Mark Ready, merge, Phase 5C-B or Phase 6 work is performed.

Stop: **SUPER-PI-PHASE5C-A-LARGE-READ-WINDOWING Corrected Draft Merge Gate —
awaiting external incremental review and explicit merge authorization.**
