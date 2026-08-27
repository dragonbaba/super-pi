# Model profiles and capability manifests

Every model published by `ModelRuntime` carries metadata describing where its profile came from and which optional provider features may be sent on the wire.

## Profile sources

| Source | Meaning |
| --- | --- |
| `built-in` | Versioned model data shipped with Super Pi. |
| `provider-catalog` | Model data returned by a provider or restored from its catalog cache. |
| `explicit-custom` | A model declared through `models.json` or an extension provider registration. |
| `conservative-fallback` | An unknown model ID using only the provider's unambiguous API adapter identity. |

`costKnown=false` distinguishes unknown pricing from a genuinely free model. Numeric cost fields remain zero for compatibility with existing accounting code, but consumers should display the price as unknown.

## Capability Manifest V1

`ModelCapabilitiesV1` records input modalities, serial/parallel tool behavior, strict schemas, streamed arguments, reasoning style, signature round-trip, prompt-cache mode, previous-response continuation, WebSocket continuation, deferred tools, remote compaction, and token limits.

Every manifest crosses `normalizeModelCapabilitiesV1()`: the complete V1 shape and cross-field invariants are validated, cloned, and deeply frozen. Input modalities, reasoning availability, context limits, and output limits must agree with the final legacy model fields. Invalid explicit custom manifests are rejected. Invalid provider-catalog cache manifests are discarded, safely rederived from catalog fields, and diagnosed.

The manifest is the gate for optional provider fields. Legacy model fields and `compat` settings are used to derive manifests for existing catalogs. Provider adapters may enrich built-in or catalog models with provider-owned facts such as Gemini/Mistral strict-schema support or the provider's reasoning mechanism; adapter request assembly does not infer those facts again from model IDs. An explicit custom model may provide the complete `capabilities` object in `models.json` or extension registration. Capability-affecting overlays without an explicit manifest rederive one from the final overlaid model, and provider/config/extension overlays carry `explicit-custom` provenance.

Provider-owned enrichment runs at every model ingress: shipped models, provider fetch callbacks, remote catalog fetches, offline catalog restoration, and the final OAuth/extension result. Catalog storage is revisioned raw provider data; locally derived manifests, provenance, diagnostics, and enrichment markers are rebuilt by the current provider profiler at restore time. Legacy entries without a revision, including caches that contain a previously derived V1 manifest, are migrated to raw storage and reprofiled safely.

OpenAI-compatible request assembly applies defaults, merges only non-structural generation keys from `samplingParams`, runs independent capability gates, then invokes `onPayload`. Messages/input/instructions, modern and legacy tool controls (`tools`, `functions`, `tool_choice`, `function_call`), web-search controls, reasoning/thinking, previous-response continuation, strict-schema controls, and cache protocol fields are never accepted from `samplingParams`. Chat and Responses adapters maintain protocol-specific reserved-key sets. `onPayload` is the only explicit final wire override and may deliberately replace gated fields; effective dispatch observation records that final override without retaining original payload text.

The authority fields are independent: `parallelTools`, `strictToolSchema`, `previousResponseId`, prompt-cache retention, signature round-trip, and remote compaction are each enforced even when their parent feature is otherwise enabled. `reasoning.mode` selects the provider wire mechanism (`levels`, `budget`, or `adaptive`); model IDs participate only when provider profiles are constructed. `thoughtSignatureRoundTrip=false` strips same-model thinking, text, and tool signatures, and `remoteCompaction=false` prevents provider-native compaction calls.

`streamedToolArguments` is observational metadata describing how tool-call arguments arrive in response streams. It is not a request gate and does not cause a protocol field to be sent.

## Unknown models

Unknown IDs no longer copy an arbitrary sibling model. A fallback is created only when the provider has an explicit API or exactly one catalog API. It uses:

- text input and ordinary streaming only;
- 32,768 context tokens and 4,096 output tokens;
- unknown pricing;
- no tool calling, reasoning, image/audio input, parallel tools, strict schemas, prompt cache, previous-response continuation, WebSocket continuation, deferred tools, or remote compaction.

If a provider has multiple possible APIs, declare the model explicitly instead of relying on fallback inference. Requested thinking levels are warned and clamped when the selected profile does not support them.

When `toolCalling=false`, the coding-agent keeps the user's active-tool selection in session state but builds a tool-neutral default prompt and sends no effective tool definitions. Prior tool calls/results are converted to ordinary text messages without tool roles, call IDs, signatures, or synthetic tool-result protocol. Switching back to a tool-capable model reuses the preserved active-tool selection.

## Reasoning levels

The user-facing levels remain `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` for compatibility. The manifest classifies the adapter mechanism as `none`, `levels`, `budget`, or `adaptive`, and its `reasoning.levels` array is the single source of truth for CLI, AgentSession, and adapter clamping. `thinkingLevelMap` only maps an already-supported level to a provider wire value.

## Conformance backlog

Two non-blocking cases remain explicitly tracked:

1. Heterogeneous custom cache markers need boundary-policy binding. A future `cacheBindingHash`, or ordered `{ anchor, retentionHash, policyHash }` entries, should detect policy swaps between unchanged anchors. Multiple system blocks may need `system:<ordinal>` identities. This does not affect built-in cache policies, whose markers share one policy.
2. Cache-marker binding must preserve marker multiplicity and stable forward identities when history is appended; it must not regress to absolute message indexes or `Set`-based deduplication.

Kimi deferred-tool carriers are covered by the Phase 3 adapter conformance suite: tool definitions embedded in tool-only system messages contribute to effective tool identity without contaminating the instruction fingerprint.
