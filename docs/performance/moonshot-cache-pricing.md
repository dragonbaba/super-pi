# Moonshot K3 default cache-write pricing

Baseline: `076c36f44946a5e7c0644e09cc9aa864fa9cbb40` (PR #98 merged).
Verified on Windows / Node 26.4.0, 2026-10-11 JST.

## Corrected task premise and scope

The historical [upstream change](https://github.com/earendil-works/pi/commit/a2eef9eb60fb44bf399532151b43dab83c0a9c88)
pinned K3 cache-write cost to zero. That premise conflicts with the current
official [international cache guide](https://platform.kimi.ai/docs/guide/context-caching)
and [China cache guide](https://platform.kimi.com/docs/guide/context-caching):
K3's default 5-minute write rate equals its ordinary input rate, while 1-hour
writes cost twice the input rate. The [Chat Completions contract](https://platform.kimi.ai/docs/api/chat)
defines cached, written and uncached input as disjoint buckets. Existing adapter
parsing already subtracts both read and write counts from total prompt tokens.
Setting the write rate to zero therefore underestimates default write costs.

The Moonshot generator now sets `kimi-k3` base and context-tier write rates to
their respective accepted input rates, after existing price conversion. No
other price, fallback or tier inheritance behavior changes. Non-K3 models,
resellers and Kimi Coding subscription estimates retain their own rates.

Only the two shipped `moonshotai` / `moonshotai-cn` K3 `cost.cacheWrite` values
change, from 0 to 3. The repository already expresses costs in USD per million
tokens; the public [models.dev catalog](https://models.dev/api.json) currently
reports 3/15/0.3/3 for both provider records. The China platform documents its
own CNY prices; this patch retains the existing repository currency convention
and does not introduce exchange-rate conversion.

The manifest updates only those two content hashes. Its complete-snapshot
timestamp, structure hash and all other 37 provider hashes remain unchanged.
Generation is deterministic from the existing records, without a live catalog
rewrite. Newer remote prices and explicit models.json/extension overrides retain
existing precedence. A newer remote overlay can therefore supersede this
built-in estimate; this PR does not migrate arbitrary persisted pricing.

This is T05.4.1, default 5-minute pricing. T05.4.2 separately tracks Moonshot's
1-hour response-header counters, which the adapter does not yet populate into
`usage.cacheWrite1h`. No 1-hour accounting, TTL parameter or request-capability
change is claimed here.

## Production chain and allocation ownership

models.dev input → Moonshot loader → `getModelsDevCost` → final metadata /
serialization → `flattenModelCatalog` / provider profile → remote-store restore
and catalog merge → explicit configuration → OpenAI Completions direct/Simple
dispatch → SDK response / SSE → `parseChunkUsage` → `calculateCost` → assistant
usage / completion, error or cancellation.

`getModelsDevCost` already transfers an owned base-rate object into its result.
Each accepted context tier has an existing owned rate object and the first tier
allocates one result array. The correction mutates only these owned rate fields,
not source facts or shared constants. With no tiers it adds one primitive
assignment; with tiers, one assignment per existing tier. No extra object,
array, closure, Promise, controller, string conversion, listener, timer, pool,
cache or retained input reference is introduced. The generated catalog owns its
result until serialization or owner release; no scratch storage is retained.

The complete generator AST matches the baseline after reversing just the cost
hoist and correction. The price helper and every production runtime source are
unchanged. Request options, SDK/parser objects, usage/cost objects and event
delivery still have their existing allocations; this is not a claim of zero
allocation for a full request or of a throughput improvement.

## Reproducible evidence

```sh
npm run check
npm run build:offline
node --experimental-strip-types --test tests/moonshot-cache-pricing.test.ts tests/model-catalog-pricing.test.ts tests/model-catalog-pricing-runtime.test.ts tests/model-cost-accounting.test.ts
node --expose-gc scripts/bench/moonshot-cache-pricing.mjs
npm test -- --jobs 4
```

| Check | Result |
| --- | --- |
| Baseline with the actual generator and shipped metadata | 15 of 18 tests fail, including real adapter usage costs |
| Candidate and related regressions | 18 Moonshot tests; 65 combined tests pass |
| Adapter coverage | 32 mock sends: two providers × generated/shipped × direct/Simple × mixed/all-hit/all-write/no-cache |
| Default usage conservation | 1,000 prompt + 100 completion tokens remain 1,100; writes are priced exactly once, and pure hits incur no write cost |
| Catalog isolation | Current/legacy restore, newer remote rates, explicit zero/custom overrides, non-K3, resellers and subscription estimates covered |
| Exact generation allocations, 10,000 conversions per revision | No tiers: 10,000 base objects, 0 arrays; two tiers: 30,000 objects, 10,000 arrays; baseline and candidate identical |
| New correction syntax | 0 object/array/closure/constructor/call sites; primitive field assignments and bounded existing-tier iteration only |
| Runtime function changes | 0 |
| Request lifecycle | 12 sends: two providers × direct/Simple × success/error/abort; all 96 monitored references released, 12 caller controllers and two providers held |
| Catalog lifecycle | Four current/legacy restores; all 16 model/cost/capability/merged-array references released after refresh/clear, four registries held |
| Type check, offline build, data integrity, diff whitespace | Pass |
| Complete test suite | 254 execution units; 4,142 tests, 4,050 pass, 92 skip, 0 fail/cancel |

The counter instruments the actual generator expression and price-helper AST,
including helper-owned tier allocations; it is not a reimplementation of the
price algorithm. These are exact application allocation-site executions, not
V8/SDK internal byte counts. Controlled GC uses a primitive fixture abort reason
so a caller-owned lazy Error stack cannot retain request frames. No production
cancellation behavior changes. Loopback/mock transports and synthetic credentials
are used; no live inference or billing acceptance was performed. Test-owned
configuration directories and store entries are released by recorded identity.
