# F06.2 Anthropic inline tools

## Design gate (2026-10-12, before implementation)

F06.1 is merged as `ac5c4e15c5668ccf5647879043d4de085d71bacd`.
The current adapter rebuilds request-level tools and system text on every turn.
It cannot represent removal or same-name replacement at their original point in
history. Reproduce this with consecutive offline production requests before
implementing inline changes. Fixed upstream reference remains v1.1.0
`abe508e1b89912adde45528136c3221eb69acdd7`.

Use the existing assistant-message persistence boundary for optional, versioned
Anthropic context checkpoints. A checkpoint contains an owned, serializable
snapshot of model-visible tool definitions and system text, only when changed.
It is attached only to successful final messages, never streaming partials.
Replay checkpoints immediately before their assistant turns, after all tool
results, and append the current change before the next response. Unsupported
models continue using current request-level tools and system text. Missing or
pruned checkpoints safely establish a new prefix. No generic message role,
session format migration, execution permission, or automatic action is added.

The current request's tools remain authoritative: AgentSession active registry
and dynamic prompt rebuild -> Agent modelExposure selection -> convertToLlm /
context hooks -> Context -> capability filtering -> Anthropic request builder.
Historical definitions describe earlier availability; additions/redefinitions
and removals make the final availability equal to current Context.tools.
Actual execution still uses the existing registry and permission hooks.
Checkpoint snapshots cannot retain execute callbacks or mutable tool schemas.
Payload overrides that alter system/tool declarations invalidate checkpoint
continuity, rather than recording an inaccurate prefix.

Enable the protocol only for explicitly supported exact first-party models or
an explicit custom compat opt-in, with both system-message and tool-change
support. Keep old deferred-reference behavior for unsupported models. Use the
SDK beta request types/transport when inline mode is active. No subscription
authentication changes. Empty initial tool sets fall back until a valid initial
tool exists. No live cache-hit claim is made.

The audited continuation is SDK asResponse -> existing SSE parser -> event stream
-> Agent observation/snapshots -> AgentSession message_end persistence ->
InteractiveMode -> terminal queue. Checkpoint preparation/replay is once per
request; attaching it at completion avoids copying schemas on every delta.
Request-local maps/arrays die with the request, persisted checkpoints are owned
by transcript messages and released on prune/clear/dispose. No global mutable
cache, timers, workers or pools. Existing nonzero iterator allocations remain.

Validation: minimal production-adapter regressions for additions, replacement,
removal, prompt synchronization, placement, resume/prune/model downgrade and
hooks; real AgentSession integration for active tools and nested exposure;
relevant source invariants/typecheck/builds; same-fixture allocation counters,
profiles and owner-release probes. No full local suite or live provider calls.

Protocol source: [Anthropic mid-conversation system messages and tool changes](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages),
read 2026-10-12. Content-bearing updates follow a user/tool-result turn and precede
an assistant or the end of the request. Same-name definitions replace existing
tools. Inline definitions require `inline-tools-2026-09-15` on the Claude API.

## Implementation and verification

The production fixture first failed because adding a tool changed request-level
`tools`; evidence is `baseline.log`. The adapter now uses the beta SDK transport
only for native inline requests. Exact-model allowlisting avoids inferring
support from a family/version prefix (in particular Sonnet 5 stays disabled).
Both compat flags are accepted in models.json without changing the provider-neutral
capability manifest. ToolCalling=false still removes the tool protocol.

The first successful native response records an owned JSON checkpoint. Later
responses record a full checkpoint only on change, so branch/prune recovery does
not depend on an earlier delta chain. Tool conversion policy is recorded too;
policy/model changes, paused responses and declaration-changing payload hooks
rebase the next request. Wire schema copies and a request-owned placeholder isolate
payload-hook mutation from saved history. Tool references in legacy deferred
results continue using the old path on unsupported models. Native mode emits full
definitions after tool results instead, with final availability from current tools.

The completion envelope is copied once when a checkpoint is present. The mutable
partial message never receives it, including when a consumer drains queued deltas
after completion. This is a completion-only allocation, not a per-delta wrapper.
No JSON serialization of user text, images, or large tool results was added for
declaration comparison. Only system/tool declarations and role boundaries are
compared. Request input headroom adds declarations after the latest usage anchor,
or the initial declarations plus all updates when usage is unavailable. This
reuses the existing 3.5-character heuristic, without global recalibration or
subagent budgets; an incompatible explicit thinking budget fails before transport.

Windows / Node v26.4.0 validation: 109 distinct checks pass (97 behavior and 12
source/ownership). Eight new grouped cases cover add/replace/remove, instruction
replacement, JSON resume, schema isolation, prune, zero tools, model/capability
gates, hook mutation, slow consumers, failures and headroom. The real AgentSession
case persists/reopens JSONL, switches active tools and prompt guidelines, keeps
nested tools out of top-level declarations, and verifies a removed tool cannot
execute. Root typecheck and AI offline/coding-agent/server builds pass. After the
final completion-boundary adjustment, 24 affected checks and the AI build/typecheck
were rerun; unrelated prior evidence was retained.

## Allocation and lifecycle evidence

