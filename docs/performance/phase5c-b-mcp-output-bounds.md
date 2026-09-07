# Phase 5C-B MCP output bounds: Plan Gate and red evidence

Status: implementation in progress; the user approved the narrow typed-source
input adapter and no-budget fail-closed behavior. This is not yet a candidate or
acceptance packet. The Plan Gate below records baseline observations; the
implementation progress section records subsequent changes.

Baseline fetched from origin/main:
`946442c7cd41c77dde26d2b8fbce442211dfef7d`. One worktree and branch:
`Pi-phase5c-b-mcp-output-bounds`, `phase/5c-b-mcp-output-bounds`.
Initial test-only red commit: `20e90ecd80d09483cf5d7ba9e94b282957dcff33`.

## Previous acceptance and freeze

SUPER-PI-PHASE5C-A-LARGE-READ-WINDOWING is Completed / merged / accepted-area
frozen. Its local dispatch, 16 KiB selected window, 256 KiB prefix Buffer,
incremental UTF-8 and CRLF handling, short-read fill, progress guards, bounded
small snapshot, EOF verification, unreliable-size error, cursor schema/HMAC/
session/workspace/path binding, generation invalidation and G2 integration remain
untouched. No large-read tests or timings are scheduled for this stage.

G2 presentation semantics, contextual budgets, artifact/continuation identity,
TUI/Markdown/lifecycle and provider adapters remain frozen. The three read.ts P2
follow-ups remain deferred C items. Smooth Streaming Reveal remains deferred D.
No Evidence Ledger, operation-id, Harness v2, Phase 8 soak or transport-library
rewrite is in scope.

## Baseline production paths (Plan Gate)

1. Extension initialization: `packages/mcp-bridge/src/index.js` session_start
   creates `McpBridgeRuntime`; runtime connects SDK clients and registers remote
   tools through `registerRemoteTool`.
2. Request: registered `execute` -> `callRemoteTool` -> SDK 1.30.0
   `Client.callTool` -> `Protocol.request` -> stdio, StreamableHTTP or SSE
   transport. The registered tools currently use sequential execution mode.
3. Progress: SDK notification dispatch -> `Protocol._onprogress` -> the request's
   `options.onprogress` callback. The bridge currently supplies no callback, so
   no progress token is requested through that option. Its
   resetTimeoutOnProgress=true setting alone does not install progress delivery.
   The available downstream path is execute's `onUpdate` -> agent-core
   `ToolProgressDelivery.publish` (one pending latest value) -> classified agent
   events -> session/UI delivery. That existing queue must be reused.
4. Final: SDK JSON decoding and result-schema validation -> `callRemoteTool` ->
   `convertMcpResult` -> ToolResult content/details -> extension wrapper ->
   agent tool-result finalization -> AgentSession message_end, after extension
   interception -> `ToolResultPresentationOwner.create(content, toolCallId)` ->
   canonical session persistence. SDK `convertToLlmWithBlockImages` uses the same
   owner's `projectMessagesForModel` and existing contextual budget coordinator.
5. Tool error results currently use `resultText` and throw; protocol exceptions
   are copied into `state.error` and rethrown. Sanitizing terminal sequences is
   not secret redaction.

The SDK's notification dispatcher and progress parameter wrapper allocate outside
the bridge. Its timeout reset is also SDK-owned. Allocation reporting must not
claim those costs disappear when bridge callbacks avoid Promises and timers.
Agent-core's existing asynchronous progress flush can turn a downstream observer
failure into a tool error; merely catching a synchronous onUpdate throw does not
prove the complete requested failure-isolation contract.

## Actual protocol and conversion

Pinned dependency: `@modelcontextprotocol/sdk` 1.30.0. `ContentBlockSchema` is a
union of text, image, audio, embedded resource and resource_link. Embedded
resources contain URI plus text or base64 blob, with optional MIME metadata.
Image/audio data is base64. There is no arbitrary `binary` wire content type.
`CallToolResultSchema.structuredContent` is an optional string-keyed object;
nested arrays are permitted. A cyclic custom/internal value is not valid JSON.
The compatibility schema additionally supports legacy toolResult, although the
bridge's callTool currently uses the normal CallToolResultSchema default.

`bridge.js` currently normalizes images, text resources and resource links;
audio/blob content becomes an omitted-content notice with no recovery handle.
`security.js boundedJson` performs full pretty JSON.stringify and then
`truncateUtf8`, which constructs a full Buffer. Error conversion calls the same
helpers. Canonical structured object semantics are not retained by this path.

