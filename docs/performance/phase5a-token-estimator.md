# Phase 5A token-aware tool-output estimator and shadow mode

## Scope and outcome

Phase 5A adds a versioned, provider-neutral conservative estimator, an optional synchronous exact-provider boundary, metadata-only shadow observation, fixed budget simulations, a reference corpus, and an allocation benchmark.

It does not truncate, summarize, window, rewrite, artifact, continue, or otherwise change a tool result. Shadow mode is disabled unless `toolOutputShadow.enabled` is explicitly true. Enabling it does not replace content arrays, mutate tool-result objects, add extension-visible fields, change error flags, or alter usage/cost.

The measured implementation is commit `52f43afb633d2ff0943578a6798bff0b95ef3941` on branch `phase/5a-token-estimator-shadow`, in clean worktree `D:/RMProjects/Pi-phase5a-token-estimator`. Node was `v26.4.0` on Windows x64. Immediately before profiling, no other Node benchmark, HeapProfiler, controlled-GC soak, or Phase 4D-A1 benchmark process was running.

## Audited production result chain

The complete final-result path is:

```text
read/bash/powershell/search/mutation/custom/MCP ToolDefinition.execute
  -> AgentToolResult.content/details/usage
  -> agent-core finalizeExecutedToolCall
  -> AgentSession afterToolCall
       -> tool_result extension transforms
       -> normalizeToolResultImages
  -> tool_execution_end (live InteractiveMode result)
  -> ToolResultMessage (content array is referenced, not copied)
  -> message_start / message_end
  -> AgentSession message_end extension transforms
  -> Phase 5A shadow observe (read-only)
  -> AgentSession listeners and session persistence
  -> next agent context / provider serializer
  -> OpenAI, Anthropic, Google, Bedrock, or other model payload
```

The seven audit questions resolve as follows:

1. The model consumes the final `ToolResultMessage.content` after both `tool_result` and `message_end` extension transformations. OpenAI Chat, OpenAI Responses, and Google serializers join text blocks with `\n`; text-only Anthropic results do the same. Provider serializers sanitize unpaired surrogates. Image-bearing provider formats differ. The exact-estimator boundary receives a separate frozen view of immutable text references and bounded MIME metadata, never the live content objects or image data.
2. ANSI is not globally removed before the model. Agent `bash`/PowerShell output flows from process buffers through `OutputAccumulator` into text content, so escape sequences remain model-visible. Interactive rendering separately calls `getTextOutput()`, which strips ANSI for display. The separate user-bash execution lane also strips ANSI, but it is not an `AgentToolResult` lane. The fallback therefore counts ANSI when it is present in the final model content.
3. Existing ceilings are tool-local, before `AgentToolResult` finalization. `read`, `find`, `grep`, and `ls` use head truncation; `bash` and PowerShell use bounded tail accumulation. Defaults are 50 KiB or 2,000 logical lines. Custom/extension/MCP tools have no additional central ceiling unless their own implementation supplies one.
4. After the `tool_result` hook and image normalization, `tool_execution_end.result.content` and the newly created `ToolResultMessage.content` normally reference the same array. A later `message_end` extension may replace message content after the live UI has consumed `tool_execution_end`, so UI and model are not unconditionally the same view today. Session rebuild uses the persisted final `ToolResultMessage`. Phase 5A preserves this behavior exactly.
5. Tool progress ends at `ToolProgressDelivery.flush()`. Partial `tool_execution_update` values are UI/observer events and do not enter session history or model context. Only the final result proceeds through `afterToolCall`, `tool_execution_end`, and `ToolResultMessage` creation.
6. Built-in read, shell, search, and mutation tools are wrapped as `AgentTool`s. Extension and MCP bridges also return `AgentToolResult`. After execution they share the same finalization and message chain; only their tool-local preprocessing and ceilings differ.
7. The safe shadow point is in `AgentSession._handleAgentEvent`, after the final `message_end` extension transform and before listener delivery and session persistence. It observes the actual final message content without touching agent-core, InteractiveMode/TUI, provider assembly, or tool implementations.

## Estimator and shadow contracts

`super-pi.conservative-v1` performs one bounded scan over each final text block and accounts for the virtual newline separators used by dominant provider serializers without joining blocks. It omits unpaired surrogates from the model-visible count while retaining their raw UTF-8 byte count for diagnostics. Image/base64 bodies are not scanned, copied, serialized, hashed, or emitted to telemetry. An image-only result uses a fixed provider placeholder for conservative text estimation.

