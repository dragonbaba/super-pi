# Catalog pricing tiers: generation and runtime preservation

T05.1 and its required T05.2 inheritance fix share one conversion boundary. The previous generator reconstructed four base rates for most models.dev providers, OpenRouter and Vercel AI Gateway, and dropped pricing tiers. Derived Azure models also discarded tiers. The one existing models.dev tier converter filled missing tier rates with zero; reusing it unchanged would propagate that error to additional providers.

The baseline is `97074eff8c78197dbf4e91ed492e3d7db400d5cc`. Tests execute the actual generator with fixed catalog responses and captured JSON writes, including its final provider overrides and Azure derivation. No paid model requests, public catalog downloads or credentials are required. The shipped model snapshots are not regenerated from moving live catalogs in this change; model-record/default updates remain in T05.3. New catalog generation and online/offline consumption of its output now retain the same prices.

## Behavior and boundaries

- All models.dev conversions use the same helper. Each tier inherits absent rates from the base independently, while explicit zero remains zero. Existing Mistral fallback, Kimi/Moonshot base-price rules and Google alias selection remain in place. Vertex request accounting keeps cache-write storage charges excluded and its Gemini 2.5 Flash cache-read correction in every tier.
- models.dev context thresholds and OpenRouter `min_prompt_tokens` follow the existing strict-above `ModelCost` convention, matching upstream [catalog tier preservation](https://github.com/earendil-works/pi/commit/943a10e744) and [Bedrock correction](https://github.com/earendil-works/pi/commit/4665fafb4d). OpenRouter time/day-dependent overrides are omitted because `ModelCost` cannot represent them.
- Gateway brackets have inclusive starts and exclusive ends. Both starts and ends become transition points, allowing rates to revert to scalar base prices across gaps. Four rate lists are combined into request-wide tiers; the zero-token bracket supplies the initial rates. Source order determines the first matching bracket when brackets overlap.
- models.dev rates retain the existing dollars/million convention. OpenRouter/Gateway dollars/token rates are converted once with six-decimal rounding. There is no currency conversion. Invalid, fractional or negative prompt thresholds are ignored.
- `calculateCost` retains its existing maximum-matching-threshold selection over input + cache read + cache write. Output tokens do not select tiers. One-hour cache-write calculation, unknown-cost routers and explicit user overrides remain unchanged.

## Call chain and ownership

Audited chain: catalog fetch → provider conversion → generator overrides/Azure clone → JSON/provider shard → `flattenModelCatalog` → `createProvider`/profile ingress → remote parse/profile/merge → transactional publication → raw store entry/persistence → current or legacy-profile restoration → user override → provider usage → `calculateCost` → existing event delivery.

Production changes are confined to generator scripts. Nine runtime files (models, store, capabilities, catalog merge/remote overlay, provider composition and three usage adapters) are byte-identical to the baseline. No per-delta/request parser, new runtime import, listener, timer, controller, global cache or pool is introduced. Existing runtime/profile allocations remain; this is not a claim of zero allocation for the entire stream.

Normalized cost objects, tier arrays and tier records belong to the generated model. They contain primitive prices and thresholds, with no references to raw catalog records. No-tier models allocate only one cost object. A two-tier models.dev conversion allocates three objects and one array; previously omitted provider tiers necessarily add two records and one retained output array compared with four-rate-only data. Azure owns separate copied tier records. A supplied special-provider base record transfers ownership to the helper.

Gateway conversion allocates a call-local boundary set and sorted boundary array, each bounded by twice the input bracket count. Output tiers share that bound. Its worst-case work is O(B² + B log B), at generation time only. Temporary references leave scope on return/throw; only normalized output survives. There is no scratch cache or oversized backing store retained for reuse, and no object pool.

## Verification

Environment: Windows, Node 26.4.0, npm 12.0.1.

| Gate | Observed result |
| --- | --- |
| Before-fix behavior | 37 final fixture tests on the unchanged generator: 36 failed, 1 existing Copilot full-tier path passed |
| Candidate behavior | 43 tests passed: 34 provider outputs including Azure, 3 additional format/inheritance tests, ownership/invalid threshold checks, provider exceptions, long-cache accounting and 3 runtime integration cases |
| Runtime integration | Real loopback HTTP 200/304/400, raw cache persistence, current/legacy offline restore, user replacement/empty tier overrides; model input unchanged |
| Focused checks | 86 passed, including catalog merge/profile/cost, source invariants and stream hot paths |
| Type/build | `npm run check` and `npm run build:offline` passed |
| Full suite | 251 execution units; 4078 tests, 3986 passed, 92 skipped, zero failed/cancelled |
| Existing merge benchmark | 4000 baseline + 4000 dynamic → 6000 models; existing indexed merge median 0.2028 ms, p95 0.3120 ms |
| Existing restore benchmark | Offline current-profile restoration: p50 0.0352 ms, p95 0.0614 ms; 13 profiled models, one restored target |

The existing merge benchmark's legacy comparator p95 was 33.8882 ms; the indexed implementation predates this PR, so that difference is not an improvement attributable to this change. Runtime benchmarks are smoke/regression evidence, not a new throughput claim.

Exact counters use AST instrumentation of the actual functions. Native array results are counted separately from array literals; engine internals, iterator objects and string-number conversion internals are outside the counter boundary. The one module-lifetime Gateway field array is excluded from per-call totals.

| Function / workload | Calls | Objects | Literal arrays | Native arrays | Closures | `new` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Previous models.dev helper, 2 tiers | 10000 | 40000 | 20000 | 10000 | 10000 | 0 |
| New models.dev helper, 2 tiers | 10000 | 30000 | 10000 | 0 | 0 | 0 |
| New models.dev helper, no tiers | 10000 | 10000 | 0 | 0 | 0 | 0 |
| OpenRouter, 1 override | 10000 | 20000 | 10000 | 0 | 0 | 0 |
| Gateway, 1 bounded bracket / 2 transitions | 10000 | 40000 | 10000 | 10000 | 0 | 10000 sets |
| Runtime `calculateCost`, 2 tiers | 100000 | 0 | 0 | 0 | 0 | 0 |

Controlled GC released all 46 observed references: 9 raw catalog references while three generated costs remained reachable; 11 cost/array/tier references after generated output was dropped; and 26 model/cost/provider references after normal restoration, legacy restoration, publication failure and cancellation/clear. Four cleared model registries remained reachable during the final check. Store entries and provider registrations were removed. Runtime test servers and temporary configuration directories close in `finally`.

The first test run exposed floating-point assertion ordering and unsupported MiniMax fixture IDs; both fixtures were corrected before the recorded baseline. An initial runtime fixture omitted API-key auth metadata and therefore never entered online refresh; it was corrected to use an explicitly configured fake credential. The first GC probe retained the last loop value in its own top-level frame; moving observation into a returning helper removed that probe-owned root. No production changes were made in response to those harness issues.

## Reproduction

Run from the repository root after building. The allocation probe compares against the fixed pre-T05.1 Git object, which must be available locally.

```text
npm run check
npm run build:offline
node --test tests/model-catalog-pricing.test.ts tests/model-catalog-pricing-runtime.test.ts
node --expose-gc scripts/bench/model-catalog-pricing.mjs
node --expose-gc scripts/bench/model-catalog-merge.ts
node --expose-gc scripts/bench/model-catalog-restore.ts
npm test
```

Task evidence is under `.git/t05-1-model-cost-tiers-20261010/`: pre-edit design, upstream diff, deterministic edit preview, baseline/candidate/focused/type/build/full logs, full summary, allocation/GC output, merge/restore results and source hashes. This verifies catalog conversion and accounting with fixed data, not live provider billing or a release-wide catalog refresh.
