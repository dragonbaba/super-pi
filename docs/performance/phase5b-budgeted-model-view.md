# Phase 5B-B budgeted tool-result model view

Phase 5B-B adds an opt-in `ToolResultPresentationV2` at the final, post-extension tool-result boundary. It requires both `enabled: true` and an explicit positive `budgetTokens`. The default, absent, disabled, and enabled-without-budget paths retain Phase 5B-A/V1 behavior: the provider receives the legacy content unchanged and no continuation is created. This phase does not select a production default budget.

## Ownership and production chain

The persisted `ToolResultMessage.content` remains the complete post-extension result and is the UI source of truth. A V2 presentation owns an independent UI outer array whose text/image blocks and underlying strings are immutable references to that complete result. Truncation never writes into the legacy message or an extension-visible event.

The coding-agent SDK applies the provider-neutral projection after the existing image-input policy and before provider dispatch. Only the bounded `modelContent` is placed in the provider message wrapper; `uiContent`, presentation metadata, and continuation state do not enter the provider wire. Provider adapters are unchanged.

The projection is reproducible from the persisted full message, session identity, tool-call identity, explicit budget, fixed algorithm version, and estimator metadata. It is not stored only in a process-local `WeakMap`. A resumed session recreates the same cursor and model view. Continuation lookup searches only the current active session branch and validates the cursor's bounded identity and source metrics. A missing, switched, forked, or changed source fails explicitly as stale rather than returning another result.

## Projection algorithm

Oversized text is represented by deterministic bounded head and tail slices separated by a fixed truncation notice containing the continuation cursor. Projection performs one full estimator scan and at most four bounded re-estimation/shrink passes. It does not split into lines, serialize the complete result, copy image data, or create another full-size string. Multiple text blocks preserve source order; image blocks remain represented structurally without charging image-token cost to the text estimator.

Every truncated result has a resumable continuation descriptor. Continuation reads return bounded text chunks in source order, use the same token estimator, and report whether more content remains. Budgets too small to hold the fixed notice fail explicitly. V1 remains unchanged and unknown/malformed presentation versions conservatively fall back to the legacy message.

## Correctness coverage

Tests cover absent/disabled/invalid budgets, small V1 results, English, CJK, JSON, source code, ANSI, emoji and family emoji, combining marks, malformed surrogate boundaries, a 10 MiB single line, multiple blocks, and text plus image. They also cover exact continuation reconstruction, resumed-session projection identity, stale cursors across sessions and active branches, provider-wire isolation, extension/session-event isolation, full legacy persistence, and malformed-version fallback.

The ownership fixtures prove that model/UI outer arrays are distinct, complete UI block references are reused, text and image-data string identities are reused, and provider projection does not mutate the legacy message. Parallel direct-owner fixtures exercise 2, 4, and 8 active dispatch scopes; high-water marks are exactly 2, 4, and 8, all active scopes return to zero after matching release, disposal does not synthesize releases, and listener-retained presentations remain readable.

## Performance method

`npm run bench:tool-result-budgeted-model-view` uses Node 26.4.0 on Windows x64, five warmups, twenty measured operations, a 1,024-byte HeapProfiler sampling interval, controlled GC, and top-20 sampled allocation sites. Direct fixtures are tiny, 64 KiB, 1 MiB, 10 MiB, multi-block, and text plus image. Production fixtures use the actual AgentSession final-result chain in absent, disabled, and enabled modes. Separate fixtures measure provider projection, current/resumed projection, continuation, 2/4/8 scope lifecycles, and WeakRefs for the presentation and both outer arrays.

The clean runtime implementation revision `e8637d4b19755abc9e367542f2142e78976fc201` measured the following representative results before documentation-only closeout. The Draft PR body records the final exact-head rerun.

| Fixture | CPU p50 / p95 (ms) | Sampled B/result | Estimated token reduction |
| --- | ---: | ---: | ---: |
| tiny direct | 0.0050 / 0.0306 | 2,265.6 | unchanged V1 |
| 64 KiB direct | 0.9969 / 1.1284 | 5,578.8 | 96.88% |
| 1 MiB direct | 13.9273 / 14.2101 | 5,712.8 | 99.81% |
| 10 MiB direct | 137.4289 / 141.0886 | 6,148.4 | 99.98% |
| AgentSession absent | 0.0106 / 0.0300 | 4,386.8 | not applicable |
| AgentSession disabled | 0.0079 / 0.0119 | 2,965.2 | not applicable |
| AgentSession enabled, 10 MiB | 137.8102 / 140.8278 | 8,941.6 | 99.98% |

The sampled allocation result remains roughly 5.6–6.2 KiB per truncated direct result from 64 KiB through 10 MiB, so allocation follows the bounded model view rather than input size. Each enabled oversized result creates one presentation, one UI outer array, one provider/model wrapper when projected, and two bounded model arrays in the measured initial-plus-shrink path. The source model array is reused for small V1 results. No sampled allocation site showed per-character objects.

The default-off A/B used an unmodified detached worktree at merged main `e0bfc54df3ca7cdd4be1abdb7938c3c08e3e7904` and the same Node runtime, fixture, five warmup batches, twenty measured batches, 100 results per batch, and HeapProfiler interval. Five child-process rounds interleaved baseline, candidate absent, and candidate disabled. A first run put disabled at +5.28% p50/+7.50% p95 while absent remained below 1%; this was not treated as passing evidence. An unchanged repeat measured baseline 0.004167/0.006102 ms, absent 0.004174/0.005985 ms (+0.17%/-1.92%), and disabled 0.004217/0.005801 ms (+1.20%/-4.93%). All absent/disabled presentation, projection, UI-array, and sink-owner counters were zero; listener and persistence counts remained one per result. The combined runs do not show a stable regression above 5%.

Controlled-GC samples stabilized with a 7.3-byte-per-cycle fitted slope, one positive delta, and no consecutive growth. Presentation, model-array, and UI-array WeakRefs all cleared. Active dispatch scopes ended at zero. HeapProfiler sites and dynamic counters provide measured allocation evidence; full-result copies, complete serialization, temporary line arrays, per-result Map/Set, per-result closures, and object pools are separately enforced source invariants and are not represented as fabricated runtime counters.

## Limits retained for later phases

This phase does not choose a default budget, summarize output, create artifacts, add a continuation UI, alter TUI rendering, or enforce remaining-context policy. Text estimation excludes image billing/tokens. Continuation identity deliberately avoids hashing or retaining the complete output; it combines stable session/tool identity with structural and estimator metrics, so a pathologically different result with identical metrics is outside this phase's stale-detection guarantee. Provider-specific exact estimators and budget safety factors remain Phase 5A extension points rather than provider-adapter truncation logic.
