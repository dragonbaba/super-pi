# pi-openai-server-compaction

This is a Pi extension which adds **Codex-style remote compaction** for OpenAI models, giving you better continuity across compaction boundaries while preserving all of Pi's normal features.

What does that mean? Why would you want it? My impression has been that Codex compacts better than Claude Code and better than Pi. And I supposed this was because Codex compacts by using OpenAI's server-side Responses compaction protocol. That protocol sends a `compaction_trigger` through `POST /v1/responses` and receives an encrypted `compaction` item. This extension configures Pi to use that protocol for OpenAI models alongside Pi's native compaction logic.

But is Codex's compaction _actually_ better? Since the OpenAI compaction endpoint compacts to encrypted binary blobs, no one can say what it is doing under the hood. However, we don't need to know how it works to determine if it works better. Anyone can call the endpoint. And since codex is an open source, we can mimic exactly how codex itself uses the endpoint. That is what this extension configures Pi to do.

So is native compaction better? For the user-facing comparison I care about,
the evidence says yes, with important price and reliability qualifiers. A
held-out benchmark of the real product defaults found 78.0% exact recall for
this extension's native policy versus 48.0% for Pi's default compactor; full
context scored 100%. Native did this while emitting 4.58x as many compaction
output tokens and leaving a 29% larger billed downstream context. It preserved
much more old state, but this is not evidence that it is better at the same
token budget.
Native was also highly variable: every large artifact scored perfectly, while
three small artifacts performed about as poorly as Pi.

Strictly, this directly compares Pi with this extension's reconstruction of
Codex-style compaction, not with an end-to-end run of the Codex CLI. The result
also does not show that the endpoint reliably detects when more capacity is
needed: its short artifacts were the failures. What it does show is that the
native default sometimes allocates far more context, and those large-allocation
runs drove its aggregate advantage.

