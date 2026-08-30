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

1. The model consumes the final `ToolResultMessage.content` after both `tool_result` and `message_end` extension transformations. OpenAI Chat, OpenAI Responses, and Google serializers join text blocks with `\n`; text-only Anthropic results do the same. Provider serializers sanitize unpaired surrogates. Image-bearing provider formats differ, which is why the exact-estimator boundary receives the original content blocks.
2. ANSI is not globally removed before the model. Agent `bash`/PowerShell output flows from process buffers through `OutputAccumulator` into text content, so escape sequences remain model-visible. Interactive rendering separately calls `getTextOutput()`, which strips ANSI for display. The separate user-bash execution lane also strips ANSI, but it is not an `AgentToolResult` lane. The fallback therefore counts ANSI when it is present in the final model content.
3. Existing ceilings are tool-local, before `AgentToolResult` finalization. `read`, `find`, `grep`, and `ls` use head truncation; `bash` and PowerShell use bounded tail accumulation. Defaults are 50 KiB or 2,000 logical lines. Custom/extension/MCP tools have no additional central ceiling unless their own implementation supplies one.
4. After the `tool_result` hook and image normalization, `tool_execution_end.result.content` and the newly created `ToolResultMessage.content` normally reference the same array. A later `message_end` extension may replace message content after the live UI has consumed `tool_execution_end`, so UI and model are not unconditionally the same view today. Session rebuild uses the persisted final `ToolResultMessage`. Phase 5A preserves this behavior exactly.
5. Tool progress ends at `ToolProgressDelivery.flush()`. Partial `tool_execution_update` values are UI/observer events and do not enter session history or model context. Only the final result proceeds through `afterToolCall`, `tool_execution_end`, and `ToolResultMessage` creation.
6. Built-in read, shell, search, and mutation tools are wrapped as `AgentTool`s. Extension and MCP bridges also return `AgentToolResult`. After execution they share the same finalization and message chain; only their tool-local preprocessing and ceilings differ.
7. The safe shadow point is in `AgentSession._handleAgentEvent`, after the final `message_end` extension transform and before listener delivery and session persistence. It observes the actual final message content without touching agent-core, InteractiveMode/TUI, provider assembly, or tool implementations.

## Estimator and shadow contracts

`super-pi.conservative-v1` performs one bounded scan over each final text block and accounts for the virtual newline separators used by dominant provider serializers without joining blocks. It omits unpaired surrogates from the model-visible count while retaining their raw UTF-8 byte count for diagnostics. Image/base64 bodies are not scanned, copied, serialized, hashed, or emitted to telemetry. An image-only result uses a fixed provider placeholder for conservative text estimation.

The fallback creates one fixed-shape scan-state object and one required estimate result per call. Enabled shadow observation adds one metadata payload. There are no per-character or per-chunk objects, line arrays, promises, abort controllers, closures, maps, sets, dynamic regular expressions, full-result buffers, full-result serialization, or object pools.

The optional `ToolOutputExactTokenEstimator` is synchronous. It is called after the metadata scan, must not mutate or retain content, and must return a finite non-negative safe integer. A throw, invalid number, or unavailable exact estimator falls back to `super-pi.conservative-v1` without changing result delivery.

Shadow telemetry has only fixed low-cardinality metadata:

- raw UTF-8 bytes and lines, using existing truncation metadata when present;
- current model-visible text bytes and estimated tokens;
- proposed model-view tokens and would-truncate decisions at 1k, 2k, 4k, 8k, and 16k;
- a fixed proposed reason, fixed tool category, estimator id/version, and exact/fallback confidence.

It contains no output text or snippet, prompt, args, path, cwd, headers, keys, session content, hash, secret, or image/base64 body. Sink failures are caught. `dispose()` clears exact-estimator and sink references and disables subsequent observation.

## Corpus accuracy

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
| 1k | 3/29 | 10.34% | 72.20% |
| 2k | 3/29 | 10.34% | 63.56% |
| 4k | 2/29 | 6.90% | 50.25% |
| 8k | 1/29 | 3.45% | 32.25% |
| 16k | 1/29 | 3.45% | 9.22% |

The simulated current model-visible total is 35,564 estimated tokens. Tool-category distribution is: extension 16 fixtures/31,108 tokens, shell 5/1,432, MCP 5/2,192, and read 3/832. In this deliberately small corpus, today's byte/line ceiling and a 4k token ceiling each identify two fixtures, with zero decision mismatches. This is measurement evidence only and is not sufficient to select the 5B production default.

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
fullStringCopies=0
fullStringSerializations=0
temporaryLineArrays=0
promisesCreated=0
closuresCreated=0
wrapperObjectsCreated=660
telemetryPayloadsCreated=0
telemetryPayloadsDropped=0
maximumInputCharacters=10485760
finalRetainedReferences=0
```

The 660 wrappers are exactly two per call: one fixed-shape scan state and one returned estimate. The estimator benchmark does not enable telemetry, so it creates no shadow payloads. Enabled shadow creates one additional fixed metadata payload per final tool result. Disabled shadow ran one million optional observations in 0.8022 ms with `disabledShadowEstimatorCalls=0`; the observer is absent, so no content is scanned.

Controlled-GC heap was 20,958,160 bytes before measurement and 21,049,552 bytes after profiling/final GC, a 91,392-byte process delta that includes inspector/runtime state. Five post-measurement controlled-GC lifecycle samples plateaued at 21,050,072, 21,050,256, 21,050,224, 21,050,224, and 21,050,224 bytes, with a 27.2-byte/cycle fitted slope. The observer retains no output references after each synchronous call, and disposal clears estimator and telemetry references. No object pool is used; sampled allocations do not justify one and result/payload objects cross public observation boundaries.

## Static and behavioral gates

The AST gate separately proves zero production `ArrowFunction`, `FunctionExpression`, Promise construction, `AbortController`, dynamic `RegExp`, `split`, `map`, `filter`, `flatMap`, `join`, `Array.from`, `Buffer.from`, `JSON.stringify`, `String`, `new String`, and object-pool usage in the estimator module. These are source invariants, not runtime counters.

Behavioral tests cover empty/tiny text, English/CJK/JSON/code/ANSI/emoji, 10 MiB single-line input, malformed surrogates, exact success, exact throw/invalid fallback, metadata-only serialization, absent/throwing telemetry, repeated and parallel results, multi-session counter isolation, dispose release, and insertion ordering. The byte-for-byte control test compares shadow off/on returned content, session history, extension hook input, real OpenAI Responses provider payload, UI result, error flag, usage, and cost.

No B0 or B1 condition was encountered. No TUI, InteractiveMode, agent-core, provider request assembly, or Phase 5B/5C/6 production file was modified.
