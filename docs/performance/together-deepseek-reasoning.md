# Together DeepSeek V4 Pro 0813 reasoning metadata

Baseline: `eaa63e4df7375df340659128d7c898bf17369e6d` (PR #96 merged).
Measurement: Windows, Node 26.4.0, 2026-10-11 JST.

The generator previously recognized only `deepseek-ai/DeepSeek-V4-Pro`. The
existing `-0813` record therefore disabled `supportsReasoningEffort`, so requests
omitted the selected effort. [Together's documentation](https://docs.together.ai/docs/deepseek-v4-quickstart)
specifies the renamed ID, `high`/`max`, and the `reasoning.enabled` switch.
Super Pi requires an explicit `max` mapping to expose that level. The new ID
receives those controls; the existing legacy, Flash and GPT-OSS rules are retained.

The generator recognizes the exact ID and creates one thinking map per model.
The shipped record was regenerated with the actual generator using its frozen
existing name, price, limits and modalities; only its reasoning metadata changed.
All other model records and the other providers' manifest hashes were checked
unchanged. The existing manifest utility updates the Together hash while retaining
the complete snapshot's original generation timestamp. A one-record correction
does not establish freshness for other records, including those in Together.

## Production chain and ownership

`models.dev` input → `getTogetherCompat` / `getTogetherThinkingLevelMap` → final
metadata overrides → JSON → `flattenModelCatalog` / `togetherProvider` /
`createProvider` → capability derivation / `getSupportedThinkingLevels` →
`streamSimple` clamp → `stream` / `buildParams` Together branch → capability
sanitization → HTTP SSE → done/error/abort → event stream settlement.

Generation and model profiling occur at catalog ingress. Catalogs own the model
and thinking map; request parameters belong to one request until settlement.
The new generator constant map has module lifetime, and the finite ID set gains
one entry. No new runtime cache, pool, listener, controller, timer or worker exists.
The runtime change in behavior is an existing primitive `reasoning_effort`
assignment becoming enabled. The pre-existing request reasoning wrapper and
sanitization copy remain; this is not a zero-allocation request path.

Remote catalog merge/restore and user override implementations are unchanged.
Regression coverage verifies corrected current/legacy cached profiles and rejects
an older broken overlay using the existing local-generation timestamp check.
The freshness chain is manifest → `getBuiltinModelDataGeneratedAt` →
`ModelRuntime.create` → `withRemoteCatalog.remoteModels` → profile/merge → snapshot.
Advancing the shared timestamp during a partial repair incorrectly discarded
intervening remote updates. The repair preserves that cutoff. The probe exercises
the actual `ModelRuntime` with an unchanged OpenAI row and Together Flash row:
four current/legacy cache restores, four HTTP 200 responses (including repeat
Last-Modified values), and two HTTP 304 revalidations keep the intervening updates.
It also checks the snapshot timestamp and all 38 unrelated provider hashes against
the fixed baseline. The pre-fix runtime probe failed by restoring the built-in GPT-4
record instead of the remote update; the separate timestamp invariant failed too.
A newer external catalog remains authoritative under the existing merge policy;
this change does not rewrite arbitrary future external metadata or user overrides.

## Reproducible allocation and release checks

Run from the repository root:

```sh
npm run check
npm run build:offline
node --expose-gc scripts/bench/together-reasoning.mjs
node --experimental-strip-types --test tests/together-models.test.ts
npm test -- --jobs 4
```

Build first: the runtime imports the built AI package, and the probe rejects a
stale built manifest. Its local catalog HTTP server is closed in `finally` and
fixture store entries are deleted on success or assertion failure.

The probe checks twelve runtime files against the fixed baseline, instruments the
actual generator helpers and the exact Together parameter branch with TypeScript
AST counters, then exercises real `streamSimple` with an in-memory HTTP substitute.

| Scope | Baseline → candidate |
| --- | --- |
| Generator module initialization | 8 → 9 object literals; 3 arrays, 3 `new` expressions, 0 closures in both |
| 10,000 helper pairs for the renamed model | 10,000 → 10,000 objects; 0 arrays, closures or `new` expressions |
| 10,000 Together parameter branches, separately for off/high/max | 10,000 → 10,000 reasoning wrappers; 0 arrays, closures or `new` expressions |
| Runtime source | 12 files byte-equivalent after line-ending normalization, including both timestamp consumers |
| Request lifecycle | 9 payload preparations, 9 mock sends; 63 WeakRefs released, 0 retained |

Lifecycle cases cross off/high/max with success, HTTP error and cancellation.
Caller-owned controllers (9) and the shared catalog model stay reachable while
contexts, message arrays, options, payloads, reasoning wrappers, streams and
results are collected. The probe counts application syntax sites, not V8/SDK
internal allocation. The isolated branch counter is not a complete request cost
estimate; the unchanged call chain still performs its established work. No CPU
or throughput improvement is claimed, and no live provider inference was made.
