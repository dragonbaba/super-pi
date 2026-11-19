# CodeMode card construction

The default tool card built a fallback Text and a self-render Container before selecting its CodeMode tree. Its first built-in lookup for each cwd also instantiated nine tool definitions even though that table contains no CodeMode tool. The tree now constructs its own display directly. Explicit renderer overrides still take the ordinary lookup path. Unknown tool rows retain their text fallback, and renderer definitions retain their shell selection.

The audited path was Agent tool delivery → InteractiveMode live and history row selection → ToolExecutionComponent → CodeMode tree → retained viewport → terminal queue and flush/disposal. The only removed allocations occur at row construction. The test exercises a custom override followed by a default tree, including padding change, a visible nested read and cache release. The 134 relevant rendering, source-invariant and queue tests passed. Type checking and the 12-package build passed.

Three runs per version on Windows/Node 26.13.0 constructed and rendered 8,192 cards per run after 128 warmups. Both versions produced the same SHA-256 of all rendered lines and released all 8,192 tracked cards after six controlled GC turns. Counts per run fell from 8,192 fallback texts and 8,192 self-render containers to zero of each. Median sampled peak heap was 54.33 → 53.07 MB, median live heap after GC with all cards held was 52.84 → 51.60 MB, and median heap after release was 24.70 → 24.62 MB. Process construction CPU ranged from 16–78 ms before and 15–32 ms after. CPU timing is coarse on this machine.

The 4,096-update handled-failure tree probe created one child row, delivered zero event Promises and released both tracked owners. It sampled 1,249 → 1,213 bytes/update, mostly retained layout, with median/p95 render times of 0.0004/0.0012 → 0.0004/0.0013 ms. The 20,000-update delivery probe recorded zero per-update inline closures, wrappers, Promise tails or Promise arrays. The queue wrote all 20,000 frames at 116.46 sampled bytes/frame with zero frame Promises, controllers, queue string materializations or full copies, and zero active/pending bytes after flush.

Rerun after building offline. For the baseline, run the same construction benchmark against the original tool component.

```powershell
node --expose-gc --experimental-strip-types scripts/bench/codemode-card-init.ts
node --expose-gc --experimental-strip-types scripts/bench/codemode-tree.ts --handled-failures
node --expose-gc --experimental-strip-types scripts/bench/tui-session-event-allocations.ts --updates 20000 --warmup 2000
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000 --warmup 1000
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/tool-renderer-registration.test.ts tests/tool-renderer-source-invariants.test.ts tests/tui-retained-source-invariants.test.ts tests/tui-retained-tool-progress.test.ts tests/codemode-tree.test.ts tests/tui-frame-queue.test.ts
```