The fallback creates one fixed-shape scan-state object and one required estimate result per call. Enabled shadow observation adds one metadata payload. There are no per-character or per-chunk objects, line arrays, internally-created promises, promise tails, abort controllers, inline rejection closures, maps, sets, dynamic regular expressions, full-result buffers, full-result serialization, or object pools. A stable module-level rejection observer is bound once per enabled observer and attached only when an external sink returns a thenable.

The optional `ToolOutputExactTokenEstimator` is resolved for every result from `{ api, provider, model }`; resolver results are not cached across model changes. It is called after the metadata scan with frozen arrays of immutable text string references, text/image counts, and at most 64-byte validated MIME strings. It never receives `ToolResultMessage.content` or `image.data`, and its result is defined as text-only. A throw, invalid number, rejected thenable, resolver failure, or unsupported model falls back to `super-pi.conservative-v1`. Exact telemetry uses the fixed low-cardinality id `super-pi.exact-v1`, so resolver-provided secrets or paths cannot become estimator ids.

Shadow telemetry has only fixed low-cardinality metadata:

- raw UTF-8 bytes and lines, using existing truncation metadata when present;
- estimated model-visible text bytes and tokens, explicitly excluding image-token billing;
- proposed model-view tokens and would-truncate decisions at 1k, 2k, 4k, 8k, and 16k;
- a fixed proposed reason, fixed tool category, estimator id/version, and exact/fallback confidence.

It contains no output text or snippet, prompt, args, path, cwd, headers, keys, session content, hash, secret, or image/base64 body. The generic `wouldTruncate` value is nullable unless an explicit `candidateBudgetTokens` is supplied; there is no implicit 1k candidate. Synchronous sink throws and asynchronous sink rejections are isolated without awaiting the sink. `telemetrySinkDrops` counts absent, thrown, rejected, or observation-failed records; `telemetrySinkRejections` counts both synchronous throws and asynchronous rejections. `dispose()` decrements each actively tracked resolver/sink reference as it is cleared; it does not assign a synthetic zero. Shared counter sets retain a monotonic reference high-water mark across sequential and concurrent observer lifecycles.

## Merge Gate closeout

The Merge Gate closeout adds fixed-seed adversarial fixtures for random lower/upper/mixed case, camelCase, alphabetic API-key-like strings, punctuation, rare Han, CJK extension characters, kana, Hangul, and mixed CJK/ASCII identifiers. The pre-fix baseline had 71.43% maximum/p99 underestimation, including 71.43% for the 12-character lowercase fixture and 66.67% for the CJK-extension fixture.

The fixed `phase5a-v2` corpus has 42 `cl100k_base` fixtures. A second independent reference run uses `o200k_base` for all 40 non-large fixtures. Both enforce every-fixture underestimation at most 10%, p99 at most 10%, and average overestimation at most 35%.

| Reference | Fixtures | p99/max under | Average over |
| --- | ---: | ---: | ---: |
| `cl100k_base` | 42 | 4.76% | 27.40% |
| `o200k_base` | 40 | 3.70% | 34.21% |

The fallback therefore remains `conservative-fallback`; Phase 5B enforcement is still outside this change. The scanner correction retains the original one-pass `ScanState` structure and adds only primitive letter/symbol masks, transition/unique counters, CJK subtype counters, and a malformed-surrogate join counter.

Async rejection tests cover both the telemetry sink and a JavaScript/`any` exact-estimator thenable. After a microtask turn they observe zero `unhandledRejection` events. The real AgentSession test proves extension replacement occurs before shadow, listeners and persistence still receive the replacement, and absent/disabled/enabled production results are structurally equal.

### Entropy-threshold closeout

The fixed `phase5a-v3` corpus retains all 42 `phase5a-v2` fixtures and appends 88 deterministic threshold fixtures. Four independent seeds cover lowercase lengths/cardinalities 12/(8,10,12), 16/(12,14,16), 64/(16,19,20,26), and 256/(16,19,20,26); uppercase and normalized mixed-case cardinalities 16/19/20; and 64/256-character printable-symbol alphabets whose characters collide under the former `code & 31` mask.

