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
```

Every result uses `BenchmarkResult` schema version 1 and records the commit, Node version, OS/architecture, CPU, memory, terminal dimensions, fixture version, warm-up/measurement counts, p50/p95/p99, min/max, coefficient of variation, heap observations, and benchmark-specific string/boolean observations such as content hashes. Defaults are 5 warm-up and 20 measured runs; local smoke checks may use `--warmup 1 --runs 3`. Shared CI checks schema and deterministic structural counters rather than machine-specific millisecond thresholds.

Larger variants are generated in memory instead of committed as blobs:

```text
npm run --silent -- bench:tui-transcript -- --items 50000 --width 200 --height 60
npm run --silent -- bench:tool-output -- --mebibytes 10
```

The TUI transcript benchmark constructs the production `UserMessageComponent` and `AssistantMessageComponent` tree, primes it through `TuiMainScreen`, and applies deterministic synchronous terminal backpressure to every measured update. The default slow sink rate is 16 KiB/s; change it explicitly with `--terminal-bytes-per-second`. The prefix benchmark builds every resource ordering per sample and records the canonical prefix SHA-256, hash-set SHA-256, unique hash count, and drift count.

The stream and tool-progress benchmarks use the coalesced observer lane by default. Add `--legacy-delivery` to measure the compatibility `subscribe()` lane, which intentionally awaits and delivers every requested update:

```text
npm run --silent -- bench:stream -- --legacy-delivery
npm run --silent -- bench:tool-progress -- --legacy-delivery
```

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