`tools/call` has no standard cursor/nextCursor. ListTools/ListResources and other
list APIs have pagination. Results permit opaque `_meta`, but the bridge has no
custom server tool-pagination contract or resource-retrieval tool. List cursors,
HTTP resumption tokens and experimental task metadata are not interchangeable
with tool-result pagination. Preserve supported opaque metadata; do not parse a
custom key into an invented replay command. With no actual pagination contract,
recovery must be identified as local session recovery.

## Three separate bounds

| Layer | Current boundary and limitation |
| --- | --- |
| A: transport/frame | Existing stdio maxBufferSize and HTTP response limit are 10 MiB; SSE event limit is 4 MiB. HTTP uses the existing bounded fetch wrapper. The SDK still materializes a complete JSON value and schema-parsed result before bridge normalization. stdio may concatenate Buffers. These guards are not a zero-copy transport guarantee. |
| B: canonical post-parse | Current conversion stops at 256 items and clips text to 50 KiB, discarding the omitted source. Images permit 5 MiB each / 10 MiB aggregate. Structured JSON is serialized before the clip. Replace silent loss with admission/recoverability; reject over-ceiling custom results before avoidable serialization. A 10 MiB text-only internal fixture can be tested, but its JSON envelope exceeds the existing 10 MiB wire ceiling. |
| C: model | G2 owns estimated-token, per-turn and remaining-context enforcement. No production default token budget exists. Presentation-disabled execution has no owner. MCP must not create an independent estimator or choose a new token default. Notices must fit the selected emergency byte allowance as well as the configured G2 budget. |

Raw parsed-object ceilings must include structure and typed data; many tiny
fields cannot bypass admission. The existing 10 MiB response ceiling is the
initial emergency-bound candidate, not a new token budget. Exact accounting and
corpus evidence are still required before finalizing its post-parse application.

## Concrete integration dependency

The current owner accepts only TextContent | ImageContent. Its active-branch
artifact identity and recovery operate on message.content; structured objects,
audio and blobs in details do not automatically become recoverable artifacts.
There is no extension-context API to admit such a source. Reclassifying audio as
an image, dumping its base64 into text or keeping an MCP-private Map would each
violate the requested architecture.

Proposed narrow adapter (subsequently authorized): admit validated MCP source
metadata into the existing owner/session pipeline; retain canonical source
references in the existing records and persisted session source, not a second
registry. Existing text/image identities and behavior stay unchanged. Extend
source validation/recovery only as necessary to support typed MCP data, with
session/branch/source checks and the existing record/admission lifecycle. Exact
source integrity coverage must be specified before implementation; a handle
covering only a placeholder is not sufficient integrity for a blob in details.

Second decision (subsequently authorized): for large MCP results when the G2 owner or configured
budget is unavailable, return a bounded configuration-required failure rather
than invent a token budget, discard data as successful output or activate a
second owner. Tiny text compatibility remains unchanged.

Expected production files: MCP `bridge.js`, `security.js`, a focused typed/result
normalization module; narrow changes in the existing owner and session/extension
plumbing only if the dependency is authorized. Exact plumbing paths must be
selected from the source-boundary design, not created to match an old plan.
One Draft PR is sufficient if this integration is authorized. None exists yet.

## Deterministic evidence so far

The first red run: nine tests, one pass and eight expected contract failures.
The expanded suite: fourteen tests, three pass and eleven expected failures.
Passing controls: tiny text/order, first-delivery-is-final with exactly one call
and no update, actual SDK list pagination versus tool-call metadata shape.
Failing contracts: 64 KiB / 1 MiB / 10 MiB canonical suffix recovery, bounded
notice, explicit cyclic serialization failure, malformed base64 rejection,
protocol-error canary absence, progress callback, audio/blob recovery and
explicit content-item overflow. The tests exercise actual bridge functions and
G2 artifact recovery with a fake client; no API key or network server is used.

Baseline offline build and type check passed after dependency installation.
No local full npm test, performance processes, allocation profile, controlled-GC
run, large-read retest, review request or CI candidate run has been consumed.
Remaining work includes the full required matrix, production fixes, allocation
audit, bounded benchmarks/GC, exact CI and the authorized Draft reviews.

This document does not assert completion. Stop target remains the Phase 5C-B
Draft Candidate Gate, awaiting external final review and explicit merge
authorization. Do not Mark Ready, merge or start Phase 6–8.

## Implementation progress after authorization

