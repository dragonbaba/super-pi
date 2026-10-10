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
migrate arbitrary stored configurations or rewrite newer remote catalog rows.

## Audited production chain

models.dev loader → canonical ID / reasoning-option key → final metadata
overrides → deduplication / serialization → `flattenModelCatalog` →
`cloudflareAIGatewayProvider` / `createProvider` / capability profiling →
`cloudflareStreams` / `resolveCloudflareModel` → Anthropic `stream` or
`streamSimple` → `buildParams` / SDK request → SSE events → done/error/abort
settlement. The existing remote-store restore, catalog merge and explicit
models.json override paths are exercised separately.

The only executable production change is one string replacement at catalog
generation. The resulting immutable ID belongs to the catalog and has the same
length as the source ID. The runtime does not normalize IDs per request or delta.
No new state, listener, timer, controller, cache, pool or worker is introduced.

The existing request path still allocates: the Cloudflare wrapper resolves two
URL placeholders and copies the model when the URL changes; provider dispatch,
profiling, the SDK, request options, message conversion and SSE settlement retain
their established objects, arrays and asynchronous work. None of those functions
changes. Source verification compares the complete generator AST after reverting
the single assignment and restricts all production differences to the generator,
the Cloudflare JSON and the manifest.

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
| Corrected regression cases | 22 pass, including 28 real adapter sends using an in-memory fetch substitute |
| Related catalog/pricing/profile tests | 75 pass |
| Complete suite | 253 execution units; 4,119 tests, 4,027 pass, 92 skip, 0 fail/cancel |
| ID expression, 20,000 executions for each revision | 0 object/array/closure/constructor sites in both; candidate calls `replaceAll` once per row |
| String work | One bounded ID replacement per generated Anthropic row; no additional request-time or delta-time ID conversion |
| Production runtime functions changed | 0 |
| Snapshot scope | Exactly 7 key/ID pairs; all other model fields, records and provider hashes preserved |
| Capabilities derived from old and new IDs | Identical for all 10 shipped Cloudflare Anthropic models |
| Request lifecycle, each revision | 6 sends and 6 payloads: direct/Simple × success/HTTP error/abort |
| Controlled GC after the caller error-stack boundary | All 54 monitored references released; 6 caller controllers, provider and model remain reachable |

The lifecycle comparison sends the original and corrected model metadata through
the same production provider; all runtime sources are proven unchanged. With
default cancellation, the retained caller controllers own their default abort
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
