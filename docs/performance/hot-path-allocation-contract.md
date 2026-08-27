# Hot-path allocation contract

This document is a version-controlled performance contract for Super Pi. It applies to Phase 4C and to every later change that touches a production hot path, including Phases 5, 6, 7, and 8. A review must cover the existing production call chain around a change, not only newly added lines.

## Hot-path scope

The following paths are hot by default:

- provider delta parsing and delivery;
- assistant `message_update` and streaming content updates;
- tool progress production and delivery;
- observer and agent-event delivery;
- `InteractiveMode` update handling;
- `requestRender()` and `scheduleRender()`;
- Main and Alt `doRender()`;
- viewport and layout composition;
- terminal-frame generation;
- `TerminalFrameQueue.submit()`, `start()`, `finish()`, and `flush()`;
- `ProcessTerminal.writeFrame()`;
- large tool-output token estimation, truncation, and continuation;
- high-frequency Evidence Ledger lookup.

When a change touches one of these paths, the review scope is the complete production call graph from the producer to its release boundary. Moving an allocation into an existing helper does not remove it from the audit.

## Required evidence

Every hot-path change must provide all three classes of evidence:

1. deterministic structural counters, such as queue depth, promises/update, copied lines, or string materializations;
2. an allocation profile or exact allocation counter;
3. lifecycle evidence showing controlled-GC behavior and release of retained references after flush, abort, clear, or disposal.

Source invariants and allocation benchmarks are regression gates. Timing alone is insufficient, and a single noisy heap sample is not a lifecycle conclusion.

## Closure contract

Normal high-frequency paths have these allocation limits:

- inline `ArrowFunction`: zero;
- inline `FunctionExpression`: zero;
- inline `then`/`catch`/`finally` callback: zero;
- inline `Promise` executor: zero;
- per-event `setTimeout`/`nextTick` callback: zero;
- `bind(this)` inside a loop: zero.

Stable callbacks must be module-level functions or instance fields created once for the owning lifecycle. A helper called by a hot method is part of the same audit.

Low-frequency closure exemptions are limited to startup, stop, fatal cleanup, suspend, mode switch, external-editor handoff, explicit user commands, and lifecycle deadlines. Tests must name exact exempt functions; a file-wide or class-wide exemption is not permitted. Code called once per frame, delta, or progress update is not lifecycle code merely because it participates in cleanup.

## Promise and AbortController contract

Normal frame, provider-delta, and tool-progress paths have:

- Promise allocations: zero;
- `AbortController` allocations: zero;
- signal/options wrapper allocations: zero;
- Promise tails: zero;
- Promise arrays: zero.

The allowed boundaries are one shared deferred per idle-to-busy cycle, lifecycle-level deadline/abort state, and an explicitly documented low-frequency intercepting hook. A normal OS terminal write has no absolute deadline; lifecycle owners impose a separate bounded wait and release local references when it expires.

## Temporary object contract

Do not use hot-path wrapper objects such as:

```ts
submit({ data, diffLines });
writeFrame(data, { signal });
return { frame, cursor, bytes };
const next = { ...state };
Object.assign(state, update);
const seen = new Set();
const index = new Map();
```

If ownership is bounded to one active and one pending value, use fixed primitive instance slots such as:

```text
activeData
activeGeneration
activeBytes
pendingData
pendingGeneration
pendingBytes
```

Keep object shapes stable. Clear optional references with `undefined`; do not use `delete` to mutate hidden classes.

## Temporary array contract

Do not introduce these operations in a hot path without profiler evidence and an explicit ownership argument:

- `Array.from(...)`;
- `[...items]`;
- `items.map(...)`;
- `items.filter(...)`;
- `items.flatMap(...)`;
- `items.slice(...)`;
- `Promise.all([...])`.

Necessary arrays are limited to viewport-sized output, the lines rendered by the active component, and required terminal-diff data. For every retained hot-path array, document:

- maximum length;
- owner;
- release point;
- cleanup on early return, throw, and abort;
- whether reuse can retain an unusually large backing store.

Scratch arrays must be instance- or call-owned, cleared on every exit path, and discarded above a documented capacity threshold when backing-store retention would be harmful. Arrays returned to extensions or callers are not scratch.

## String construction and materialization contract

Do not rematerialize a complete frame merely to coerce, hash, inspect, or log it. The production frame path forbids:

- `new String(frame)`;
- `String(frame)`;
- `` `${frame}` ``;
- `frame + ""`;
- `Buffer.from(frame)`;
- `JSON.stringify(frame)`;
- unnecessary full-size `slice`, copy, hash, or log operations.