The original red commits and Plan Gate are preserved. Production changes use
one internal `tool-result-source.ts` input adapter, the existing owner, and
session/extension dependency injection. There is no new artifact directory,
registry, token estimator, cursor owner or retention policy. Small ordinary
text remains inline and has no source digest or artifact. No-budget oversized
text and typed content needing recovery return a fixed configuration failure.
Existing inline image limits remain independent from the text limit.

The result normalizer validates supported typed shapes, base64 length/alphabet/
padding and basic media signatures without full decoding. Structured values
receive a bounded text preview and an immutable canonical source descriptor.
Cycles, non-JSON values and custom `toJSON` execution are rejected before model
serialization. Many small fields are charged against the source ceiling.
Opaque `_meta` is preserved locally; this does not implement server pagination.

Current request path: registered execute -> `McpBridgeRuntime.callRemoteTool`
-> pinned `McpClient.callTool` -> existing SDK request/transport. The SDK result
schema hook substitutes string validation for its eager base64 `atob` refinement;
the bridge performs encoding and media admission. The SDK still parses complete
JSON and reconstructs schema objects. No zero-copy/frame-memory claim is made.

Progress path: synchronous pinned-client progress dispatch -> the SDK's existing
active-request progress Map -> `McpCall.notify` -> existing agent latest slot.
No second progress queue is created. The client override relies on pinned SDK
1.30.0 `_onnotification`, `_onprogress` and `_progressHandlers`; upgrades require
the actual-client boundary regressions. Unknown/late tokens are ignored without
serializing arbitrary notification payloads. Progress counters and messages are
numeric only. An MCP-classified observer rejection is isolated in the existing
agent slot; the ordinary tool critical-listener behavior remains unchanged.

Final path: one parsed result -> bounded admission/normalization -> existing
session owner admission -> canonical tool result -> existing session final hook
and presentation/model projection. MCP tool-level failures carry a bounded error
category through that hook. Configured server `isError` text remains canonical
and recoverable. Protocol errors and connection stderr do not retain arbitrary
server messages or causes. Abort/final/dispose clear request callbacks.

MCP source identity extends only the newly admitted input kinds. Typed sources
hash their immutable value once and later identity checks use that digest plus
the canonical placeholder. Large MCP text caches one digest as a non-enumerable
property of the immutable canonical block; no complete text is duplicated into
a descriptor. Persisted JSON loses that cache and validates the restored source
generation once. Existing text/image caller identity and public artifact/cursor
formats are unchanged. Integrity tests measured four full text hash passes
before this correction and one afterward across creation plus three artifact
reads. Artifact access still validates session, call and active history through
the existing owner.

Development evidence: the combined MCP suites and existing 16 G2 artifact/model
budget regressions passed 60 tests at `744abc0`. Five subsequent lifecycle tests
cover four concurrent calls ending in success/error/abort/dispose, ignored late
progress, same-session JSON restore, foreign session and inactive branch denial.
The SDK boundary measured 300,000 Promise allocations for 100,000 progress
notifications before the shim and zero afterward. The client-side media decode
counter is zero; the in-process test server's own pre-send validation is excluded.
Type checking and offline builds pass. These are focused development checks;
the final candidate test, performance, GC, CI and review gates remain outstanding.

## Focused performance and allocation packet

`scripts/bench/mcp-output-bounds.ts` measures three fixtures. Five independent
timing processes total were used, including two after the media digest fix.
Local runtime: Windows, Node v26.4.0. CI uses the unchanged Node 22.19.x workflow.
Small-path comparison is a test-only reproduction of the baseline text
normalization path, not a network/server benchmark. No production tuning was
performed for sub-millisecond timing differences.

| Fixture | Raw fixture JSON bytes | Final two normalization p50 / p95 ms | Model estimated tokens | Recovery |
| --- | ---: | --- | ---: | --- |
| Small text | 183 | 0.0005–0.0006 / 0.0010 | 56 | inline, zero artifacts/cursors |
| 1 MiB structured object | 1,048,637 | 5.7360–5.7798 / 5.8762–6.2296 | 111 | one existing session artifact |
| 1 MiB text + image/resource + 100 progress updates | 1,223,546 | 0.1296–0.1315 / 0.1402–0.1432 | 112 | one existing session artifact |

