# Clean-HOME startup evidence (G2S-B0-CANDIDATE-STARTUP)

Red production stamp: `c48913f5007a1bc10125d2bbb25cd55a92f72ff9`; production inherited from d5516ca for this path.

Real CLI entry, isolated HOME/settings/session, offline, no provider key, regular/fullscreen: exits 1 before extension session_start and before terminal raw mode. Error: `Invalid capabilities for unknown/unknown: contextWindow must be a positive safe integer`.

Direct SDK profiler probe `node --experimental-strip-types scripts/bench/alpha-startup-profile.ts`: 100 attempts, 100 identical construction failures, 0 successes. CPU profile contains AgentSession → _rebuildSystemPrompt → getModelCapabilities → deriveModelCapabilities → normalizeModelCapabilitiesV1. AgentSession had 4 self samples; the narrower throw path had zero self samples. This is evidence of the startup-blocking call chain, **not** a claim of a streaming CPU hotspot. Leading sampled allocations are path joins (individual sites 789,360/679,200 bytes), sort (357,168), _bindExtensionCore (241,280), createAgentSession (221,784), ExtensionRunner (125,216), _buildRuntime (114,376).

Root cause: Agent's internal no-model sentinel has api/provider/id `unknown`, contextWindow/maxTokens zero. AgentSession's documented optional model accessor returns that sentinel as though it were a selected model. Capability validation correctly rejects it. The authorized evidence-gated change is limited to that accessor: expose this exact sentinel as no model, retaining validation for actual malformed models. No provider, wire, session serialization, hook ordering, projection or agent-final-event behavior changes.

This reproducible clean-HOME failure is not yet established as the exact cause of the user's existing configured-copy failure. That separate report remains open pending capture/matrix evidence.
