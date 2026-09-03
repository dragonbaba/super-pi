# Phase 5B-A tool-result presentation core

## Scope

Phase 5B-A establishes a versioned final-tool-result presentation and its runtime ownership boundary. It is disabled by default and does not truncate, summarize, window, rewrite, artifact, persist a continuation, or enforce a token budget. It does not modify TUI rendering or provider request assembly.

## Audited production chain

The production path is:

```text
tool implementation / extension / MCP
  -> AgentToolResult
  -> AgentSession afterToolCall
       -> tool_result extension
       -> image normalization
  -> tool_execution_end (final live UI result)
  -> ToolResultMessage
  -> message_start
  -> message_end extension replacement
  -> optional ToolResultPresentationV1 creation
  -> Phase 5A shadow observation
  -> AgentSession listeners
  -> SessionManager persistence
  -> agent state / next provider request
```

Tool progress ends at `tool_execution_update` and never enters the presentation factory. Presentation creation occurs only for final `message_end` events whose message role is `toolResult`.

## Ownership contract

`ToolResultPresentationV1` is an AgentSession event sidecar, not a field written into `ToolResultMessage` or an extension event. The feature is created only when `toolResultPresentation.enabled === true`.

The final post-`message_end`-extension `ToolResultMessage.content` array is `modelContent`. Agent state, session persistence, compaction inputs, and provider serializers continue to consume that exact array through the existing `message.content` field. Provider assembly therefore cannot accidentally consume `uiContent`.

`uiContent` owns a distinct outer array. Its entries reuse the finalized content-block objects; text strings and image-data strings are not copied. Content blocks are immutable by contract after the final-result boundary. A consumer may mutate either outer array without changing the other array's membership, but it must not mutate shared block objects.

The extension contract is deliberately one-way:

1. `message_end` extensions see the legacy message with no presentation field.
2. The final extension replacement becomes the source for both views.
3. AgentSession constructs one fixed-field session event that shares the final message reference but is distinct from both the original Agent event and the extension event.
4. All AgentSession listeners in that dispatch receive the same session event and presentation sidecar.
5. AgentSession stores neither the session event nor the sidecar after the dispatch method returns. A listener that keeps the sidecar becomes its owner.

The owner is captured in a stable local before presentation creation. A listener may synchronously dispose the session; the dispatch `finally` still pairs exactly one release against that local owner, while persistence runs once afterward. The dispatch-scope counters do not claim that listener-retained objects are unreachable.

Session persistence remains in the existing schema and stores only `message.content`, which is the complete model view in 5B-A. This avoids serializing a duplicate large result. Existing sessions therefore require no migration. A missing, malformed, or unknown presentation version conservatively falls back to legacy `message.content`. Because 5B-A performs no truncation, a restored session still has the complete result available to both existing UI and provider consumers.

`continuation`, `artifact`, and `truncation` are reserved unavailable fields in V1. No code in this phase creates any of them.

## Allocation contract and instrumentation

Enabled creation allocates exactly one required presentation object and one new UI outer array. The existing model outer array is reused, so the presentation owns two independent outer arrays while creating only one. It performs one linear block-reference copy and reads string lengths without materializing, encoding, hashing, splitting, or serializing content.

Dynamic counters record:

- presentation objects created;
- UI outer arrays created, reused model outer arrays, and presentation-held outer-array references;
- reused model arrays, content blocks, text strings, and image-data strings;
- maximum content blocks, text code units, and image-data code units as separate metrics;
- active dispatch presentation scopes and their high-water mark;
- completed dispatch scopes, unmatched scope releases, and owner disposal.

`activeDispatchPresentationScopes` measures in-flight AgentSession dispatch scopes, not GC reachability or references retained by third-party listeners. Release occurs in `finally` after listener notification; disposal never assigns a synthetic zero. WeakRef benchmark gates separately prove release of the presentation and both outer arrays. Disabled and absent production paths do not construct an owner and perform zero presentation, array, or content-reference work.

Source invariants independently prohibit production arrow/function-expression closures, Promise or AbortController construction, Map/Set/WeakMap/WeakSet, object spreads, `split`, array transforms, full-size `slice`, `Buffer.from`, `JSON.stringify`, string coercion, Promise arrays, and object pools. Full-string copies, full-result serializations, and line arrays are source invariants rather than pseudo-runtime counters.

## Correctness evidence

The fixed tests cover:

- feature absent, disabled, and enabled production paths;
- post-extension ordering and extension invisibility;
- unchanged small-result content, errors, session persistence, and model identity;
- independent outer-array membership with shared block/string references;
- a 10 MiB single text block without string copying;
- progress events creating no presentation work;
- legacy session fallback and unknown-version rejection;
- multiple owners and parallel active-presentation HWM;
- release and disposal without fabricated reference clearing, with separate weak-reference gates for the presentation and both outer arrays;
- source allocation invariants.

## Closeout benchmark method

The branch merged `main@fc8145843435a3bacbc130ffa26670a3ed1822e7`, the PR #12 merge commit. PR #12 exact head `00e7510877b9fe413ab114bc43782710d6fb7928` is an ancestor of the candidate branch. Formal results are stamped with the final candidate commit and an empty `git status --short`.