Baseline small normalization p50/p95: 0.0006/0.0012 ms. Final absolute candidate
deltas: p50 -0.0001 to 0 ms; p95 -0.0002 ms. Projection plus recovery p50/p95:
small 0.0059/0.0094–0.0096 ms; structured 6.3537–6.3778/6.5584–6.6415 ms;
mixed 7.1768–7.2407/7.5504–7.6605 ms. The large raw sources are not forwarded as
full model text. Every measured large case reads its canonical artifact and
checks that the existing source array is reused. Four cursor strings are built
by the existing projection passes; this is not four independent cursor owners.

One sampled allocation profile on the mixed fixture (12 iterations): initial
heap 31,594,136, sampled peak 34,006,064, final 29,157,224 bytes. Largest site:
`Buffer.byteLength`, 1,048,592 sampled bytes, consistent with flattening the
synthetic repeated source string. Other leading sampled sites: benchmark run
24,200; inspector post 16,088; existing estimator ASCII-run logic 14,320;
projection record creation 11,672; typed-source creation 11,568 bytes. The profile
does not prove absence of native/V8 temporary allocation or transport copies.

One controlled-GC lifecycle run: 9 WeakRefs, zero retained after owner clear,
dispose and eight event-loop/GC turns. Heap initial 31,459,888, peak 32,908,288,
final 27,388,856 bytes. Source objects, wrappers, content arrays and owner are
tracked; primitives cannot be WeakRef targets. Canonical access naturally lasts
while the session still owns its messages; the fixture releases those roots.
The benchmark itself opens no source file or remote connection. The separate
stdio error fixture closes its SDK client/transport and child process.

Evidence limitation: these timings/profile/GC were gathered at production
`db5de9d`. The subsequent source-invariant correction replaces two `for...in`
loops with `Object.keys` iteration; it adds one transient key array per visited
object/pass, without changing source ownership or byte/token policy. They are
not represented as exact-head performance measurements. The requested process,
profile and GC budgets were not restarted after this correction.

| Boundary | Explicit allocation / ownership accounting |
| --- | --- |
| SDK progress adapter, each accepted notification | zero inline closures, Promise executors/tails/arrays, AbortControllers, timers, Map/Set constructions; bounded outer/params envelope objects; SDK performs one bounded rest-object copy |
| McpCall notification | zero Promise/timer/controller; one text string, one content array, result/text/details objects; no arbitrary server message reference; callback is bound once per request |
| Existing agent latest slot | one latest pending value per executing tool; existing asynchronous drain promises are per drain cycle, not an accumulating notification queue; MCP observer failure is isolated |
| Normalizer | no async helper, Promise, controller, spread, decode or source Buffer; one output array and bounded wrappers; two structured-key selector entries; temporary structural traversal arrays and per-property descriptors |
| Structured source | one bounded writer; validation and integrity traversals; at most one full serialization for an inline object, zero full serialization for a partial large preview; key arrays follow repository syntax policy and are released after each traversal |
| Typed binary | zero full base64 decodes; numeric signature inspection; canonical base64 string reference shared with the existing source owner; no artifact-source copy |
| Integrity | one source digest per newly admitted immutable typed/text/large-image generation; later artifact checks hash bounded digests/identity framing; JSON restore validates its new generation once |
| Existing owner | unchanged 128-record / 128 Mi-code-unit retention limits, existing eviction/admission and clear/dispose; conservative structural code-unit charges include node/key overhead |

The transport still owns complete JSON parsing and schema object reconstruction.
Post-parse admission cannot undo that allocation. The 10 MiB canonical envelope
reuses the existing transport safety ceiling; the 50 KiB model text ceiling
reuses the previous inline MCP allowance. These are raw safety limits, not token
defaults. Tests span tiny, 64 KiB, 1 MiB and 10 MiB text, large nested/many-field
objects, and mixed typed blocks; the wire JSON envelope must also fit its own
existing transport limit.

## Candidate checks and classifications

The single local `npm test` run reached the source-invariant gate and failed on
the two new `for...in` statements. Those statements were corrected in `a4d637b`;
the affected source-invariant and structured-content checks pass. The local full
run was not repeated. Exact-head Linux/Windows CI remains the final full-suite
gate and must be recorded in the PR packet before candidate acceptance.

Current reproducible MCP findings have deterministic red/fix commits, including
SDK Promise history, eager media decoding, late progress payload logging,
observer-failure final corruption, lost canonical server errors, lost failure
status, stderr/cause retention, structured `toJSON`, media compatibility,
immutable source digest reuse and stale extension input callbacks.