The complete downstream stream loop, five SSE helpers and event stream / Agent /
AgentSession / InteractiveMode / ProcessTerminal sources match the merged base.
`audit.mjs` records their comparison and the candidate source SHA256. Direct delta
AST counts remain zero closures, new Promises, controllers and array literals;
three pre-existing event-envelope literals belong to mutually exclusive branches.
New work is confined to request preparation and successful completion. Request
maps and arrays are bounded by the supplied transcript/tool set and die with that
request; no retained scratch pool or global owner was added. Stored snapshots are
owned by their transcript messages and leave with prune, clear and owner disposal.

The same two-turn fixture (existing read checkpoint, newly added lookup and prompt
update) ran through the real SDK and adapter, three samples of 20,000 deltas after
2,000 warmup updates. The baseline loader loads the merged adapter by its original
module URL without modifying the checkout. Every sample has 20,000 deltas, one
terminal event, one fetch, two lifecycle controllers and zero SDK SSE decoder calls.
Existing full-chain Promise initializations remain 280118 per request. No snapshot
appears on any partial event. This is not a claim of zero allocations in the
existing async-iterator chain.

Sampled bytes/update: baseline 4731.6564 / 4099.2048 / 4084.1572; final
4725.1852 / 4090.1488 / 4070.8368. Instrumented times: baseline
1469.995 / 1456.551 / 1450.706 ms, final 1448.006 / 1450.790 / 1455.150 ms.
Leading allocation sites remain decodeSseLine, event-stream iterators,
iterateSseMessages, iterateAnthropicEvents and consumeLine. HeapProfiler sampling
includes collected objects, runtime and harness allocations; post-GC heap deltas
also retain profiler records (baseline 5541816 / -544320 / 58880 bytes; final
5558152 / -507744 / 103128). These are not CPU p95 or an improvement claim.

Normal/error readers unlock; normal/error/abort disposal collects all 25 candidate
WeakRefs (22 baseline), including new checkpoint/tool-array/schema references.
Both candidates retain the SDK's existing one once-abort listener after settlement
until the caller owner aborts; then listener count is zero. No immediate-release
claim is made for an externally retained caller signal. No pool, background
worker, service, new worktree or live provider call was introduced.

Raw evidence: `.git/f06-2-inline-tools-20261012/` (`baseline.log`, related/integration/
final-regression logs, check/build logs, `source-audit.json`, `measure.mts`,
`baseline-loader.mjs`, before/after JSON and six heap profiles). No full local
suite or real Anthropic cache-hit test was run. Prefix equality and protocol
behavior are offline SDK transport evidence, not service-side acceptance.

## Review correction design gate

Review of `6f8fe34a3` identified four integration gaps to reproduce before fixing:
the beta endpoint overrides client-default beta headers; a usage anchor may
precede a newly rebased initial declaration; metadata observes only the initial
prefix; the public proxy completion contract drops checkpoints. Merge active
client beta flags at request startup, track the first retained checkpoint index
for usage accounting, replay declaration-only metadata from the final payload,
and carry optional context/raw-stop metadata in proxy completion envelopes.
No delta parser is to change. Proxy audit covers fetch -> reader/line decoder ->
processProxyEvent -> EventStream -> Agent/Session and observer/terminal cleanup.
Proxy completion must copy the envelope instead of mutating queued partials;
legacy terminal events remain valid. Add focused failing probes and compare the
proxy delta branches, allocation counts and owner release before/after.

All four probes failed before the correction and now pass (`review-baseline.log`,
`review-fixes.log`). The final-payload observer now replays native declaration
updates, excludes the dormant placeholder from active tools, and hashes system
updates without exposing their text. A usage record before the first retained
checkpoint is conservatively charged the new initial declarations. SDK client
default beta headers are merged before the final payload hook, preserving its
override precedence. The proxy's optional final fields require forwarding by
external proxy servers; legacy servers remain compatible but cannot preserve
inline continuity. 61 affected checks pass; cumulative distinct checks are 113.

With effective-dispatch observation enabled, three 20,000-update review samples
have the same 280118 Promises/request, two controllers, one fetch, zero SDK
decodes and 25 collected WeakRefs. Sampled bytes/update change from
4734.6884 / 4068.9036 / 4093.2828 to 4707.6452 / 4072.5900 / 4059.0684.
Final instrumented times are 1473.307 / 1438.137 / 1465.149 ms; post-GC heap
deltas are 5588976 / -500296 / 103184 bytes. Same profiler limitations apply.

The proxy's full reader loop and all pre-terminal event branches match the merged
base. Three 10,000-update samples after 1,000 warmup retain 40028 Promises/request
and no checkpoint on buffered partials. Sampled bytes/update: baseline
1572.3664 / 1110.6536 / 1070.6200; candidate 1590.9544 / 1117.1896 / 1060.3696.
Times: 28.017 / 19.906 / 16.440 ms vs 23.971 / 19.673 / 16.738 ms.
Post-GC heap deltas: 1099224 / -185120 / 3408 vs 1123656 / -209968 / 2288 bytes.
All 15 candidate WeakRefs (13 baseline) collect, including parsed checkpoint and
tool-array references. Abort listeners are removed. The proxy's pre-existing
completed reader remains locked while an external owner retains the body;
collection here proves release after owner disposal, not immediate unlock.
No proxy reader/delta algorithm was changed. Raw `proxy-measure.mts`,
`proxy-before/after.json`, review before/after JSON and profiles record the details.
