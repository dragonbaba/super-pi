# Request input estimate calibration (T04.6)

The request estimator uses **3.5 UTF-16 code units per estimated text token**, while keeping the existing **1200-token image placeholder**. Provider-reported usage remains the anchor; only unmeasured trailing messages and newly added tools are estimated. This is a small correction to request headroom, not an exact tokenizer or a guarantee against context overflow.

Baseline: `ea5b7e0878621eaeff73c3298853a0fbfc7b4597`. Environment: Windows x64, Node 26.4.0, npm 12.0.1. The runtime changes only two numeric constants in `packages/ai/src/utils/estimate.ts`. The separately implemented compaction and tool-output estimators, usage/cost totals, 4096-token safety reserve, minimum answer and caller/model output ceilings keep their contracts.

## Calibration and decision

[Upstream 27075fe075](https://github.com/earendil-works/pi/commit/27075fe075) changed 4 to 3.5 to reduce context-limit failures. Before changing Super Pi, a fixed local corpus compared those divisors with `js-tiktoken@1.0.21` using `cl100k_base` and `o200k_base`. These are offline text references; they do not measure a DeepSeek/Claude model, provider framing, image billing or a live request.

| Fixed text fixture | UTF-16 units | cl100k / o200k tokens | Old estimate | New estimate |
| --- | ---: | ---: | ---: | ---: |
| English instructions | 33536 | 5632 / 5632 | 8384 | 9582 |
| Chinese instructions | 8960 | 7168 / 5888 | 2240 | 2560 |
| Mixed Chinese/English | 14336 | 6912 / 5120 | 3584 | 4096 |
| TypeScript | 35328 | 8704 / 8704 | 8832 | 10094 |
| JSON results | 22272 | 7168 / 7168 | 5568 | 6364 |
| 64 tool definitions | 22263 | 5186 / 5250 | 5566 | 6361 |
| 512 log lines | 44032 | 16384 / 16384 | 11008 | 12581 |
| Repeated ASCII, 512 units | 512 | 64 / 64 | 128 | 147 |

The smaller divisor reduces underestimation for logs, JSON and mixed text without adding a full-text scan or a runtime tokenizer dependency. It increases the already conservative English estimate. Chinese remains substantially underestimated: the example still falls short by 4608 tokens against cl100k. A more complex language/model-aware estimator needs its own accuracy and hot-path cost evidence; this change does not claim to solve that larger problem.

The corpus runs each text both as fresh input and as a tail after synthetic usage of 2000 tokens. The anchor remains 2000 in every variant. Separate cases cover system/schema prefixes, deduplicated tool additions after usage, and image-only/mixed tails. Blindly changing only the upstream divisor would raise the image placeholder from 1200 to 1372 despite having no image measurement. Super Pi instead derives image characters as `1200 * CHARS_PER_TOKEN`, preserving image accounting and avoiding any base64 reads.

Run the committed calibration with:

```sh
node --experimental-strip-types scripts/bench/request-input-estimate-calibration.ts
```

The JSON report records the estimator SHA256, current commit, both text references, all three estimator variants, and residual under/over counts. Long homogeneous strings are bounded in tokenizer fixtures; 10 MiB strings are exercised by length/allocation probes instead of expensive JS tokenization.

## Request boundary regression

For the log fixture and a 32000-token context window, the old estimator permits 16896 output tokens. The reference text input plus that output is 33280: 1280 over the window. The corrected estimate permits 15323, giving a sum of 31707 and leaving 293 before provider framing. The new test exercises the real Simple Chat adapter and intercepts its final HTTP body with an offline fixed-reference validator; it makes no network request.

Additional tests cover unchanged usage/cache totals, stale timestamp anchors, error/aborted responses, tool arguments and schema additions, circular JSON fallback, image data that throws if accessed, output ceilings, minimum response capacity, and legacy non-adaptive clamp behavior. The final same 11 tests produce 10 failures and one control pass with the baseline estimator; all 11 pass with the candidate.

## Complete production chain and allocation ownership

The audit covers final tool results after execution/extensions → AgentSession/SDK `convertToLlm` → `ToolResultPresentationOwner.projectMessagesWithinContextualBudget` → `estimateContextTokensFromParts`/`estimateMessageTokens` → result projection → provider `streamSimple` → `buildBaseOptions`/`clampMaxTokensToContext` → `estimateContextTokens` → provider serialization/payload hook → SDK/fetch → streamed event delivery → completion/failure/abort/disposal.

All 14 estimator function bodies, request clamp, projection coordinator, SDK bridge, agent loop, and inspected OpenAI/Anthropic/Bedrock adapters are unchanged. Existing estimate result/usage-info objects and JSON serialization of tool schemas/arguments remain. There are no new string scans/copies, runtime imports, arrays, callbacks, promises, abort controllers, listeners, timers, caches or pools. The estimator retains no caller data after returning.

Exact AST-instrumented comparison, 10000 calls per case:

| Case | Baseline and candidate counts |
| --- | --- |
| Raw text, 1 unit or 10 MiB | 10000 length reads; 0 objects/arrays/closures/constructors/serializations |
| Fresh text context | 20000 existing result objects, 30000 length reads |
| Usage-anchored text tail | 30000 existing result/usage-info objects, 70000 length reads |
| Full tool schema | 20000 existing objects, 10000 JSON serializations, 3460000 serialized characters |
| Newly added schema | 30000 existing objects, 10000 JSON serializations, 3440000 serialized characters |
| Tool arguments | 20000 existing objects, 10000 JSON serializations, 210000 serialized characters |
| Image context | 20000 existing objects, 20000 length reads; image data never accessed |

Counts cover actual estimator functions, not SDK/V8 internal allocation. Identical counters do not mean the complete request chain is allocation-free.

The existing `tool-result-contextual-budget` benchmark also runs on baseline and candidate, with 1 × 10 MiB and 2/4/8 × 256 KiB results. Both perform 25/50/100/200 projection passes, return to zero active coordinators and keep a coordinator high-water mark of one. Full-result copies/serializations remain zero. Clear/dispose leave zero projection entries, zero retained code units and zero retained WeakRefs. Allocation samples and sub-millisecond timings are retained as observations, not a speedup claim.

The first sample had a 0.1384 → 0.2798 ms p95 outlier for one result. Three subsequent sequential baseline/candidate pairs, after the full suite finished, gave the following medians of per-run values. The structural counts stayed identical throughout.

| Results | Median p95 ms, old → new | Median sampled bytes, old → new |
| --- | ---: | ---: |
| 1 × 10 MiB | 0.1266 → 0.1238 | 114592 → 102176 |
| 2 × 256 KiB | 0.1801 → 0.1736 | 255376 → 249072 |
| 4 × 256 KiB | 0.2534 → 0.2645 | 648376 → 658120 |
| 8 × 256 KiB | 0.3425 → 0.3421 | 1354792 → 1362920 |

The largest paired-median p95 increase is 4.4%; sampled differences include existing projection/helper allocation and profiler noise. None is treated as a new runtime allocation mechanism or as proof of improved throughput.

The built `dist` adapter is separately exercised for fresh and usage-anchored requests across success, payload-hook failure, fetch failure, abort and pre-dispatch budget rejection. All 80 tracked references release under controlled GC while the model and ten caller controllers remain reachable. Successful requests build/send once; hook failure sends zero; budget rejection reaches neither hook nor fetch.

## Verification and limits

Type checking, offline build and 109 targeted checks (108 passed, one skipped) pass, including source invariants and stream hot paths. `npm test` passes all 249 execution units: 4035 tests, 3943 passed, 92 skipped, zero failures/cancellations. Local reproducible baseline loader, exact allocation/GC probe, calibration JSON, contextual benchmark reports and logs are retained in `.git/t04-6-request-input-estimate-20261010/`.

This remains a provider-neutral heuristic. The 4096 reserve cannot cover arbitrarily large estimation errors. Provider framing, tokenizer differences, image size/detail, edited prefixes behind a usage anchor and real service acceptance are not established by this calibration. No paid requests or provider credentials were used; no tool effects, canonical tool results or subagent budgets were changed.
