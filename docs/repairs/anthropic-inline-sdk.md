# F06.1 Anthropic inline-tool SDK prerequisite

## Design gate (2026-10-12)

The fixed upstream v1.1.0 (`abe508e1b89912adde45528136c3221eb69acdd7`)
uses `@anthropic-ai/sdk` 0.129.0. Our 0.91.1 beta message types cannot
represent system-role `tool_addition` blocks containing a `tool_definition`.
The prerequisite is a pinned SDK update and compatibility evidence, not enabling
inline tools for existing models. F06.2 will own transcript changes, model gates,
permission-filtered tool availability, and dynamic prompt synchronization.

The project currently passes current tools through AgentSession / Agent request
preparation into `Context.tools`, then `contextForModelCapabilities`,
`splitDeferredTools`, `buildParams` and `convertTools`. Tool discovery is recorded
as `addedToolNames` references. Active tools and their prompt guidelines are
rebuilt by `setActiveToolsByName` / `_rebuildSystemPrompt`. There is no generic
system-message/tool-definition history yet. Porting upstream blocks alone would
not preserve this project's authorization and prompt behavior.

## Scope and ownership

Update the AI package's exact dependency and lock resolution to 0.129.0;
declare the same version for root tests that directly import it. Adapt existing
types only if compilation identifies a concrete incompatibility.
No production beta header, model capability, tool exposure, credential policy,
session format or automatic execution is introduced by this prerequisite.
Use typed SDK fixtures to reproduce the old type gap and exercise actual
serialization of inline definitions, same-name replacement and removal through
an injected offline fetch. Existing adapter tests cover API/proxy authentication,
strict/deferred tools, thinking, cache and stream endings.

The audited production path is Anthropic client construction / request preparation
-> SDK `messages.create(...).asResponse()` -> raw Response -> our
`iterateSseMessages` / `iterateAnthropicEvents` -> block accumulation ->
AssistantMessageEventStream -> Agent observer/snapshot -> AgentSession listener
-> InteractiveMode -> terminal frame queue. SDK SSE decoding is not used by this
adapter. The dependency update therefore changes the request lifecycle, not the
per-delta parser or downstream event/render code. Existing SSE iterator Promises,
arrays, decoded records and event envelopes are not zero-allocation and are not
reclassified as compliant by this update. Request-local SDK client/options/body,
controller and timeout state must release after completion/failure/cancellation;
no new persistent cache, timer owner, worker or pool is planned.

Run the smallest affected behavior checks, source invariants, root typecheck and
AI offline/consumer builds. Record before/after samples through the real adapter
and SDK request boundary, with exact event/controller/decoder counters and
controlled-GC/reference-release checks. Do not repeat the full local suite or
unrelated TUI benchmarks. No live API calls or cache-hit claims are part of this
offline acceptance.

Protocol reference: [Anthropic mid-conversation tool changes](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages).

## Compatibility findings before adaptation

The upgraded stable `ToolUnion` includes a browser toolset identified by `type`
rather than `name`. This exposes an existing assumption in request-level dispatch
metadata: its tool identifiers must use a named tool's name or an unnamed
toolset's wire type. Reproduce the incorrect fingerprint before adding that
narrow branch; do not enable browser tools or alter conversion/execution.

Root tests import the SDK directly. The workspace-only install placed it under
`packages/ai/node_modules`, making those tests fail to resolve an undeclared
transitive dependency. Declare the same exact SDK version as a root development
dependency so clean installations have a deliberate test dependency. The lock
adds only the SDK's required standardwebhooks/base64/SHA256 dependencies.

## Verification

Windows / Node v26.4.0, baseline `4c091608757f7305c11029ac7ad4b4ea0f381423`:

- The old SDK rejects the typed inline fixture in root typecheck. The upgraded
  SDK accepts it without casts; real beta-client serialization preserves initial
  tools and earlier messages across addition, same-name replacement and removal.
- The unnamed-toolset dispatch identity check fails before adaptation and passes
  after it. 99 affected behavior checks and 12 source/ownership checks pass;
  root typecheck plus AI offline, coding-agent and server builds pass.
- The lock audit changes exactly six entries: root test dependencies, AI package,
  SDK, standardwebhooks, @stablelib/base64 and fast-sha256. The prior extraneous
  SDK record is untouched; it is not the workspace AI resolution.
- AST comparisons prove `stream` after authentication and its five SSE helpers
  unchanged. The direct delta branch contains zero closures, new Promises,
  controllers and array literals; its three existing event-envelope literals
  belong to the mutually exclusive text/thinking/tool branches. No pooling.

