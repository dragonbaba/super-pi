# Azure Foundry Chat Completions

F04.2 follows upstream v1.1.0 `abe508e1b89912adde45528136c3221eb69acdd7`.

## Design gate

The built-in Azure provider currently routes every model through Responses and
has no DeepSeek entry. Its persisted ID is `azure-openai-responses`. Keep that
ID, factory, auth lookup, default GPT selection and existing model keys. Add an
API map with the existing Chat Completions adapter and a Foundry DeepSeek V4 Pro
profile; no alias migration or second credential namespace is necessary.

Share endpoint/deployment resolution between Azure Responses and Chat request
setup. Existing endpoint priority is explicit base URL, environment base URL,
explicit resource name, environment resource name, then model base URL. Keep
Responses API-version handling. Chat uses the v1 OpenAI client without an
API-version query. Only the wire payload uses the deployment name: hooks,
assistant results and persisted sessions retain the catalog model identity.

The production chain is provider API-map dispatch -> existing lazy API ->
streamSimple/buildBaseOptions -> stream/createClient/buildParams -> onPayload ->
effective dispatch observation -> SDK -> existing delta parser -> event stream
-> agent partial/final delivery -> session persistence and interactive renderer.
The latter parser/event/consumer/release chain stays unchanged. Azure resolution
runs only at request setup; it adds one URL and the existing deployment-map
parse per request, with no model clone, extra stream, event-forwarding loop,
cache, pool, timer, listener or controller. Request locals leave with the request
on success/error/abort. Static catalog metadata belongs to the existing provider
owner. No hot-path allocation change or performance-improvement claim is made.

The generator must derive the Azure profile after native DeepSeek metadata, so
Foundry's low/medium/high effort dialect cannot be overwritten by native
DeepSeek high/max semantics. Update only the Azure snapshot and manifest; keep
all old Azure records and the original full-catalog generation timestamp.

Verification uses real SDK requests intercepted by offline fetch fixtures,
including legacy Responses, auth/settings/session keys, endpoint/deployment
priority, reasoning controls, payload hooks and failure/abort. Run focused
regressions, source invariants, typecheck and affected builds; no live provider
traffic or full local suite.

The request replay fixture also exposed a local capability boundary absent from
upstream: Chat thought signatures are stripped unless the provider declares
round-trip support. Foundry DeepSeek tool continuations then receive an empty
`reasoning_content`. Enrich this one known model at provider ingress (including
restored models), using the existing capability owner. Do not relax generic
signature filtering or alter other providers. The fixture must replay a tool
turn, since completed DeepSeek text-only turns intentionally omit reasoning.

## Verification

Windows / Node v26.4.0: the two initial regressions failed against `edb51ab2f`
before production changes. The final implementation passes 65 focused behavior
and ownership checks (eight Azure groups plus sampling, capability context,
capability matrix, stream ownership and Together generator regressions), four
source invariants, repository typecheck, AI offline build, and coding-agent/server
builds. The Azure
groups were rerun after correcting a fixture snapshot comparison to account for
non-serializable capability symbols; the other 57 checks had already passed.

```text
node --experimental-strip-types --test tests/azure-foundry.test.ts tests/sampling-params.test.ts tests/model-capability-context.test.ts tests/provider-contract/model-capability-matrix.contract.test.ts tests/provider-contract/streamed-tool-argument-ownership.contract.test.ts tests/together-models.test.ts
node --experimental-strip-types --test tests/azure-foundry.test.ts tests/source-invariants.test.ts
npm run check
npm run build:offline --workspace @super-pi/ai
npm run build --workspace @super-pi/coding-agent
npm run build --workspace @super-pi/server
```

The real generator runs with fixture-owned HTTP/filesystem effects and produces
the same Foundry compatibility, thinking map and cost record as the shipped
snapshot. All 38 legacy Azure model records remain unchanged. Real SDK fetch
fixtures cover direct/simple/provider/registry routing, root and proxy URLs,
deployment precedence, headers, final payload overrides, tool reasoning replay,
stored credentials, old settings/session selection, missing/invalid endpoints
and pre-dispatch cancellation. No synthetic key leaves the fixture.

Static diff audit: zero added delta/event wrappers, per-delta promises,
controllers, timers or caches. The only added retained state is the one static
model profile and its immutable capability enrichment; old profiles retain
their identity through the existing provider cache. Endpoint URL/map objects
are request-local and no reference escapes to global storage. Tests clear the
registry and in-memory credential store; all commands exit normally. No new
background process or resource requires cleanup. There is no changed hot path
to allocation-benchmark, and no allocation/GC improvement is claimed.

Raw local evidence is in `.git/f04-2-azure-foundry-20261012/`. Linux behavior and
the full suite are left to required CI; live Azure access, regional pricing
validation and a global install update are not part of this offline check.
