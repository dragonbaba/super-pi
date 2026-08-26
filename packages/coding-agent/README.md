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

```ts
export default function extension(pi: ExtensionAPI) {
	pi.observe(
		"message_update",
		(event) => updateDisplay(event.message),
		{ slowThresholdMs: 100, timeoutMs: 1_000, disableAfterErrors: 3 },
	);
}
```

Intercepting and transforming hooks continue to use `pi.on()`. Hosts may configure category-specific hook timeouts through `extensionRunnerOptions`; safety/veto hooks always fail closed, interactive hooks have no timeout by default, and transform hooks require an explicit fail-open or fail-closed policy.
