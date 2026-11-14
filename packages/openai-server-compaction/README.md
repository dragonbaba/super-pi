# pi-openai-server-compaction

This is a Pi extension which adds **Codex-style remote compaction** for OpenAI models, giving you better continuity across compaction boundaries while preserving all of Pi's normal features.

Current Super Pi hosts select this package through the native compaction strategy registry. Model/configuration matching happens before candidate authentication, preview or summary requests. If another native policy also matches, compaction stops with a conflict instead of choosing by extension load order. Disable the unwanted policy explicitly; this selection does not grant permission to send history to another provider. Legacy `session_before_compact` hooks keep compatibility priority for cancellation or custom results. Hosts without the registry retain the old hook path and its ordering limitations.

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
- Super Pi `^1.0.0` or legacy `>=0.84.0 <0.85.0` with `pi.setCodexRemoteCompactionEnabled(boolean)` and `pi.setOpenAIResponsesStream(...)`. A version number alone is insufficient: hosts without these APIs are disabled before command or hook registration, with an upgrade notice.
- Auth/config for the model you want to use must already work in Pi
- A supported OpenAI Responses model, e.g. `openai/gpt-5.6-sol` or `openai-codex/gpt-5.6-sol`

Codex request intent belongs to the host runtime. This extension publishes its configured `enabled` value on `session_start` and `session_tree`, and revokes it before transitions and on shutdown. The host API is available after extension loading; call it from a lifecycle hook such as `session_start`. Model capability checks and successful-request validation remain separate. The former global Symbol registry is no longer used; update the host and extension together.

Direct Responses dispatch is installed in the same runtime after loading; this extension no longer re-registers the OpenAI Provider. Native SDK requests select it after model, authentication and header preparation, while preserving user-defined native Providers and matching custom stream registrations. Metadata-only registrations still use the prepared settings. Low-level `ModelRuntime.stream()`/`complete()` and calls without the runtime dispatch use their selected Provider rather than inheriting an extension override.

Each runtime owns its compaction state, direct Responses connections and request queues. Clearing dispatch retains this owner for cleanup; an installed owner cannot be replaced or omitted when reinstalling a stream. Revocation aborts active and queued requests, and shutdown/reload waits for actual completion with a 10-second deadline. A timeout or cleanup error reports failure; it does not certify a successful shutdown. `/provider-refresh` clears live flow after requests settle and preserves remote history and configuration. Cancellation reports `aborted` in both the event and final message. The queue is bounded at 128 outstanding requests per owner. The separate AI Codex transport cache is still keyed by session ID; this change does not claim isolation of that cache for identical IDs.

## What it does

On compaction, the extension requests Responses compaction v2 through `/v1/responses`. When a portable model summary is requested, GPT models finish it before remote compaction; other supported models may run the two requests in parallel. If and only if the server returns an explicit pre-output 400/404 saying `compaction_trigger`/`remote_compaction_v2` is unsupported, it retries once through unary `/v1/responses/compact`; generic HTTP errors, rate limits, aborts, timeouts, and failures after streaming begins never issue that second request. This gives you both:

- **An OpenAI-native opaque compaction artifact** for high-fidelity continuity on compatible future turns
- **A portable Pi text summary** so non-OpenAI models, session exports, forking, and tree navigation keep working

For direct `openai/*` models between compactions, the extension also:

- Patches requests with `store: true` and `context_management`
- Uses `previous_response_id` for live continuation when safe
- Provides a WebSocket-backed transport path with HTTP fallback

For `openai-codex/*` models, the extension preserves the built-in Codex transport and only injects reconstructed remote compaction history after compaction boundaries.

## How compaction works

On Pi compaction events for supported models, the extension:

1. Generates a **portable Pi continuation checkpoint** from only the prefix Pi will discard. An optional model summary uses a separate summary context, excludes the retained tail, and falls back to Pi's built-in compactor and then a bounded deterministic checkpoint when no custom summary instructions are present.
2. Calls `POST /v1/responses` with the current effective conversation context (not superseded pre-compaction JSONL history), a trailing `compaction_trigger`, system prompt, tools, reasoning config, text config, and the final canonical preview's `service_tier`; the narrow unsupported-protocol case falls back to `POST /v1/responses/compact`
3. Retains recent user messages within Pi's intentional 20K-token replay budget measured with the GPT-family `o200k_base` BPE tokenizer (using code-point-safe bounded chunks), replacing retained inline images with a fixed text marker so Base64 payloads cannot bypass that budget, and stores them with the returned opaque `compaction` item in `CompactionEntry.details.remoteCompaction`
4. Aggregates reported portable-summary and remote-compaction usage on Pi's compaction entry so session statistics and footer totals include billed work
5. After automatic threshold compaction, queues at most one hidden follow-up only when the last assistant response was reliably truncated (`length`)

A normal final response with `stopReason: "stop"` or an ordinary `toolUse` never triggers another turn. Continuations are deduplicated by compaction entry and cannot recursively continue an auto-continuation. The hook also does **not** run for manual `/compact`, Pi-owned overflow retries, or sessions with an active `pi-goal` goal.

