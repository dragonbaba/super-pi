# Sampling parameters by thinking level

F04.1 follows the fixed upstream v1.1.0 snapshot
`abe508e1b89912adde45528136c3221eb69acdd7`. Azure provider naming and
Chat Completions support are a separate task.

## Design gate

The current model schema/composer has only `samplingParams`; request preparation
never selects a level-specific record. A model with default temperature 1 and
`samplingParamsByThinkingLevel.high.temperature = 0.6` therefore sends 1 even
when low is clamped to high. Direct adapter calls also omit model defaults.
Offline payload-capture fixtures exercise the actual adapters before dispatch.

Composition order is model defaults, the effective Pi thinking level, then
request sampling keys. The existing named-field precedence, structural-key
filter, capability sanitizer and final `onPayload` authority stay in place.
`modelOverrides` merges each level per key after the existing model/extension/
OAuth layers. OAuth projections must receive a deep copy of the new metadata.

The changed execution sites are model configuration load/composition and request
initialization: `streamSimple -> buildBaseOptions -> stream -> buildParams ->
mergeSamplingParams -> sanitizeCapabilityRequest -> onPayload -> SDK request`.
Direct `stream` enters the same request builder. Responses summary-only requests
select medium; unsupported levels are clamped using the capability manifest,
before looking up Pi keys, independently of provider wire-value mapping.

These are request setup operations, not provider-delta, event, rendering, frame,
or large-result processing. The existing context estimator and all downstream
stream consumers remain unchanged. There is no new per-delta/frame allocation,
cache, pool, timer, listener, controller or background resource. Configuration
owns at most seven optional level records per model; their size follows the
existing free-form sampling configuration. Request-local merged records contain
only the union of the three selected inputs and leave with request options on
completion/failure/abort. The simple entry point and direct adapter both resolve
defaults (at most two temporary records per simple request, one per direct
request); they retain no global references. Model replacement releases old
configuration through the existing owner. No hot-path allocation exemption or
performance-improvement claim is needed.

## Verification

On Windows / Node v26.4.0, all eight new regression groups failed against
`494e790145b20fd7e55927143d0b82f3566817b4`, before production edits. The final
initial candidate passes 65 related behavioral checks plus four existing source
invariants:

```text
node --experimental-strip-types --test tests/sampling-params.test.ts tests/model-profile.test.ts tests/model-capability-context.test.ts tests/provider-contract/model-capability-authority.contract.test.ts tests/provider-contract/model-capability-matrix.contract.test.ts tests/request-input-estimate.test.ts
node --experimental-strip-types --test tests/source-invariants.test.ts
npm run check
npm run build:offline --workspace @super-pi/ai
npm run build --workspace @super-pi/coding-agent
npm run build --workspace @super-pi/server
```

Coverage includes three real adapter payload builders through simple and direct
entry points, default/level/request precedence, clamping, off, absent levels,
provider aliases, explicit zero/null, summary-only Responses, structural-key
filtering, and ignored sampling keys on Anthropic. Configuration fixtures check
custom declarations, extension replacement, final per-key user overrides and
invalid values. Existing profile tests prove nested OAuth metadata mutations do
not reach the base catalog. An existing fetch fixture verifies the final
`onPayload` override still wins and reaches effective dispatch observation.

The server's compile-time model-field accounting explicitly keeps the new
sampling metadata server-side, matching existing sampling defaults. The change
does not add a public protocol field.

Raw logs are in `.git/f04-1-thinking-sampling-20261012/`. Fixture directories are
owned by `mkdtemp` and removed by the registered test cleanup; all local checks
completed and no persistent process was started. Tests use synthetic keys and
intercept dispatch; no real provider request was sent. The local full suite and
unrelated TUI/frame benchmarks were not run because this changes request setup,
not a streaming hot path. Shared CI and review must correspond to the final PR
head before merge.

## Review follow-up design gate

The initial review identified a direct-Responses mismatch when the capability
manifest excludes `off`: sampling clamps to high, but the request builder maps
implicit off to the wire value `none`, which the sanitizer cannot clamp back.
The same root cause also affects direct Chat requests before provider mapping.
The regression fixture uses a manifest supporting only high, provider-specific
low/high aliases, omitted effort, explicit low, and Responses summary-only calls.
The correction must clamp before wire mapping and use that effective level for
sampling. Changes remain in request builders, with no delta-loop changes. Chat
may copy options once at request setup if the effective effort differs, so all
existing format-specific branches and thinking budgets see the same value;
the copy has the request lifetime and does not mutate caller options.

All three new adapter regression groups failed before this correction (Chat
omitted effort; Responses and Azure emitted `none`). After correction, 43
sampling/capability checks and 18 adjacent Together/source checks pass, along
with typecheck and the AI offline build. Unchanged configuration/profile and
request-estimation tests retain their earlier passing result. The changed
request-setup functions remain outside delta/observer/frame loops. Evidence:
`review-baseline.log`, `review-tests.log`, and `review-adjacent.log` in the same
local evidence directory.