Before the formula change, both tokenizers failed 61 fixtures. `cl100k_base` maximum/p99 underestimation was 71.43%, including 2 estimated tokens for 7 actual tokens at lowercase 12/10; `o200k_base` maximum/p99 was 66.67%. The former symbol mask represented only 6 of the 16 collision-alphabet characters. Direct state tests also proved the first character was omitted from the letter and symbol masks.

The corrected classifier maps all 32 printable ASCII symbols collision-free into one 32-bit primitive mask and uses a continuous distinct-character contribution instead of the 16/20-letter cliffs. It retains one pass, one fixed `ScanState`, and no maps, sets, per-character objects, lookup tables, second scan, or per-result closures.

| Reference | Fixtures | p99 under | Max under | Average over |
| --- | ---: | ---: | ---: | ---: |
| `cl100k_base` | 130 | 8.57% | 8.57% | 24.66% |
| `o200k_base` | 128 | 5.88% | 8.51% | 28.20% |

Every fixture remains at or below 10% underestimation and both overall average-overestimation gates remain below 35%.

The initial correctness implementation showed a stable performance regression, so a primitive-only fast path now initializes a new ASCII run directly and advances identical characters by length only. Formal clean-worktree results at production commit `24ca90ed078dce4539e9ddfc71e9a3ca1bc5c33a`, compared with the frozen `c68543a` baseline, were:

| Fixture | Closeout p50/p95 | Baseline p50/p95 | Change p50/p95 |
| --- | ---: | ---: | ---: |
| 64 KiB English | 0.8837/0.9093 ms | 0.8906/0.9023 ms | -0.78%/+0.78% |
| 1 MiB logs | 14.5583/16.1513 ms | 14.8522/15.3896 ms | -1.98%/+4.95% |
| 10 MiB single-line | 60.6701/62.2925 ms | 101.0506/104.0889 ms | -39.96%/-40.16% |

Aggregate throughput was 141.04 MiB/s, compared with the frozen 94.11 MiB/s baseline. HeapProfiler sampled 206,072 bytes, with no per-character allocation site. Dynamic counters remained exactly one scan-state and one estimate object per call; controlled-GC slope remained 27.2 bytes/cycle. Full copies, serializations, line arrays, and object pools remained source-invariant zero.

The corresponding production shadow benchmark measured observer enabled at 0.8486/0.9806 ms p50/p95 and real AgentSession absent/disabled/enabled at 0.0222/0.0475, 0.0169/0.0345, and 0.8723/0.9311 ms. Disabled mode recorded zero estimator, scan-state, estimate, payload, and sink work. Clear/dispose reduced heap by 86,456 bytes, left zero active retained references, and produced a 25.6-byte/cycle controlled-GC slope.

## Initial Candidate Gate corpus (historical, superseded by phase5a-v2)

The fixed `phase5a-v1` corpus has 29 fixtures, including English prose/logs, Chinese, mixed text, JSON/minified JSON, TypeScript/JavaScript, Python, shell output, stack traces, repeated errors, ANSI, emoji/family emoji, combining marks, URLs, UUID/hash text, base64-like text, long unbroken words, 1 MiB output, 10 MiB single-line output, empty/tiny text, and malformed surrogate boundaries.

Reference counts use declared dev-only `js-tiktoken@1.0.21` with `cl100k_base`. The 1 MiB and 10 MiB counts are fixed reproducible reference counts so routine tests do not tokenize those giant strings. No tokenizer is added to production dependencies and no network or API key is used.

Overall results:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Underestimation p50 | 0.00% | — |
| Underestimation p95 | 4.55% | — |
| Underestimation p99 | 4.76% | <= 10% |
| Underestimation max | 4.76% | <= 10% |
| Overestimation p50 | 15.00% | — |
| Overestimation p95 | 45.00% | — |
| Average overestimation | 19.05% | <= 35% |

Per-category distribution:

