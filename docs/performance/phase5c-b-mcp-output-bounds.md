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