No new transport, provider, TUI, read or G2 retention/cursor subsystem is added.
The six-line existing agent progress change is justified by a deterministic MCP
delivery failure; its ordinary-tool critical-listener regression still passes.
Remaining D limitations: already-parsed transport frame allocation, pinned SDK
private progress hook, and no actual tools/call pagination contract in this SDK
integration. Standard list cursors/HTTP resumption are not tool pagination.
The previously deferred read.ts C suggestions remain outside this PR.

Rollback point is `946442c7cd41c77dde26d2b8fbce442211dfef7d`; revert this branch's
commits through ordinary reviewed changes if needed. Do not reset main. The
candidate worktree is dedicated. The unrelated main worktree has an existing
untracked `SUPER_PI_CODEX_PHASED_OPTIMIZATION_PLAN.md`; it has not been modified
or removed. The accepted Phase 5C-A worktree remains clean and untouched.

## Candidate Review and local closeout

Published candidate `f1f77e8f92b89de1dfcc39ed4455473661654b7c` passed both jobs in
[CI run 34096363452](https://github.com/dragonbaba/super-pi/actions/runs/34096363452).
The one Candidate Review is
[review 5129445968](https://github.com/dragonbaba/super-pi/pull/26#pullrequestreview-5129445968).
Its four correctness findings have local fixes and deterministic regressions:

| Finding / thread | Class | Correction |
| --- | --- | --- |
| 3947665863: invalid V2 notice | B0 | `6da8e17` retains the exact existing continuation notice and adds a separate bounded local-artifact metadata block. Both existing model/UI validators accept the resulting V2 view. No validator or public cursor format is changed. |
| 3947665872: advertised older-host compatibility | B0 | `8869df8` feature-detects the adapter export before bridge loading and removes the eager host import from security utilities. Missing-export simulation proves the extension entry reaches its compatibility gate. |
| 3947665860: ordinary progress listener suppression | B1 | `9de5a8f` requires both MCP tool naming and an internal symbol source marker, which cannot come from JSON result details. Ordinary-tool critical listener behavior is preserved. |
| 3947665868: budget too small for failure text | B1 | `1ef236c` asks the existing owner to admit the bounded failure. If text cannot fit, canonical details retain the reason and the final has zero model text. An actual session message_end test proves exactly one delivery and persistence with budget 1. No token minimum/default is invented. |

Self-audit corrections in the same closeout batch:

- `463c053` red / `cdf4175` fix: immutable typed source integrity includes its
  `requiresRecovery` policy. A restored flag edit fails closed.
- `a6ed48a` red / `3434396` fix: discard provisional MCP admission before mutable
  tool_result hooks. Recheck byte/source bounds and admit the final hook output
  through the existing owner. A tiny result expanded in-place to 1 MiB cannot
  reuse stale token metadata or bypass the 50 KiB model-text ceiling even with
  a large configured token budget. No-hook small results retain their path.

The source adapter now performs an additional bounded validation pass only at
the mutable MCP hook boundary. Hook failures produce a zero-text typed final with
a bounded configuration/admission reason. Private typed source annotations stay
canonical; ordinary model projections strip them. Existing G2 record removal
and admission operations are reused without a new retention policy.

The Object.keys evidence finding was subsequently resolved by the explicitly
authorized replacement profile and GC at `72002b5`. Its exact results and fixture
are in PR #26 reply `3948196997`: 4,209 key arrays / 12,624 slots, one inspection,
one bounded preview and one integrity construction; 20 ownership and 4,209 key
array WeakRefs cleared. That evidence is accepted and frozen. Both automated
review slots are consumed; no third broad review is authorized.

## Cumulative external review corrections after 72002b5

The preceding provisional-admission design is superseded. External cumulative
review reproduced premature freezing of public text/image blocks through
tool_result and message_end, unnecessary no-budget rejection of safe resource
wrappers/optional metadata, and rejection of unrecognized image subtypes.

Red commits `ea32201` and `9e7f3a4` preserve the candidate and activate the actual
ExtensionRunner hook dispatch. `ad1c076` fixes final ownership; `c194441` fixes
small typed and MIME compatibility. The expanded cumulative fixture uses valid
large PNG input and tests both hooks, in-place updates, returned replacements,
splice/push, no-op and no-handler cases, final budget/byte rejection, and full
source digest reuse across artifact/continuation recovery.

Final production call graph:

MCP conversion → session-injected non-owning byte/source preflight → tool_result
→ existing image normalizer → message_end → final byte/source validation →
existing owner.create → model/UI delivery and canonical persistence.

The internal extension injection signature is unchanged. It validates without
inserting an owner record, issuing artifacts, hashing public text/image blocks
or freezing them. The post-tool_result path also performs no owning admission.
Only the final create boundary establishes public source identity. Immutable
private typed descriptors retain their existing normalization-time digest and
validation behavior; their public wrapper remains mutable. Existing G2 budget,
projection, integrity and retention algorithms are unchanged.

An MCP final admission failure clears the failed record and replaces final
content with zero model text, isError and a bounded configuration reason before
delivery/persistence. It does not invoke the tool again or send a provider
request. Non-MCP failures retain their previous propagation. Final large image
blocks replaced by hooks/normalization receive the existing source marker with
the same base64 reference, after mutable hooks have finished.

Small resource text stays inline; safe bounded resource links expose bounded
name/URI text without download. Credential/query/fragment-bearing resource links
fail with a fixed category. No-budget mode ignores optional _meta as baseline
did. Configured opaque metadata remains local. Blob/audio/large resource text
and structured content still require configured recovery. Unrecognized bounded
image/* subtypes retain typed image form; known PNG/JPEG/GIF/WebP signature
checks, base64 and size checks remain. Downstream image support is unchanged.

Allocation delta: no new owner, source registry, cursor state, Promise, timer,
AbortController, hash cache or complete source copy. Final validation uses the
existing bounded input helper; final image tagging adds no string/base64 copy.
Failure only allocates the empty final and bounded metadata. Resource-link
validation adds one transient URL and bounded inline string per link. Progress,
structured Object.keys traversal and digest implementation are unchanged.

Focused validation passed 116 tests (the 100000-progress campaign excluded),
including the existing 16 G2 artifact/model-budget regressions; check and offline
build passed. One exact final-head controlled-GC process is authorized; no new
allocation profile is needed because the source implementation is unchanged.
Final GC results and exact Linux/Windows CI are recorded in PR metadata, preserving
their head without a documentation-only commit afterward. The stop is Corrected
Draft Merge Gate awaiting external incremental review and explicit merge
authorization. No Ready, merge, auto-merge or later phase is authorized.

## Last-diff corrections after 6285fee

External findings B0-5C-B-04, B1-5C-B-05 and B0-5C-B-06 are covered by red
commit `6528184` (19 failing cases) and production fix `0acfa1f`. Earlier
small-resource formatting, unconditional configured metadata retention and
in-place final image tagging descriptions are superseded below.

Inline embedded resources use the baseline `[MCP resource canonical-URI]`
header and sanitized text. Links use `[MCP resource link: name — canonical-URI]`.
Both parse the bounded URI, reject credentials/query/fragment, use canonical
URL.href and the existing sanitizer. OSC/CSI/ESC/prohibited controls cannot
enter inline canonical/model/UI text. Newlines, CJK and emoji survive text
sanitization. Final inline byte accounting charges the actual formatted string.
Large resource payloads retain their typed source without constructing a full
secondary string. Inline scratch exists only for resource/link results, has at
most 256 entries, shares its strings with normalized output, and expires when
conversion returns or throws.

Optional _meta is ignored unless another source already requires recovery. It
does not consume an item slot when ignored, force a tiny final into omission,
or introduce an artifact merely to preserve optional metadata. Required recovery
and retained metadata still share the existing owner and its aggregate bounds.

After both mutable hooks, final text/image blocks needing digest storage receive
host-owned wrappers. Public strings/data are assigned by reference, without
base64 decode, deep copy, serialization or new digest framing. At most one
additional final outer array (256 entries) and one wrapper per affected block
are allocated; existing input validation may already produce bounded wrappers.
No marker or digest symbol is written to extension-owned blocks, even if they
are extensible or already tagged. Frozen/sealed/preventExtensions outputs and
returned replacements/array splices are supported through the actual runner.
Small unannotated blocks and private typed descriptors retain their existing
path. Only host wrappers are frozen by final digest caching.

Structured traversal, Object.keys, source digest framing/cache implementation,
owner algorithms, progress, transport, V2/cursor/artifact formats, read and
TUI/provider paths are unchanged. The accepted allocation profile remains
frozen. 146 focused tests pass (100000-progress campaign excluded), including
the 16 G2 artifact/model-budget regressions; check/build/diff checks pass. One
replacement final-head controlled-GC process is authorized; its exact results
and Linux/Windows CI are recorded in PR metadata, without a later docs-only
commit. No timing, allocation profile or automated review is requested.

Stop: Final Corrected Draft Merge Gate, awaiting external last-diff review and
explicit merge authorization. Ready, merge and later phases remain unauthorized.
