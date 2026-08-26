# Phase 0/1 review benchmark evidence

Measured on 2026-08-26 with Node v26.4.0 on Windows x64, Intel Core i7-14700KF (28 logical cores), 34,134,798,336 bytes RAM, `TERM=dumb`, no Kitty images, and no exposed GC. Every comparison used 5 warm-up runs and 20 measured runs on the same machine.

Baseline: `828542a0053682ebe5729dd7bd5bcac7c8faee33`  
Candidate: `71d20d5b4d4b05d429918c5e2bb79a516c69b94d`

Commands:

```text
npm run --silent -- bench:stream -- --warmup 5 --runs 20
npm run --silent -- bench:tool-progress -- --warmup 5 --runs 20
```

| Benchmark | Metric | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: | ---: |
| stream-events, 100k deltas | p50 | 20.3381 ms | 21.5037 ms | +5.73% |
| stream-events, 100k deltas | p95 | 22.3385 ms | 22.7567 ms | +1.87% |
| stream-events, 100k deltas | mean | 20.7224 ms | 22.0215 ms | +6.27% |
| stream-events, 100k deltas | CV | 0.0561 | 0.0749 | both below 0.10 |
| tool-progress, 100k updates | p50 | 1.2519 ms | 1.3089 ms | +4.55% |
| tool-progress, 100k updates | p95 | 2.1348 ms | 1.9027 ms | -10.87% |
| tool-progress, 100k updates | mean | 1.4628 ms | 1.4665 ms | +0.25% |
| tool-progress, 100k updates | CV | 0.3020 | 0.2115 | still noisy |

Structural results remained identical: stream delivered one final observer event from 100,000 updates with one snapshot and one pending key; tool progress delivered one final observer event with one pending slot and one pending key. The tool-progress timing comparison is not a reliable regression conclusion because both coefficients of variation exceed 0.10. The stream result is stable enough to show a small latency cost from stronger snapshot isolation while retaining bounded delivery.

The strengthened prefix and TUI scenarios were introduced in the candidate harness. Their production paths (`system-prompt.ts`, TUI renderer, transcript components, and theme) are byte-identical between baseline and candidate, so a timing delta would only compare different harnesses. Candidate evidence is recorded instead:

| Benchmark | Fixture | p50 | p95 | CV | Structural evidence |
| --- | --- | ---: | ---: | ---: | --- |
| prefix-build | 100 orderings × 64 resources | 24.0919 ms | 25.0210 ms | 0.0275 | 100 drifts; 100 unique hashes; 173,865 bytes |
| tui-transcript | 5,000 real messages, 120×40, 16 KiB/s terminal | 17.7146 ms | 19.1477 ms | 0.0409 | 5,001 component renders; 12,502 lines; 167 terminal bytes; 10.1929 ms simulated backpressure |

Prefix identities:

```text
canonicalPrefixSha256 = 95fb98ffa65b7d83bd5bbb79cc773c270bc5a5765dfdbefb602eb3e590e5bafe
prefixHashSetSha256   = b66d140e26bfda3a2147e895d2041e7da2d2146181460620cef48c886d7b03de
transcriptSha256      = e7491d8a45fff1879998a8ba914f2abd740002c66ed102b0780c853690e573e9
```

The 100 prefix drifts are now explicit evidence that input enumeration order affects the built prefix. This is not hidden as a timing result and remains a known cache-stability risk for a later phase.
