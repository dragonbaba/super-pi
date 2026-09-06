# Clean-HOME startup evidence (G2S-B0-CANDIDATE-STARTUP)

Red production stamp: `c48913f5007a1bc10125d2bbb25cd55a92f72ff9`; production inherited from d5516ca for this path.

Real CLI entry, isolated HOME/settings/session, offline, no provider key, regular/fullscreen: exits 1 before extension session_start and before terminal raw mode. Error: `Invalid capabilities for unknown/unknown: contextWindow must be a positive safe integer`.

Direct SDK profiler probe `node --experimental-strip-types scripts/bench/alpha-startup-profile.ts`: 100 attempts, 100 identical construction failures, 0 successes. CPU profile contains AgentSession → _rebuildSystemPrompt → getModelCapabilities → deriveModelCapabilities → normalizeModelCapabilitiesV1. AgentSession had 4 self samples; the narrower throw path had zero self samples. This is evidence of the startup-blocking call chain, **not** a claim of a streaming CPU hotspot. Leading sampled allocations are path joins (individual sites 789,360/679,200 bytes), sort (357,168), _bindExtensionCore (241,280), createAgentSession (221,784), ExtensionRunner (125,216), _buildRuntime (114,376).

Root cause: Agent's internal no-model sentinel has api/provider/id `unknown`, contextWindow/maxTokens zero. AgentSession's documented optional model accessor returns that sentinel as though it were a selected model. Capability validation correctly rejects it. The authorized evidence-gated change is limited to that accessor: expose this exact sentinel as no model, retaining validation for actual malformed models. No provider, wire, session serialization, hook ordering, projection or agent-final-event behavior changes.

This reproducible clean-HOME failure is not yet established as the exact cause of the user's existing configured-copy failure. That separate report remains open pending capture/matrix evidence.

## Capture command and current limits

After `npm run build:offline`, run:

```powershell
npm run alpha:g2-capture -- --tui-mode regular
```

Quit normally when input is ready. The runner prints the retained phase-report path. HOME/config/session are isolated, offline is enabled, no session is persisted, and the runner removes its exact temporary HOME after exit. Cwd remains the invoked project so project loading can still be exercised. This command does not import the user's global settings/auth and cannot alone reproduce a failure requiring that configuration.

Capture is a test-only explicit `--import` module, absent from normal CLI loading. Without `SP_ALPHA_STARTUP_CAPTURE` it performs no imports or instrumentation. It writes at most 256 scalar records: fixed phase label, duration, generation, and optional whitelisted error code. No error messages, prompt, API key, result, session content or full path is recorded. Wrappers exist only around startup work and are restored when init settles; no per-delta wrapper or log is installed.

Measured phases: capture entry, interactive-init entry, tools, TUI mount/start, theme, extension rebind, history, branch watcher, provider count, first render, highlight load, input-ready/cancel/failure, uncaught monitor, process exit. CLI module import plus runtime construction precede interactive-init entry and are **not separately timed** by this diagnostic. This is an explicit remaining instrumentation gap, not a fabricated constructor duration.

Actual pipe-backed CLI regular/fullscreen `/quit` tests verify exactly one input-ready record and only the allowed scalar schema. Ctrl+D, double Ctrl+C and extension shutdown also pass with capture disabled. Native PTY/manual execution is still not claimed.

Deterministic partial-startup cleanup now covers ensure-tools/theme/rebind/history/provider-count/first-render failures in both modes, preserving the original Error and exiting 1 after terminal/runtime cleanup. Quit during each of four startup awaits returns init=false without stale writes. 25 actual init/quit cycles per mode restore raw mode and input/resize/SIGTERM listener counts. These tests inject faults into real init phases; they do not establish the root cause of the user's unobserved failure.