The local same-machine sampler runs 2,000 warmup deltas, then three 20,000-delta
requests through the real SDK `asResponse` and production adapter. Each sample
has one fetch, exactly 20,000 text deltas, one terminal event, zero SDK SSE
decoder calls and two controllers per request (fixture caller plus SDK).
The complete asynchronous iterator/ReadableStream chain has 280,112 -> 280,118
Promise initializations per request, including harness and existing iterators;
these are **not** reported as zero-allocation provider delivery. The six-count
difference is at the changed request boundary; no per-delta body changed.

| Measurement | SDK 0.91.1 | SDK 0.129.0 |
| --- | --- | --- |
| Sampled bytes/update, three runs | 4654.631 / 4070.910 / 4060.414 | 4668.854 / 4100.452 / 4088.571 |
| Instrumented elapsed ms, three runs | 1436.5 / 1427.9 / 1451.2 | 1669.2 / 1424.7 / 1435.5 |
| Post-GC heap deltas, bytes | 5415520 / -878024 / 88592 | 5453048 / -480144 / 83080 |

Heap samples include inspector profile objects and instrumentation; elapsed time
is not CPU p95 (the first candidate sample overlaps build/typecheck). These
numbers establish the measured scope, not a speed or heap improvement. Leading
allocation sites in both versions remain decodeSseLine, event-stream iterators,
iterateAnthropicEvents, iterateSseMessages and consumeLine.

Completion/error paths unlock the response body. SDK 0.91.1 and 0.129.0 both
retain one once-only listener on a settled caller signal until its owner aborts;
the fixture disposes its caller explicitly, then verifies zero listeners. Across
normal completion, SSE error and aborted fetch, all 16 WeakRefs to responses,
bodies, signals, streams, results and controllers collect after owner disposal.
There are no persistent task processes or timers. This evidence does not assert
immediate listener release while an external caller keeps its signal alive.

Raw evidence and reproducible local probes are in
`.git/f06-inline-tools-20261012/` (`type-baseline.log`, `dispatch-baseline.log`,
`behavior.log`, `source.log`, `check.log`, build logs, `audit.mjs`,
`source-audit.json`, `measure.mts`, before/after JSON and six heap profiles).
Commands: `node .git/f06-inline-tools-20261012/audit.mjs` and
`node --expose-gc --experimental-strip-types .git/f06-inline-tools-20261012/measure.mts before|after`.
The full local suite, live Anthropic calls, real cache-hit behavior and F06.2
session integration are outside this prerequisite's acceptance.

## Review: credential-provider boundary

Review of `177786bd4` identified new SDK authentication behavior: a client without
a static key/token can start credential discovery during construction, while
credentials/config/profile may resolve a token only later. Checking static
fields alone cannot enforce the existing subscription boundary. Reproduce with
synthetic credential providers and stub the SDK's discovery method before
constructing profile/anonymous fixtures; never consult real credential files.

Reject injected clients with structured SDK credential state before payload
hooks, token resolution or API transport. Preserve explicit static API/proxy
authentication and custom clients that own their transport. Internally created
clients must override the SDK's protected default-discovery opt-in to false, so
header-only proxy auth cannot begin ambient discovery. Validate constructor
default headers after construction too, because the new SDK also merges ambient
custom headers. A preconstructed external client may already have started its
own discovery; the adapter cannot undo that constructor side effect and must
reject further use. Changes stay at request startup, not the delta path.

All three review probes fail on `177786bd4` and pass after correction. They cover
structured providers and withOptions clones, config/profile/anonymous clients,
built-in proxy discovery, and ambient subscription headers. Static injected
API-key/token clients and a custom discovery-disabled header client still work.
17 affected checks (including source invariants), root typecheck and all three
builds pass; the earlier unaffected 99/12-check evidence is retained. Total
distinct behavior cases increase to 102. No actual credential files are read by
the review fixtures; constructor discovery is stubbed before clients are made.

The final request-startup change adds bounded header inspection, with no extra
per-delta code. Repeated three-run profile samples are 4695.758 / 4087.622 /
4084.791 bytes per update, 280,118 Promise initializations per request, two
controllers, zero SDK decodes and 16 WeakRefs with zero survivors. Instrumented
elapsed times are 1748.6 / 1439.4 / 1405.7 ms; heap deltas are 5462616 / -548192 /
134280 bytes with the same profiler limitations. Full post-auth stream and five
SSE helpers still match the merged base. Raw review evidence is in
`auth-review-baseline.log`, `review-regression.log`, `review.json` and three
`review-*.heapprofile` files.
