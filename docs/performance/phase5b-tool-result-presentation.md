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
3. AgentSession listeners receive the presentation sidecar.
4. AgentSession itself retains no presentation or UI-array reference after synchronous listener delivery. A listener that keeps the sidecar becomes its owner.

Session persistence remains in the existing schema and stores only `message.content`, which is the complete model view in 5B-A. This avoids serializing a duplicate large result. Existing sessions therefore require no migration. A missing, malformed, or unknown presentation version conservatively falls back to legacy `message.content`. Because 5B-A performs no truncation, a restored session still has the complete result available to both existing UI and provider consumers.

`continuation`, `artifact`, and `truncation` are reserved unavailable fields in V1. No code in this phase creates any of them.

## Allocation contract and instrumentation

Enabled creation allocates exactly one required presentation object and one new UI outer array. The existing model outer array is reused, so the presentation owns two independent outer arrays while creating only one. It performs one linear block-reference copy and reads string lengths without materializing, encoding, hashing, splitting, or serializing content.

Dynamic counters record:

- presentation objects created;
- outer arrays created and owned;
- reused model arrays, content blocks, text strings, and image-data strings;
- maximum content blocks and input characters;
- active presentation handoffs and their high-water mark;
- explicit releases, unmatched releases, and owner disposal.

`activePresentations` measures in-flight AgentSession handoffs, not references retained by third-party listeners. Release occurs in `finally` after listener notification; disposal never assigns a synthetic zero. Disabled and absent production paths do not construct an owner and perform zero presentation, array, or content-reference work.

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

Formal HeapProfiler, controlled-GC, and 10 MiB allocation results are intentionally deferred until the concurrent Phase 4D-B1 formal benchmark has ended. After PR #12 merges, this branch must merge the resulting `origin/main` and rerun the complete validation and presentation benchmark before Candidate Gate delivery.
