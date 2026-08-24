# @super-pi/provider-aware-compaction

A narrowly scoped, fail-closed Pi 0.84 compaction policy extension for providers whose default high-density summaries are empty, unstable, or too short.

## Default policies

| Active model | Summary model | Policy |
|---|---|---|
| `superapi-claude/*` | `deepseek/deepseek-v4-flash` | Cross-provider fallback with exact-state preservation |
| `deepseek/deepseek-v4-flash` | self | Original system/tools/message prefix replay plus one trailing compaction instruction; current mapped thinking level |
| `kimi-coding/k3-256k` | self | Same-provider preservation focus and a 32K reserve (26,214-token summary cap) |

All other models—including xAI Grok and DeepSeek V4 Pro—are untouched.

Every policy cancels compaction when its summary model is missing, unauthenticated, errors, or returns an empty summary. It never writes an empty checkpoint and does not affect OpenAI/Codex remote compaction.

Only the superapi Claude policy routes the summarized history prefix to another provider. DeepSeek and Kimi remain same-provider.

## DeepSeek original-prefix replay

For DeepSeek Flash self-compaction, the extension reconstructs the discarded head directly from Pi's active compaction-aware Session entries, converts it with Pi's normal message converter, reuses the current effective system prompt and active tool schemas in active order, and appends exactly one final user compaction instruction. It calls the same OpenAI-compatible adapter with the current Session ID and does not set `cacheRetention: "none"`, allowing the provider's existing KV prefix to be reused.

The path is scoped to `deepseek-self-preserve-v1`. Claude→DeepSeek cross-provider fallback and Kimi keep the existing standalone-summary request because they cannot reuse the active DeepSeek prefix under the same policy. A missing cut boundary or active tool schema cancels compaction fail-closed.

No request, prompt, message, tool schema, response, URL, header, credential, or cache-key body is persisted or emitted. Prefix objects exist only for the compaction call and are released afterward; there is no request-history cache, listener, timer, or resume/branch state. Session reload and branching reconstruct from their own active append-only branch.

Exact replay is defined at Pi's normal Session→LLM conversion boundary. An extension that performs a model-visible `context` rewrite not represented in Session remains outside this compatibility guarantee; this package does not retain provider payload bodies merely to mask that boundary.

## Project data boundary

Cross-provider summarization is denied by default. A trusted project must explicitly opt in with `.super-pi/provider-aware-compaction.json`:

```json
{
  "allowCrossProviderSummary": true
}
```

Missing, invalid, false, or untrusted project configuration cancels Claude compaction fail-closed; it does not silently fall back to the known empty-summary path. This does not disable same-provider DeepSeek or Kimi policies. For an explicitly approved one-process run, set `SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER=1`; set it to `0` for a process-wide denial.

## DeepSeek effort metadata

`~/.super-pi/agent/models.json` supplies the official V4 effort mapping via `modelOverrides`:

- Flash: `low→low`, `high→high`, `xhigh→high`, `max→max`
- Pro: `low/high→high`, `xhigh/max→max`
- `minimal` and `medium` are unsupported; Pi clamps a global `medium` selection upward to `high`

This package currently intercepts only V4 Flash because V4 Pro has not been benchmarked.

## Configuration

Environment variables are read once when the extension loads:

- `SP_PORTABLE_COMPACTION_FALLBACK=0`: disable all extension policies (stock Pi compaction resumes).
- `SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER=1`: explicitly approve cross-provider summarization for this process.
- `SP_PORTABLE_COMPACTION_ALLOW_CROSS_PROVIDER=0`: deny cross-provider summarization for this process.
- `SP_PORTABLE_COMPACTION_TARGET_PROVIDER`: replace built-in selection with one custom target provider.
- `SP_PORTABLE_COMPACTION_FALLBACK_MODEL`: custom fallback `provider/model`; default `deepseek/deepseek-v4-flash`.

## Evidence

Retained 50K-token product-defaults pilots, 15 held-out questions:

- Opus 5 Pi default: empty summary; retained tail only, 5/15.
- Opus 5 → DeepSeek preservation fallback: 15/15.
- DeepSeek Flash High self-preservation, independent seed 302: 15/15.
- Kimi K3 256K default: 6/15.
- Kimi self-preservation at the default 13,107-token cap: 10/15.
- Kimi self-preservation with 32K reserve, independent seed 302: 15/15.
- Grok 4.5 native Pi compaction: 14/15; intentionally untouched.

These pilots establish feasibility and guardrails; they are not broad statistical claims. Reproducible artifacts are under `~/.super-pi/agent/experiments/cross-provider-compaction-baseline/`.

## Bounded fallback telemetry

On cancellation only, the extension best-effort appends `compaction-telemetry-v1` with the active model, policy enum, `cancelled` outcome, bounded reason enum, and producer version. The existing `tool-input-repair-telemetry` aggregate consumes this entry; this package owns no telemetry database. Successful compactions are counted from Pi's persisted compaction entry, so success is not double-counted. Telemetry append failures are swallowed and cannot weaken fail-closed behavior. Prompt/summary text, provider errors, URLs, headers, credentials, cache keys, and raw responses are never included.

## Verification

```bash
npm test
npm run benchmark:prefix
```

The localhost E2E sends a synthetic regular request and compaction request through the same installed OpenAI-compatible adapter, then proves the latter's serialized system/tool/message sequence begins with the former and has one trailing compaction instruction. The benchmark uses only synthetic fixtures and reports median/p80, retained heap, and a body-free behavior hash.

The package is version-gated to Pi 0.84.x. Re-audit before widening its model or version gates.