The direct benchmark uses 5 warmups, 20 measurements, controlled GC, and HeapProfiler sampling at 1,024 bytes. It separately measures tiny text, 1 MiB text, 10 MiB text, and fixed text-plus-image content. The production benchmark exercises actual AgentSession final `message_end` delivery in absent, disabled, and enabled modes with a 10 MiB text result.

The default-off A/B uses an unmodified detached worktree at the merged main commit. Five child-process rounds interleave baseline, candidate absent, and candidate disabled order. Each process uses the same Node runtime, fixture, 5 warmup batches, 20 measured batches, 100 results per batch, and 1,024-byte HeapProfiler interval. This produces stable per-result medians instead of treating one sub-millisecond run as a regression signal.

The lifecycle section clears session history, starts a new session, disposes the AgentSession, yields an event-loop turn, and records eight controlled-GC samples. Separate WeakRefs cover the presentation, model outer array, and UI outer array. Structural 2/4/8 scope fixtures retain every presentation across owner disposal, then prove exact scope release and bounded high-water marks.

## Closeout gates

- candidate absent and disabled have no stable p50 or p95 regression above 5% against clean merged main;
- absent and disabled create zero presentation objects, UI arrays, model-array reuse work, and content-reference work;
- enabled creates exactly one presentation object and one UI array per result and reuses exactly one model array;
- direct 1 MiB and 10 MiB sampled allocation remain in the same bounded range rather than scaling with string size;
- text-plus-image reuses both block references, the text string, and image-data string while reporting separate code-unit maxima;
- 2/4/8 dispatch scopes produce HWM 2/4/8, retain listener-visible presentations, and return active scope count to zero without unmatched releases;
- presentation, model-array, and UI-array WeakRefs all clear after lifecycle cleanup;
- controlled GC has no sustained positive run;
- listener and persistence delivery remain exactly one per production result.

Full-string copies, full-result serialization, temporary line arrays, per-result Map/Set, per-result closures, and object pools remain source-invariant zero. HeapProfiler sampling is statistical and includes inspector/runtime allocation sites; exact machine-local timing and allocation values belong in the Draft PR closeout body rather than committed raw JSON.

## Known limitations

Phase 5B-A still performs no truncation, summary, continuation, artifact creation, token-budget enforcement, TUI view selection, or provider assembly change. Dispatch-scope counters do not establish GC reachability; only the lifecycle WeakRef evidence does. The fixed image payload is deliberately small and base64-like because the ownership proof concerns identity, not image decoding or token cost.

## G2C post-merge corrective evidence

The post-merge corrective benchmark extends the existing UI allocation probe without changing the provider projection benchmark. Its enabled sampling window now executes the production event order `tool_execution_end -> pending registration -> post-extension message_end -> attach -> clear`; discovery is not injected before sampling. Runtime counters report registration objects created, attached, retained high-water mark, eviction, teardown release, and current pending/attached entries. Absent and explicitly disabled fixtures execute the same event driver and must report zero registration and discovery work.

The same benchmark separately profiles expanded grouped reads, runs wholesale teardown over 128 bounded results, and scans a 50,000-message mixed V1/V2 history. Teardown instruments the discarded components and requires zero `updateDisplay`, full-result text scan, and image-conversion calls during both transcript/session rebuild and stop. Rebuild metadata and the attached registry remain hard-capped at 128; V1 results do not consume discovery capacity, and history/source probe counts remain linear.

Controlled-GC evidence now covers production-owned component, discovery, registration, canonical source, and projection-validation records. Owner disposal must finish with projection record entries and retained projection code units at `0/0`, every corresponding WeakRef must clear, and the stabilized heap tail must have no sustained positive slope. The source audit distinguishes registration object literals, all ownership object literals, arrays, Map/Set construction, Promise/AbortController construction, closures, serialization, and full-result copies.

Timing samples report p50, p95, p99, coefficient of variation, and absolute deltas. Grouped expansion and other millisecond-scale tails are treated as inconclusive when their process-level variation is high; deterministic work counts, allocation sites, and reference release remain the primary gates. Exact numeric results and the measured commit/worktree stamps belong in the Draft PR review packet so stale measurements cannot be mistaken for candidate evidence.

The final corrective closeout also locks live canonical validation to a session-owned active-branch identity index. Resume initializes the index once, ordinary appended messages require one incremental probe each, and each live ToolResult requires one exact lookup instead of rescanning the full transcript. Compaction and tree navigation rebuild the index at their existing state-replacement boundaries. The index stores only ToolResult ids and canonical message references (never result text copies), is released on session disposal, and has a hard 65,536-entry cap; overflow fails discovery closed until a later branch rebuild fits within the cap. The 50,000-message live profiler must therefore report one 50,000-probe build, one append plus one lookup per measured result, and no overflow.

Rebuild selection keeps only a bounded 128-element array after the existing 256-candidate classification. Before final admission it clears stale projection records, then re-admits selected discoveries oldest-to-newest so the presentation owner's eviction order matches the chronological UI registry. The deterministic eviction probe adds one live result to a full 128-entry rebuild and requires the newest still-advertised discovery to remain a resident hit with zero additional full-source scan.