| Category | Fixtures | Actual | Estimated | Avg under | Avg over |
| --- | ---: | ---: | ---: | ---: | ---: |
| empty/tiny | 2 | 1 | 1 | 0.00% | 0.00% |
| English prose | 2 | 180 | 260 | 0.00% | 42.50% |
| English logs | 1 | 248 | 280 | 0.00% | 12.90% |
| Chinese | 1 | 280 | 332 | 0.00% | 18.57% |
| mixed Chinese/English | 1 | 160 | 176 | 0.00% | 10.00% |
| JSON | 1 | 344 | 400 | 0.00% | 16.28% |
| minified JSON | 1 | 208 | 288 | 0.00% | 38.46% |
| TypeScript/JavaScript | 2 | 432 | 544 | 0.00% | 26.76% |
| Python | 1 | 248 | 288 | 0.00% | 16.13% |
| shell output | 1 | 216 | 208 | 3.70% | 0.00% |
| stack traces | 1 | 368 | 464 | 0.00% | 26.09% |
| repeated errors | 1 | 176 | 240 | 0.00% | 36.36% |
| ANSI logs | 1 | 240 | 240 | 0.00% | 0.00% |
| emoji | 1 | 184 | 208 | 0.00% | 13.04% |
| family emoji | 1 | 336 | 368 | 0.00% | 9.52% |
| combining marks | 1 | 252 | 240 | 4.76% | 0.00% |
| URLs | 1 | 168 | 240 | 0.00% | 42.86% |
| UUID/hash | 1 | 320 | 368 | 0.00% | 15.00% |
| base64-like | 1 | 720 | 896 | 0.00% | 24.44% |
| long unbroken word | 2 | 3,456 | 3,456 | 2.27% | 10.00% |
| malformed Unicode | 3 | 4 | 5 | 0.00% | 33.33% |
| 1 MiB output | 1 | 353,327 | 403,297 | 0.00% | 14.14% |
| 10 MiB single line | 1 | 1,310,720 | 1,310,720 | 0.00% | 0.00% |

No category averages more than 10% underestimation. Full fixture-level output is reproducible with `npm run test:tool-token-estimator-accuracy`.

## Budget simulation

The simulation applies candidate token buckets only to the corpus's content after today's 50 KiB/2,000-line tail ceiling. It does not implement truncation or choose a Phase 5B default.

| Candidate | Would truncate | Ratio | Proposed token reduction |
| --- | ---: | ---: | ---: |
| 1k | 3/42 | 7.14% | 65.39% |
| 2k | 3/42 | 7.14% | 57.57% |
| 4k | 2/42 | 4.76% | 45.51% |
| 8k | 1/42 | 2.38% | 29.21% |
| 16k | 1/42 | 2.38% | 8.35% |

The simulated current model-visible total is 39,270 estimated tokens. Tool-category distribution is: extension 29 fixtures/34,766 tokens, shell 5/1,480, MCP 5/2,192, and read 3/832. In this deliberately small corpus, today's byte/line ceiling and a 4k token ceiling each identify two fixtures, with zero decision mismatches. This is measurement evidence only and is not sufficient to select the 5B production default.

## Allocation and CPU benchmark

The benchmark uses 5 warmups and 20 measured runs per fixture, controlled GC, and V8 HeapProfiler sampling. It covers tiny, 64 KiB, 1 MiB, 10 MiB single-line, English, Chinese, JSON, code, ANSI, emoji, and repeated errors.

| Fixture | CPU p50 | CPU p95 | Throughput |
| --- | ---: | ---: | ---: |
| tiny | 0.0019 ms | 0.0106 ms | timing-floor only |
| 64 KiB English | 0.8686 ms | 0.9036 ms | 71.05 MiB/s |
| 1 MiB logs | 15.0677 ms | 15.5067 ms | 66.03 MiB/s |
| 10 MiB single line | 107.4957 ms | 110.0189 ms | 92.92 MiB/s |
| English | 0.9383 ms | 0.9627 ms | 66.18 MiB/s |
| Chinese | 0.1034 ms | 0.1225 ms | 588.14 MiB/s |
| JSON | 0.8916 ms | 0.9223 ms | 69.83 MiB/s |
| code | 0.9320 ms | 1.0096 ms | 66.26 MiB/s |
| ANSI | 0.9064 ms | 0.9635 ms | 68.15 MiB/s |
| emoji | 0.1788 ms | 0.1832 ms | 349.66 MiB/s |
| repeated errors | 0.9641 ms | 0.9983 ms | 64.54 MiB/s |

Aggregate throughput was 89.43 MiB/s over 230.00 MiB of measured input. HeapProfiler sampled 207,160 bytes, 941.64 sampled bytes/input, or 900.69 sampled bytes/MiB. The leading production sites were `createScanState` (62,424 sampled bytes) and the required estimate result in `estimateToolOutputTokens` (17,184 sampled bytes). The remaining leading sites were benchmark timing/sorting and inspector internals.