Each normal frame has these hard limits:

- final full-size frame materializations: at most one;
- application-created full-size frame copies: zero;
- active full-size frame strings: at most one;
- pending full-size frame strings: at most one;
- render intents holding a complete frame string: zero;
- instrumentation holding a complete frame string: zero;
- default logging copies of a complete frame string: zero.

`fullSizeFrameCopies === 0` proves only that application code did not deliberately copy the string. It does not prove that V8 will never flatten a cons string. Large-frame changes therefore also require HeapProfiler samples, peak-heap observations, active/pending reference counters, and controlled-GC evidence after flush and abort.

Large tool output follows the same rule: an estimator must not create a second complete result string, and truncation must not split a 10 MiB single line into an unbounded line array.

## Frame-queue contract

The Phase 4C frame lane is callback-driven:

- active writes are at most one;
- pending latest frames are at most one;
- a newer frame replaces the stale pending frame and releases its reference immediately;
- content and cursor form one atomic frame;
- normal frame Promise, `AbortController`, and wrapper-object counts are zero;
- a busy cycle owns at most one shared flush deferred;
- Writable completion requires both successful callback and backpressure completion (`write() === true` or a later `drain`);
- normal write completion and lifecycle deadline are separate;
- lifecycle abort clears logical queue references but cannot cancel an OS write;
- a canceled write retains exclusive physical writer ownership until its own callback and drain settle, so stale events cannot satisfy a replacement generation;
- one replacement may wait in fixed primitive terminal slots; no second physical write starts early;
- flush, failure, and final disposal clear queue, writer, waiter, and terminal-owned listener references;
- queue failure does not prevent terminal restoration attempts.

The portable numeric regression gates are:

```text
activeWrite <= 1
pendingLatestFrame <= 1
terminalFrameQueueHighWaterMark <= 2
framePromisesCreated/frame = 0
frameAbortControllersCreated/frame = 0
frameWrapperObjectsCreated/frame = 0
fullSizeFrameCopies/frame = 0
full-size frame materializations/frame <= 1
busy-cycle deferreds <= 1
```

## Object-pool admission

Object pools are not a default optimization. A pool is allowed only when all of these conditions are met:

1. an allocation profiler proves the object is a leading hot allocation;
2. acquire/release ownership is explicit;
3. the lifetime is bounded;
4. ownership is preferably one synchronous call;
5. crossing `await` is prohibited unless separately proven safe;
6. the pool has a hard capacity;
7. release clears every field and large reference;
8. oversized objects above a threshold are discarded;
9. `try`/`finally` guarantees release;
10. multiple instances cannot share state accidentally;
11. tests cover double release, use-after-release, stale fields, reentrancy, throw, abort, clear, and dispose;
12. a benchmark proves sampled allocation falls by at least 20%, CPU p95 does not regress by more than 5%, and final heap does not increase by more than 10%.

If any condition is not met, remove the pool.

Potential candidates are synchronous layout records, rect/clip scratch, segment metadata, visible-region numeric arrays, and parser-local synchronous scratch. Do not pool strings or frame strings, Promises, `AbortController`s, agent events, messages, tool results, extension-visible objects, provider payloads, transcript items, externally returned arrays, or objects crossing an asynchronous boundary.

## Later-phase requirements

Phase 5 token estimation and UI/model tool-result views must avoid Promise tails per chunk, repeated complete-result copies, giant line arrays for minified input, and mutable-array aliasing between views. Artifacts and continuations must be bounded.

Phase 6 Evidence Ledger and operation storage must avoid large temporary key strings, repeated canonical serialization of complete results, retained source text, and unbounded pooling of operation records. High-frequency lookup requires its own allocation benchmark.

Phases 7 and 8 inherit the same limits when composing shared primitives or running soak tests. Migration does not reset the allocation baseline.

## Required review and reporting

For every touched hot path, report:

- the production call graph that was audited;
- existing and new hot-path allocations;
- closures, Promises, `AbortController`s, wrapper objects, and arrays per frame/event/update;
- sampled bytes per frame or update and the leading allocation sites;
- full-size string materializations and copies;
- active/pending byte and reference counts;
- cleanup evidence for normal completion, failure, abort, and disposal;
- the object-pool decision and supporting evidence.

Run the exact AST/source-invariant tests and the relevant queue-only and production allocation benchmarks before merging a hot-path change. Shared CI enforces deterministic counters; same-machine profiling is the timing and allocation baseline.
