# Growing assistant stream baseline

The paced replacement fixture submits short independent messages. Run the growing variant to exercise cumulative partial messages, nonempty text deltas, the production Markdown theme, observer snapshots, the interactive component and the alternate-screen renderer. The scheduler advances 16 virtual milliseconds per batch. The terminal completes writes synchronously. Each final component output is checked against a fresh render of the complete source after measurement.

Windows x64, Node 26.13.0, i7-14700KF, packages rebuilt together from base `4799e1b21`. Each fixture has 5,000 completed items and 100 measured deliveries of 20 updates after ten warm-up deliveries. The measured stream starts with an empty body. Code grows inside one open TypeScript fence. Timing and allocation profiles run in separate processes.

| Fixture | Final UTF-16 units | Batch wall p95 ms | Dispatch and flush p95 ms | Render to synchronous sink p95 ms | Sampled bytes / delivery |
| --- | ---: | ---: | ---: | ---: | ---: |
| Prose | 34,890 | 0.497 | 0.069 | 0.398 | 399,294 |
| Code | 34,896 | 118.206 | 0.102 | 118.105 | 6,538,882 |

Stage percentiles are computed independently. Code allocation samples include RegExp execution, splitting and ANSI wrapping. Timing and sampled runs produced matching final SHA-256 hashes for both workloads. This benchmark covers an offline synthetic producer and sink. Physical display latency and live inference require separate measurements.

```sh
npm run build:offline
node --expose-gc scripts/bench/tui-paced-real-leaf.ts --growing --timing-only
node --expose-gc scripts/bench/tui-paced-real-leaf.ts --growing
node --test tests/tui-real-hot-paths.test.ts
```