Dynamic counters across 330 warmup/measured/lifecycle calls were:

```text
estimatorCalls=330
exactEstimatorCalls=0
fallbackEstimatorCalls=330
charactersScanned=359487450
utf8BytesObserved=361760070
lineBreaksObserved=634680
scanStateObjectsCreated=330
estimateObjectsCreated=330
exactInputObjectsCreated=0
telemetryPayloadsCreated=0
telemetrySinkCalls=0
telemetrySinkDrops=0
telemetrySinkRejections=0
telemetryRejectionObserversAttached=0
maximumInputCharacters=10485760
activeObservations=0
```

The two dynamically wired object counters are exactly one fixed-shape scan state and one returned estimate per call. The estimator benchmark does not enable telemetry, so it creates no shadow payloads. Full-string copies/serializations, temporary line arrays, Promise construction, and closure usage are source invariants and are deliberately not represented as runtime counters. Disabled behavior is measured through the real AgentSession production path in the closeout benchmark, not through optional chaining on an undefined local.

Controlled-GC heap was 20,958,160 bytes before measurement and 21,049,552 bytes after profiling/final GC, a 91,392-byte process delta that includes inspector/runtime state. Five post-measurement controlled-GC lifecycle samples plateaued at 21,050,072, 21,050,256, 21,050,224, 21,050,224, and 21,050,224 bytes, with a 27.2-byte/cycle fitted slope. The observer retains no output references after each synchronous call, and disposal clears estimator and telemetry references. No object pool is used; sampled allocations do not justify one and result/payload objects cross public observation boundaries.

### Enabled shadow production benchmark

`npm run bench:tool-output-shadow` measures three separate paths with 5 warmups and 20 measured results: direct observer with a stable no-op sink; actual AgentSession `message_end -> extension replacement -> shadow -> listener -> persistence`; and actual absent/disabled AgentSession controls. A pre-commit smoke run on Windows x64 produced:

| Path | CPU p50 | CPU p95 | Sampled B/result |
| --- | ---: | ---: | ---: |
| observer enabled | 1.0123 ms | 1.1543 ms | 2,872.0 |
| AgentSession absent | 0.0245 ms | 0.1351 ms | 10,226.0 |
| AgentSession disabled | 0.0169 ms | 0.0534 ms | 7,922.0 |
| AgentSession enabled | 1.0260 ms | 1.0764 ms | 8,643.2 |

Every enabled measured result dynamically recorded one scan state, one estimate result, one telemetry payload, and one sink call. It recorded zero exact calls, sink drops/rejections, rejection-observer attachments, or shadow observation errors. Absent and disabled production controls recorded zero estimator/payload/sink work while still delivering one listener event and one persisted message per result. After session-history clear and disposal, active observed messages and tracked sink/resolver references were both zero; heap decreased by 87,200 bytes and the five-sample controlled-GC slope was 25.6 bytes/cycle. The benchmark reports full-copy, serialization, line-array, and object-pool conclusions only under `sourceInvariant*`, never as runtime counters.

## Static and behavioral gates

The AST gate separately proves zero production `ArrowFunction`, `FunctionExpression`, Promise construction, `AbortController`, dynamic `RegExp`, `split`, `map`, `filter`, `flatMap`, `join`, `Array.from`, `Buffer.from`, `JSON.stringify`, `String`, `new String`, and object-pool usage in the estimator module. These are source invariants, not runtime counters.

Behavioral tests cover empty/tiny text, English/CJK/JSON/code/ANSI/emoji, 10 MiB single-line input, malformed surrogates, exact success, exact throw/invalid/rejected-thenable fallback, model-aware exact resolution, immutable exact input ownership, metadata-only serialization, absent/throwing/rejecting telemetry, repeated and parallel results, multi-session counter isolation, dispose release, and insertion ordering. The byte-for-byte control test compares shadow off/on returned content, session history, extension hook input, real OpenAI Responses provider payload, UI result, error flag, usage, and cost. A second control executes the actual AgentSession `message_end` path for absent, disabled, and enabled modes.

The Merge Gate B0/B1 findings described above are closed. No TUI, InteractiveMode, `packages/agent`, provider request assembly, or Phase 5B/5C/6 production file was modified.
