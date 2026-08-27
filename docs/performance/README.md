# Performance benchmarks

Phase 0 benchmarks are offline, deterministic, and write JSON only to standard output. They never require provider credentials and do not modify source files.

Run the default corpus with Node's TypeScript stripping. `--silent` keeps redirected output valid JSON, and the explicit `npm run -- <script>` form works across the supported npm versions:

```text
npm run --silent -- bench:stream
npm run --silent -- bench:tool-progress
npm run --silent -- bench:tui-transcript
npm run --silent -- bench:tui-frame-queue
npm run --silent -- bench:prefix
npm run --silent -- bench:tool-output
npm run --silent -- bench:model-runtime
npm run --silent -- bench:model-runtime:warm
```

Every result uses `BenchmarkResult` schema version 1 and records the commit, Node version, OS/architecture, CPU, memory, terminal dimensions, fixture version, warm-up/measurement counts, p50/p95/p99, min/max, coefficient of variation, heap observations, and benchmark-specific string/boolean observations such as content hashes. Defaults are 5 warm-up and 20 measured runs; local smoke checks may use `--warmup 1 --runs 3`. Shared CI checks schema and deterministic structural counters rather than machine-specific millisecond thresholds.

Larger variants are generated in memory instead of committed as blobs:

```text
npm run --silent -- bench:tui-transcript -- --items 50000 --width 200 --height 60
npm run --silent -- bench:tui-retained-lifecycle -- --items 50000 --cycles 5
npm run --silent -- bench:tool-output -- --mebibytes 10
npm run --silent -- bench:prefix -- --context-kib 1024
```

The TUI transcript benchmark constructs the production `UserMessageComponent` and `AssistantMessageComponent` tree inside the retained transcript container, primes it through `TuiMainScreen`, and applies deterministic synchronous terminal backpressure to every measured update. `RetainedContainer.children` continues to contain the original components; session-local sidecar records own cached lines and never replace child identity. It records root, completed-item, active-item, overlay, generated/visible-line, target-height/block probes, viewport item visits, composed/copied lines, full-history fallbacks, cursor-scanned lines, terminal diff/byte, retained-cache, and pending-render-request counters. The pending-render-request high-water mark describes the existing coalesced render request state, not a terminal output/frame queue; terminal queue work remains reserved for Phase 4C. A completed item retains only its latest width and presentation-version render; active items remain uncached until completion freezes their logical version. Invalidation propagates into the original component, including image/cell-dimension caches. A completed tool's deferred image conversion or custom renderer invalidation advances only that sidecar's visual generation, leaving the frozen logical version and unrelated completed items untouched. The default slow sink rate is 16 KiB/s; change it explicitly with `--terminal-bytes-per-second`. Pass `--cpu-only` to disable simulated sink delay, or `--full-history` to retain the Phase 4A full-history composition path as an in-process control.

Phase 4B adds per-item height metadata, an O(1) cached document height, and a 256-item block-height index. Bottom-following frames walk backward only far enough to cover the viewport; historical Fullscreen scrolling locates the containing block before scanning item heights. Main Screen performs one full initial replay (and a full replay at resize/Kitty safety boundaries) so terminal scrollback remains available, then diffs only its visible absolute-line window. Fullscreen composes transcript and overlays separately. Cursor/IME scanning therefore receives viewport lines only. Line-range composition copies only intersecting lines—even from one 100,000-line item—and carries a numeric Kitty boundary/header observation separately when cropping must start inside an image. Dynamic plain transcript children must call `invalidateViewportChild()` when their height can change; retained version/visual invalidation does this automatically. Direct `children.splice()` insertion or replacement must call `notifyChildrenChanged()`; permanent removal continues to use `removeChild()` or `clear()` so sidecars and height records are released.

On 2026-08-27, Windows x64, Node 26.4.0, i7-14700KF, 120×40, CPU-only runs with 10 warmups and 50 measured active updates produced 5,000-item p50/p95 of 0.0328/0.0433 ms and 50,000-item p50/p95 of 0.0321/0.0456 ms. Both sizes performed exactly 17 target-height probes, zero block probes, 17 viewport item visits, 40 composed/copied lines, one active render, zero completed renders, and zero full-history fallbacks. With the deterministic 16 KiB/s sink (5 warmups, 20 measurements), 5,000 items measured 10.339/10.394 ms p50/p95 and 50,000 measured 10.334/10.487 ms; both wrote 167 bytes. Controlled-GC lifecycle runs (3 cycles, 1 warmup, 3 measurements) used 20 height blocks for 5,000 items and 196 for 50,000; `clear()` reduced retained items, cached lines, indexed items, and height blocks to zero. The final controlled-GC heap slopes were 9,028 and 11,376 bytes/cycle respectively; these noisy slopes are trend evidence, while the structural counters are the portable gates.

