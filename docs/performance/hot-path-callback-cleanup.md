# Production callback and intermediate-allocation cleanup

This follow-up is based on `6ebe643f1dcf6eded74da3b59bb3f177a720dbee` (Draft #53). The implementation and runtime evidence use `ba6a77738860caaa38d2dee8a94daa92e4249f7b`. This document does not expand #53's upstream acceptance work.

## Scope and ownership

The repository inventory examined 858 tracked production JS/TS files, excluding tests, generated output, vendor code and scripts. Inventory matches are candidates, not a claim that every callback or `String(value)` is a violation. The checked production chains are enumerated in `tests/allocation-cleanup-hot-paths.test.ts`; each target must actually exist, and its entire body is inspected.

- Responses/Codex -> `processResponsesStream` -> slot lookup/delta/finalization helpers: pure helpers are module functions; slot maps and parser state remain per stream. Parallel stream regression verifies reasoning/text separators, opaque backfill and distinct response IDs. Request conversion -> `transformMessages` -> message/block conversion and synthetic orphan results: fuse normalization/image downgrade/conversion, retain the necessary ordered orphan pass, and reuse only call-owned pending collections. Tool result text/images are collected together; required outgoing DTOs remain allocated. A request-bound ID callback still captures request model/provider configuration. It is created at request conversion, never per delta.
- Autocomplete/model/settings/LLama selection -> stable search getters -> `fuzzyFilter`: query normalization and swap detection happen once per query, text normalization once per item, scoring returns primitives internally, and output order remains stable. Async fd/network search owns its existing request callbacks and cancellation; no global scratch or cache was added.
- Menu render -> frame/hint/detail/review/wrap helpers -> syntax styling: build only required output arrays, iterate visible rows, and use module formatting helpers. Syntax styling no longer constructs a formatter dictionary with closures per highlight. External highlighting/wrapping still has its own required allocations; this is not a zero-allocation claim.
- HStack/VStack/ScrollView -> child render -> layout/hit helpers: preserve intrinsic/layout/render ordering and child-owned cached arrays. No scratch is shared across owners. Stable ScrollView timeout callback belongs to the view. Compatibility Stack render is distinct from Alt's specialized layout path.
- Markdown token/inline/list/table render -> theme functions -> LaTeX parser/layout: theme callbacks belong to each Markdown owner, default math options and delimiter tables are immutable module configuration, and matrix/layout aggregation uses direct loops. Parser tokens still belong to the current parse. B4 token reuse was not introduced.
- Tree/menu selection -> ancestor/gutter/key formatting helpers: helpers have explicit call-owned maps/sets, retain nearest-visible-ancestor and branch ordering, and key hints use one delimiter scan. Tree construction, labels and explicit preview requests retain lifecycle callbacks.
- Footer render -> whole-session scan and extension status line: B3 history aggregation remains separate from live usage. A narrow status revision invalidates one footer-owned string on actual set/delete/clear. Warm status render does not enumerate/sort/sanitize statuses. Legacy providers without a revision continue to reflect changes. Empty/same-value updates and disposal are tested. This removes status work, not every footer allocation.
- Alt frame -> Kitty placement -> `prepareKittyScreen` -> existing frame queue: scan protocol controls directly, reuse bounded existing cache entries, mark visibility on their owner, and write prepared rows into the caller's output. Preserve transmission-generation checks, LRU order, and existing limits: 16 offscreen entries, 32 MiB encoded and 64 MiB estimated decoded data. No new image cache, retained output scratch, or pool was added.
- Shell capture -> owner `onChunk`: reuse the fixed CR regex and count newlines without splitting the chunk. Its asynchronous execution/abort callbacks remain at the existing execution boundary. Chrome text and actual edit-error rendering preserve empty text-block separators and ignore images without filter/map arrays. Full session render preserves canonical entry conversion while removing flatMap wrappers.
- Prompt URL extension: one extension owner holds stable event/factory callbacks; actual widget components own their theme/text. Metadata completion is generation-checked across prompt changes, actual `session_start` and shutdown. Restore searches history backwards without copying/reversing it. The previous unsupported `session_switch` registration was replaced by the actual session-start boundary. Custom session names remain authoritative.

Fixed global regexes are used only by synchronous `String.replace`, which resets their `lastIndex`; other shared patterns are non-global. No global mutable parser state, unbounded cache, pool, extra health check/retry framework, per-delta credential read, account/provider/endpoint/billing-source switch, or EventStream rewrite was introduced. Unknown values at extension/protocol boundaries still use necessary primitive `String(value)` coercion. The inventory found no production `new String` allocation. B1 visibleWidth fast path, B2 Box cache, B4 Markdown token reuse, the deferred upstream items and unproved Codex #3307 remain unchanged.

## Deterministic and behavior evidence

The new root hot-suite regression contains 11 tests. Its source gate currently inspects 150 function/method bodies; inline function creation, regex construction and map/filter/flatMap/reduce/find/some/every/forEach calls are all **0** in those bodies. The conservative baseline body inventory counted 173 nested functions, 17 regex literals and 149 such array calls. Extracted helper bodies explain why more candidate bodies are separately inspected. This is a scoped call-chain count, not a whole-repository zero-callback assertion.

Goldens were generated from unchanged #53 code, not from the candidate: 44 LaTeX cases; 28 menu width/height scenes including navigation/search; five syntax cases; all seven animation effects with a seeded RNG and multiple widths; five tree filter modes with empty/multi-token/missing queries, hidden ancestors, branch gutters and horizontal clipping. Root tests also cover frozen child render arrays, reentrant and throwing children, Kitty reuse/new transmission generation/capacity/disposal, empty text separators, actual key modifiers/separators and stale widget completion across two independent owners. Existing fuzzy semantic-oracle, footer history, tool execution, stream cancellation and final-unmount regressions are reused.

Footer tests instrument status enumeration and prove 100 warm reads cause zero enumerations; real changes rebuild once, same values do not invalidate, legacy mutable providers still update, and disposal releases the cached line. The former alpha callback test now strictly requires zero warm copy/sort/map and one stable comparator on real changes.

## Offline allocation evidence

Same machine, Windows, Node **v26.4.0**, npm **12.0.1**, serialized processes; baseline #53 versus the implementation commit above. These are offline production-code fixtures, not real online requests. Helper sampling uses Inspector at 1,024-byte intervals after 200 warmups, 1,500 measured calls, the same inputs and final hash/result count. Fuzzy uses 500 items; history conversion uses 500 input messages and a fixed fixture timestamp. All returned array WeakRefs are unreachable after dropping results and two GCs across an event-loop boundary. Heap deltas include retained Inspector profile metadata and are not reported as application retention.

| Fixture | Baseline sampled B/unit | Candidate B/unit | CPU p95 ms, baseline -> candidate |
| --- | ---: | ---: | --- |
| fuzzy filtering | 306,789 | 66,672 | 0.542 -> 0.223 |
| LaTeX nested fraction/matrix | 13,757 | 12,346 | 0.054 -> 0.040 |
| syntax highlighting | 73,634 | 63,089 | 0.190 -> 0.176 |
| history transformation | 376,537 | 303,242 | 0.893 -> 0.353 |
| multi-select menu rendering | 36,336 | 29,455 | 0.132 -> 0.116 |
| production Kitty Alt frame | 11,403 | 10,927 | 0.032 -> 0.031 |
| direct compatibility Stack render | 92,998 | 92,727 | 0.233 -> 0.254 |
| production Alt mouse hit test | 1,063 | 1,087 | 0.0028 -> 0.0039 |

The last three fixtures use the existing `scripts/bench/tui-b3-plan-gate.ts`, 200 warmups and 5,000 measured units. Kitty yields 5,000 writes, 5,110,000 bytes and the same final frame hash. Stack yields 45,000 lines; mouse hit yields 4,250 matches. Both sides terminate normally. The first mouse/Stack samples have p95 regressions; they are retained above. To examine warmup sensitivity rather than hide those results, the same existing fixtures were rerun with 5,000 warmups and 20,000 measured units: mouse 729 -> 568 B/event, p95 0.0023 -> 0.0020 ms, 17,000 identical hits; Stack 92,069 -> 91,458 B/frame, p95 0.298 -> 0.217 ms, 180,000 identical output lines. Stack's total allocation benefit is small; source closure removal is not claimed to eliminate the larger string/layout cost.

Existing `scripts/bench/tui-frame-allocations.ts` with production Main/Alt, 5,000 history items, 200 warmups, 2,000 frames and three lifecycle cycles verifies the full frame boundary:

| Fixture | Baseline B/frame | Candidate B/frame | p95 ms, baseline -> candidate | Frames / UTF-8 bytes, both |
| --- | ---: | ---: | --- | --- |
| production-main | 7,393 | 7,448 | 0.0339 -> 0.0348 | 2,000 / 95,000 |
| production-alt | 11,680 | 11,466 | 0.0487 -> 0.0479 | 2,000 / 366,000 |

Both preserve zero full frame copies, frame Promises, AbortControllers and wrappers; active-write and queue high-water marks are 1, pending frames 0. All tracked layout/component/source/row/index/screen and overlay/selection references are **0 after disposal**, and maximum retained references across three cycles is 0. Main's sampled allocation is slightly higher: no whole-frame allocation improvement is claimed.

Reproduce the existing benchmarks at the baseline and implementation commits:

```powershell
node --expose-gc --experimental-strip-types scripts/bench/tui-b3-plan-gate.ts --candidate kitty-fallback --profile --warmup 200 --measured 5000
node --expose-gc --experimental-strip-types scripts/bench/tui-b3-plan-gate.ts --candidate mouse-hit --profile --warmup 5000 --measured 20000
node --expose-gc --experimental-strip-types scripts/bench/tui-b3-plan-gate.ts --candidate stack-direct --profile --warmup 5000 --measured 20000
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --fixture production-main --warmup 200 --frames 2000 --lifecycle-cycles 3
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --fixture production-alt --warmup 200 --frames 2000 --lifecycle-cycles 3
```

Local evidence is under `.artifacts/hot-path-allocations/`: `target-counters.json`, `profile-*-baseline.json`, `profile-*-candidate.json`, `performance-results.json`, `production-results.json`, and the ignored helper sampler. No second test runner or workflow is committed. Raw profiles are retained locally; the checked-in structural and behavior tests are the portable gates.

## Validation limits

`npm run check`, offline build, root hot suite and provider contract suite passed. `npm test -- --list` includes the new regression. Full local `npm run verify` exited **1**, at `tests/lsp-validation-scope.test.ts` / `actual tool classifies capped directory symlinks before declaring omitted scope`, during exact fixture cleanup (`ENOTEMPTY` on Windows junction root). The prior baseline also reproduced this issue; that does not establish its exact environment root cause. The runner did not reach later files. No cleanup error was swallowed, timeout raised, skip expanded or production LSP/ACL behavior changed.

Supplementary validation uses the existing `scripts/test.mjs` with 136 tiny import wrappers under the ignored artifact directory. Original relative file names preserve suite classification, isolated cwd and GC flags; each wrapper imports its exact existing root test. The same runner still executes the memory workspace. This first supplementary run stopped at `mutation-contract-recovery.test.ts`: the process could not resolve Bash from its PATH/default locations, yielding `[SHELL_START_FAILED]`. The identical test under the baseline reproduced that exact startup error. Existing `D:\Git\bin\bash.exe` was confirmed; a second supplementary root includes that failed file and the remaining 112 files, with only the test process PATH prepended by `D:\Git\bin`. No global toolchain or settings were changed. This supplements the interrupted runs and never changes verify's exit code. Its final status and current-HEAD Linux/Windows CI belong in the PR body, avoiding a status-only commit cycle.

Prior #53 verification failures and quota-blocked remote review remain accurately recorded in that PR. 本次在线有效性未实测。Original policy-blocked temporary junction directories and pack artifact remain retained at their recorded identities; no cleanup bypass or main-workspace user-file change was attempted. Remote Codex review must not be treated as passed until an actual covered-version review is returned; an unchanged quota block is not retriggered.
