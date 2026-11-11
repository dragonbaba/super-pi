# Super Pi coding agent

This package contains the local `superpi` CLI and interactive coding-agent runtime
for [Super Pi](https://github.com/dragonbaba/super-pi).

It is maintained as source inside the Super Pi monorepo. The initial project
does not publish this package to npm and does not provide a `pi` executable
alias. Build it from the repository root with `npm run build:offline`.

Super Pi is derived from Pi `v0.84.1`; see the repository `NOTICE.md` for
attribution and provenance.

## Configuration editor assistance

Static JSON schemas for global `~/.sp/agent/config/settings.json` and project
`.sp/config/settings.json` are included in this package's `schemas/` directory.
They provide field completion and type/spelling diagnostics, including Super Pi
extensions and legacy settings. Use the project schema for project files to
identify global-only options. See [settings schema setup](../../docs/repairs/settings-json-schema.md)
for online/offline examples and the unchanged runtime/trust boundaries.

Branch summaries support an optional `branchSummary.maxTokens` output allowance
(default 2048). See [branch summary settings](../../docs/branch-summaries.md) for
provider thinking semantics, context reserves, costs, and SDK usage.

Global `~/.sp/agent/config/keybindings.json` has a separate
`schemas/keybindings.schema.json` for built-in action names, descriptions and
binding value types, including legacy names and empty arrays for unbinding.
See [keybindings schema setup](../../docs/repairs/keybindings-json-schema.md).

## Independent tool renderers

Extensions can use `pi.registerToolRenderer((toolName, next) => renderers)` to
customize interactive/history tool rows and HTML exports, including tools that
are no longer registered. This does not register or activate executable tools.
See [tool renderer registration](../../docs/tool-renderers.md) for precedence,
lifecycle rules and an example.

## Fullscreen behavior

The interactive TUI always uses the fullscreen (alternate-screen) renderer; the deprecated `tuiMode` setting and `--tui-mode` flag are ignored.

When scrolling up, a `↓ Back to bottom · Esc` button appears above the input area. Click it or press Escape to resume following new output without changing the input draft. Autocomplete and dialogs retain their Escape handling; at the bottom, Escape keeps its usual interrupt behavior.

The transcript scrollbar reserves the rightmost column, so showing or hiding it never reflows text. With the default `fullscreenScrollbar: "auto"` it appears while scrolling or while the pointer hovers that column; pressing the thumb drags it, and pressing the rest of the column jumps there and continues the drag. `"always"` keeps it visible; `"hidden"` removes it and gives the column back to text.

Exit restores the terminal as it was before Super Pi started and leaves only the session resume hint. The deprecated `fullscreenExitOutput` setting is ignored.

## PowerShell on Windows

Start with `superpi`, then use `/permissions` to choose MXC read-only,
MXC sandbox read/write (default), host restricted, host restricted with Auto
approval, or full host access. Switching preserves the conversation and drains
the previous runtime; host access requires an explicit choice and is not
inherited by a new session. MXC directly accesses authorized workspaces and
requires PowerShell 7, without shell or host fallback. See
[execution environments and permissions](../../docs/execution-environments.md)
for workspace access, capacity limits,
prerequisites, and migration from existing settings. The executable selection
below applies to host PowerShell execution.

The `powershell` tool is enabled by default on Windows. Resolution prefers PowerShell 7 (`pwsh.exe`) from `PATH`, then its standard installation under `Program Files`; Windows PowerShell 5.1 is used only as a fallback.

To select an explicit executable, add `powershellPath` to the global settings file at `~/.sp/agent/config/settings.json`:

```json
{
  "powershellPath": "D:\\PowerShell\\7\\pwsh.exe"
}
```

For security, `powershellPath` is global-only: `.sp/config/settings.json` in a project cannot override it. Super Pi also maintains a global `powershellStatus` record containing the selected path, availability, and verification state. A persisted path is reused across process launches without repeatedly starting PowerShell, provided the executable still exists. A new, missing, or explicitly changed path is resolved without launching it and saved as pending; the first real tool execution confirms whether it is usable.

Successful validation or execution records PowerShell as available; a failed recovery records it as unavailable, reports the error to the model, and removes the tool from the active set. An unavailable record is not probed again on later launches or implicitly cleared by a path change. Explicitly enabling the tool writes a pending, unverified state and permits one new attempt; the next success or failure is persisted again.

The optional `defaultTools` array controls only the initial built-in tool selection. Extension and SDK custom tools remain enabled. On Windows, include `"powershell"` when overriding this list if PowerShell should remain active:

```json
{
  "defaultTools": ["read", "bash", "powershell", "edit", "write"]
}
```

## Streaming extension observers

Existing `pi.on("message_update", handler)` and `pi.on("tool_execution_update", handler)` registrations remain serial and awaited for every event published by the Agent dispatcher. Assistant updates continue to publish every provider update on this compatibility path.

Tool producers now choose one of two bounded progress contracts. Calling `onUpdate(partialResult)` uses latest-value delivery and may coalesce rapid updates before they reach `pi.on()` or `Agent.subscribe()`. A producer that requires lossless compatibility delivery must use `await onUpdate.awaited(partialResult)` and await each update before publishing the next one. This replaces the previous unbounded Promise accumulation; lossless delivery without producer backpressure is intentionally unsupported because it cannot have bounded memory.

Display-only extensions should use `pi.observe()` for these two events. Observer updates run on a latest-value lane separate from the built-in UI, the final update is flushed before the corresponding end event, return values are ignored, and failures do not fail the agent run. Slow observers are recorded. An observer is disabled after three consecutive ordinary failures by default; a timeout disables it immediately so it cannot delay the next run. Slow, timeout, and failure thresholds are configurable per registration:

Observer payload snapshots recursively clone and freeze ordinary objects and arrays. `Map`, `Set`, `Date`, and typed-array values are cloned so they do not share mutable storage with provider or tool state, but their internal contents are not guaranteed to be deeply immutable; observers should treat every payload as read-only.

```ts
export default function extension(pi: ExtensionAPI) {
	pi.observe(
		"message_update",
		(event) => updateDisplay(event.message),
		{ slowThresholdMs: 100, timeoutMs: 1_000, disableAfterErrors: 3 },
	);
}
```

Intercepting and transforming hooks continue to use `pi.on()`. Hosts may configure category-specific hook timeouts through `extensionRunnerOptions`; the standard CLI applies a 30-second timeout to safety/veto hooks, including bootstrap `project_trust`, and always fails them closed. Interactive hooks have no timeout by default, and transform hooks require an explicit fail-open or fail-closed policy. A timeout stops awaiting the handler but cannot forcibly cancel already-running JavaScript. Its eventual fulfillment or rejection is observed and ignored; returned transforms or trust decisions are never applied after the timeout.

## Run settlement events

Extensions and JSON/RPC subscribers receive `agent_settled` after a run and its
automatic retries, compaction and queued continuations finish:

```json
{"type":"agent_settled","aborted":false}
```

`aborted` is true when the run is cancelled, including during retry backoff or
automatic compaction. A provider error or a request for user input alone leaves
it false. Existing consumers can ignore the additive field; clients connecting
to older hosts should treat an absent field as false.

## Terminal program status

Interactive mode reports OSC 7501 to supporting terminals: `working` during runs
and compaction, `blocked` for permission/input/login dialogs or a run waiting for
input, then `done`, `error`, or `idle` after completion, failure, or cancellation.
An automatic retry keeps the run working until its final outcome is known.

Support is queried at terminal startup. Set `SP_PROGRAM_STATUS=1` to force reports
when replies cannot reach the application, or `SP_PROGRAM_STATUS=0` to disable
them. OSC 9;4 progress and its existing setting remain independent. JSON and RPC
output do not contain these terminal sequences.

When a terminal advertises a limited capability list, unsupported states fall
back to `idle` (or `clear` if `idle` is unavailable). An unsupported blocking kind
falls back to `question` when supported, otherwise it is omitted. Optional status
write failures do not interrupt dialog resolution or cleanup.

Reports contain only the session name, dialog title, or first error line, bounded
to 2048 UTF-8 bytes with control characters removed. Prompt text, assistant output,
tool results and login credentials are not included. Unchanged statuses are not
re-sent; a slow output retains only the latest pending state. Suspend/resume and
renderer replacement replay the current status after support is established.

## Tool-result budget

Tool-result projection stays disabled unless explicitly configured. Use
`/tool-budget status` to see the effective text-token budget, whether the last
request preparation applied it or was blocked, and the unknown image/billing
estimates. `/tool-budget <positive integer>` and `/tool-budget off` change this
idle session only; `/settings` offers the same control. They do not save global or
project configuration, change startup priority, or replay completed tools. After a
too-small budget blocks a request, explicitly adjust the budget and continue your
message. Built-in result projection keeps the complete Session/UI result. MCP
input admission may instead retain only an error, without the remote output or a
continuation, even if the remote tool already executed. A new or reopened
session uses its startup configuration; the temporary override is not persisted.

## Prefix manifest diagnostics

Each main provider request keeps pre-dispatch intent separate from the effective request. `session.prefixIntentManifest` exposes configured intent, while `session.prefixManifest` contains metadata-only hashes reported after payload transforms and effective transport selection. `session.prefixDriftDiagnostic` compares the current request against the preceding successfully completed main request; repeated observations within one request retain that baseline. Auxiliary summarization does not replace these diagnostics. OpenAI Codex reuses its bounded successful-dispatch commitment for these hashes, including automatic WebSocket-to-SSE fallback, without retaining or reserializing the complete request. Other built-in SSE providers observe their transformed payload immediately before dispatch.

Use `session.getPrefixObservation(message)` at assistant `message_end` to associate the exact final response and its normalized usage with the effective manifest. It returns the request sequence, adapter observation count, manifest, optional drift diagnostic, and an explicit comparison availability state. Observation count is not a count of physical HTTP retries. Only the latest completed response in the live session is eligible: copied/restored messages, missing observations, failed/aborted requests, superseded requests, context changes, explicit credential changes and disposed sessions return `undefined`. Branch/reset, compaction, branch summaries and reload invalidate the scope; ordinary append does not. Explicit credential generation is a local boundary, not proof of the upstream account selected by custom headers. Neither a matching prefix nor a drift diagnostic proves server cache eligibility, retention, miss cause or avoidable cost. See the [request attribution validation](../../docs/performance/pf04-request-attribution-validation.md).

Object keys and unordered discovered sibling resources are canonicalized; semantic tool, context-precedence, message, and request-transform order is preserved. Manifest serialization contains hashes, observation-state enums, byte counts, generations, and counts only—never the complete system prompt, tool schema, cache key, headers, credentials, project content, or external absolute paths. Dynamic-instruction and compaction fields remain `unavailable` until their production state is wired; they are not represented by synthetic generation zero values.

OpenAI-compatible prompt cache keys up to 64 Unicode code points remain unchanged. Longer keys use a readable prefix plus the first 24 hex characters of `SHA-256(full-key)`, avoiding collisions between long session IDs that share the same leading 64 characters.