The retained lifecycle variant requires `--expose-gc` (included in its npm script). It records numeric cache ownership before clear, verifies every retained/cache count reaches zero after clear, and samples controlled-GC heap after repeated create/render/resize/clear cycles. Heap slope is evidence for trend review, not a pass/fail assertion from one noisy process sample.

Known Phase 4B boundaries are intentional: the first Main Screen replay, width resize, non-Termux height resize, upward content shrink, and Kitty safety boundaries still use the full renderer; arbitrary historical lookup scans forward through 256-item height blocks, while a stable bottom frame performs zero block probes; a 50,000-item width remeasurement can produce a high transient heap peak (347,323,176 bytes in the run above); extension-provided dynamic transcript children must call `invalidateViewportChild()` after any height-changing mutation; and terminal output queueing, latest-frame replacement, and critical final-frame flush remain exclusively Phase 4C work.

The prefix benchmark builds every resource ordering per sample and records the canonical manifest SHA-256, hash-set SHA-256, unique hash count, and drift count. Its fixture identity includes the context size and `prefix-manifest-v1`, preventing comparisons against the older raw-prefix drift harness.

The stream and tool-progress benchmarks use the coalesced observer lane by default. Add `--legacy-delivery` to measure the compatibility `subscribe()` lane, which intentionally awaits and delivers every requested update:

```text
npm run --silent -- bench:stream -- --legacy-delivery
npm run --silent -- bench:tool-progress -- --legacy-delivery
```

Delivery mode is part of each stream/tool-progress fixture identity, so latest and legacy results cannot be compared accidentally. To measure assistant snapshot cost under a provider-like 16 ms cadence, run the paced stream fixture (30 updates by default):

```text
npm run --silent -- bench:stream -- --paced-16ms
```

The cold model-runtime benchmark launches one independent child process per sample, including module loading and production offline runtime construction without credential refresh. The warm fixture constructs another runtime in the already-loaded benchmark process. Both verify `modelCount === profiledModelCount` and record provider/model counts. Use matching Phase 2 and Phase 3 worktrees on the same machine to enforce the Phase 3 cold and warm startup p95 regression budget of at most 5%.

Save baseline and candidate JSON outside the source tree (or under ignored `.artifacts/`) and compare them with:

```text
npm run --silent -- bench:compare -- baseline.json candidate.json
```

Comparison is rejected unless benchmark/fixture, Node version, platform, architecture, warm-up and measured run counts, CPU identity/core count, total memory, terminal dimensions/type, Kitty mode, and exposed-GC mode match. Commit and measurement timestamp are expected to differ and are not comparability keys.

The committed `phase0-v1` fixture identities are locked by `tests/benchmark-fixtures.test.ts`:

| Fixture | Items/bytes | SHA-256 |
| --- | ---: | --- |
| assistant deltas | 100,000 | `d951fcc60ce64a712e4e5942cddd19c09a4654821a545ce28a8c3be5edfbbfd8` |
| tool progress | 100,000 | `63f6c593e0917043e1831a2849942d59a5a1367004be97f755516c050225b889` |
| transcript | 5,000 | `e7491d8a45fff1879998a8ba914f2abd740002c66ed102b0780c853690e573e9` |
| transcript | 50,000 | `38888f343b0cd1bb016e24380b4d067622599871470e58c307817bb95cfba43c` |
| tool output | 1 MiB | `34400900ebb4c42d1e8d2f292ed5655c1f69e930e325da12b1c80d6e5d138c94` |
| tool output | 10 MiB | `177f87570538aa3ee086eb2a16d093fc371d422c00d79ee978de76a75123efbd` |
| resource orderings | 100 | `c9c890a15a88cc2b2f3003acc87f24b8c0b6a08169c7f2057bf9d386bc6d6832` |
| model profiles | 3 | `9e6f8ddda601fa4a19236f6d359173225e16f7b1357c17de805fb9d24df9eb52` |

Conclusions require the same machine, Node version, fixture, and benchmark options. If the coefficient of variation exceeds 0.10, reduce environmental noise before using timing results. Structural metrics such as event counts, render counts, queue high-water marks, output bytes, and final delivery remain the primary regression gates.
