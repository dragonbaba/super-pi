# Cloudflare AI Gateway Claude model IDs

Baseline: `8ed7d79e8d81c197274a95725358cb92c3cec68e` (PR #97 merged).
Measurement: Windows, Node 26.4.0, 2026-10-11 JST.

The Cloudflare Anthropic catalog loader retained dotted model IDs from models.dev.
The gateway's native Anthropic route forwards these IDs to Anthropic. The
[upstream correction](https://github.com/earendil-works/pi/commit/c10bfb0d79dbbc998539a0a3e6c6a736a4e6db06)
normalizes them during generation; [Cloudflare's documented native request](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)
uses `claude-sonnet-4-5` at `/anthropic/v1/messages`.

The generator now converts dots to dashes only in its Cloudflare Anthropic branch.
Seven existing shipped model keys and IDs are corrected. Every other field and
record is preserved, including capabilities, prices, limits and names. The
manifest's Cloudflare hash and structure hash change; the complete snapshot's
generation timestamp and all 38 other provider hashes stay unchanged. A partial
repair must not expire unrelated remote catalog updates.

OpenAI and Workers AI routes retain their native ID formats. Generation still
deduplicates canonical IDs with its existing first-record precedence. Explicit
custom IDs and model overrides remain caller-controlled. Consumers configuring
these built-ins should use their corrected dashed IDs; this change does not
migrate arbitrary stored configurations.

Persisted catalogs newer than that unchanged manifest can still contain the old
dotted IDs. `profileRemoteModel` now canonicalizes Cloudflare `anthropic-messages`
rows whose IDs start with `claude-`, before capability profiling and exact-ID
merging. This applies on every offline restore and downloaded catalog ingress,
including a fresh-cache skip, 304, or failed refresh. Existing last-record remote
merge precedence is preserved when dotted and dashed records collide. Raw stored
facts, ETags and timestamps are preserved; normalization is a projection at each
ingress, with no cache rewrite or forced network refresh. Explicit models.json
and extension definitions bypass this projection. A saved dotted catalog
reference follows the existing reported missing-model fallback; it cannot select
the invalid cached record. This does not add a saved-ID alias.

## Audited production chain

models.dev loader → canonical ID / reasoning-option key → final metadata
overrides → deduplication / serialization → `flattenModelCatalog` →
`cloudflareAIGatewayProvider` / `createProvider` / capability profiling →
`cloudflareStreams` / `resolveCloudflareModel` → Anthropic `stream` or
`streamSimple` → `buildParams` / SDK request → SSE events → done/error/abort
settlement. The upgrade chain is `FileModelsStore` → `createModels.refresh`
local/network phases → `remoteModels` freshness filter → `profileRemoteModel` →
provider profiler → `withModelProfile` → generation-checked publication →
`mergeCatalogModels` → ModelRuntime composition/snapshot → session restoration →
the same request chain. Explicit models.json/extension composition also invokes
provider profile hooks, which is why the correction belongs in remote ingress
instead of a shared provider hook.

Generation replaces dots once per Anthropic row; remote ingress does so only for
a matching dotted Claude record. `stripModelProfileMetadata` already returns an
owned shallow copy; legacy stripping creates another existing copy. The new
assignment reuses that private raw object without mutating the input record or
adding a copy. The immutable ID has the same length as its source and belongs to
the resulting catalog model. The runtime does not normalize IDs per request or delta.
No new state, listener, timer, controller, cache, pool or worker is introduced.

The existing cold path owns arrays from restore filtering/mapping, merge and
runtime composition, sized by the accepted catalog rather than an arbitrary new
capacity. Publication replaces the previous overlay and invalidates its cached
merge; clear/owner release drops the current references. Existing async refresh,
deadline and abort ownership is unchanged. Raw storage keeps the original facts
under its existing lifecycle. No scratch buffers or object pools are added.

The existing request path still allocates: the Cloudflare wrapper resolves two
URL placeholders and copies the model when the URL changes; provider dispatch,
profiling, the SDK, request options, message conversion and SSE settlement retain
their established objects, arrays and asynchronous work. None of those functions
changes. Source verification compares the complete generator AST after reverting
the single assignment and the complete remote-provider AST after removing the
one ingress guard. Production differences are restricted to those two files,
the Cloudflare JSON and the manifest; all other request/stream/runtime sources
remain identical to the fixed baseline.

## Reproduction and measurements

```sh
npm run check
npm run build:offline
node --experimental-strip-types --test tests/cloudflare-model-ids.test.ts
node --expose-gc scripts/bench/cloudflare-model-ids.mjs --baseline-lifecycle
node --expose-gc scripts/bench/cloudflare-model-ids.mjs
npm test -- --jobs 4
```

| Evidence | Result |
| --- | --- |
| Actual baseline generator and shipped catalog | 21 of 22 regression cases fail; wire cases observe the old dotted ID |
| Upgrade regression before the review repair | 4 of 27 fail: current/legacy old cache, 304 overlay, persisted ModelRuntime restore |
| Corrected regression cases | 27 pass, including 28 original adapter sends and 4 persisted-runtime/fallback sends using in-memory fetch substitutes |
| Related catalog/pricing/profile/merge tests with the corrected cases | 46 pass |
| Complete suite | 253 execution units; 4,124 tests, 4,032 pass, 92 skip, 0 fail/cancel |
| ID expression, 20,000 executions for each revision | 0 object/array/closure/constructor sites in both; candidate calls `replaceAll` once per row |
| Remote ingress, 40,000 executions | 20,000 dotted records replaced once; 20,000 canonical records returned without replacement; 0 new object/array/closure/constructor sites |
| String work | One bounded ID replacement per generated Anthropic row or accepted dotted remote Claude row; no request-time or delta-time ID conversion |
| Production runtime functions changed | 1 cold-ingress function; 0 request/event/delta functions |
| Snapshot scope | Exactly 7 key/ID pairs; all other model fields, records and provider hashes preserved |
| Capabilities derived from old and new IDs | Identical for all 10 shipped Cloudflare Anthropic models |
| Request lifecycle, each revision | 6 sends and 6 payloads: direct/Simple × success/HTTP error/abort |
| Controlled GC after the caller error-stack boundary | All 54 monitored references released; 6 caller controllers, provider and model remain reachable |
| Catalog GC, current/legacy × replacement/clear | 1,024 restored records; all 3,076 model/cost/capability/merged-array references released while 4 registry/provider/store owners remain reachable |

The request lifecycle comparison sends the original and corrected model metadata
directly through the same production provider, bypassing catalog ingress; all
request sources are proven unchanged. The catalog lifecycle probe separately
exercises the repaired production restore/merge path in both invocation modes.
With default cancellation, the retained caller controllers own their default abort
reasons. Before materializing those reasons' lazy stacks, Node 26.4.0 retains the
same 11 monitored request references in both revisions. Reading only these
fixture-owned stacks releases all 54 references after controlled GC. An explicit
primitive cancellation reason also releases all 54 without this step. The probe
prints the pre-boundary retained labels and requires zero afterward; it does not
claim collection while caller-owned lazy stacks retain their captured frames.

Counters cover application syntax and the isolated ID expression, not V8's string
storage or total SDK allocation. No throughput improvement or complete-request
zero allocation is claimed. Model selection and requests are verified offline;
no live Cloudflare/Anthropic inference or billing acceptance was performed. Test
models.json directories are removed in `finally`, and fixture store entries are
deleted by provider identity after each restore test.