The compaction request mirrors the shape of surrounding normal requests (reasoning effort, text settings, tool definitions) rather than using endpoint defaults.

## Safety

The extension clears live continuation state on: session start/reload/resume, switch/fork, tree navigation, compaction completion, model selection, shutdown, and an explicit `/provider-refresh` command.

`/provider-refresh` waits until the current agent is fully idle, then closes only the current session's WebSocket and clears only its live `previous_response_id` / transport baseline. It does not change Pi's local JSONL history, persisted or reconstructed remote-compaction replay, observed request-shape settings, or project configuration. The next provider request starts a fresh transport flow from the appropriate local history.

Remote compaction history is only replayed for compatible models. Cross-model turns are filtered from reconstructed replay history to prevent contamination after resume or tree navigation.

Continuity recovery has explicit limits:

- Direct Responses WebSocket requests assemble their candidate previous ID and input before payload hooks. A hook that removes that ID keeps its resulting input; the host does not splice an older prefix back in or replay the hook. Unknown cold/HTTP evidence is cleared before hooks. A final tier or foreign-ID mismatch is rejected before sending, and a subsequent cold request can establish a new boundary.
- Native Codex hooks see the full logical request before cached WebSocket delta selection. An ordinary cache mismatch can send that full input. After compaction, a missing or ambiguous opaque boundary rejects the request without sending or falling back to SSE, while preserving the cache evidence. Restoring a valid boundary can reuse it; `/provider-refresh` starts a fresh transport using compatible persisted opaque history or the portable local representation.
- These rules do not promise transparent recovery for arbitrary hook changes. They do not cache additional full histories, retry hooks to infer intent, or treat an error response as a successful continuity boundary.

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

Project config is resolved from the active session's trusted `ctx.cwd`, not the process working directory. Session startup installs direct Responses dispatch only when the captured configuration is enabled. Disabled sessions retain their selected Provider; no OpenAI Provider registration is replaced. Untrusted sessions read only global/environment configuration.

Compaction reads `service_tier` from the canonical preview after all ordinary payload hooks, including the optional Fast hook. It never rereads Fast configuration or a process-global override, and never substitutes an observed response tier. Codex validates this final requested tier against the last successful request commitment; changing it before compaction rejects the mismatch before dispatch. A successful ordinary request establishes the new tier's boundary.

Direct Responses WebSocket continuation also binds the final requested tier to the successful response ID. The existing options-based shape check remains a conservative first filter. After payload hooks, any remaining `previous_response_id` must match that successful ID and its exact requested tier (including an explicitly omitted tier); response pricing tiers never establish continuation identity. Unknown cold/HTTP continuation is discarded before hooks so the existing full-input path can run once. A hook that changes tier while retaining an old ID is rejected before sending; it is not silently replayed, and client history is not spliced into its input. If the hook explicitly removes the ID, its resulting input is preserved. Failed or canceled requests never advance this successful boundary.

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

`portableSummaryModel` is a model ID from the active provider. The default, `"current"`, reuses the active model and its captured authentication. A cheaper same-provider model may reduce summary cost, but is selected only when its context window can hold the current compaction input plus the summary output budget; otherwise the active model is used. This setting never selects a model from another provider.

Portable summaries reuse the active request's complete authentication snapshot, including its effective model URL, nullable headers and environment. A different summary model resolves its own authentication once; if unavailable, the whole active snapshot is retained. Both the first portable request and an allowed built-in compactor fallback use the selected snapshot, without mixing fields or resolving authentication again. Header deletion markers still prevent the legacy compactor fallback, and cancellation or custom summary instructions retain their existing failure behavior.

Current hosts run both summary algorithms inside `withSupplementalSummary`, opened before candidate authentication. The host applies its header and payload hooks with `purpose: "supplemental-summary"` and the selected summary model. Fast therefore applies to eligible Codex summaries; a later payload hook can override their requested tier. The ordinary request and remote-compaction tier remain governed by their own canonical payload. Summary requests use SSE without session caching or a previous response ID, reuse the host's provider selection and Codex owner, and leave ordinary continuation, successful-request commitment, prefix and tool-budget state intact. Cancellation, model changes, reload and shutdown invalidate pending work; scope exit waits for the request iterator's cleanup, including errors after a terminal event. Hosts without this optional API retain the legacy dispatch path and do not provide these host-scope guarantees.

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

Run the maintained offline contracts from the monorepo root:

```bash
node --experimental-strip-types --test tests/provider-contract/openai-remote-compaction-fallback.contract.test.ts tests/provider-contract/openai-compaction-lifecycle.contract.test.ts
```

These contracts use synthetic responses and verify fallback, cancellation and
continuation lifecycle. The former standalone `smoke` and `test:live` npm scripts
are not provided by this checkout. Offline success does not establish real-provider
continuity; real calls require separately authorized manual acceptance.

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
| `src/custom-stream.ts`                     | Explicit runtime dispatch entrypoint                              |
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
