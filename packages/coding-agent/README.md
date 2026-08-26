# Super Pi coding agent

This package contains the local `superpi` CLI and interactive coding-agent runtime
for [Super Pi](https://github.com/dragonbaba/super-pi).

It is maintained as source inside the Super Pi monorepo. The initial project
does not publish this package to npm and does not provide a `pi` executable
alias. Build it from the repository root with `npm run build:offline`.

Super Pi is derived from Pi `v0.84.1`; see the repository `NOTICE.md` for
attribution and provenance.

## Fullscreen behavior

The global `fullscreenExitOutput` setting controls what remains when the process exits. `"transcript"` (the default) prints the complete transcript back to the main terminal; `"resume-hint"` restores the pre-fullscreen terminal and leaves only the ordinary resume hint. This can also be changed in `/settings`.

## PowerShell on Windows

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

## Prefix manifest diagnostics

Each provider request keeps pre-dispatch intent separate from the request that actually won provider dispatch. `session.prefixIntentManifest` exposes configured intent, while `session.prefixManifest` contains metadata-only hashes reported after payload transforms and effective transport selection; `session.prefixDriftDiagnostic` compares effective dispatches. OpenAI Codex reuses its bounded successful-dispatch commitment for these hashes, including automatic WebSocket-to-SSE fallback, without retaining or reserializing the complete request. Other built-in SSE providers observe their transformed payload immediately before dispatch.

Object keys and unordered discovered sibling resources are canonicalized; semantic tool, context-precedence, message, and request-transform order is preserved. Manifest serialization contains hashes, observation-state enums, byte counts, generations, and counts only—never the complete system prompt, tool schema, cache key, headers, credentials, project content, or external absolute paths. Dynamic-instruction and compaction fields remain `unavailable` until their production state is wired; they are not represented by synthetic generation zero values.

OpenAI-compatible prompt cache keys up to 64 Unicode code points remain unchanged. Longer keys use a readable prefix plus the first 24 hex characters of `SHA-256(full-key)`, avoiding collisions between long session IDs that share the same leading 64 characters.
