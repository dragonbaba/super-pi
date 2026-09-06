# Phase 5C-A large-file read windowing

Goal: SUPER-PI-PHASE5C-A-LARGE-READ-WINDOWING.
Baseline: origin/main d8e0e655c25628eb3aa5711cb3ea7b58cded17c9 (fetched).
Branch: phase/5c-a-large-read-windowing.

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

After: registry/wrapper -> resolve path -> stat dispatch. Small files (<=256 KiB)
and images retain the original access/MIME/read/decode/split/slice/truncate result
path. For large local text: MIME sniff -> canonical workspace/path -> open ->
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

Small-path timing includes the extra stat; a subsequently removed duplicate path
resolution makes these conservative, not final timing claims. Large comparisons
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
open/read/close; cursor calls bypass sniffing. Cursor encoding allocates one bounded
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

Focused read suite: 26 pass. Existing G2 artifact and budgeted-model-view suites:
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
- C: extra small-read stat cost; prefix scan for random offsets; NUL-only binary
  indication; filesystem metadata cannot detect adversarial changes that preserve
  every available generation field; remote/harness whole-file reads remain scoped out.
- D: D-TUI-SMOOTH-STREAMING-REVEAL remains non-blocking and unimplemented.

Rollback point: d8e0e655c25628eb3aa5711cb3ea7b58cded17c9. No main modification,
merge, Mark Ready, rebase, reset/clean, force-push or branch deletion is authorized
or performed. One Draft Candidate Review will be requested on the PR. Merge remains
subject to external final review and explicit user authorization.
