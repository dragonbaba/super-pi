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

The manifest is the gate for optional provider fields. Legacy model fields and `compat` settings are used to derive manifests for existing catalogs. An explicit custom model may provide the complete `capabilities` object in `models.json` or extension registration. Provider adapters still allow `onPayload` to replace the assembled request; that callback is an explicit effective-wire override.

## Unknown models

Unknown IDs no longer copy an arbitrary sibling model. A fallback is created only when the provider has an explicit API or exactly one catalog API. It uses:

- text input and ordinary streaming only;
- 32,768 context tokens and 4,096 output tokens;
- unknown pricing;
- no tool calling, reasoning, image/audio input, parallel tools, strict schemas, prompt cache, previous-response continuation, WebSocket continuation, deferred tools, or remote compaction.

If a provider has multiple possible APIs, declare the model explicitly instead of relying on fallback inference. Requested thinking levels are warned and clamped when the selected profile does not support them.

## Reasoning levels

The user-facing levels remain `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` for compatibility. The manifest classifies the adapter mechanism as `none`, `levels`, `budget`, or `adaptive`; `thinkingLevelMap` performs the final provider-specific value mapping. A `null` map entry marks a level unsupported.

## Conformance backlog

Two non-blocking cases remain explicitly tracked:

1. Heterogeneous custom cache markers need boundary-policy binding. A future `cacheBindingHash`, or ordered `{ anchor, retentionHash, policyHash }` entries, should detect policy swaps between unchanged anchors. Multiple system blocks may need `system:<ordinal>` identities. This does not affect built-in cache policies, whose markers share one policy.
2. Cache-marker binding must preserve marker multiplicity and stable forward identities when history is appended; it must not regress to absolute message indexes or `Set`-based deduplication.

Kimi deferred-tool carriers are covered by the Phase 3 adapter conformance suite: tool definitions embedded in tool-only system messages contribute to effective tool identity without contaminating the instruction fingerprint.