An earlier benchmark reported 100% native recall versus 82.8% and 76.7% for two
text summaries at apparently matched downstream sizes. That procedure first
observed native's output usage and then imposed it as the text arm's maximum,
which is asymmetric and can favor native. Its same-budget interpretation is
therefore superseded. See the pinned [product-defaults report](https://github.com/algal/pi-openai-server-compaction/blob/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/benchmarks/product-defaults/REPORT.md)
and [reproduction instructions](https://github.com/algal/pi-openai-server-compaction/blob/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/benchmarks/product-defaults/README.md). The
[older matched-cap report](https://github.com/algal/pi-openai-server-compaction/blob/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/benchmarks/native-vs-text/REPORT.md) remains retained
  with a methodological correction. This installed package intentionally keeps
  the evidence out of the runtime payload; the links below are pinned to the
  audited upstream commit so the reports, harnesses, and raw records remain
  reproducible after `main` changes.

None of this proves the encrypted blobs use a clever latent-space
representation. They might be encrypted optimized text or structured state
values. (A little reverse engineering suggests the blobs are produced through
a textual prompt, for what it is worth:
https://x.com/alexisgallagher/status/2042396986327060736?s=20 .)

> **Status:** experimental but live-tested against real Pi + real OpenAI backends.
> Recommended rollout: install project-local first, use for a week, keep rollback easy.

## Support matrix

| Provider/model family | Remote compaction           | `previous_response_id` continuity | Custom WS stream                 | Live-tested |
|-----------------------|-----------------------------|-----------------------------------|----------------------------------|-------------|
| `openai/*`            | Yes                         | Yes                               | Yes                              | Yes         |
| `openai-codex/*`      | Yes                         | No (built-in transport retained)  | No (built-in transport retained) | Yes         |
| Azure                 | Partial (opt-in via config) | Partial                           | No                               | No          |

## Install

Project-local (recommended):

```bash
pi install -l git:github.com/algal/pi-openai-server-compaction
```

Global:

```bash
pi install git:github.com/algal/pi-openai-server-compaction
```

One-shot, non-persistent:

```bash
git clone https://github.com/algal/pi-openai-server-compaction.git
cd pi-openai-server-compaction && npm install
superpi -e ./packages/openai-server-compaction/src/index.ts --model openai/gpt-5.6-luna
```

## Requirements

- Node `>= 22`
- Pi `>=0.84.0 <0.85.0`
- Auth/config for the model you want to use must already work in Pi
- A supported OpenAI Responses model, e.g. `openai/gpt-5.6-sol` or `openai-codex/gpt-5.6-sol`

## What it does

On compaction, the extension requests Responses compaction v2 through `/v1/responses` in parallel with generating a portable Pi text summary. If and only if the server returns an explicit pre-output 400/404 saying `compaction_trigger`/`remote_compaction_v2` is unsupported, it retries once through unary `/v1/responses/compact`; generic HTTP errors, rate limits, aborts, timeouts, and failures after streaming begins never issue that second request. This gives you both:

- **An OpenAI-native opaque compaction artifact** for high-fidelity continuity on compatible future turns
- **A portable Pi text summary** so non-OpenAI models, session exports, forking, and tree navigation keep working

For direct `openai/*` models between compactions, the extension also:

- Patches requests with `store: true` and `context_management`
- Uses `previous_response_id` for live continuation when safe
- Provides a WebSocket-backed transport path with HTTP fallback

For `openai-codex/*` models, the extension preserves the built-in Codex transport and only injects reconstructed remote compaction history after compaction boundaries.

## How compaction works

On Pi compaction events for supported models, the extension:

1. Generates a **portable Pi continuation checkpoint** from only the prefix Pi will discard. The request reuses the normal system/tool/message prefix for prompt-cache locality, excludes the retained tail, and falls back to Pi's built-in compactor and then a bounded deterministic checkpoint when no custom summary instructions are present.
2. Calls `POST /v1/responses` with the current effective conversation context (not superseded pre-compaction JSONL history), a trailing `compaction_trigger`, system prompt, tools, reasoning config, text config, and the effective request tier: the current process-local Fast override first, then the last observed base `service_tier`; the narrow unsupported-protocol case falls back to `POST /v1/responses/compact`
3. Retains recent user messages within Pi's intentional 20K-token replay budget measured with the GPT-family `o200k_base` BPE tokenizer (using code-point-safe bounded chunks), replacing retained inline images with a fixed text marker so Base64 payloads cannot bypass that budget, and stores them with the returned opaque `compaction` item in `CompactionEntry.details.remoteCompaction`
4. Aggregates reported portable-summary and remote-compaction usage on Pi's compaction entry so session statistics and footer totals include billed work
5. After automatic threshold compaction, queues at most one hidden follow-up only when the last assistant response was reliably truncated (`length`)

A normal final response with `stopReason: "stop"` or an ordinary `toolUse` never triggers another turn. Continuations are deduplicated by compaction entry and cannot recursively continue an auto-continuation. The hook also does **not** run for manual `/compact`, Pi-owned overflow retries, or sessions with an active `pi-goal` goal.

The compaction request mirrors the shape of surrounding normal requests (reasoning effort, text settings, tool definitions) rather than using endpoint defaults.

## Safety

The extension clears live continuation state on: session start/reload/resume, switch/fork, tree navigation, compaction completion, model selection, shutdown, and an explicit `/provider-refresh` command.

`/provider-refresh` waits until the current agent is fully idle, then closes only the current session's WebSocket and clears only its live `previous_response_id` / transport baseline. It does not change Pi's local JSONL history, persisted or reconstructed remote-compaction replay, observed request-shape settings, or project configuration. The next provider request starts a fresh transport flow from the appropriate local history.

Remote compaction history is only replayed for compatible models. Cross-model turns are filtered from reconstructed replay history to prevent contamination after resume or tree navigation.

## Data handling

Users should be aware:

- For direct `openai/*` models, the extension sets `store: true` on requests, meaning OpenAI retains conversation data server-side
- Conversation context is sent to OpenAI's Responses compaction protocol
- Returned opaque compaction artifacts are stored in Pi's local session JSONL
- These artifacts are provider-native and not human-readable
- Codex compaction uses the same session, client-request, routing, originator, and Pi user-agent identity contract as a regular Pi Codex request. It does not create or read `CODEX_HOME/installation_id`, add compaction-only `client_metadata`, or emit turn/window/thread identity headers that regular Pi requests do not send.
- Provider request previews run the normal context/request transformation waterfall with `dryRun: true`; handlers must return the same deterministic transformation without external or durable side effects.
- Optional `shapeDiagnostics` (or `SP_OPENAI_SERVER_COMPACTION_SHAPE_DIAGNOSTICS=1`) stores only bounded SHA-256 component hashes for regular/compaction payload components and the actual outgoing compaction identity/routing headers. It does not claim to observe regular transport headers at runtime; regular-vs-compaction header parity is verified by the offline transport integration test. Diagnostics are disabled by default and never store raw prompts, schemas, headers, URLs, credentials, or cache keys.
- Malformed JSON in a successful remote-compaction SSE stream is a protocol failure; it is never skipped in favor of later events.
- For GPT-series models, authentication, request-preview, provider-native compaction, or required portable-summary failure appends a `failed_closed` `compaction-telemetry-v1` entry, shows the bounded raw reason only in the transient UI error, and explicitly returns `{ cancel: true }` so Pi cannot run default local compaction. Persisted telemetry contains only model, fixed strategy, stage/reason enums, a privacy-safe `failureClass`, and producer version. Non-GPT models retain the previous fallback behavior. The existing tool-repair aggregate consumes these entries; this package creates no telemetry store. Raw errors, prompts, summaries, responses, URLs, headers, credentials, and cache keys are excluded. Telemetry persistence failures are swallowed and do not weaken GPT cancellation.

## Configuration

Config is read from:

- `~/.sp/agent/config/openai-server-compaction.json` (global)
- `.sp/config/openai-server-compaction.json` (project-local, takes precedence only when `ctx.isProjectTrusted()` is true)

Project config is resolved from the active session's `ctx.cwd`, not the process working directory. Because Pi's provider registration API has no session context at extension-load time, the OpenAI provider wrapper is registered once but delegates unchanged to Pi's built-in HTTP stream whenever the trusted per-session configuration has `enabled: false`. This avoids project-config leakage and preserves normal provider behavior when disabled.

Codex Fast state is read from a fail-closed, versioned process-global contract shared with `@super-pi/openai-fast-mode`; this extension never rereads `pi-openai-fast.json` on the compaction path. Missing, malformed, or unknown state means no Fast override. The persisted JSON is only the next process/reload default. This contract assumes Pi 0.84.x has one active `AgentSessionRuntime` per process and must be redesigned for concurrent embedded runtimes.

```json
{
  "enabled": true,
  "includeAzure": false,
  "thresholdRatio": 0.7,
  "compactThreshold": 0,
  "usePreviousResponseId": true,
  "notify": false,
  "autoContinueAfterThreshold": true,
  "portableSummaryModel": "current"
}
```

`portableSummaryModel` is a model ID from the active provider. The default, `"current"`, maximizes prompt-cache reuse. A cheaper same-provider model may reduce summary cost, but is selected only when its context window can hold the current compaction input plus the summary output budget; otherwise the active model is used. This setting never selects a model from another provider.

Environment overrides:

| Variable                                           | Effect                                                      |
|----------------------------------------------------|-------------------------------------------------------------|
| `SP_OPENAI_SERVER_COMPACTION_ENABLED`              | Enable/disable the extension                                |
| `SP_OPENAI_SERVER_COMPACTION_AZURE`                | Include Azure OpenAI models                                 |
| `SP_OPENAI_SERVER_COMPACTION_THRESHOLD`            | Explicit compact threshold (tokens)                         |
| `SP_OPENAI_SERVER_COMPACTION_RATIO`                | Compact threshold as ratio of context window (default: 0.7) |
| `SP_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID` | Enable/disable `previous_response_id`                       |
| `SP_OPENAI_SERVER_COMPACTION_NOTIFY`               | Show UI notifications when features activate                |
| `SP_OPENAI_SERVER_COMPACTION_AUTO_CONTINUE`        | Continue once after automatic threshold compaction (default: true) |
| `SP_OPENAI_SERVER_COMPACTION_SUMMARY_MODEL`        | Same-provider model ID for portable summaries (default: `current`) |

## Provider flow refresh

If the current OpenAI provider flow appears stale after a transport error or an expired WebSocket, run:

```text
/provider-refresh
```

The command preserves the current session and conversation. It deliberately causes the next direct OpenAI request to establish a new provider flow rather than reusing the prior live continuation.

## Troubleshooting

If something goes wrong:

1. **Refresh provider flow:** run `/provider-refresh` to reset only the current session's live transport/continuation
2. **Quick disable:** set `SP_OPENAI_SERVER_COMPACTION_ENABLED=0` or add `"enabled": false` to config
3. **Bypass entirely:** run Pi with `--no-extensions`
4. **Reload:** run `/reload` in Pi to re-initialize extensions
5. **Uninstall:** `pi remove pi-openai-server-compaction`
6. **Inspect:** check your session JSONL for `compaction` entries with `details.remoteCompaction` to see if remote compaction was recorded

## Testing

Smoke test (offline, verifies imports and key algorithms):

```bash
npm run smoke
```

Live end-to-end test (requires working Pi + OpenAI auth):

```bash
npm run test:live
```

Override the test model:

```bash
SP_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.6-sol npm run test:live
```

The focused cache-rewarm matrix is intentionally kept outside this installed package and every Pi auto-load path. Run it explicitly from `~/.sp/agent/experiments/codex-cache-tail/` when live evidence is needed; see that folder's README. It consumes quota and can wait in real time for idle-window cells. Normal Pi never discovers or imports the observer.

## Limitations

- Pi's local JSONL/tree model remains authoritative
- Empty portable model output is never replaced by a metadata-only “remote compaction applied” checkpoint; automatic compaction retains the latest user goal deterministically if both model summary paths fail
- Opaque remote compaction artifacts are only reused for compatible OpenAI Responses turns
- Switching to a different provider/model falls back to Pi's text-summary portability path
- Outside an active `/goal`, Pi has no authoritative semantic task-completion state. Automatic continuation therefore uses only reliable `length` truncation evidence; ordinary `toolUse` and clean `stop` responses are not treated as stranded. Use `/goal` when a long task must keep running until explicit verified completion.

## Repo layout

| File                                       | Purpose                                                           |
|--------------------------------------------|-------------------------------------------------------------------|
| `src/index.ts`                             | Extension wiring, compaction hook, lifecycle handling             |
| `src/remote-compaction.ts`                 | Responses compaction v2 integration and replacement-history handling |
| `src/openai-ws-stream.ts`                  | WebSocket continuation path                                       |
| `src/openai-ws-connection.ts`              | WebSocket connection manager                                      |
| `src/openai.ts`                            | Model detection and payload patching                              |
| `src/custom-stream.ts`                     | Provider override entrypoint                                      |
| `src/config.ts`                            | Configuration loading                                             |
| `src/state.ts`                             | Ephemeral per-session runtime state                               |
| `src/stream-message-shared.ts`             | Shared assistant message builders                                 |
| `tests/live/openai-compaction-rpc-live.ts` | Live Pi RPC regression test                                       |
| [Pinned product-defaults evidence](https://github.com/algal/pi-openai-server-compaction/tree/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/benchmarks/product-defaults) | Current default-vs-default benchmark; source-repository evidence, not shipped in this package |
| [Pinned native-vs-text evidence](https://github.com/algal/pi-openai-server-compaction/tree/8a3de2f3b0c178fdd6f73f2f94172dfc3943e466/benchmarks/native-vs-text) | Earlier matched-cap benchmark; source-repository evidence, not shipped in this package |
| `ARCHITECTURE.md`                          | Design and control-flow documentation                             |
| `TESTPLAN.md`                              | Manual and automated test plan                                    |
| `CHANGELOG.md`                             | Version history                                                   |

## License

MIT. See `LICENSE.md`.
