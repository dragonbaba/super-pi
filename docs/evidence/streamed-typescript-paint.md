# TypeScript paint during assistant streaming

Windows x64, i7-14700KF, Node 26.13.0, baseline `6139f3558`. The growing-code workload delivers 2,000 deltas in 100 updates across 5,000 history items. On the same machine, timing-only p95 changed from 118.50 to 1.79 ms per delivery. Sampled allocations changed from 4,840,037 to 753,542 bytes per delivery. Prose p95 was 0.55 and 0.51 ms. Both runs wrote 100 frames and rendered zero completed history items during streaming. The code workload consists of consecutive TS comments. The sink is synchronous.

The audited path runs from snapshot delivery through InteractiveMode, assistant content and Markdown layout, retained viewport, alt screen and frame queue. The growing body is deliberately monochrome while streaming. The oracle compares the complete pending output against fresh monochrome layout. Completion tests compare the actual colored output with a fresh synchronous render, including tabs, multiline tokens, multiple blocks and width changes.

The fast path uses one callback per paint owner, direct newline scanning and the existing required row materialization. It creates zero per-delta worker jobs, callbacks, promises or abort controllers. Only the final render can collect a bounded batch. One session worker parses normalized tokens and returns HTML without theme state. One waiting completion can replace another. Aborted, replaced and released generations discard their results. Earlier waiting messages remain readable and may be colored on a subsequent layout. Theme formatting and targeted retained-cache invalidation happen on the UI thread. The session retires or terminates its worker on replacement and shutdown.

A separate controlled-GC 80-message completion probe rendered the same 35,000-unit source, checked each final result against a fresh render and tracked the component and its early/final arrays. Both runs released all 240 references. Sampled process RSS peaked at 202 MiB synchronously and 234 MiB with the worker using the production language registry. Final main-thread heap after GC was 24 and 19 MiB respectively. This measures process memory with one worker and includes the oracle.

```sh
npm run build:offline
node --test tests/streaming-typescript-paint.test.ts tests/tui-real-hot-paths.test.ts tests/tui-hot-paths.test.ts tests/tui-retained-source-invariants.test.ts tests/tui-alt-layout-allocation.test.ts
node --expose-gc scripts/bench/tui-paced-real-leaf.ts --growing --timing-only
node --expose-gc scripts/bench/tui-paced-real-leaf.ts --growing
node --expose-gc scripts/bench/tui-frame-allocations.ts --frames 2000 --warmup 200 --alt-control mixed
node --expose-gc scripts/bench/tui-frame-queue-allocations.ts --frames 2000
```
